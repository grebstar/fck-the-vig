/* Screw the Vig — draws the 1200x630 preview picture for a shared bet (docs/js/share-card.js).
   main.js hands it the legs and the prices it found; the picture is uploaded with the bet so texting apps
   (iMessage, WhatsApp, Slack...) show this bet instead of the generic site picture. */

const W = 1200, H = 630;
const C = { bg: '#110a24', surface: '#1d1439', surface2: '#2a1f50', line: '#2d2352', text: '#f6f3ff', muted: '#b4aad8', dim: '#8a80b0', accent: '#9b74ff', ink: '#14062e' };
const FONT = 'Sora, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const font = (w, px) => `${w} ${px}px ${FONT}`;

let logoP = null;
function logo(src) {
  logoP ||= new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  return logoP;
}

function rr(x, ctx, X, Y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(X + r, Y); ctx.arcTo(X + w, Y, X + w, Y + h, r); ctx.arcTo(X + w, Y + h, X, Y + h, r);
  ctx.arcTo(X, Y + h, X, Y, r); ctx.arcTo(X, Y, X + w, Y, r); ctx.closePath();
  ctx.fillStyle = x; ctx.fill();
}
// Shorten text with an ellipsis until it fits maxW.
function fit(ctx, s, maxW) {
  s = String(s);
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}
// Largest font size (down to min) at which s fits maxW.
function sizeToFit(ctx, s, weight, px, min, maxW) {
  for (; px > min; px -= 1) { ctx.font = font(weight, px); if (ctx.measureText(s).width <= maxW) return px; }
  ctx.font = font(weight, min); return min;
}

/**
 * card = {
 *   kind: 'parlay' | 'single', legs: [{ label, sub }], stake,
 *   best: { name, am, payout, color } | null,     // best full-parlay price among the sender's legal books
 *   rows: [{ name, color, payout }],              // books sorted best first
 *   extra: number,                                // how much more the best pays than the worst (0 if one book)
 *   asOf: 'Nov 6, 7:42 PM CST', logoSrc: 'logo.svg'
 * }
 * Resolves to { blob, mime }.
 */
export async function drawShareCard(card) {
  try { await Promise.all([font(800, 40), font(700, 30), font(600, 20), font(400, 20)].map(f => document.fonts.load(f))); } catch { /* system font */ }
  const img = await logo(card.logoSrc || 'logo.svg');
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  // background, same as og.png
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(0, 0, 0, 0, 0, 760);
  g.addColorStop(0, '#2a1f50'); g.addColorStop(0.6, 'rgba(42,31,80,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(W, H, 0, W, H, 600);
  g.addColorStop(0, 'rgba(155,116,255,.22)'); g.addColorStop(0.65, 'rgba(155,116,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // brand row
  const L = 64;
  if (img) { ctx.save(); ctx.shadowColor = 'rgba(155,116,255,.45)'; ctx.shadowBlur = 24; ctx.drawImage(img, L, 40, 76, 76); ctx.restore(); }
  ctx.font = font(800, 44); ctx.fillStyle = C.text;
  const bx = img ? L + 94 : L;
  ctx.fillText('Screw the Vig', bx, 94);
  const bw = ctx.measureText('Screw the Vig').width;
  ctx.fillStyle = C.accent; ctx.fillText('.', bx + bw, 94);
  ctx.font = font(600, 21); ctx.fillStyle = C.dim; ctx.textAlign = 'right';
  ctx.fillText('screwvig.com', W - 64, 88); ctx.textAlign = 'left';

  // legs (left column)
  const colW = 600;
  const legs = card.legs;
  const n = legs.length;
  ctx.font = font(700, 20); ctx.fillStyle = C.accent;
  const head = card.kind === 'single' ? 'SHARED BET' : `${n}-LEG PARLAY`;
  ctx.fillText(head.split('').join(String.fromCharCode(8202)), L, 176);
  const shown = n > 5 ? legs.slice(0, 4) : legs;
  const one = shown.length === 1;
  const big = shown.length <= 3;
  const step = big ? 100 : shown.length === 4 ? 82 : 72;
  let y = 176 + (one ? 74 : big ? 58 : 50);
  for (const leg of shown) {
    // a violet tick, then the pick and the game under it
    rr(C.accent, ctx, L, y - (one ? 36 : big ? 26 : 22), 6, one ? 40 : big ? 30 : 26, 3);
    const px = sizeToFit(ctx, leg.label, 700, one ? 46 : big ? 34 : 28, 20, colW - 24);
    ctx.font = font(700, px); ctx.fillStyle = C.text;
    ctx.fillText(fit(ctx, leg.label, colW - 24), L + 22, y);
    if (leg.sub) {
      sizeToFit(ctx, leg.sub, 500, one ? 22 : big ? 20 : 18, 15, colW - 24); ctx.fillStyle = C.muted;
      ctx.fillText(fit(ctx, leg.sub, colW - 24), L + 22, y + (one ? 40 : big ? 32 : 28));
    }
    y += step;
  }
  if (one && card.best && card.rows.length > 1) {
    // a straight bet has room for the one-line pitch
    ctx.font = font(800, 34); ctx.fillStyle = C.text;
    ctx.fillText('Same bet.', L, y + 70);
    ctx.fillStyle = C.accent; ctx.fillText('Best price.', L + ctx.measureText('Same bet. ').width, y + 70);
  }
  if (n > shown.length) {
    ctx.font = font(700, 22); ctx.fillStyle = C.accent;
    ctx.fillText(`+ ${n - shown.length} more legs`, L + 22, y - 8);
  }

  // footer
  ctx.font = font(500, 18); ctx.fillStyle = C.dim;
  ctx.fillText(fit(ctx, `Prices as of ${card.asOf}. Tap to see every book in your state.`, colW + 20), L, 598);

  // price card (right)
  const X = 712, Y = 140, CW = 424, CH = 470;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 60; ctx.shadowOffsetY = 24;
  rr(C.surface, ctx, X, Y, CW, CH, 30); ctx.restore();
  ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.stroke();
  const P = 26;
  ctx.font = font(600, 18); ctx.fillStyle = C.muted;
  const stakeTxt = card.stake > 0 ? `$${Number(card.stake).toLocaleString('en-US', { maximumFractionDigits: 2 })} bet` : 'Payout';
  ctx.fillText(stakeTxt, X + P, Y + 44);
  if (card.rows.length) {
    ctx.textAlign = 'right';
    ctx.fillText(`${card.rows.length} book${card.rows.length === 1 ? '' : 's'}`, X + CW - P, Y + 44);
    ctx.textAlign = 'left';
  }

  if (card.best) {
    // violet payout box
    const bxY = Y + 64, bxH = 168;
    rr(C.accent, ctx, X + P, bxY, CW - 2 * P, bxH, 24);
    ctx.fillStyle = C.ink;
    ctx.font = font(700, 18); ctx.fillText('Best payout', X + P + 22, bxY + 38);
    const pay = money(card.best.payout);
    const ppx = sizeToFit(ctx, pay, 800, 60, 34, CW - 2 * P - 44);
    ctx.font = font(800, ppx); ctx.fillText(pay, X + P + 22, bxY + 38 + ppx + 4);
    ctx.font = font(700, 19);
    ctx.fillText(fit(ctx, `${fmtAm(card.best.am)} at ${card.best.name}`, CW - 2 * P - 44), X + P + 22, bxY + bxH - 22);

    // book rows
    const rows = card.rows.slice(0, 4);
    const top = card.rows[0]?.payout || 1;
    let ry = bxY + bxH + 28;
    rows.forEach((r, i) => {
      rr(r.color || '#475569', ctx, X + P, ry, 30, 30, 9);
      ctx.font = font(600, 17); ctx.fillStyle = i ? C.muted : C.text;
      ctx.fillText(fit(ctx, r.name, 150), X + P + 44, ry + 21);
      const barX = X + P + 200, barW = CW - 2 * P - 200 - 100;
      rr(C.surface2, ctx, barX, ry + 11, barW, 8, 4);
      rr(i ? C.muted : C.accent, ctx, barX, ry + 11, Math.max(8, barW * Math.min(1, r.payout / top)), 8, 4);
      ctx.font = font(800, 20); ctx.fillStyle = i ? C.text : C.accent; ctx.textAlign = 'right';
      ctx.fillText(money(r.payout), X + CW - P, ry + 23); ctx.textAlign = 'left';
      ry += 44;
    });
    if (card.extra > 0.004 && card.rows.length > 1) {
      ctx.font = font(700, 17); ctx.fillStyle = C.accent;
      ctx.fillText(fit(ctx, `${money(card.extra)} more than the worst book`, CW - 2 * P), X + P, Y + CH - 24);
    }
  } else {
    // no single book prices every leg: point people to the site instead
    if (img) ctx.drawImage(img, X + CW / 2 - 70, Y + 100, 140, 140);
    ctx.textAlign = 'center'; ctx.fillStyle = C.text; ctx.font = font(800, 30);
    ctx.fillText('Same bet.', X + CW / 2, Y + 300);
    ctx.fillStyle = C.accent; ctx.fillText('Best price.', X + CW / 2, Y + 340);
    ctx.fillStyle = C.muted; ctx.font = font(600, 18);
    ctx.fillText('Tap to price it at every book', X + CW / 2, Y + 392);
    ctx.fillText('legal in your state.', X + CW / 2, Y + 418);
    ctx.textAlign = 'left';
  }

  // JPEG keeps the upload small; fall back to PNG if a browser can't make JPEGs.
  let blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
  if (blob && blob.type === 'image/jpeg') return { blob, mime: 'image/jpeg' };
  blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  return { blob, mime: 'image/png' };
}

const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAm = a => (a > 0 ? `+${a}` : `${a}`);
