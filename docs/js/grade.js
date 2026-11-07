/* Grades saved bets against final scores and box scores from ESPN's public scoreboard feed.
   Pure functions plus one runner that takes a fetch function, so it can be tested without a browser.
   Rule of thumb: when anything is uncertain (team or player not found, game postponed), the leg is
   marked "review" instead of guessing. The bettor can then settle it by hand. */

export const LEAGUE_PATH = {
  americanfootball_nfl: 'football/nfl',
  americanfootball_ncaaf: 'football/college-football',
  basketball_nba: 'basketball/nba',
  basketball_ncaab: 'basketball/mens-college-basketball',
};
// ESPN only lists ranked/featured college games unless you ask for all of Division I.
const BOARD_EXTRA = { americanfootball_ncaaf: '&groups=80&limit=300', basketball_ncaab: '&groups=50&limit=400' };
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
export const FINAL = new Set(['won', 'lost', 'push', 'void']);

export const norm = s => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[-/]/g, ' ').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
export const normPlayer = s => norm(s).replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();

// YYYYMMDD in US Eastern time (the calendar ESPN's scoreboard uses).
export function etDate(iso, offsetDays = 0) {
  const d = new Date(new Date(iso).getTime() + offsetDays * 864e5);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = t => parts.find(p => p.type === t).value;
  return g('year') + g('month') + g('day');
}

// 2 = same team name, 1 = same nickname (e.g. "Warhawks"), 0 = different team.
export function teamScore(oddsName, competitor) {
  const a = norm(oddsName);
  const t = competitor?.team || {};
  if (!a) return 0;
  if (a === norm(t.displayName) || a === norm(`${t.location || ''} ${t.name || ''}`)) return 2;
  const nick = norm(t.name);
  if (nick && a.endsWith(' ' + nick)) return 1;
  return 0;
}

// Find the ESPN game for a leg: both teams must match (at least one by full name) within 36 hours of kickoff.
export function findGame(events, leg) {
  const start = new Date(leg.commence).getTime();
  let best = null;
  for (const ev of events || []) {
    const t = new Date(ev.date).getTime();
    if (!Number.isFinite(t) || Math.abs(t - start) > 36 * 3600e3) continue;
    const comps = ev.competitions?.[0]?.competitors || [];
    if (comps.length !== 2) continue;
    for (const [h, a] of [[comps[0], comps[1]], [comps[1], comps[0]]]) {
      const sh = teamScore(leg.home, h), sa = teamScore(leg.away, a);
      if (!sh || !sa || sh + sa < 3) continue;
      const score = sh + sa - Math.abs(t - start) / 864e5;
      if (!best || score > best.score) best = { ev, home: h, away: a, score };
    }
  }
  return best;
}

// 'final' | 'pending' | 'review' (postponed, cancelled, suspended)
export function gameState(ev) {
  const type = ev.competitions?.[0]?.status?.type || ev.status?.type || {};
  const name = String(type.name || '');
  if (type.completed && /FINAL/.test(name)) return 'final';
  if (/POSTPONED|CANCEL|SUSPENDED|FORFEIT|DELAYED/.test(name)) return 'review';
  return 'pending';
}

const r = (status, why) => (why ? { status, why } : { status });

// Moneyline, spread and total legs.
export function gradeGameLeg(leg, match) {
  const hs = Number(match.home.score), as = Number(match.away.score);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return r('review', 'Final score missing');
  const side = leg.name === leg.home ? 'home' : leg.name === leg.away ? 'away' : null;
  if (leg.market === 'totals') {
    if (leg.point == null) return r('review', 'No total on this leg');
    const tot = hs + as;
    if (tot === leg.point) return r('push', `Total ${tot}`);
    const over = tot > leg.point;
    if (leg.name === 'Over') return r(over ? 'won' : 'lost', `Total ${tot}`);
    if (leg.name === 'Under') return r(over ? 'lost' : 'won', `Total ${tot}`);
    return r('review', 'Unknown side');
  }
  if (!side) return r('review', 'Team not in this game');
  const us = side === 'home' ? hs : as, them = side === 'home' ? as : hs;
  const final = `${leg.away} ${as}, ${leg.home} ${hs}`;
  if (leg.market === 'h2h') {
    if (us === them) return r('push', `Tie: ${final}`);
    return r(us > them ? 'won' : 'lost', final);
  }
  if (leg.market === 'spreads') {
    if (leg.point == null) return r('review', 'No spread on this leg');
    const m = us + leg.point - them;
    if (m === 0) return r('push', final);
    return r(m > 0 ? 'won' : 'lost', final);
  }
  return r('review', 'Market not graded automatically');
}

// ---------- box scores ----------
// Map of normalized player name -> { dnp, nfl: {passing:{YDS,TD}, ...} | nba: {points, ...} }
export function parseBox(summary, sportKey) {
  const out = new Map();
  for (const team of summary?.boxscore?.players || []) {
    for (const cat of team.statistics || []) {
      const labels = cat.labels || [];
      const keys = cat.keys || [];
      for (const a of cat.athletes || []) {
        const nm = normPlayer(a.athlete?.displayName);
        if (!nm) continue;
        const p = out.get(nm) || { name: a.athlete.displayName, dnp: true, cats: {} };
        const stats = a.stats || [];
        if (!a.didNotPlay && stats.length) p.dnp = false;
        if (sportKey.startsWith('basketball')) {
          const at = k => stats[keys.indexOf(k)];
          if (stats.length && keys.length) {
            const threes = String(at('threePointFieldGoalsMade-threePointFieldGoalsAttempted') ?? '').split('-')[0];
            p.cats.nba = { points: +at('points'), rebounds: +at('rebounds'), assists: +at('assists'), threes: +threes };
          }
        } else if (stats.length) {
          const vals = {};
          labels.forEach((l, i) => { vals[l] = Number(stats[i]); });
          p.cats[cat.name] = vals;
        }
        out.set(nm, p);
      }
    }
  }
  return out;
}

const NFL_STAT = {
  player_pass_yds: ['passing', 'YDS'], player_pass_tds: ['passing', 'TD'], player_rush_yds: ['rushing', 'YDS'],
  player_reception_yds: ['receiving', 'YDS'], player_receptions: ['receiving', 'REC'],
};
const NBA_STAT = {
  player_points: n => n.points, player_rebounds: n => n.rebounds, player_assists: n => n.assists,
  player_threes: n => n.threes, player_points_rebounds_assists: n => n.points + n.rebounds + n.assists,
};

export function statValue(p, market, sportKey) {
  if (sportKey.startsWith('basketball')) {
    const f = NBA_STAT[market];
    return f && p.cats.nba ? f(p.cats.nba) : null;
  }
  if (market === 'player_anytime_td') return (p.cats.rushing?.TD || 0) + (p.cats.receiving?.TD || 0);
  const spec = NFL_STAT[market];
  if (!spec) return null;
  return p.cats[spec[0]]?.[spec[1]] ?? 0; // listed in the box score but not in this category = 0
}

export function gradePropLeg(leg, box, sportKey) {
  const p = box.get(normPlayer(leg.desc));
  if (!p) return r('review', `${leg.desc} isn't in the box score`);
  if (p.dnp) return r('void', `${leg.desc} did not play`);
  const v = statValue(p, leg.market, sportKey);
  if (v == null || !Number.isFinite(v)) return r('review', 'Stat not available');
  if (leg.name === 'Yes') return r(v >= 1 ? 'won' : 'lost', `${v}`);
  if (leg.name === 'No') return r(v >= 1 ? 'lost' : 'won', `${v}`);
  if (leg.point == null) return r('review', 'No line on this leg');
  if (v === leg.point) return r('push', `${v}`);
  const over = v > leg.point;
  if (leg.name === 'Over') return r(over ? 'won' : 'lost', `${v}`);
  if (leg.name === 'Under') return r(over ? 'lost' : 'won', `${v}`);
  return r('review', 'Unknown side');
}

// ---------- settling a whole bet ----------
const toDec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);

// Returns { status, payout } from leg results. Pushes and voids drop out of a parlay.
export function settle(bet) {
  const legs = bet.legs || [];
  const st = legs.map(l => l.result?.status || 'open');
  if (st.includes('lost')) return { status: 'lost', payout: 0 };
  if (st.some(s => !FINAL.has(s))) return { status: 'open', payout: null };
  const live = legs.filter((l, i) => st[i] === 'won');
  if (!live.length) return { status: 'push', payout: bet.stake };
  const full = legs.reduce((d, l) => d * toDec(l.price), 1);
  const kept = live.reduce((d, l) => d * toDec(l.price), 1);
  // If the bettor entered their own total odds (e.g. a same-game parlay), scale it by the legs that still count.
  const total = bet.oddsEdited && bet.odds != null ? toDec(bet.odds) * (kept / full) : kept;
  return { status: 'won', payout: round2(bet.stake * total) };
}
const round2 = n => Math.round(n * 100) / 100;

// ---------- runner ----------
// Grades every open game/prop leg whose game should be over. Mutates bets in place; returns true if anything changed.
export async function gradeBets(bets, getJson, now = Date.now()) {
  const boards = new Map(), summaries = new Map();
  const board = async (sport, day) => {
    const k = `${sport}|${day}`;
    if (!boards.has(k)) {
      const extra = BOARD_EXTRA[sport] || '';
      boards.set(k, getJson(`${ESPN}${LEAGUE_PATH[sport]}/scoreboard?dates=${day}${extra}`).then(d => d.events || []).catch(() => null));
    }
    return boards.get(k);
  };
  const summary = async (sport, id) => {
    const k = `${sport}|${id}`;
    if (!summaries.has(k)) summaries.set(k, getJson(`${ESPN}${LEAGUE_PATH[sport]}/summary?event=${id}`).then(d => parseBox(d, sport)).catch(() => null));
    return summaries.get(k);
  };

  let changed = false;
  for (const bet of bets) {
    if (bet.deleted || bet.manual) continue;
    let betChanged = false;
    for (const leg of bet.legs || []) {
      if (leg.t !== 'game' && leg.t !== 'prop') continue;
      if (FINAL.has(leg.result?.status)) continue;
      if (!LEAGUE_PATH[leg.sport]) continue;
      const start = new Date(leg.commence).getTime();
      if (!(now - start > 2.5 * 3600e3)) continue;           // give the game time to finish
      if (now - start > 21 * 864e5) continue;                // stop looking after three weeks
      let match = null, ok = false;
      for (const off of [0, -1, 1]) {
        const evs = await board(leg.sport, etDate(leg.commence, off));
        if (evs) ok = true;
        match = evs && findGame(evs, leg);
        if (match) break;
      }
      if (!ok) continue;                                      // network problem: try again later
      let res;
      if (!match) {
        res = now - start > 2 * 864e5 ? r('review', "Couldn't find this game's result") : null;
      } else {
        const state = gameState(match.ev);
        if (state === 'pending') res = null;
        else if (state === 'review') res = r('review', 'Game postponed or cancelled. Check your book');
        else if (leg.t === 'game') res = gradeGameLeg(leg, match);
        else {
          const box = await summary(leg.sport, match.ev.id);
          if (!box) continue;
          res = gradePropLeg(leg, box, leg.sport);
        }
      }
      if (res && (res.status !== leg.result?.status || res.why !== leg.result?.why)) {
        leg.result = { ...res, at: new Date(now).toISOString() };
        betChanged = true;
      }
    }
    const s = settle(bet);
    if (s.status !== bet.status || s.payout !== bet.payout) {
      bet.status = s.status;
      bet.payout = s.payout;
      bet.settledAt = s.status === 'open' ? null : new Date(now).toISOString();
      betChanged = true;
    }
    if (betChanged) { bet.updated = now; changed = true; }
  }
  return changed;
}
