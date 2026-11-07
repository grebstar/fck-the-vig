// Pulls current odds from The Odds API and writes docs/data/odds.json for the site.
// Runs in GitHub Actions (see .github/workflows/update-odds.yml). No dependencies: Node 18+.
//
// MODE=lines  game lines (moneyline, spread, total) for every upcoming game in each sport's window
// MODE=props  player props for the next few games per sport (one call per game)
// MODE=all    both (used for manual "Run workflow")
//
// Credit math (The Odds API docs): each market costs 1 credit per region; up to 10 bookmakers
// count as 1 region. Game lines: 3 markets x 1 = 3 credits per sport. Props: 1 credit per prop
// market actually returned, per game. Empty responses and the /sports and /events lists are free.
// Credits reset on the 1st of every month.
//
// Pacing: props get whatever is left after setting aside enough credits for every game-line run and
// weekly futures until the 1st, split evenly across the days left. So the same code works on the
// free plan (500 credits) and on bigger plans (more credits = more props, automatically).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const list = (v, d) => (v && v.trim() ? v : d).split(',').map(s => s.trim()).filter(Boolean);
const int = (v, d) => (v != null && String(v).trim() !== '' && !isNaN(+v) ? +v : d);

const API_KEY = env.ODDS_API_KEY;
const API_BASE = (env.ODDS_API_BASE || 'https://api.the-odds-api.com').replace(/\/$/, '');
const MODE = (env.MODE || 'all').trim().toLowerCase();
const SPORTS = list(env.SPORTS, 'americanfootball_nfl,basketball_nba,americanfootball_ncaaf,basketball_ncaab');
const BOOKMAKERS = list(env.BOOKMAKERS, 'draftkings,fanduel,betmgm,espnbet,betrivers,hardrockbet,kalshi,polymarket_us,novig,prophetx');
const MARKETS = list(env.MARKETS, 'h2h,spreads,totals');
const DAYS_AHEAD = int(env.DAYS_AHEAD, 14);  // the site's date picker shows every day that has lines
const OUT = env.OUT_FILE || 'docs/data/odds.json';

// How far ahead to list games. A wider window costs no extra credits (game lines are billed per market, not
// per game), only file size. College basketball has 100+ games a day, so it's held to a week.
const LINES_HOURS = {
  basketball_ncaab: int(env.LINES_HOURS_NCAAB, 168),
};
// Drop games that fewer than this many books are pricing (tiny college games).
const MIN_BOOKS = { basketball_ncaab: int(env.MIN_BOOKS_NCAAB, 3), americanfootball_ncaaf: int(env.MIN_BOOKS_NCAAF, 1) };

// Props: which markets and how many upcoming games per sport. College basketball props are off by default on
// the free plan; set PROP_GAMES_NCAAB (a repo Actions variable) to turn them on.
const PROP_MARKETS = {
  americanfootball_nfl: list(env.PROP_MARKETS_NFL, 'player_pass_yds,player_rush_yds,player_reception_yds,player_anytime_td'),
  basketball_nba: list(env.PROP_MARKETS_NBA, 'player_points,player_rebounds,player_assists'),
  americanfootball_ncaaf: list(env.PROP_MARKETS_NCAAF, 'player_pass_yds,player_rush_yds,player_reception_yds,player_anytime_td'),
  basketball_ncaab: list(env.PROP_MARKETS_NCAAB, 'player_points,player_rebounds,player_assists'),
};
const PROP_GAMES = {
  americanfootball_nfl: int(env.PROP_GAMES_NFL, 3),
  basketball_nba: int(env.PROP_GAMES_NBA, 2),
  americanfootball_ncaaf: int(env.PROP_GAMES_NCAAF, 1),
  basketball_ncaab: int(env.PROP_GAMES_NCAAB, 0),
};
const PROP_WINDOW_H = int(env.PROP_WINDOW_HOURS, 30);   // only games starting within this many hours
const LINES_RESERVE = int(env.MIN_REMAINING, 15);       // never go below this many credits
const LINES_EVERY_DAYS = int(env.LINES_EVERY_DAYS, 2);  // must match the workflow schedule
const PROPS_RUNS_PER_DAY = int(env.PROPS_RUNS_PER_DAY, 1);
const FUTURES_PER_WEEK = int(env.FUTURES_PER_WEEK, 5);  // sportsbook futures (fetch-futures.mjs), ~1 credit each, weekly

const SPORT_TITLES = {
  americanfootball_nfl: 'NFL', basketball_nba: 'NBA',
  americanfootball_ncaaf: 'College Football', basketball_ncaab: 'College Basketball',
};


const groups = Math.ceil(BOOKMAKERS.length / 10);
const isoNoMs = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const num = v => (v == null || v === '' ? null : Number(v));
let quota = null;

async function getJson(path, params) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries({ apiKey: API_KEY, ...params })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const q = { remaining: num(res.headers.get('x-requests-remaining')), used: num(res.headers.get('x-requests-used')), last: num(res.headers.get('x-requests-last')) };
  if (q.remaining != null) quota = q;
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}: ${body.slice(0, 200)}`);
  return { data: JSON.parse(body), q };
}

function normalizeBooks(bookmakers) {
  const books = {};
  for (const b of bookmakers || []) {
    const markets = {};
    for (const m of b.markets || []) {
      markets[m.key] = (m.outcomes || []).map(o => ({
        name: o.name,
        ...(o.description ? { desc: o.description } : {}),
        price: o.price,
        ...(o.point != null ? { point: o.point } : {}),
        ...(o.link ? { link: o.link } : {}),
      }));
    }
    books[b.key] = { title: b.title, last_update: b.last_update || null, ...(b.link ? { link: b.link } : {}), markets };
  }
  return books;
}

const isProp = k => k.startsWith('player_');

// Merge prop markets into an event's books without touching game-line markets (and vice versa).
function mergeBooks(base, extra, keepPred) {
  const out = {};
  for (const [bk, b] of Object.entries(base || {})) {
    out[bk] = { ...b, markets: Object.fromEntries(Object.entries(b.markets).filter(([k]) => keepPred(k))) };
  }
  for (const [bk, b] of Object.entries(extra || {})) {
    if (!out[bk]) out[bk] = { ...b, markets: {} };
    out[bk].title = b.title;
    out[bk].last_update = b.last_update || out[bk].last_update;
    if (b.link) out[bk].link = b.link;
    Object.assign(out[bk].markets, b.markets);
  }
  for (const [bk, b] of Object.entries(out)) if (!Object.keys(b.markets).length) delete out[bk];
  return out;
}

async function updateLines(out, prevSports, active) {
  const cost = MARKETS.length * groups;
  for (const key of SPORTS) {
    const title = SPORT_TITLES[key] || key;
    const prev = prevSports.get(key);
    if (!active.has(key)) { out.sports.push({ key, title, in_season: false, events: [] }); continue; }
    if (quota?.remaining != null && quota.remaining - cost < LINES_RESERVE) {
      out.notes.push(`${title} lines not updated: only ${quota.remaining} API credits left this month.`);
      if (prev) out.sports.push(prev);
      continue;
    }
    const to = new Date(Date.now() + (LINES_HOURS[key] || DAYS_AHEAD * 24) * 3600e3);
    try {
      const { data, q } = await getJson(`/v4/sports/${key}/odds`, {
        bookmakers: BOOKMAKERS.join(','), markets: MARKETS.join(','), oddsFormat: 'american',
        dateFormat: 'iso', includeLinks: 'true', commenceTimeTo: isoNoMs(to),
      });
      const prevEvents = new Map((prev?.events || []).map(e => [e.id, e]));
      const minBooks = MIN_BOOKS[key] || 1;
      const events = data.filter(ev => (ev.bookmakers || []).length >= minBooks).map(ev => {
        const old = prevEvents.get(ev.id);
        return {
          id: ev.id, commence_time: ev.commence_time, home: ev.home_team, away: ev.away_team,
          lines_at: new Date().toISOString(),
          ...(old?.props_at ? { props_at: old.props_at } : {}),
          books: mergeBooks(old?.books, normalizeBooks(ev.bookmakers), isProp), // keep old props, replace lines
        };
      }).sort((a, b) => a.commence_time.localeCompare(b.commence_time));
      out.sports.push({ key, title, in_season: true, lines_at: new Date().toISOString(), props_at: prev?.props_at || null, events });
      console.log(`${title} lines: ${events.length} games of ${data.length} (cost ${q.last ?? '?'}, remaining ${q.remaining ?? '?'})`);
    } catch (err) {
      console.error(`${title} lines: ${err.message}`);
      out.notes.push(`${title} lines failed to update: ${err.message.slice(0, 120)}`);
      if (prev) out.sports.push(prev);
    }
  }
}

// Credits props may spend on this run: what's left after reserving every remaining game-line run and the
// weekly futures until credits reset on the 1st, split evenly across the props runs left this month.
export function propsBudget(remaining, now, { sports, linesCost, linesEvery = 2, runsPerDay = 1, futuresPerWeek = 6, reserve = 15 }) {
  if (remaining == null) return Infinity;
  const d = new Date(now);
  const reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const daysLeft = Math.max(1, Math.ceil((reset - now) / 864e5));            // includes today
  const linesRunsLeft = Math.ceil((daysLeft - 1) / linesEvery);              // after this run
  const held = linesRunsLeft * sports * linesCost + Math.ceil(daysLeft / 7) * futuresPerWeek + reserve;
  return Math.max(0, Math.floor((remaining - held) / (daysLeft * runsPerDay)));
}

async function updateProps(out) {
  const now = Date.now();
  const inSeason = out.sports.filter(sp => sp.in_season).length;
  let budget = propsBudget(quota?.remaining ?? null, now, {
    sports: inSeason, linesCost: MARKETS.length * groups, linesEvery: LINES_EVERY_DAYS,
    runsPerDay: PROPS_RUNS_PER_DAY, futuresPerWeek: FUTURES_PER_WEEK, reserve: LINES_RESERVE,
  });
  console.log(`Props budget this run: ${budget === Infinity ? 'unlimited' : budget} credits`);
  // Queue games per sport, then take them round-robin so one busy sport can't use the whole budget.
  const queues = [];
  for (const sp of out.sports) {
    const markets = PROP_MARKETS[sp.key] || [];
    const n = PROP_GAMES[sp.key] || 0;
    if (!sp.in_season || !markets.length || !n) continue;
    const targets = sp.events
      .filter(e => { const t = new Date(e.commence_time).getTime(); return t > now && t - now < PROP_WINDOW_H * 3600e3; })
      .slice(0, n);
    if (targets.length) queues.push({ sp, markets, targets });
  }
  let skipped = 0;
  for (let round = 0; queues.some(q => q.targets.length > round); round++) {
    for (const { sp, markets, targets } of queues) {
      const ev = targets[round];
      if (!ev) continue;
      const maxCost = markets.length * groups;
      if (maxCost > budget || (quota?.remaining != null && quota.remaining - maxCost < LINES_RESERVE)) { skipped++; continue; }
      try {
        const { data, q } = await getJson(`/v4/sports/${sp.key}/events/${ev.id}/odds`, {
          bookmakers: BOOKMAKERS.join(','), markets: markets.join(','), oddsFormat: 'american',
          dateFormat: 'iso', includeLinks: 'true',
        });
        budget -= q.last ?? maxCost;
        ev.books = mergeBooks(ev.books, normalizeBooks(data.bookmakers), k => !isProp(k)); // replace props, keep lines
        ev.props_at = new Date().toISOString();
        sp.props_at = ev.props_at;
        console.log(`${sp.title} props: ${ev.away} @ ${ev.home} (cost ${q.last ?? '?'}, remaining ${q.remaining ?? '?'})`);
      } catch (err) {
        console.error(`${sp.title} props ${ev.id}: ${err.message}`);
        out.notes.push(`${sp.title} props failed for ${ev.away} @ ${ev.home}.`);
      }
    }
  }
  if (skipped) console.log(`Props: skipped ${skipped} game(s) to stay within this month's credits.`);
}

async function main() {
  if (!API_KEY) {
    console.error('ODDS_API_KEY is not set. Add it as a repository secret (Settings → Secrets and variables → Actions).');
    process.exit(1);
  }
  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
  const prevSports = new Map((previous?.sports || []).map(s => [s.key, s]));

  const out = {
    generated_at: new Date().toISOString(),
    source: 'the-odds-api',
    bookmakers: BOOKMAKERS,
    quota: null,
    sports: [],
    notes: [],
    // What this run was set up to fetch. The site's "Good to know" panel reads it, so its numbers stay
    // right when the Actions variables or the plan change.
    config: {
      days_ahead: DAYS_AHEAD, lines_hours: LINES_HOURS, min_books: MIN_BOOKS,
      lines_every_days: LINES_EVERY_DAYS, props_runs_per_day: PROPS_RUNS_PER_DAY,
      prop_window_hours: PROP_WINDOW_H, prop_games: PROP_GAMES, prop_markets: PROP_MARKETS, markets: MARKETS,
    },
  };

  const { data: sportList } = await getJson('/v4/sports', {}); // free
  const active = new Set(sportList.filter(s => s.active).map(s => s.key));

  if (MODE === 'lines' || MODE === 'all' || !previous) {
    await updateLines(out, prevSports, active);
  } else {
    for (const key of SPORTS) if (prevSports.has(key)) out.sports.push(prevSports.get(key));
  }
  // Drop games that started more than 6 hours ago.
  const cutoff = Date.now() - 6 * 3600e3;
  for (const sp of out.sports) sp.events = (sp.events || []).filter(e => new Date(e.commence_time).getTime() > cutoff);

  if (MODE === 'props' || MODE === 'all') await updateProps(out);

  out.quota = quota;
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT} (mode ${MODE}). Credits remaining: ${quota?.remaining ?? 'unknown'}`);
}

// Run only when executed directly (tests import propsBudget).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(err => { console.error(err); process.exit(1); });
