// node scripts/build-gaps.test.mjs — checks build-gaps.mjs math and filters on a tiny hand-made odds file.
import assert from 'node:assert/strict';
import { buildGaps, profit100 } from './build-gaps.mjs';

assert.equal(profit100(150), 150);
assert.equal(profit100(-200), 50);
const now = Date.parse('2026-11-09T12:00:00Z');
const ev = (h, books) => ({ commence_time: new Date(now + h * 3600e3).toISOString(), home: 'Home', away: 'Away', books });
const ml = (a, b) => ({ markets: { h2h: [{ name: 'Away', price: a }, { name: 'Home', price: b }] } });
const odds = { generated_at: 'x', sports: [{ title: 'NFL', events: [
  ev(5, { draftkings: ml(150, -170), fanduel: ml(130, -150), betmgm: ml(120, -140), kalshi: ml(300, -400) }),
  ev(60, { draftkings: ml(500, -700), fanduel: ml(100, -120), betmgm: ml(100, -120) }), // outside the 36h window
] }] };
const out = buildGaps(odds, now);
assert.equal(out.gaps.length, 2, 'two sides of the one in-window game');
const top = out.gaps[0];
assert.equal(top.bet, 'Away moneyline');
assert.equal(top.best.book, 'DraftKings'); assert.equal(top.best.price, '+150');
assert.equal(top.worst.book, 'BetMGM'); assert.equal(top.worst.price, '+120');
assert.equal(top.extra_profit_per_100, 30); // Kalshi +300 ignored: exchanges excluded
assert.equal(top.implied_gap_pts, 5.5); // 45.5% at +120 vs 40.0% at +150
console.log('build-gaps test: ok');
