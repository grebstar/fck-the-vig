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
