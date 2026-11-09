/* Builds docs/data/gaps.json: the biggest price differences between sportsbooks on the same bet,
   for games starting soon. A small, plain-JSON summary that bots and agents can read without
   running the site's JavaScript (the full odds.json is ~70 KB). No network, no API credits. */
import { readFileSync, writeFileSync } from 'node:fs';
import { toDec, implied, fmtAm, fmtPt, BOOK_TITLES, EXCHANGES } from '../docs/js/odds-math.js';

const IN = process.env.ODDS_FILE || 'docs/data/odds.json';
const OUT = process.env.GAPS_FILE || 'docs/data/gaps.json';
const WINDOW_HOURS = Number(process.env.GAPS_WINDOW_HOURS || 36);
const TOP = Number(process.env.GAPS_TOP || 10);
const MIN_BOOKS = 3;
const MAX_ODDS = 400; // skip long shots and heavy favorites (beyond +400 / -400): big dollar gaps there are noise
const MARKETS = ['h2h', 'spreads', 'totals']; // game lines only; exchanges excluded (their prices are before fees)

// Profit on a $100 bet at American odds.
export const profit100 = a => Math.round((toDec(a) - 1) * 10000) / 100;

export function buildGaps(odds, now = Date.now()) {
  const gaps = [];
  for (const sport of odds.sports || []) {
    for (const ev of sport.events || []) {
      const start = Date.parse(ev.commence_time);
      if (!(start > now && start - now <= WINDOW_HOURS * 3600e3)) continue;
      for (const mk of MARKETS) {
        const sides = new Map(); // "name|point" -> [{bk, price}]
        for (const [bk, b] of Object.entries(ev.books || {})) {
          if (EXCHANGES.has(bk)) continue;
          for (const o of b.markets?.[mk] || []) {
            if (typeof o.price !== 'number' || Math.abs(o.price) > MAX_ODDS) continue;
            const key = `${o.name}|${o.point ?? ''}`;
            if (!sides.has(key)) sides.set(key, []);
            sides.get(key).push({ bk, price: o.price, link: o.link || null });
          }
        }
        for (const [key, offers] of sides) {
          if (offers.length < MIN_BOOKS) continue;
          offers.sort((x, y) => toDec(y.price) - toDec(x.price));
          const best = offers[0], worst = offers[offers.length - 1];
          const extra = Math.round((profit100(best.price) - profit100(worst.price)) * 100) / 100;
          const gapPts = Math.round((implied(worst.price) - implied(best.price)) * 1000) / 10;
          if (extra <= 0) continue;
          const [name, pt] = key.split('|');
          const point = pt === '' ? null : Number(pt);
          const bet = mk === 'h2h' ? `${name} moneyline` : mk === 'spreads' ? `${name} ${fmtPt(point)}` : `${name} ${point}`;
          gaps.push({
            sport: sport.title || sport.key, game: `${ev.away} @ ${ev.home}`, commence_time: ev.commence_time,
            market: mk, bet, books_compared: offers.length,
            best: { book: BOOK_TITLES[best.bk] || best.bk, price: fmtAm(best.price) },
            worst: { book: BOOK_TITLES[worst.bk] || worst.bk, price: fmtAm(worst.price) },
            extra_profit_per_100: extra,
            implied_gap_pts: gapPts,
          });
        }
      }
    }
  }
  gaps.sort((a, b) => b.implied_gap_pts - a.implied_gap_pts || b.extra_profit_per_100 - a.extra_profit_per_100);
  return {
    generated_at: new Date(now).toISOString(),
    odds_generated_at: odds.generated_at || null,
    window_hours: WINDOW_HOURS,
    note: 'Same bet, same line, sportsbooks only (exchanges excluded). extra_profit_per_100 = profit on a $100 bet at the best price minus at the worst price; implied_gap_pts = difference in implied win probability (percentage points), used for ranking. Prices beyond +/-400 are skipped.',
    gaps: gaps.slice(0, TOP),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const odds = JSON.parse(readFileSync(IN, 'utf8'));
  const out = buildGaps(odds);
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`gaps.json: ${out.gaps.length} gaps from odds generated ${out.odds_generated_at}`);
}
