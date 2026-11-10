/* Pure odds helpers shared by the site (main.js) and the GitHub Action that checks line-move alerts
   (scripts/check-alerts.mjs). No DOM, no network. */

export const toDec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
export const toAm = d => (d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)));
export const fmtAm = a => (a > 0 ? `+${a}` : `${a}`);
export const fmtPt = p => (p > 0 ? `+${p}` : `${p}`);
export const implied = a => 1 / toDec(a);

export const BOOK_TITLES = {
  draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', espnbet: 'theScore Bet', betrivers: 'BetRivers',
  hardrockbet: 'Hard Rock Bet', kalshi: 'Kalshi', polymarket_us: 'Polymarket', polymarket: 'Polymarket', novig: 'Novig', prophetx: 'ProphetX',
};
export const EXCHANGES = new Set(['kalshi', 'polymarket_us', 'polymarket', 'novig', 'prophetx', 'betopenly', 'limitless']);

export const MARKET_LABELS = {
  player_pass_yds: 'Pass Yds', player_rush_yds: 'Rush Yds', player_reception_yds: 'Rec Yds',
  player_receptions: 'Receptions', player_pass_tds: 'Pass TDs', player_anytime_td: 'Anytime TD',
  player_points: 'Points', player_rebounds: 'Rebounds', player_assists: 'Assists', player_threes: 'Threes',
  player_points_rebounds_assists: 'Pts+Reb+Ast',
  player_shots_on_goal: 'Shots on Goal', player_goal_scorer_anytime: 'Anytime Goal',
};
export const isProp = mk => mk.startsWith('player_');
export const mLabel = mk => MARKET_LABELS[mk] || mk.replace(/^player_/, '').replace(/_/g, ' ');

export function legLabel(leg) {
  if (isProp(leg.market)) {
    if (leg.point == null) return `${leg.desc} ${mLabel(leg.market)}${leg.name === 'Yes' ? '' : ` (${leg.name})`}`;
    return `${leg.desc} ${leg.name === 'Over' ? 'o' : 'u'}${leg.point} ${mLabel(leg.market)}`;
  }
  if (leg.market === 'h2h') return `${leg.name} ML`;
  if (leg.market === 'spreads') return `${leg.name} ${fmtPt(leg.point)}`;
  return `${leg.name} ${leg.point}`;
}

// Kalshi's trading fee is about 7% x P x (1 - P) per $1 contract (P = price), so the real cost of a contract is
// a little above the quoted price. Other exchanges' fees aren't modeled; the site labels them "before fees".
export const KALSHI_FEE = 0.07;
export function effDec(bk, price) {
  const d = toDec(price);
  if (bk !== 'kalshi') return d;
  const p = 1 / d;
  return 1 / (p + KALSHI_FEE * p * (1 - p));
}

const same = (o, name, desc) => o.name === name && (o.desc || null) === (desc || null);

// Best price for one side at an exact line (any line when point is null), across the given books.
export function bestOffer(ev, spec, books) {
  let best = null;
  for (const [bk, b] of Object.entries(ev.books || {})) {
    if (books && !books.has(bk)) continue;
    for (const o of b.markets?.[spec.market] || []) {
      if (!same(o, spec.name, spec.desc)) continue;
      if (spec.point != null && o.point !== spec.point) continue;
      if (!best || toDec(o.price) > toDec(best.price)) best = { price: o.price, point: o.point ?? null, bk, link: o.link || null };
    }
  }
  return best;
}

// The line most books are hanging for this side (exchanges' ladders count once per book).
export function consensusPoint(ev, spec, books) {
  const count = new Map();
  for (const [bk, b] of Object.entries(ev.books || {})) {
    if (books && !books.has(bk)) continue;
    const pts = new Set();
    for (const o of b.markets?.[spec.market] || []) if (same(o, spec.name, spec.desc) && o.point != null) pts.add(o.point);
    if (pts.size !== 1) continue;            // books listing several lines (alt ladders) don't vote
    const p = [...pts][0];
    count.set(p, (count.get(p) || 0) + 1);
  }
  let best = null;
  for (const [p, n] of count) if (!best || n > best.n) best = { point: p, n };
  return best;
}

// ---------- two-way pairs (both sides of one bet) ----------
// Returns a key shared by both sides and which side ('A' or 'B') an outcome is.
export function pairOf(ev, mk, o) {
  if (mk === 'h2h') {
    if (o.name === ev.home) return { key: 'h2h', side: 'A' };
    if (o.name === ev.away) return { key: 'h2h', side: 'B' };
    return null;
  }
  if (o.point == null && (mk === 'spreads' || mk === 'totals')) return null;
  if (mk === 'spreads') {
    if (o.name === ev.home) return { key: `spreads|${o.point}`, side: 'A' };
    if (o.name === ev.away) return { key: `spreads|${-o.point}`, side: 'B' };
    return null;
  }
  if (mk === 'totals') {
    if (o.name === 'Over') return { key: `totals|${o.point}`, side: 'A' };
    if (o.name === 'Under') return { key: `totals|${o.point}`, side: 'B' };
    return null;
  }
  if (isProp(mk) && o.desc) {
    const base = `${mk}|${o.desc}|${o.point ?? ''}`;
    if (o.name === 'Over' || o.name === 'Yes') return { key: base, side: 'A' };
    if (o.name === 'Under' || o.name === 'No') return { key: base, side: 'B' };
  }
  return null;
}

function collectPairs(ev, allowed) {
  const pairs = new Map();
  for (const [bk, b] of Object.entries(ev.books || {})) {
    if (allowed && !allowed.has(bk)) continue;
    for (const [mk, outs] of Object.entries(b.markets || {})) {
      for (const o of outs) {
        if (!Number.isFinite(o.price) || Math.abs(o.price) < 100) continue;
        const pr = pairOf(ev, mk, o);
        if (!pr) continue;
        const k = `${mk}::${pr.key}`;
        if (!pairs.has(k)) pairs.set(k, { mk, A: [], B: [], byBook: new Map() });
        const p = pairs.get(k);
        const offer = { bk, price: o.price, name: o.name, desc: o.desc || null, point: o.point ?? null, link: o.link || null, eff: effDec(bk, o.price) };
        if (p[pr.side].some(x => x.bk === bk)) continue;      // one quote per book per side
        p[pr.side].push(offer);
        const bb = p.byBook.get(bk) || {};
        bb[pr.side] = offer;
        p.byBook.set(bk, bb);
      }
    }
  }
  return pairs;
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Sure things: back both sides at different books and win the same amount either way.
export function findArbs(events, allowed, { now = Date.now(), maxProfit = 0.10, minProfit = 0.0005 } = {}) {
  const out = [];
  for (const ev of events) {
    if (new Date(ev.commence_time).getTime() <= now) continue;
    for (const p of collectPairs(ev, allowed).values()) {
      if (!p.A.length || !p.B.length) continue;
      // Ignore quotes far from everyone else's (usually stale or a different market wearing the same name).
      const sane = side => {
        if (side.length < 3) return side;
        const med = median(side.map(o => 1 / o.eff));
        return side.filter(o => Math.abs(1 / o.eff - med) <= 0.10);
      };
      const A = sane(p.A).sort((x, y) => y.eff - x.eff), B = sane(p.B).sort((x, y) => y.eff - x.eff);
      if (!A.length || !B.length) continue;
      let pick = null;
      for (const a of A.slice(0, 2)) for (const b of B.slice(0, 2)) {
        if (a.bk === b.bk) continue;
        const sum = 1 / a.eff + 1 / b.eff;
        if (!pick || sum < pick.sum) pick = { a, b, sum };
      }
      if (!pick || pick.sum >= 1) continue;
      const profit = 1 / pick.sum - 1;
      if (profit < minProfit || profit > maxProfit) continue;
      if ([pick.a, pick.b].some(o => o.price < -2000 || o.price > 2000)) continue;
      out.push({ ev, mk: p.mk, sides: [pick.a, pick.b], sum: pick.sum, profit });
    }
  }
  return out.sort((x, y) => y.profit - x.profit);
}

// How to split a total stake so both sides return the same amount.
export function arbStakes(sides, total) {
  const inv = sides.map(s => 1 / s.eff);
  const sum = inv.reduce((a, b) => a + b, 0);
  const stakes = inv.map(x => Math.round((total * x / sum) * 100) / 100);
  const returns = sides.map((s, i) => stakes[i] * s.eff);
  const spent = stakes.reduce((a, b) => a + b, 0);
  return { stakes, minReturn: Math.min(...returns), profit: Math.min(...returns) - spent, spent };
}

// Value: a price better than the fair (no-vig) price, where fair = median of each book's own no-vig price.
export function findValue(events, allowed, { now = Date.now(), minEdge = 0.02, maxEdge = 0.25, minBooks = 4 } = {}) {
  const out = [];
  for (const ev of events) {
    if (new Date(ev.commence_time).getTime() <= now) continue;
    for (const p of collectPairs(ev, allowed).values()) {
      const fairA = [];
      for (const q of p.byBook.values()) {
        if (!q.A || !q.B) continue;
        const ia = 1 / toDec(q.A.price), ib = 1 / toDec(q.B.price);
        if (ia + ib < 0.97 || ia + ib > 1.25) continue;      // not a normal two-way market
        fairA.push(ia / (ia + ib));
      }
      if (fairA.length < minBooks) continue;
      const pA = median(fairA);
      let best = null;
      for (const [side, prob] of [['A', pA], ['B', 1 - pA]]) {
        for (const o of p[side]) {
          const edge = prob * o.eff - 1;
          if (!best || edge > best.edge) best = { offer: o, edge, fair: prob, books: fairA.length };
        }
      }
      if (best && best.edge >= minEdge && best.edge <= maxEdge && Math.abs(best.offer.price) <= 1000) {
        out.push({ ev, mk: p.mk, ...best, fairAm: toAm(1 / best.fair) });
      }
    }
  }
  return out.sort((x, y) => y.edge - x.edge);
}

// ---------- line-move alerts ----------
// alert: { spec: {market, name, desc, point}, mode: 'target' | 'move', target, base_price, base_point, books: [...] }
// Returns null (nothing to send) or { price, point, book, message }.
export function checkAlert(alert, ev) {
  if (!ev) return null;
  const spec = alert.spec;
  const books = alert.books?.length ? new Set(alert.books) : null;
  const name = bk => BOOK_TITLES[bk] || bk;
  const best = bestOffer(ev, spec, books);
  if (alert.mode === 'target') {
    if (!best || alert.target == null) return null;
    if (toDec(best.price) + 1e-9 < toDec(alert.target)) return null;
    return { price: best.price, point: best.point, book: best.bk,
      message: `${legLabel(spec)} is ${fmtAm(best.price)} at ${name(best.bk)} (your target was ${fmtAm(alert.target)}).` };
  }
  // 'move': the line itself moved, or the best price moved by 2.5+ points of implied probability.
  if (spec.point != null) {
    const cons = consensusPoint(ev, spec, books);
    if (cons && cons.point !== spec.point) {
      const now = bestOffer(ev, { ...spec, point: cons.point }, books);
      return { price: now?.price ?? null, point: cons.point, book: now?.bk ?? null,
        message: `Line moved: ${legLabel(spec)} is now ${legLabel({ ...spec, point: cons.point })}${now ? ` (best ${fmtAm(now.price)} at ${name(now.bk)})` : ''}.` };
    }
  }
  if (best && alert.base_price != null && Math.abs(implied(best.price) - implied(alert.base_price)) >= 0.025) {
    const better = toDec(best.price) > toDec(alert.base_price);
    return { price: best.price, point: best.point, book: best.bk,
      message: `${legLabel(spec)} ${better ? 'got better' : 'got worse'}: ${fmtAm(alert.base_price)} → ${fmtAm(best.price)} at ${name(best.bk)}.` };
  }
  return null;
}
