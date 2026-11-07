/* Saved bets: stored in this browser, and synced to an account when signed in.
   Deleted bets are kept as small tombstones so a delete on one device reaches the others. */

const KEY = 'ftv-bets';
const MAX_BETS = 1000;

export function loadBets() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(b => b && typeof b.id === 'string') : [];
  } catch { return []; }
}
export function saveBets(bets) {
  try { localStorage.setItem(KEY, JSON.stringify(bets)); return true; } catch { return false; }
}

export const newId = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Newest version of each bet wins (by `updated`).
export function mergeBets(a, b) {
  const map = new Map();
  for (const bet of [...(a || []), ...(b || [])]) {
    if (!bet || typeof bet.id !== 'string') continue;
    const cur = map.get(bet.id);
    if (!cur || (bet.updated || 0) > (cur.updated || 0)) map.set(bet.id, bet);
  }
  return [...map.values()].sort((x, y) => (y.created || '').localeCompare(x.created || '')).slice(0, MAX_BETS);
}

export const visible = bets => bets.filter(b => !b.deleted);

export function tombstone(bet) {
  return { id: bet.id, deleted: true, created: bet.created, updated: Date.now() };
}

const toDec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);

// Record and profit across settled bets that were actually placed (not just watched).
export function summarize(bets) {
  const s = { won: 0, lost: 0, push: 0, open: 0, staked: 0, returned: 0, profit: 0, toWin: 0 };
  for (const b of visible(bets)) {
    if (!b.placed) continue;
    if (b.status === 'open') {
      s.open++;
      s.toWin += b.stake * (b.odds != null ? toDec(b.odds) : 1) - b.stake;
      continue;
    }
    if (b.status === 'won') s.won++;
    else if (b.status === 'lost') s.lost++;
    else s.push++;
    s.staked += b.stake;
    s.returned += b.payout || 0;
  }
  s.profit = s.returned - s.staked;
  s.roi = s.staked ? (s.profit / s.staked) * 100 : null;
  return s;
}

// ---------- breakdowns ----------
export const SPORT_LABELS = {
  americanfootball_nfl: 'NFL', basketball_nba: 'NBA',
  americanfootball_ncaaf: 'College Football', basketball_ncaab: 'College Basketball',
};
const TYPE_LABELS = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total', prop: 'Player props', parlay: 'Parlays', future: 'Futures' };

export function betSport(b) {
  const sports = new Set((b.legs || []).map(l => l.sport).filter(Boolean));
  if (sports.size !== 1) return 'Mixed sports';
  const s = [...sports][0];
  return SPORT_LABELS[s] || s;
}
export function betType(b) {
  if (b.kind === 'future' || b.legs?.[0]?.t === 'future') return TYPE_LABELS.future;
  if ((b.legs || []).length > 1) return TYPE_LABELS.parlay;
  const l = b.legs?.[0];
  if (!l) return 'Other';
  if (l.t === 'prop') return TYPE_LABELS.prop;
  return TYPE_LABELS[l.market] || 'Other';
}

function tally(rows, keyOf) {
  const map = new Map();
  for (const b of rows) {
    const k = keyOf(b);
    const r = map.get(k) || { key: k, won: 0, lost: 0, push: 0, staked: 0, returned: 0, bets: 0 };
    r.bets++;
    if (b.status === 'won') r.won++; else if (b.status === 'lost') r.lost++; else r.push++;
    r.staked += b.stake;
    r.returned += b.payout || 0;
    map.set(k, r);
  }
  return [...map.values()].map(r => ({ ...r, profit: r.returned - r.staked, roi: r.staked ? ((r.returned - r.staked) / r.staked) * 100 : null }))
    .sort((a, b) => b.bets - a.bets || a.key.localeCompare(b.key));
}

// Settled, placed bets grouped by sport and by bet type, plus a hit rate for every player-prop leg
// (including legs inside parlays) by stat and by over/under.
export function breakdown(bets, propLabel = m => m) {
  const settled = visible(bets).filter(b => b.placed && b.status !== 'open');
  const props = new Map();
  const sides = { Over: { won: 0, lost: 0 }, Under: { won: 0, lost: 0 }, Yes: { won: 0, lost: 0 } };
  for (const b of visible(bets)) {
    if (!b.placed) continue;
    for (const l of b.legs || []) {
      if (l.t !== 'prop') continue;
      const st = l.result?.status;
      if (st !== 'won' && st !== 'lost') continue;
      const k = propLabel(l.market);
      const r = props.get(k) || { key: k, won: 0, lost: 0 };
      r[st]++;
      props.set(k, r);
      if (sides[l.name]) sides[l.name][st]++;
    }
  }
  const rate = r => (r.won + r.lost ? (r.won / (r.won + r.lost)) * 100 : null);
  return {
    count: settled.length,
    bySport: tally(settled, betSport),
    byType: tally(settled, betType),
    props: [...props.values()].map(r => ({ ...r, rate: rate(r) })).sort((a, b) => (b.won + b.lost) - (a.won + a.lost)),
    sides: Object.entries(sides).filter(([, r]) => r.won + r.lost).map(([k, r]) => ({ key: k === 'Yes' ? 'Yes (to score)' : `${k}s`, ...r, rate: rate(r) })),
  };
}
