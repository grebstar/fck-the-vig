/* One link that puts a whole parlay on a book's bet slip (docs/js/slip-links.js).
   Built from the single-leg links The Odds API gives us. The books don't publish multi-leg formats, so each
   one below follows the pattern of that book's own single-leg link. `tested` turns true once a format is
   confirmed on the live site; until then the page labels the button as a beta and keeps the leg-by-leg list. */

export const COMBO_BOOKS = {
  draftkings: { tested: false },   // ?outcomes=A+B
  fanduel: { tested: false },      // addToBetslip?marketId[0]=..&selectionId[0]=..&marketId[1]=..
  espnbet: { tested: false },      // theScore Bet: ?market_selection_id[0]=..&odds_numerator[0]=..&market_selection_id[1]=..
  betmgm: { tested: false },       // ?options=A,B&type=Combo
};

const param = (url, name) => {
  const m = new RegExp(`[?&]${name.replace(/[[\]]/g, '\\$&')}=([^&#]*)`).exec(url);
  return m ? m[1] : null;   // raw (still URL-encoded), so IDs like DraftKings' %23 survive
};
const origin = url => { try { return new URL(url).origin; } catch { return null; } };
const SAFE = /^[A-Za-z0-9%._:~-]+$/;

const BUILDERS = {
  draftkings(links) {
    const ids = links.map(l => param(l, 'outcomes'));
    if (ids.some(x => !x || !SAFE.test(x))) return null;
    return `https://sportsbook.draftkings.com/?outcomes=${ids.join('+')}`;
  },
  fanduel(links) {
    const legs = links.map(l => [param(l, 'marketId'), param(l, 'selectionId')]);
    if (legs.some(([m, s]) => !m || !s || !SAFE.test(m) || !SAFE.test(s))) return null;
    return `https://sportsbook.fanduel.com/addToBetslip?${legs.map(([m, s], i) => `marketId[${i}]=${m}&selectionId[${i}]=${s}`).join('&')}`;
  },
  espnbet(links) {
    const legs = links.map(l => [param(l, 'market_selection_id[0]'), param(l, 'odds_numerator[0]'), param(l, 'odds_denominator[0]')]);
    if (legs.some(([id]) => !id || !SAFE.test(id))) return null;
    return `https://sportsbook.thescore.bet/?${legs.map(([id, n, d], i) => [
      `market_selection_id[${i}]=${id}`,
      n && SAFE.test(n) ? `odds_numerator[${i}]=${n}` : '',
      d && SAFE.test(d) ? `odds_denominator[${i}]=${d}` : '',
    ].filter(Boolean).join('&')).join('&')}`;
  },
  betmgm(links) {
    const hosts = new Set(links.map(origin));
    if (hosts.size !== 1) return null;
    const [host] = hosts;
    if (!host || !/^https:\/\/sports\.[a-z]{2}\.betmgm\.com$/.test(host)) return null;   // state must already be filled in
    const opts = links.map(l => param(l, 'options'));
    if (opts.some(x => !x || !SAFE.test(x))) return null;
    return `${host}/en/sports?options=${opts.join(',')}&type=Combo`;
  },
};

// links: the cleaned single-leg link for every leg, in order (state already filled in). Returns null when the
// book has no multi-leg format, a leg has no link, or a link doesn't look the way we expect.
export function comboLink(book, links) {
  const build = BUILDERS[book];
  if (!build || !Array.isArray(links) || links.length < 2 || links.some(l => typeof l !== 'string' || !l)) return null;
  try { return build(links); } catch { return null; }
}
