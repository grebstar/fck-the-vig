// Season-long markets: championships, awards, stat leaders and win totals.
// Writes docs/data/futures.json. Runs in GitHub Actions after fetch-odds.mjs. No dependencies: Node 18+.
//
// Two sources:
//  - Kalshi's public market data (free, no key): refreshed on every run.
//  - The Odds API "outrights" (sportsbook futures): 1 credit per market. Refreshed at most once a week
//    (or when MODE=futures), and only while plenty of credits are left for game lines.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const env = process.env;
const OUT = env.FUTURES_FILE || 'docs/data/futures.json';
const API_KEY = env.ODDS_API_KEY;
const API_BASE = (env.ODDS_API_BASE || 'https://api.the-odds-api.com').replace(/\/$/, '');
const KALSHI = (env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
const MODE = (env.MODE || 'all').trim().toLowerCase();
const BOOKMAKERS = (env.BOOKMAKERS && env.BOOKMAKERS.trim() ? env.BOOKMAKERS : 'draftkings,fanduel,betmgm,espnbet,betrivers,hardrockbet,kalshi,polymarket_us,novig,prophetx')
  .split(',').map(s => s.trim()).filter(Boolean);
const OUTRIGHT_EVERY_H = Number(env.OUTRIGHT_EVERY_HOURS || 156);   // about 6.5 days
const OUTRIGHT_RESERVE = Number(env.OUTRIGHT_RESERVE || 80);       // leave this many credits for game lines
const MAX_OUTRIGHTS = Number(env.MAX_OUTRIGHTS || 5);
const SPORT_PREFIXES = ['americanfootball_nfl', 'americanfootball_ncaaf', 'basketball_nba', 'basketball_ncaab'];
const COLLEGE = new Set(['americanfootball_ncaaf', 'basketball_ncaab']);

// [sport, Kalshi series, title, group, type, matching Odds API outright key]
const SERIES = [
  ['americanfootball_nfl', 'KXSB', 'Super Bowl winner', 'Champion', 'team', 'americanfootball_nfl_super_bowl_winner'],
  ['americanfootball_nfl', 'KXAFC', 'AFC champion', 'Champion', 'team'],
  ['americanfootball_nfl', 'KXNFC', 'NFC champion', 'Champion', 'team'],
  ['americanfootball_nfl', 'KXNFLMVP', 'MVP', 'Awards', 'player'],
  ['americanfootball_nfl', 'KXNFLOPOY', 'Offensive Player of the Year', 'Awards', 'player'],
  ['americanfootball_nfl', 'KXNFLDPOY', 'Defensive Player of the Year', 'Awards', 'player'],
  ['americanfootball_nfl', 'KXNFLOROY', 'Offensive Rookie of the Year', 'Awards', 'player'],
  ['americanfootball_nfl', 'KXNFLDROY', 'Defensive Rookie of the Year', 'Awards', 'player'],
  ['americanfootball_nfl', 'KXNFLCOMEBACK', 'Comeback Player of the Year', 'Awards', 'player'],
  ['americanfootball_nfl', 'KXNFLCOTY', 'Coach of the Year', 'Awards', 'player'],
  ['americanfootball_nfl', 'KXLEADERNFLPYDS', 'Passing yards leader', 'Stat leaders', 'player'],
  ['americanfootball_nfl', 'KXLEADERNFLPTDS', 'Passing TDs leader', 'Stat leaders', 'player'],
  ['americanfootball_nfl', 'KXLEADERNFLRUSHYDS', 'Rushing yards leader', 'Stat leaders', 'player'],
  ['americanfootball_nfl', 'KXLEADERNFLRYDS', 'Receiving yards leader', 'Stat leaders', 'player'],
  ['americanfootball_nfl', 'KXLEADERNFLSACKS', 'Sacks leader', 'Stat leaders', 'player'],
  ['americanfootball_nfl', 'KXNFLWINS', 'Team win totals', 'Win totals', 'ladder'],
  ['basketball_nba', 'KXNBA', 'NBA champion', 'Champion', 'team', 'basketball_nba_championship_winner'],
  ['basketball_nba', 'KXNBAEAST', 'Eastern Conference champion', 'Champion', 'team'],
  ['basketball_nba', 'KXNBAWEST', 'Western Conference champion', 'Champion', 'team'],
  ['basketball_nba', 'KXNBAMVP', 'MVP', 'Awards', 'player'],
  ['basketball_nba', 'KXNBAROY', 'Rookie of the Year', 'Awards', 'player'],
  ['basketball_nba', 'KXNBADPOY', 'Defensive Player of the Year', 'Awards', 'player'],
  ['basketball_nba', 'KXNBASIXTH', 'Sixth Man of the Year', 'Awards', 'player'],
  ['basketball_nba', 'KXNBAMIMP', 'Most Improved Player', 'Awards', 'player'],
  ['basketball_nba', 'KXNBACLUTCH', 'Clutch Player of the Year', 'Awards', 'player'],
  ['basketball_nba', 'KXNBACOY', 'Coach of the Year', 'Awards', 'player'],
  ['basketball_nba', 'KXLEADERNBAPTS', 'Points per game leader', 'Stat leaders', 'player'],
  ['basketball_nba', 'KXLEADERNBAREB', 'Rebounds per game leader', 'Stat leaders', 'player'],
  ['basketball_nba', 'KXLEADERNBAAST', 'Assists per game leader', 'Stat leaders', 'player'],
  ['basketball_nba', 'KXNBAWINS', 'Team win totals', 'Win totals', 'ladder'],
  ['americanfootball_ncaaf', 'KXNCAAF', 'National champion', 'Champion', 'team', 'americanfootball_ncaaf_championship_winner'],
  ['americanfootball_ncaaf', 'KXHEISMAN', 'Heisman Trophy', 'Awards', 'player'],
  ['americanfootball_ncaaf', 'KXNCAAFWINS', 'Regular-season win totals', 'Win totals', 'ladder'],
  ['basketball_ncaab', 'KXMARMAD', 'National champion', 'Champion', 'team', 'basketball_ncaab_championship_winner'],
  ['basketball_ncaab', 'KXNCAAMBNAISMITH', 'Naismith Player of the Year', 'Awards', 'player'],
  ['basketball_ncaab', 'KXNCAAMBCOTY', 'Naismith Coach of the Year', 'Awards', 'player'],
];

// Kalshi lists pro teams by city ("Los Angeles C"). Full names let us line them up with sportsbook futures.
const NFL_TEAMS = {
  'Arizona': 'Arizona Cardinals', 'Atlanta': 'Atlanta Falcons', 'Baltimore': 'Baltimore Ravens', 'Buffalo': 'Buffalo Bills',
  'Carolina': 'Carolina Panthers', 'Chicago': 'Chicago Bears', 'Cincinnati': 'Cincinnati Bengals', 'Cleveland': 'Cleveland Browns',
  'Dallas': 'Dallas Cowboys', 'Denver': 'Denver Broncos', 'Detroit': 'Detroit Lions', 'Green Bay': 'Green Bay Packers',
  'Houston': 'Houston Texans', 'Indianapolis': 'Indianapolis Colts', 'Jacksonville': 'Jacksonville Jaguars', 'Kansas City': 'Kansas City Chiefs',
  'Las Vegas': 'Las Vegas Raiders', 'Los Angeles C': 'Los Angeles Chargers', 'Los Angeles R': 'Los Angeles Rams', 'Miami': 'Miami Dolphins',
  'Minnesota': 'Minnesota Vikings', 'New England': 'New England Patriots', 'New Orleans': 'New Orleans Saints', 'New York G': 'New York Giants',
  'New York J': 'New York Jets', 'Philadelphia': 'Philadelphia Eagles', 'Pittsburgh': 'Pittsburgh Steelers', 'San Francisco': 'San Francisco 49ers',
  'Seattle': 'Seattle Seahawks', 'Tampa Bay': 'Tampa Bay Buccaneers', 'Tennessee': 'Tennessee Titans', 'Washington': 'Washington Commanders',
};
const NBA_TEAMS = {
  'Atlanta': 'Atlanta Hawks', 'Boston': 'Boston Celtics', 'Brooklyn': 'Brooklyn Nets', 'Charlotte': 'Charlotte Hornets',
  'Chicago': 'Chicago Bulls', 'Cleveland': 'Cleveland Cavaliers', 'Dallas': 'Dallas Mavericks', 'Denver': 'Denver Nuggets',
  'Detroit': 'Detroit Pistons', 'Golden State': 'Golden State Warriors', 'Houston': 'Houston Rockets', 'Indiana': 'Indiana Pacers',
  'Los Angeles C': 'Los Angeles Clippers', 'Los Angeles L': 'Los Angeles Lakers', 'Memphis': 'Memphis Grizzlies', 'Miami': 'Miami Heat',
  'Milwaukee': 'Milwaukee Bucks', 'Minnesota': 'Minnesota Timberwolves', 'New Orleans': 'New Orleans Pelicans', 'New York': 'New York Knicks',
  'Oklahoma City': 'Oklahoma City Thunder', 'Orlando': 'Orlando Magic', 'Philadelphia': 'Philadelphia 76ers', 'Phoenix': 'Phoenix Suns',
  'Portland': 'Portland Trail Blazers', 'Sacramento': 'Sacramento Kings', 'San Antonio': 'San Antonio Spurs', 'Toronto': 'Toronto Raptors',
  'Utah': 'Utah Jazz', 'Washington': 'Washington Wizards',
};
const teamName = (sport, label) => (sport === 'americanfootball_nfl' ? NFL_TEAMS[label] : sport === 'basketball_nba' ? NBA_TEAMS[label] : null) || label;

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/\bst\b\.?/g, 'state').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
const COLLEGE_ALIASES = { 'miami fl': 'miami hurricanes', 'miami oh': 'miami oh redhawks' };
// Words that turn one school into another ("Texas" vs "Texas Tech"), so a prefix match can't be trusted.
const QUALIFIERS = new Set(['state', 'tech', 'and', 'am', 'a', 'international', 'southern', 'northern', 'eastern', 'western', 'central', 'christian', 'atlantic', 'methodist', 'baptist', 'oh', 'fl']);

// College names differ between sources ("Ohio St." vs "Ohio State Buckeyes"). Match only when unambiguous.
function matchCollege(label, names) {
  let k = norm(label);
  k = COLLEGE_ALIASES[k] || k;
  const exact = names.filter(n => norm(n) === k);
  if (exact.length === 1) return exact[0];
  const cands = names.filter(n => {
    const nn = norm(n);
    if (!nn.startsWith(k + ' ')) return false;
    const next = nn.slice(k.length + 1).split(' ')[0];
    return !QUALIFIERS.has(next);
  });
  return cands.length === 1 ? cands[0] : null;
}

const toAm = p => { const d = 1 / p; return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); };
const dollars = v => (v == null || v === '' ? null : Number(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.ok) return { data: await res.json(), res };
    if (i >= tries || (res.status < 500 && res.status !== 429)) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
    await sleep(1000 * i);
  }
}

async function kalshiEvents(series) {
  const events = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const { data } = await getJson(`${KALSHI}/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    events.push(...(data.events || []));
    cursor = data.cursor;
    if (!cursor || !(data.events || []).length) break;
    await sleep(150);
  }
  return events;
}

// A Kalshi price only counts when someone is bidding and the bid/ask spread is tight (otherwise it's a stale quote).
function liveAsk(m, { lo = 0.005, hi = 0.995 } = {}) {
  if (m.status !== 'active') return null;
  const ask = dollars(m.yes_ask_dollars ?? (m.yes_ask != null ? m.yes_ask / 100 : null));
  const bid = dollars(m.yes_bid_dollars ?? (m.yes_bid != null ? m.yes_bid / 100 : null));
  if (!(ask > 0 && ask < 1) || !(bid > 0) || ask - bid > 0.10 + 1e-9) return null;
  if (ask < lo || ask > hi) return null;
  return ask;
}

async function kalshiMarket([sport, series, title, group, type]) {
  const events = await kalshiEvents(series);
  if (!events.length) return null;
  const link = `https://kalshi.com/markets/${series.toLowerCase()}`;
  const outcomes = [];
  let season = null;
  if (type === 'ladder') {
    for (const ev of events) {
      const m = /:\s*(.+?)\s+(?:Total|Regular Season)\s+Wins/i.exec(ev.title || '');
      const label = m ? m[1] : (ev.sub_title || '').replace(/\s*\(?\d{4}(-\d{2})?\)?\s*$/, '');
      if (!label) continue;
      season = season || (/(\d{4}(?:-\d{2})?)/.exec(ev.sub_title || '') || [])[1] || null;
      const team = teamName(sport, label);
      const strikes = (ev.markets || [])
        .map(mk => ({ n: Number(mk.floor_strike), ask: liveAsk(mk, { lo: 0.08, hi: 0.92 }), type: mk.strike_type }))
        .filter(x => x.ask != null && Number.isFinite(x.n) && x.type === 'greater_or_equal')
        .sort((a, b) => a.n - b.n);
      // Chance of "at least N wins" must fall as N rises; drop quotes that break that (thin markets).
      const clean = [];
      for (const s of strikes) if (!clean.length || s.ask < clean[clean.length - 1].ask) clean.push(s);
      clean.sort((a, b) => Math.abs(a.ask - 0.5) - Math.abs(b.ask - 0.5));
      for (const s of clean.slice(0, 4).sort((a, b) => a.n - b.n)) {
        outcomes.push({ name: `${team} ${s.n}+ wins`, team, strike: s.n, prices: { kalshi: toAm(s.ask) } });
      }
    }
  } else {
    const ev = events.sort((a, b) => (a.event_ticker || '').localeCompare(b.event_ticker || ''))[0];
    season = (/(\d{4}(?:-\d{2})?)/.exec(ev.sub_title || '') || [])[1] || null;
    for (const mk of ev.markets || []) {
      const ask = liveAsk(mk);
      if (ask == null || !mk.yes_sub_title) continue;
      const name = type === 'team' ? teamName(sport, mk.yes_sub_title) : mk.yes_sub_title;
      outcomes.push({ name, prices: { kalshi: toAm(ask) } });
    }
  }
  if (!outcomes.length) return null;
  return { id: `${sport}:${series}`, sport, series, title, group, type, season, links: { kalshi: link }, outcomes };
}

async function fetchOutrights(prev, notes) {
  const raw = {};
  const now = Date.now();
  const last = prev?.books_at ? new Date(prev.books_at).getTime() : 0;
  const due = MODE === 'futures' || now - last > OUTRIGHT_EVERY_H * 3600e3;
  if (!API_KEY || !due) return { raw: prev?.books_raw || {}, at: prev?.books_at || null, quota: null };
  const q = u => `${API_BASE}${u}${u.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(API_KEY)}`;
  let quota = null;
  const { data: sports, res } = await getJson(q('/v4/sports')); // free
  const rem = Number(res.headers.get('x-requests-remaining'));
  if (Number.isFinite(rem)) quota = { remaining: rem };
  const keys = sports.filter(s => s.has_outrights && SPORT_PREFIXES.some(p => s.key.startsWith(p + '_'))).map(s => ({ key: s.key, title: s.title }));
  let left = Number.isFinite(rem) ? rem : 0;
  for (const s of keys.slice(0, MAX_OUTRIGHTS)) {
    if (left - 1 < OUTRIGHT_RESERVE) { notes.push(`Sportsbook futures not refreshed: ${left} API credits left this month.`); break; }
    try {
      const { data, res: r2 } = await getJson(q(`/v4/sports/${s.key}/odds?markets=outrights&oddsFormat=american&includeLinks=true&bookmakers=${BOOKMAKERS.join(',')}`), 1);
      left = Number(r2.headers.get('x-requests-remaining')) || left - 1;
      quota = { remaining: left, used: Number(r2.headers.get('x-requests-used')) || null };
      const out = { title: s.title, outcomes: {}, links: {} };
      for (const ev of data || []) for (const b of ev.bookmakers || []) for (const m of b.markets || []) {
        if (m.key !== 'outrights') continue;
        for (const o of m.outcomes || []) {
          (out.outcomes[o.name] ||= {})[b.key] = o.price;
          if (o.link) (out.links[o.name] ||= {})[b.key] = o.link;
        }
      }
      raw[s.key] = out;
      console.log(`Outrights ${s.key}: ${Object.keys(out.outcomes).length} outcomes (remaining ${left})`);
    } catch (err) {
      console.error(`Outrights ${s.key}: ${err.message}`);
      notes.push(`${s.title} sportsbook futures failed to update.`);
      if (prev?.books_raw?.[s.key]) raw[s.key] = prev.books_raw[s.key];
    }
  }
  return { raw, at: new Date().toISOString(), quota };
}

// Put sportsbook prices next to Kalshi's for the same market (by team name).
function combine(markets, raw) {
  const used = new Set();
  for (const mk of markets) {
    const key = SERIES.find(s => s[1] === mk.series)?.[5];
    const book = key && raw[key];
    if (!book) continue;
    used.add(key);
    const names = Object.keys(book.outcomes);
    const matched = new Set();
    for (const o of mk.outcomes) {
      const hit = names.includes(o.name) ? o.name : COLLEGE.has(mk.sport) ? matchCollege(o.name, names) : null;
      if (!hit || matched.has(hit)) continue;
      matched.add(hit);
      const direct = o.prices.kalshi; // Kalshi's own feed is fresher than the weekly sportsbook snapshot
      o.name = hit;
      Object.assign(o.prices, book.outcomes[hit]);
      if (direct != null) o.prices.kalshi = direct;
      if (book.links[hit]) o.links = book.links[hit];
    }
    for (const n of names) {
      if (matched.has(n)) continue;
      mk.outcomes.push({ name: n, prices: { ...book.outcomes[n] }, ...(book.links[n] ? { links: book.links[n] } : {}) });
    }
  }
  // Sportsbook futures with no Kalshi twin get their own market.
  for (const [key, book] of Object.entries(raw)) {
    if (used.has(key)) continue;
    const sport = SPORT_PREFIXES.find(p => key.startsWith(p + '_'));
    const outcomes = Object.entries(book.outcomes).map(([name, prices]) => ({ name, prices: { ...prices }, ...(book.links[name] ? { links: book.links[name] } : {}) }));
    if (outcomes.length) markets.push({ id: `${sport}:${key}`, sport, series: null, title: book.title, group: 'Champion', type: 'team', season: null, links: {}, outcomes });
  }
  return markets;
}

async function main() {
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
  const notes = [];
  const markets = [];
  let kalshiOk = 0;
  for (const s of SERIES) {
    try {
      const m = await kalshiMarket(s);
      if (m) { markets.push(m); kalshiOk++; }
    } catch (err) {
      console.error(`Kalshi ${s[1]}: ${err.message}`);
      // Keep yesterday's numbers for this market rather than dropping it.
      const old = prev?.markets?.find(x => x.id === `${s[0]}:${s[1]}`);
      if (old) markets.push({ ...old, outcomes: old.outcomes.map(o => ({ ...o, prices: o.prices.kalshi != null ? { kalshi: o.prices.kalshi } : {} })).filter(o => Object.keys(o.prices).length) });
    }
    await sleep(120);
  }
  console.log(`Kalshi: ${kalshiOk} markets`);

  let books = { raw: prev?.books_raw || {}, at: prev?.books_at || null, quota: null };
  try { books = await fetchOutrights(prev, notes); } catch (err) { console.error(`Outrights: ${err.message}`); notes.push('Sportsbook futures failed to update.'); }

  const out = {
    generated_at: new Date().toISOString(),
    kalshi_at: kalshiOk ? new Date().toISOString() : prev?.kalshi_at || null,
    books_at: books.at,
    quota: books.quota,
    notes,
    markets: combine(markets, books.raw),
    books_raw: books.raw,
  };
  for (const m of out.markets) {
    if (m.type === 'ladder') m.outcomes.sort((a, b) => a.team.localeCompare(b.team) || a.strike - b.strike);
    else m.outcomes.sort((a, b) => best(b) - best(a));
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT}: ${out.markets.length} markets`);
}
// Highest implied chance first (favorites at the top).
const best = o => Math.max(...Object.values(o.prices).map(a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100))));

main().catch(err => { console.error(err); process.exit(1); });
