/* FCK The Vig — parlay price check across books.
   Reads data/odds.json (written by the GitHub Action), falls back to data/sample-odds.json. */
(() => {
  'use strict';

  const POLL_MS = 60_000;          // how often the page checks for a newer odds file
  const STALE_AFTER_H = 26;        // status turns red when the file is older than this
  const MAX_LEGS = 12;

  const EXCHANGE_FALLBACK = ['kalshi', 'polymarket_us', 'polymarket', 'novig', 'prophetx', 'betopenly', 'limitless'];

  const S = {
    data: null, source: null, states: null, sport: null,
    legs: [], stake: 10, state: 'ALL', events: new Map(), openProps: new Map(),
  };

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- odds math ----------
  const toDec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
  const toAm = d => (d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)));
  const fmtAm = a => (a > 0 ? `+${a}` : `${a}`);
  const fmtPt = p => (p > 0 ? `+${p}` : `${p}`);
  const money = n => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ---------- data ----------
  async function loadJson(path) {
    const r = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  async function loadOdds() {
    try {
      const d = await loadJson('data/odds.json');
      return { d, source: 'live' };
    } catch {
      // Local testing only: test/sample-odds.json copied into docs/data. Not deployed.
      const d = await loadJson('data/sample-odds.json');
      return { d, source: 'sample' };
    }
  }

  function indexEvents() {
    S.events.clear();
    for (const sp of S.data.sports) for (const ev of sp.events) S.events.set(ev.id, { ...ev, sport: sp.key });
    // Drop legs whose game disappeared from the feed (finished or pulled).
    S.legs = S.legs.filter(l => S.events.has(l.eventId));
  }

  const exchanges = () => new Set(S.states?.exchanges || EXCHANGE_FALLBACK);
  const isExchange = key => exchanges().has(key) || EXCHANGE_FALLBACK.includes(key);

  function allBookKeys() {
    const keys = new Set();
    for (const ev of S.events.values()) for (const k of Object.keys(ev.books)) keys.add(k);
    return keys;
  }

  function allowedBooks() {
    const all = allBookKeys();
    if (S.state === 'ALL' || !S.states?.states?.[S.state]) return all;
    const ok = new Set([...S.states.states[S.state].books, ...exchanges()]);
    return new Set([...all].filter(k => ok.has(k)));
  }

  function bookTitle(key) {
    for (const ev of S.events.values()) if (ev.books[key]) return ev.books[key].title;
    return key;
  }

  const MARKET_LABELS = {
    player_pass_yds: 'Pass Yds', player_rush_yds: 'Rush Yds', player_reception_yds: 'Rec Yds',
    player_receptions: 'Receptions', player_pass_tds: 'Pass TDs', player_anytime_td: 'Anytime TD',
    player_points: 'Points', player_rebounds: 'Rebounds', player_assists: 'Assists', player_threes: 'Threes',
    player_points_rebounds_assists: 'Pts+Reb+Ast',
  };
  const isProp = mk => mk.startsWith('player_');
  const mLabel = mk => MARKET_LABELS[mk] || mk.replace(/^player_/, '').replace(/_/g, ' ');
  const same = (o, name, desc) => o.name === name && (o.desc || null) === (desc || null);
  // Exchanges often list a ladder of lines for one side (o9.5, o16.5, o19.5...).
  // Pick the exact line if offered, otherwise the closest one.
  function pickOutcome(outcomes, name, desc, point) {
    let best = null, gap = Infinity;
    for (const o of outcomes || []) {
      if (!same(o, name, desc)) continue;
      const g = point == null || o.point == null ? 0 : Math.abs(o.point - point);
      if (g < gap) { best = o; gap = g; }
    }
    return best;
  }

  // Most common line for a side across allowed books, and the best price at that line.
  function consensus(ev, market, name, allowed, desc) {
    const byPoint = new Map();
    for (const [bk, b] of Object.entries(ev.books)) {
      if (!allowed.has(bk)) continue;
      for (const o of b.markets?.[market] || []) {
        if (!same(o, name, desc)) continue;
        const k = o.point ?? 'none';
        if (!byPoint.has(k)) byPoint.set(k, []);
        byPoint.get(k).push(o.price);
      }
    }
    if (!byPoint.size) return null;
    let best = null;
    for (const [k, prices] of byPoint) {
      const top = Math.max(...prices.map(toDec));
      if (!best || prices.length > best.count || (prices.length === best.count && top > best.dec)) {
        best = { point: k === 'none' ? null : k, count: prices.length, dec: top };
      }
    }
    return { point: best.point, price: toAm(best.dec), count: best.count };
  }

  // ---------- parlay ----------
  function priceParlay() {
    const allowed = allowedBooks();
    const full = [], alt = [], missing = [];
    for (const bk of allowed) {
      let dec = 1, exact = true, ok = true, link = null;
      const legs = [];
      for (const leg of S.legs) {
        const b = S.events.get(leg.eventId)?.books[bk];
        const o = pickOutcome(b?.markets?.[leg.market], leg.name, leg.desc, leg.point);
        if (!o) { ok = false; break; }
        const sameLine = leg.point == null || o.point === leg.point;
        if (!sameLine) exact = false;
        dec *= toDec(o.price);
        legs.push({ price: o.price, point: o.point, same: sameLine });
        link = link || b.link || null;
      }
      if (!ok) { missing.push(bk); continue; }
      const off = legs.reduce((t, l, k) => t + (l.same ? 0 : Math.abs((l.point ?? 0) - (S.legs[k].point ?? 0))), 0);
      const row = { bk, title: bookTitle(bk), ex: isExchange(bk), dec, am: toAm(dec), payout: S.stake * dec, legs, link, off };
      (exact ? full : alt).push(row);
    }
    const byDec = (a, b) => b.dec - a.dec;
    return { full: full.sort(byDec), alt: alt.sort((a, b) => a.off - b.off || b.dec - a.dec), missing };
  }

  function legLabel(leg) {
    if (isProp(leg.market)) {
      if (leg.point == null) return `${leg.desc} ${mLabel(leg.market)}${leg.name === 'Yes' ? '' : ` (${leg.name})`}`;
      return `${leg.desc} ${leg.name === 'Over' ? 'o' : 'u'}${leg.point} ${mLabel(leg.market)}`;
    }
    if (leg.market === 'h2h') return `${leg.name} ML`;
    if (leg.market === 'spreads') return `${leg.name} ${fmtPt(leg.point)}`;
    return `${leg.name} ${leg.point}`;
  }

  function toggleLeg(eventId, market, name, point, desc) {
    desc = desc || null;
    const i = S.legs.findIndex(l => l.eventId === eventId && l.market === market && l.name === name && l.desc === desc);
    if (i >= 0) { S.legs.splice(i, 1); return render(); }
    // Picking the other side of the same market (same player for props) replaces it.
    const j = S.legs.findIndex(l => l.eventId === eventId && l.market === market && l.desc === desc);
    if (j >= 0) S.legs.splice(j, 1);
    if (S.legs.length >= MAX_LEGS) return;
    S.legs.push({ eventId, market, name, point, desc });
    render();
  }

  // ---------- rendering ----------
  function renderStatus() {
    const el = $('#status'), t = $('#statusText');
    el.className = 'status';
    if (!S.data) { t.textContent = 'Loading odds…'; return; }
    const ageMin = Math.max(0, Math.round((Date.now() - new Date(S.data.generated_at)) / 60000));
    const age = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin} min ago` : ageMin < 1440 ? `${Math.round(ageMin / 60)} hr ago` : `${Math.round(ageMin / 1440)} days ago`;
    if (S.source === 'sample') { el.classList.add('sample'); t.textContent = 'Sample data'; return; }
    el.classList.add(ageMin > STALE_AFTER_H * 60 ? 'stale' : 'live');
    t.textContent = `Live odds · updated ${age}`;
    el.title = S.data.quota?.remaining != null ? `${S.data.quota.remaining} API credits left this month` : '';
  }

  function renderBanner() {
    const b = $('#banner');
    const msgs = [];
    if (S.source === 'sample') msgs.push('<strong>Sample odds.</strong> Teams and prices are made up so you can try the parlay builder. This is a local test file, not live odds.');
    if (S.state !== 'ALL') msgs.push(`<strong>State filter is preliminary.</strong> ${esc(S.states?._status || '')}`);
    for (const n of S.data?.notes || []) msgs.push(esc(n));
    b.hidden = !msgs.length;
    b.innerHTML = msgs.join('<br>');
  }

  function renderTabs() {
    const nav = $('#sportTabs');
    nav.innerHTML = S.data.sports.map(sp => {
      const label = sp.in_season === false ? `${esc(sp.title)} <span class="count">off-season</span>` : `${esc(sp.title)} <span class="count">${sp.events.length}</span>`;
      return `<button class="tab" role="tab" data-sport="${esc(sp.key)}" aria-selected="${sp.key === S.sport}">${label}</button>`;
    }).join('');
  }

  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  function pickBtn(ev, market, name, allowed, kind, desc) {
    const c = consensus(ev, market, name, allowed, desc);
    if (!c) return `<button class="pick" disabled><span class="pr">—</span></button>`;
    const on = S.legs.some(l => l.eventId === ev.id && l.market === market && l.name === name && l.desc === (desc || null));
    const ln = market === 'h2h' ? 'ML' : market === 'spreads' ? fmtPt(c.point) : c.point == null ? kind : `${kind} ${c.point}`;
    const data = `data-ev="${esc(ev.id)}" data-mk="${esc(market)}" data-nm="${esc(name)}" data-pt="${c.point ?? ''}" data-ds="${esc(desc || '')}"`;
    return `<button class="pick${on ? ' on' : ''}" ${data} aria-pressed="${on}" title="Best price across ${c.count} book(s) at this line">
      <span class="ln">${esc(ln)}</span><span class="pr">${fmtAm(c.price)}</span></button>`;
  }

  function renderGames() {
    const sp = S.data.sports.find(s => s.key === S.sport);
    const box = $('#games');
    if (!sp || sp.in_season === false) { box.innerHTML = `<div class="game">${esc(sp?.title || '')} is out of season.</div>`; return; }
    if (!sp.events.length) { box.innerHTML = `<div class="game">No games in the next week.</div>`; return; }
    const allowed = allowedBooks();
    const ago = iso => { if (!iso) return null; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} d ago`; };
    const fresh = [sp.lines_at && `Game lines updated ${ago(sp.lines_at)}`, sp.props_at && `props updated ${ago(sp.props_at)}`].filter(Boolean).join(' · ');
    let lastDay = '', html = fresh && S.source !== 'sample' ? `<div class="fresh">${esc(fresh)}</div>` : '';
    for (const e of sp.events) {
      const ev = S.events.get(e.id);
      const when = new Date(ev.commence_time);
      const day = dayFmt.format(when);
      if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
      const started = when < new Date();
      const nBooks = Object.keys(ev.books).filter(k => allowed.has(k)).length;
      html += `<article class="game">
        <div class="game-meta"><span>${started ? '<span class="started">Started</span> · ' : ''}${esc(timeFmt.format(when))}</span><span class="books-count">${nBooks} books</span></div>
        <div class="grid">
          <span></span><span class="h">Spread</span><span class="h">Money</span><span class="h">Total</span>
          <span class="team">${esc(ev.away)}</span>
          ${pickBtn(ev, 'spreads', ev.away, allowed)}${pickBtn(ev, 'h2h', ev.away, allowed)}${pickBtn(ev, 'totals', 'Over', allowed, 'O')}
          <span class="team"><small>@</small> ${esc(ev.home)}</span>
          ${pickBtn(ev, 'spreads', ev.home, allowed)}${pickBtn(ev, 'h2h', ev.home, allowed)}${pickBtn(ev, 'totals', 'Under', allowed, 'U')}
        </div>${propsHtml(ev, allowed)}</article>`;
    }
    box.innerHTML = html;
  }

  function propMarkets(ev, allowed) {
    const mks = new Set();
    for (const [bk, b] of Object.entries(ev.books)) if (allowed.has(bk)) for (const k of Object.keys(b.markets)) if (isProp(k)) mks.add(k);
    return [...mks].sort((a, b) => Object.keys(MARKET_LABELS).indexOf(a) - Object.keys(MARKET_LABELS).indexOf(b));
  }

  function propsHtml(ev, allowed) {
    const mks = propMarkets(ev, allowed);
    if (!mks.length) return '';
    const open = S.openProps.get(ev.id);
    const nPicked = S.legs.filter(l => l.eventId === ev.id && isProp(l.market)).length;
    let html = `<button class="props-toggle" data-props="${esc(ev.id)}" aria-expanded="${!!open}">
      Player props <span class="count">${mks.length} markets${nPicked ? ` · ${nPicked} in parlay` : ''}</span><span class="chev">${open ? '▴' : '▾'}</span></button>`;
    if (!open) return html;
    const mk = mks.includes(open) ? open : mks[0];
    html += `<div class="props"><div class="chips">${mks.map(k => `<button class="chip" data-pev="${esc(ev.id)}" data-pmk="${esc(k)}" aria-pressed="${k === mk}">${esc(mLabel(k))}</button>`).join('')}</div>`;
    // Players: union across allowed books, in the order the busiest book lists them.
    const players = new Map();
    const booksByDepth = Object.entries(ev.books).filter(([bk]) => allowed.has(bk))
      .sort((a, b) => (b[1].markets[mk]?.length || 0) - (a[1].markets[mk]?.length || 0));
    for (const [, b] of booksByDepth) for (const o of b.markets[mk] || []) {
      if (!o.desc) continue;
      if (!players.has(o.desc)) players.set(o.desc, new Set());
      players.get(o.desc).add(o.name);
    }
    const yesNo = [...players.values()].some(s => s.has('Yes'));
    html += `<div class="prop-grid${yesNo ? ' yn' : ''}"><span class="h left">Player</span>${yesNo ? '<span class="h">Yes</span>' : '<span class="h">Over</span><span class="h">Under</span>'}`;
    for (const [pl, sides] of players) {
      html += `<span class="player">${esc(pl)}</span>`;
      html += yesNo ? pickBtn(ev, mk, 'Yes', allowed, '', pl)
        : pickBtn(ev, mk, 'Over', allowed, 'O', pl) + pickBtn(ev, mk, 'Under', allowed, 'U', pl);
    }
    return html + '</div></div>';
  }

  function rowHtml(r, i, best) {
    const legs = r.legs.map((l, k) => {
      const lg = S.legs[k];
      const line = l.point == null ? '' : lg.market === 'spreads' ? `${fmtPt(l.point)} ` : `${lg.name === 'Over' ? 'o' : 'u'}${l.point} `;
      return `<span class="lp${l.same ? '' : ' off'}" title="${esc(legLabel(lg))}">${esc(line)}${fmtAm(l.price)}</span>`;
    }).join('');
    const go = r.link ? `<a class="go" href="${esc(r.link)}" target="_blank" rel="noopener">Open ↗</a>` : '';
    return `<div class="row${i === 0 && best ? ' best' : ''}">
      <span class="pos">${i + 1}</span>
      <span class="bk"><span class="n">${esc(r.title)}</span><span class="badge ${r.ex ? 'ex' : 'book'}">${r.ex ? 'Exchange' : 'Book'}</span></span>
      <span class="odds">${fmtAm(r.am)}</span>
      <span class="pay">${money(r.payout)}</span>
      <span class="diff">${legs} ${go}</span>
    </div>`;
  }

  function renderSlip() {
    const n = S.legs.length;
    $('#legs').innerHTML = S.legs.map((l, i) => {
      const ev = S.events.get(l.eventId);
      return `<li class="leg"><span class="what">${esc(legLabel(l))}</span>
        <span class="game-l">${esc(ev.away)} @ ${esc(ev.home)}</span>
        <button class="x" data-rm="${i}" aria-label="Remove leg">×</button></li>`;
    }).join('');
    $('#empty').hidden = n > 0;
    $('#clearLegs').hidden = n === 0;

    const warn = [];
    const perGame = new Map();
    for (const l of S.legs) perGame.set(l.eventId, (perGame.get(l.eventId) || 0) + 1);
    if ([...perGame.values()].some(c => c > 1)) {
      warn.push(`<div class="note warn"><strong>Same-game parlay.</strong> Books price these with their own correlation models, so the real payout in the app will usually differ (often lower) from the leg-by-leg math below.</div>`);
    }

    let res = '';
    let toggle = `Parlay · ${n} leg${n === 1 ? '' : 's'}`;
    if (n > 0) {
      const { full, alt, missing } = priceParlay();
      const label = n === 1 ? 'Straight bet' : `${n}-leg parlay`;
      if (full.length) {
        const best = full[0], worst = full[full.length - 1];
        const edge = best.payout - worst.payout;
        toggle += ` · Best ${fmtAm(best.am)} (${money(best.payout)})`;
        res += `<div class="hero">
          <div class="lbl">${esc(label)} · best payout for ${money(S.stake)}</div>
          <div class="big"><span class="num">${money(best.payout)}</span></div>
          <div class="sub">at <strong>${esc(best.title)}</strong> (${fmtAm(best.am)})${full.length > 1 && edge > 0.005 ? ` — <span class="edge">${money(edge)} more</span> than ${esc(worst.title)} (${money(worst.payout)})` : ''}</div>
        </div>`;
        res += `<div class="rank"><h3>Same lines · ${full.length} book${full.length === 1 ? '' : 's'}</h3>${full.map((r, i) => rowHtml(r, i, true)).join('')}</div>`;
      } else {
        res += `<div class="note info">No book in this state has every leg at the exact same line.</div>`;
      }
      if (alt.length) {
        res += `<div class="rank"><h3>Different lines on at least one leg</h3>${alt.map((r, i) => rowHtml(r, i, false)).join('')}</div>`;
      }
      if (missing.length) {
        res += `<div class="missing">Not offering every leg: ${missing.map(bookTitle).map(esc).join(', ')}</div>`;
      }
      if ([...full, ...alt].some(r => r.ex)) {
        res += `<div class="note info"><strong>Exchanges</strong> (Kalshi, Polymarket, Novig, ProphetX) are priced here leg-by-leg. Trading fees aren't included, and a native combo on that platform may be priced differently.</div>`;
      }
    }
    $('#warnings').innerHTML = warn.join('');
    $('#results').innerHTML = res;
    $('#slipToggleText').textContent = toggle;
  }

  function render() {
    renderStatus();
    renderBanner();
    renderTabs();
    renderGames();
    renderSlip();
  }

  // ---------- events ----------
  document.addEventListener('click', e => {
    const pick = e.target.closest('.pick[data-ev]');
    if (pick) {
      const pt = pick.dataset.pt === '' ? null : Number(pick.dataset.pt);
      return toggleLeg(pick.dataset.ev, pick.dataset.mk, pick.dataset.nm, pt, pick.dataset.ds || null);
    }
    const pt = e.target.closest('[data-props]');
    if (pt) {
      const id = pt.dataset.props;
      if (S.openProps.has(id)) S.openProps.delete(id); else S.openProps.set(id, true);
      return renderGames();
    }
    const chip = e.target.closest('[data-pmk]');
    if (chip) { S.openProps.set(chip.dataset.pev, chip.dataset.pmk); return renderGames(); }
    const tab = e.target.closest('.tab[data-sport]');
    if (tab) { S.sport = tab.dataset.sport; return render(); }
    const rm = e.target.closest('[data-rm]');
    if (rm) { S.legs.splice(Number(rm.dataset.rm), 1); return render(); }
    if (e.target.closest('#clearLegs')) { S.legs = []; return render(); }
    if (e.target.closest('#slipToggle')) {
      const s = $('#slip'); s.classList.toggle('open');
      $('#slipToggle').setAttribute('aria-expanded', s.classList.contains('open'));
    }
  });
  $('#stake').addEventListener('input', e => {
    const v = Number(e.target.value);
    S.stake = v > 0 ? v : 0;
    renderSlip();
  });
  $('#stateSel').addEventListener('change', e => {
    S.state = e.target.value;
    try { localStorage.setItem('ftv-state', S.state); } catch {}
    render();
  });

  // ---------- boot + polling ----------
  async function refresh(first) {
    try {
      const { d, source } = await loadOdds();
      if (!first && S.data && d.generated_at === S.data.generated_at) { renderStatus(); return; }
      S.data = d; S.source = source;
      indexEvents();
      if (!S.sport || !S.data.sports.some(s => s.key === S.sport)) {
        S.sport = (S.data.sports.find(s => s.in_season !== false && s.events.length) || S.data.sports[0])?.key;
      }
      render();
    } catch (err) {
      console.error(err);
      if (first) {
        $('#statusText').textContent = 'Waiting for first odds update';
        $('#games').innerHTML = '<div class="game">Live odds haven\'t been pulled yet. They appear here after the first update runs.</div>';
      }
    }
  }

  (async () => {
    try {
      S.states = await loadJson('data/states.json');
      const sel = $('#stateSel');
      for (const [code, st] of Object.entries(S.states.states).sort((a, b) => a[1].name.localeCompare(b[1].name))) {
        sel.insertAdjacentHTML('beforeend', `<option value="${esc(code)}">${esc(st.name)}</option>`);
      }
      let saved = null; try { saved = localStorage.getItem('ftv-state'); } catch {}
      if (saved && S.states.states[saved]) { S.state = saved; sel.value = saved; }
    } catch { /* state filter optional */ }
    await refresh(true);
    setInterval(() => refresh(false), POLL_MS);
    setInterval(renderStatus, 30_000);
  })();
})();
