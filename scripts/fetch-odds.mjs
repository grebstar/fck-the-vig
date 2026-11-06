// Pulls current odds from The Odds API and writes docs/data/odds.json for the site.
// Runs in GitHub Actions (see .github/workflows/update-odds.yml). No dependencies: Node 18+.
//
// MODE=lines  game lines (moneyline, spread, total) for every game in the next DAYS_AHEAD days
// MODE=props  player props for the next few games per sport (one call per game)
// MODE=all    both (used for manual "Run workflow")
//
// Credit math (The Odds API docs): each market costs 1 credit per region; up to 10 bookmakers
// count as 1 region. Game lines: 3 markets x 1 = 3 credits per sport. Props: 1 credit per prop
// market actually returned, per game. Empty responses and the /sports and /events lists are free.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const env = process.env;
const list = (v, d) => (v && v.trim() ? v : d).split(',').map(s => s.trim()).filter(Boolean);
const int = (v, d) => (v != null && String(v).trim() !== '' && !isNaN(+v) ? +v : d);

const API_KEY = env.ODDS_API_KEY;
const API_BASE = (env.ODDS_API_BASE || 'https://api.the-odds-api.com').replace(/\/$/, '');
const MODE = (env.MODE || 'all').trim().toLowerCase();
const SPORTS = list(env.SPORTS, 'americanfootball_nfl,basketball_nba,americanfootball_ncaaf');
const BOOKMAKERS = list(env.BOOKMAKERS, 'draftkings,fanduel,betmgm,espnbet,betrivers,hardrockbet,kalshi,polymarket_us,novig,prophetx');
const MARKETS = list(env.MARKETS, 'h2h,spreads,totals');
const DAYS_AHEAD = int(env.DAYS_AHEAD, 7);
const OUT = env.OUT_FILE || 'docs/data/odds.json';

// Props: which markets and how many upcoming games per sport.
const PROP_MARKETS = {
  americanfootball_nfl: list(env.PROP_MARKETS_NFL, 'player_pass_yds,player_rush_yds,player_reception_yds,player_anytime_td'),
  basketball_nba: list(env.PROP_MARKETS_NBA, 'player_points,player_rebounds,player_assists'),
  americanfootball_ncaaf: list(env.PROP_MARKETS_NCAAF, 'player_pass_yds,player_rush_yds,player_reception_yds,player_anytime_td'),
};
const PROP_GAMES = {
  americanfootball_nfl: int(env.PROP_GAMES_NFL, 3),
  basketball_nba: int(env.PROP_GAMES_NBA, 2),
  americanfootball_ncaaf: int(env.PROP_GAMES_NCAAF, 1),
};
const PROP_WINDOW_H = int(env.PROP_WINDOW_HOURS, 30);   // only games starting within this many hours
const LINES_RESERVE = int(env.MIN_REMAINING, 15);       // never go below this many credits
const PROPS_RESERVE = int(env.PROPS_RESERVE, 40);       // props stop earlier so game lines can still update

const SPORT_TITLES = { americanfootball_nfl: 'NFL', basketball_nba: 'NBA', americanfootball_ncaaf: 'College Football' };

if (!API_KEY) {
  console.error('ODDS_API_KEY is not set. Add it as a repository secret (Settings → Secrets and variables → Actions).');
  process.exit(1);
}

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
  const to = new Date(Date.now() + DAYS_AHEAD * 864e5);
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
    try {
      const { data, q } = await getJson(`/v4/sports/${key}/odds`, {
        bookmakers: BOOKMAKERS.join(','), markets: MARKETS.join(','), oddsFormat: 'american',
        dateFormat: 'iso', includeLinks: 'true', commenceTimeTo: isoNoMs(to),
      });
      const prevEvents = new Map((prev?.events || []).map(e => [e.id, e]));
      const events = data.map(ev => {
        const old = prevEvents.get(ev.id);
        return {
          id: ev.id, commence_time: ev.commence_time, home: ev.home_team, away: ev.away_team,
          lines_at: new Date().toISOString(),
          ...(old?.props_at ? { props_at: old.props_at } : {}),
          books: mergeBooks(old?.books, normalizeBooks(ev.bookmakers), isProp), // keep old props, replace lines
        };
      }).sort((a, b) => a.commence_time.localeCompare(b.commence_time));
      out.sports.push({ key, title, in_season: true, lines_at: new Date().toISOString(), props_at: prev?.props_at || null, events });
      console.log(`${title} lines: ${events.length} games (cost ${q.last ?? '?'}, remaining ${q.remaining ?? '?'})`);
    } catch (err) {
      console.error(`${title} lines: ${err.message}`);
      out.notes.push(`${title} lines failed to update: ${err.message.slice(0, 120)}`);
      if (prev) out.sports.push(prev);
    }
  }
}

async function updateProps(out) {
  const now = Date.now();
  for (const sp of out.sports) {
    const markets = PROP_MARKETS[sp.key] || [];
    const n = PROP_GAMES[sp.key] || 0;
    if (!sp.in_season || !markets.length || !n) continue;
    const targets = sp.events
      .filter(e => { const t = new Date(e.commence_time).getTime(); return t > now && t - now < PROP_WINDOW_H * 3600e3; })
      .slice(0, n);
    for (const ev of targets) {
      const maxCost = markets.length * groups;
      if (quota?.remaining != null && quota.remaining - maxCost < PROPS_RESERVE) {
        out.notes.push(`Props paused: ${quota.remaining} API credits left (saving the rest for game lines).`);
        return;
      }
      try {
        const { data, q } = await getJson(`/v4/sports/${sp.key}/events/${ev.id}/odds`, {
          bookmakers: BOOKMAKERS.join(','), markets: markets.join(','), oddsFormat: 'american',
          dateFormat: 'iso', includeLinks: 'true',
        });
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
}

async function main() {
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

main().catch(err => { console.error(err); process.exit(1); });
