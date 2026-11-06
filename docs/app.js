/* FCK The Vig — parlay price check across sportsbooks and prediction markets.
   Reads data/odds.json (written by the GitHub Action) and data/states.json (where each book is legal). */
(() => {
  'use strict';

  const POLL_MS = 60_000;          // how often the page checks for a newer odds file
  const STALE_AFTER_H = 26;        // status turns red when the file is older than this
  const MAX_LEGS = 12;
  const STATE_KEY = 'ftv-state';

  const BOOK_COLORS = {
    draftkings: '#1f9d55', fanduel: '#1f6feb', betmgm: '#a8852f', espnbet: '#e5532d', betrivers: '#1688c9',
    hardrockbet: '#6b4fd8', kalshi: '#0f9f8f', polymarket_us: '#3d5afe', polymarket: '#3d5afe', novig: '#c2378b', prophetx: '#d9822b',
  };
  const FALLBACK_EX = ['kalshi', 'polymarket_us', 'polymarket', 'novig', 'prophetx', 'betopenly', 'limitless'];

  const ICONS = {
    football: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><ellipse cx="12" cy="12" rx="9.5" ry="5.6" transform="rotate(-35 12 12)" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.6 14.4l4.8-4.8M10.4 11.2l1.4 1.4M11.8 9.8l1.4 1.4M9 12.6l1.4 1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    basketball: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3v18M5.7 5.7c3 3 3 9.6 0 12.6M18.3 5.7c-3 3-3 9.6 0 12.6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    person: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  const sportIcon = key => (key.startsWith('basketball') ? ICONS.basketball : ICONS.football);

  const S = {
    data: null, source: null, avail: null, sport: null,
    legs: [], stake: 10, state: 'ALL', events: new Map(), openProps: new Map(), propSearch: new Map(),
  };

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

  // ---------- odds math ----------
  const toDec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
  const toAm = d => (d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)));
  const fmtAm = a => (a > 0 ? `+${a}` : `${a}`);
  const fmtPt = p => (p > 0 ? `+${p}` : `${p}`);
  const money = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ---------- data ----------
  async function loadJson(path) {
    const r = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }
  async function loadOdds() {
    try { return { d: await loadJson('data/odds.json'), source: 'live' }; }
    catch { return { d: await loadJson('data/sample-odds.json'), source: 'sample' }; } // local testing only
  }

  function indexEvents() {
    S.events.clear();
    for (const sp of S.data.sports) for (const ev of sp.events) S.events.set(ev.id, { ...ev, sport: sp.key });
    S.legs = S.legs.filter(l => S.events.has(l.eventId)); // drop legs whose game left the feed
  }

  // ---------- books & states ----------
  function bookInfo(key) {
    const b = S.avail?.books?.[key], x = S.avail?.exchanges?.[key];
    let title = key;
    for (const ev of S.events.values()) if (ev.books[key]) { title = ev.books[key].title; break; }
    const meta = b || x;
    return {
      key, name: meta?.name || title, short: meta?.short || title.slice(0, 3).toUpperCase(),
      ex: !!x || FALLBACK_EX.includes(key), color: BOOK_COLORS[key] || '#475569', minAge: x?.min_age,
    };
  }
  // 'yes' | 'no' | 'check'
  function availability(key, st = S.state) {
    if (st === 'ALL' || !S.avail) return 'yes';
    const b = S.avail.books?.[key];
    if (b) return b.states.includes(st) ? 'yes' : 'no';
    const x = S.avail.exchanges?.[key];
    if (x) return x.restricted.includes(st) ? 'no' : x.uncertain?.includes(st) ? 'check' : 'yes';
    return 'check';
  }
  function allBookKeys() {
    const keys = new Set();
    for (const ev of S.events.values()) for (const k of Object.keys(ev.books)) keys.add(k);
    return keys;
  }
  const allowedBooks = () => new Set([...allBookKeys()].filter(k => availability(k) !== 'no'));
  const stateName = st => (st === 'ALL' ? 'All states' : S.avail?.states?.[st] || st);
  const noOnlineBooks = st => !!S.avail && !Object.values(S.avail.books).some(b => b.states.includes(st));
  // Platforms that are NOT available in a state (and why), plus ones whose status is unclear.
  function blockedIn(st) {
    const out = { books: [], exchanges: [], unclear: [] };
    if (!S.avail || st === 'ALL') return out;
    for (const [k, b] of Object.entries(S.avail.books)) if (!b.states.includes(st)) out.books.push({ key: k, name: b.name });
    for (const [k, x] of Object.entries(S.avail.exchanges)) {
      if (x.restricted.includes(st)) out.exchanges.push({ key: k, name: x.name, reason: x.reasons?.[st] || 'Not available here' });
      else if (x.uncertain?.includes(st)) out.unclear.push({ key: k, name: x.name, reason: x.uncertain_reasons?.[st] || 'Status unclear' });
    }
    return out;
  }

  // ---------- markets ----------
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

  // Most common line for a side across allowed books, and the best price (and book) at that line.
  function consensus(ev, market, name, allowed, desc) {
    const byPoint = new Map();
    for (const [bk, b] of Object.entries(ev.books)) {
      if (!allowed.has(bk)) continue;
      for (const o of b.markets?.[market] || []) {
        if (!same(o, name, desc)) continue;
        const k = o.point ?? 'none';
        if (!byPoint.has(k)) byPoint.set(k, []);
        byPoint.get(k).push({ price: o.price, bk });
      }
    }
    if (!byPoint.size) return null;
    let best = null;
    for (const [k, offers] of byPoint) {
      const top = offers.reduce((a, o) => (toDec(o.price) > toDec(a.price) ? o : a));
      const dec = toDec(top.price);
      if (!best || offers.length > best.count || (offers.length === best.count && dec > best.dec)) {
        best = { point: k === 'none' ? null : k, count: offers.length, dec, bk: top.bk };
      }
    }
    return { point: best.point, price: toAm(best.dec), count: best.count, bk: best.bk };
  }

  // ---------- parlay ----------
  function priceParlay() {
    const allowed = allowedBooks();
    const full = [], alt = [], missing = [];
    for (const bk of allowed) {
      let dec = 1, exact = true, ok = true;
      const legs = [];
      for (const leg of S.legs) {
        const b = S.events.get(leg.eventId)?.books[bk];
        const o = pickOutcome(b?.markets?.[leg.market], leg.name, leg.desc, leg.point);
        if (!o) { ok = false; break; }
        const sameLine = leg.point == null || o.point === leg.point;
        if (!sameLine) exact = false;
        dec *= toDec(o.price);
        legs.push({ price: o.price, point: o.point, same: sameLine, link: o.link || null });
      }
      if (!ok) { missing.push(bk); continue; }
      const off = legs.reduce((t, l, k) => t + (l.same ? 0 : Math.abs((l.point ?? 0) - (S.legs[k].point ?? 0))), 0);
      const row = { ...bookInfo(bk), avail: availability(bk), dec, am: toAm(dec), payout: S.stake * dec, legs, off };
      (exact ? full : alt).push(row);
    }
    return {
      full: full.sort((a, b) => b.dec - a.dec),
      alt: alt.sort((a, b) => a.off - b.off || b.dec - a.dec),
      missing,
    };
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

  // ---------- helpers for visuals ----------
  function teamAbbr(name) {
    const w = String(name).replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    if (w.length >= 3) return (w[0][0] + w[1][0] + w[2][0]).toUpperCase();
    return (w[0] || '?').slice(0, 3).toUpperCase();
  }
  function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const avatar = name => `<span class="avatar" style="background:linear-gradient(135deg,hsl(${hue(name)} 55% 42%),hsl(${(hue(name) + 40) % 360} 60% 30%))">${esc(teamAbbr(name))}</span>`;
  // Full name on desktop, nickname ("Bengals") on narrow phones.
  const teamName = name => `<span class="full">${esc(name)}</span><span class="short">${esc(String(name).split(/\s+/).pop())}</span>`;
  const bchip = info => `<span class="bchip" style="background:${info.color}">${esc(info.short)}</span>`;
  const ago = iso => {
    if (!iso) return null;
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} d ago`;
  };

  // ---------- rendering ----------
  function renderStatus() {
    const el = $('#status'), t = $('#statusText');
    el.className = 'status';
    if (!S.data) { t.textContent = 'Loading odds…'; return; }
    if (S.source === 'sample') { el.classList.add('sample'); t.textContent = 'Sample data'; return; }
    const ageMin = (Date.now() - new Date(S.data.generated_at)) / 60000;
    el.classList.add(ageMin > STALE_AFTER_H * 60 ? 'stale' : 'live');
    t.textContent = `Live · updated ${ago(S.data.generated_at)}`;
    el.title = S.data.quota?.remaining != null ? `${S.data.quota.remaining} API credits left this month` : '';
  }

  function renderHeroStats() {
    const allowed = allowedBooks();
    const games = S.data.sports.reduce((n, s) => n + s.events.length, 0);
    const propGames = [...S.events.values()].filter(e => Object.values(e.books).some(b => Object.keys(b.markets).some(isProp))).length;
    const books = [...allowed].filter(k => !bookInfo(k).ex).length;
    const exs = [...allowed].filter(k => bookInfo(k).ex).length;
    $('#heroStats').innerHTML = `
      <div class="stat accent"><b>${games}</b><span>Games</span></div>
      <div class="stat"><b>${books}</b><span>Sportsbooks</span></div>
      <div class="stat"><b>${exs}</b><span>Exchanges</span></div>
      <div class="stat"><b>${propGames}</b><span>With props</span></div>`;
    $('#stateBtnText').textContent = stateName(S.state);
  }

  function renderBanner() {
    const b = $('#banner');
    const msgs = [];
    if (S.source === 'sample') msgs.push('<strong>Sample odds.</strong> Teams and prices are made up. This is a local test file, not live odds.');
    const note = S.avail?.state_notes?.[S.state];
    if (note) msgs.push(`<strong>${esc(stateName(S.state))}:</strong> ${esc(note)}`);
    if (S.state !== 'ALL' && S.avail) {
      const bl = blockedIn(S.state);
      if (noOnlineBooks(S.state)) msgs.push(`<strong>No legal online sportsbooks in ${esc(stateName(S.state))}.</strong> Showing prediction markets that accept users there.`);
      if (bl.exchanges.length) msgs.push(`<strong>Blocked in ${esc(stateName(S.state))}:</strong> ${bl.exchanges.map(x => `${esc(x.name)} (${esc(x.reason)})`).join('; ')}.`);
      if (bl.unclear.length) msgs.push(`<strong>Unclear in ${esc(stateName(S.state))}:</strong> ${bl.unclear.map(x => `${esc(x.name)} (${esc(x.reason)})`).join('; ')}. Check the app before betting.`);
    }
    for (const n of S.data?.notes || []) msgs.push(esc(n));
    b.hidden = !msgs.length;
    b.innerHTML = msgs.join('<br>');
  }

  function renderTabs() {
    $('#sportTabs').innerHTML = S.data.sports.map(sp => {
      const count = sp.in_season === false ? 'off' : sp.events.length;
      return `<button class="tab" role="tab" data-sport="${esc(sp.key)}" aria-selected="${sp.key === S.sport}">${sportIcon(sp.key)}${esc(sp.title)} <span class="count">${count}</span></button>`;
    }).join('');
    const sp = S.data.sports.find(s => s.key === S.sport);
    $('#fresh').textContent = S.source === 'sample' || !sp ? '' :
      [sp.lines_at && `Lines ${ago(sp.lines_at)}`, sp.props_at && `props ${ago(sp.props_at)}`].filter(Boolean).join(' · ');
  }

  const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

  function pickBtn(ev, market, name, allowed, kind, desc) {
    const c = consensus(ev, market, name, allowed, desc);
    if (!c) return `<button class="pick" disabled><span class="pr">—</span></button>`;
    const on = S.legs.some(l => l.eventId === ev.id && l.market === market && l.name === name && l.desc === (desc || null));
    const ln = market === 'h2h' ? 'ML' : market === 'spreads' ? fmtPt(c.point) : c.point == null ? kind : `${kind} ${c.point}`;
    const info = bookInfo(c.bk);
    const data = `data-ev="${esc(ev.id)}" data-mk="${esc(market)}" data-nm="${esc(name)}" data-pt="${c.point ?? ''}" data-ds="${esc(desc || '')}"`;
    return `<button class="pick${on ? ' on' : ''}" ${data} aria-pressed="${on}" title="Best: ${esc(info.name)} (${c.count} book${c.count === 1 ? '' : 's'} at this line)">
      <span class="ln">${esc(ln)}</span><span class="pr${c.price > 0 ? ' plus' : ''}">${fmtAm(c.price)}</span><span class="bb">${esc(info.short)}</span></button>`;
  }

  function renderGames() {
    const sp = S.data.sports.find(s => s.key === S.sport);
    const box = $('#games');
    if (!sp || sp.in_season === false) { box.innerHTML = `<div class="game empty-msg">${esc(sp?.title || '')} is out of season.</div>`; return; }
    if (!sp.events.length) { box.innerHTML = `<div class="game empty-msg">No games in the next week.</div>`; return; }
    const allowed = allowedBooks();
    if (!allowed.size) { box.innerHTML = `<div class="game empty-msg">None of the books in this feed operate in ${esc(stateName(S.state))}.</div>`; return; }
    let lastDay = '', html = '';
    for (const e of sp.events) {
      const ev = S.events.get(e.id);
      const when = new Date(ev.commence_time);
      const day = dayFmt.format(when);
      if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
      const started = when < new Date();
      const nBooks = Object.keys(ev.books).filter(k => allowed.has(k)).length;
      const hasProps = propMarkets(ev, allowed).length > 0;
      html += `<article class="game">
        <div class="game-meta"><span class="chip-time">${esc(timeFmt.format(when))}</span>${started ? '<span class="chip-live">● Started</span>' : ''}${hasProps ? '<span class="chip-props">Props</span>' : ''}<span class="books-count">${nBooks} books</span></div>
        <div class="grid">
          <span></span><span class="h">Spread</span><span class="h">Money</span><span class="h">Total</span>
          <span class="team">${avatar(ev.away)}<span class="nm">${teamName(ev.away)}</span></span>
          ${pickBtn(ev, 'spreads', ev.away, allowed)}${pickBtn(ev, 'h2h', ev.away, allowed)}${pickBtn(ev, 'totals', 'Over', allowed, 'O')}
          <span class="team">${avatar(ev.home)}<span class="nm"><span class="at">@ </span>${teamName(ev.home)}</span></span>
          ${pickBtn(ev, 'spreads', ev.home, allowed)}${pickBtn(ev, 'h2h', ev.home, allowed)}${pickBtn(ev, 'totals', 'Under', allowed, 'U')}
        </div>${propsHtml(ev, allowed)}</article>`;
    }
    box.innerHTML = html;
  }

  function propMarkets(ev, allowed) {
    const mks = new Set();
    for (const [bk, b] of Object.entries(ev.books)) if (allowed.has(bk)) for (const k of Object.keys(b.markets)) if (isProp(k)) mks.add(k);
    const order = Object.keys(MARKET_LABELS);
    return [...mks].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  function propsHtml(ev, allowed) {
    const mks = propMarkets(ev, allowed);
    if (!mks.length) return '';
    const open = S.openProps.get(ev.id);
    const nPicked = S.legs.filter(l => l.eventId === ev.id && isProp(l.market)).length;
    let html = `<button class="props-toggle" data-props="${esc(ev.id)}" aria-expanded="${!!open}">${ICONS.person}
      Player props <span class="count">${mks.length} markets${nPicked ? ` · ${nPicked} in parlay` : ''}</span><span class="chev">${open ? '▴' : '▾'}</span></button>`;
    if (!open) return html;
    const mk = mks.includes(open) ? open : mks[0];
    const q = (S.propSearch.get(ev.id) || '').toLowerCase();
    html += `<div class="props"><div class="props-tools"><div class="chips">${mks.map(k => `<button class="chip" data-pev="${esc(ev.id)}" data-pmk="${esc(k)}" aria-pressed="${k === mk}">${esc(mLabel(k))}</button>`).join('')}</div>
      <input class="psearch" data-psearch="${esc(ev.id)}" type="search" placeholder="Search players" value="${esc(q)}" aria-label="Search players"></div>`;
    // Players: union across allowed books, in the order the busiest book lists them.
    const players = new Map();
    const byDepth = Object.entries(ev.books).filter(([bk]) => allowed.has(bk))
      .sort((a, b) => (b[1].markets[mk]?.length || 0) - (a[1].markets[mk]?.length || 0));
    for (const [, b] of byDepth) for (const o of b.markets[mk] || []) {
      if (!o.desc) continue;
      if (!players.has(o.desc)) players.set(o.desc, new Set());
      players.get(o.desc).add(o.name);
    }
    const yesNo = [...players.values()].some(s => s.has('Yes'));
    html += `<div class="prop-grid${yesNo ? ' yn' : ''}"><span class="h left">Player</span>${yesNo ? '<span class="h">Yes</span>' : '<span class="h">Over</span><span class="h">Under</span>'}`;
    let shown = 0;
    for (const pl of players.keys()) {
      if (q && !pl.toLowerCase().includes(q)) continue;
      shown++;
      html += `<span class="player">${esc(pl)}</span>`;
      html += yesNo ? pickBtn(ev, mk, 'Yes', allowed, 'Yes', pl)
        : pickBtn(ev, mk, 'Over', allowed, 'O', pl) + pickBtn(ev, mk, 'Under', allowed, 'U', pl);
    }
    if (!shown) html += `<span class="player muted">No players match.</span>`;
    return html + '</div></div>';
  }

  function rowHtml(r, i, isBestGroup, bestPayout) {
    const legs = r.legs.map((l, k) => {
      const lg = S.legs[k];
      const line = l.point == null ? '' : lg.market === 'spreads' ? `${fmtPt(l.point)} ` : `${lg.name === 'Over' ? 'o' : 'u'}${l.point} `;
      const cls = `lp${l.same ? '' : ' off'}`;
      const label = `${esc(line)}${fmtAm(l.price)}`;
      return l.link
        ? `<a class="${cls}" href="${esc(l.link)}" target="_blank" rel="noopener" title="Add ${esc(legLabel(lg))} to the ${esc(r.name)} bet slip">${label}<span class="ext">↗</span></a>`
        : `<span class="${cls}" title="${esc(legLabel(lg))}">${label}</span>`;
    }).join('');
    const pct = Math.max(8, Math.min(100, (r.payout / bestPayout) * 100));
    const age = r.ex && r.minAge ? ` ${r.minAge}+` : '';
    return `<div class="row${i === 0 && isBestGroup ? ' best' : ''}">
      <span class="bar" style="width:${pct.toFixed(1)}%"></span>
      ${bchip(r)}
      <span class="bk"><span class="n">${esc(r.name)}</span><span class="badge ${r.ex ? 'ex' : 'book'}">${r.ex ? 'Exchange' + age : 'Book'}</span>${r.avail === 'check' ? '<span class="badge chk" title="Availability in your state is unclear right now">Verify</span>' : ''}</span>
      <span class="money"><span class="pay">${money(r.payout)}</span><span class="odds">${fmtAm(r.am)}</span></span>
      <span class="legp">${legs}</span>
    </div>`;
  }

  function renderSlip() {
    const n = S.legs.length;
    $('#legs').innerHTML = S.legs.map((l, i) => {
      const ev = S.events.get(l.eventId);
      return `<li class="leg"><span class="ico">${isProp(l.market) ? ICONS.person : sportIcon(ev.sport)}</span>
        <span><span class="what">${esc(legLabel(l))}</span><br><span class="game-l">${esc(ev.away)} @ ${esc(ev.home)}</span></span>
        <button class="x" data-rm="${i}" aria-label="Remove leg">×</button></li>`;
    }).join('');
    $('#empty').hidden = n > 0;
    $('#clearLegs').hidden = n === 0;
    $('#stakeRow').hidden = n === 0;
    $('#legCount').hidden = n === 0;
    $('#legCount').textContent = n;
    $('#slipCount').textContent = n;
    for (const b of document.querySelectorAll('#stakeChips button')) b.classList.toggle('on', Number(b.dataset.stake) === S.stake);

    const warn = [];
    const perGame = new Map();
    for (const l of S.legs) perGame.set(l.eventId, (perGame.get(l.eventId) || 0) + 1);
    if ([...perGame.values()].some(c => c > 1)) {
      warn.push(`<div class="note warn"><strong>Same-game parlay.</strong> Books price these with their own correlation models, so the real payout in the app will usually differ (often lower) from the leg-by-leg math below.</div>`);
    }

    let res = '';
    let toggle = 'Parlay', best = '';
    if (n > 0) {
      const { full, alt, missing } = priceParlay();
      const label = n === 1 ? 'Straight bet' : `${n}-leg parlay`;
      toggle = label;
      if (full.length) {
        const top = full[0], worst = full[full.length - 1];
        const edge = top.payout - worst.payout;
        best = `${money(top.payout)}`;
        res += `<div class="result-hero">
          <div class="lbl">${esc(label)} · best payout for ${money(S.stake)}</div>
          <div class="big">${money(top.payout)}</div>
          <div class="at">at <b>${esc(top.name)}</b> · ${fmtAm(top.am)}</div>
          ${full.length > 1 && edge > 0.005 ? `<div class="save-pill">+${money(edge)} vs ${esc(worst.name)}</div>` : ''}
        </div>`;
        res += `<div class="rank"><h3><span>Same lines</span><span>${full.length} book${full.length === 1 ? '' : 's'}</span></h3>${full.map((r, i) => rowHtml(r, i, true, top.payout)).join('')}</div>`;
      } else {
        res += `<div class="note info">No book in ${esc(stateName(S.state))} has every leg at the exact same line.</div>`;
      }
      if (alt.length) {
        const ref = full[0]?.payout || alt.reduce((m, r) => Math.max(m, r.payout), 0);
        res += `<div class="rank"><h3><span>Different line on a leg</span><span>${alt.length}</span></h3>${alt.map((r, i) => rowHtml(r, i, false, ref)).join('')}</div>`;
      }
      if ([...full, ...alt].some(r => r.legs.some(l => l.link))) {
        res += `<div class="hint">Tap a price with ↗ to add that leg to the book's bet slip (each book takes one leg per link).</div>`;
      }
      if (missing.length) res += `<div class="missing">Not offering every leg: ${missing.map(k => esc(bookInfo(k).name)).join(', ')}</div>`;
      if ([...full, ...alt].some(r => r.ex)) {
        res += `<div class="note info"><strong>Exchanges</strong> (Kalshi, Polymarket, Novig, ProphetX) are priced leg-by-leg. Trading fees aren't included, and a native combo there may be priced differently.</div>`;
      }
    }
    $('#warnings').innerHTML = warn.join('');
    $('#results').innerHTML = res;
    $('#slipToggleText').textContent = toggle;
    $('#slipToggleBest').textContent = best;
  }

  function render() {
    renderStatus();
    renderHeroStats();
    renderBanner();
    renderTabs();
    renderGames();
    renderSlip();
  }

  // ---------- state picker ----------
  function statePreview(st) {
    if (!S.avail) return '';
    if (st === 'ALL') return '<p class="muted">Every sportsbook and exchange in the feed, wherever it operates.</p>';
    const pill = (k, warn) => { const i = bookInfo(k); return `<span class="bk-pill${warn ? ' warn' : ''}"><i style="background:${i.color}"></i>${esc(i.name)}${warn ? ' (verify)' : ''}</span>`; };
    const books = Object.keys(S.avail.books).filter(k => availability(k, st) === 'yes');
    const exs = Object.keys(S.avail.exchanges).filter(k => availability(k, st) !== 'no');
    const note = S.avail.state_notes?.[st];
    return `
      <div class="grp"><span>Sportsbooks (${books.length})</span><div class="bk-list">${books.length ? books.map(k => pill(k)).join('') : '<span class="muted">None legal online here yet</span>'}</div></div>
      <div class="grp"><span>Prediction markets (${exs.length})</span><div class="bk-list">${exs.length ? exs.map(k => pill(k, availability(k, st) === 'check')).join('') : '<span class="muted">None available</span>'}</div></div>
      ${blockedHtml(st)}
      ${note ? `<p class="muted">${esc(note)}</p>` : ''}`;
  }
  function blockedHtml(st) {
    const bl = blockedIn(st);
    const parts = [];
    if (bl.exchanges.length || bl.books.length) {
      const items = bl.exchanges.map(x => `<li><b>${esc(x.name)}</b> <span class="muted">— ${esc(x.reason)}</span></li>`);
      if (bl.books.length === Object.keys(S.avail.books).length) items.unshift(`<li><b>All sportsbooks</b> <span class="muted">— online sports betting isn't legal here</span></li>`);
      else if (bl.books.length) items.unshift(`<li><b>${esc(bl.books.map(b => b.name).join(', '))}</b> <span class="muted">— not licensed for online betting here</span></li>`);
      parts.push(`<div class="grp"><span class="no-h">Not available in ${esc(stateName(st))}</span><ul class="block-list no">${items.join('')}</ul></div>`);
    }
    if (bl.unclear.length) {
      parts.push(`<div class="grp"><span class="chk-h">Unclear right now</span><ul class="block-list chk">${bl.unclear.map(x => `<li><b>${esc(x.name)}</b> <span class="muted">— ${esc(x.reason)}</span></li>`).join('')}</ul></div>`);
    }
    return parts.join('');
  }
  function openStateDialog() {
    const dlg = $('#stateDialog');
    $('#stateSel').value = S.state;
    $('#statePreview').innerHTML = statePreview(S.state);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function setState(st) {
    S.state = st;
    lsSet(STATE_KEY, st);
    render();
  }

  function openAbout() {
    if (!S.avail) return;
    const host = u => { try { return new URL(u).hostname; } catch { return u; } };
    const links = arr => arr.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(host(u))}</a>`).join('<br>');
    const rows = [];
    for (const b of Object.values(S.avail.books)) {
      rows.push(`<tr><td><b>${esc(b.name)}</b><br><span class="muted">Sportsbook</span></td><td>${b.states.length} jurisdictions: ${esc(b.states.join(', '))}</td><td>${esc(b.confidence)}</td><td>${links(b.sources)}</td></tr>`);
    }
    for (const x of Object.values(S.avail.exchanges)) {
      rows.push(`<tr><td><b>${esc(x.name)}</b><br><span class="muted">Exchange · ${x.min_age}+</span></td><td>All states except ${esc(x.restricted.join(', '))}${x.uncertain?.length ? `<br><span class="muted">Unclear: ${esc(x.uncertain.join(', '))}</span>` : ''}</td><td>${esc(x.confidence)}</td><td>${links(x.sources)}</td></tr>`);
    }
    const stRows = Object.entries(S.avail.states).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => {
      const bl = blockedIn(code);
      const okBooks = Object.entries(S.avail.books).filter(([, b]) => b.states.includes(code)).map(([, b]) => b.name);
      const booksCell = okBooks.length ? esc(okBooks.join(', ')) : '<span class="no-t">None (online betting not legal)</span>';
      const exCell = bl.exchanges.length ? bl.exchanges.map(x => `<span class="no-t">${esc(x.name)}</span> <span class="muted">${esc(x.reason)}</span>`).join('<br>') : `<span class="muted">${bl.unclear.length ? 'None blocked' : 'None blocked, all 4 available'}</span>`;
      const unCell = bl.unclear.length ? bl.unclear.map(x => `<span class="chk-t">${esc(x.name)}</span> <span class="muted">${esc(x.reason)}</span>`).join('<br>') : '';
      return `<tr><td><b>${esc(name)}</b></td><td>${booksCell}</td><td>${exCell}${unCell ? '<br>' + unCell : ''}</td></tr>`;
    }).join('');
    $('#aboutBody').innerHTML = `<p class="muted">Checked ${esc(S.avail.as_of)}. ${esc(S.avail.note)}</p>
      <h4 class="about-h">State by state</h4>
      <div class="about-scroll"><table class="about-table"><thead><tr><th>State</th><th>Sportsbooks available</th><th>Prediction markets blocked / unclear</th></tr></thead><tbody>${stRows}</tbody></table></div>
      <h4 class="about-h">Platforms and sources</h4>
      <table class="about-table"><thead><tr><th>Platform</th><th>Where</th><th>Confidence</th><th>Sources</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    const dlg = $('#aboutDialog');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
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
    const sc = e.target.closest('[data-stake]');
    if (sc) { S.stake = Number(sc.dataset.stake); $('#stake').value = S.stake; return renderSlip(); }
    if (e.target.closest('#clearLegs')) { S.legs = []; return render(); }
    if (e.target.closest('#stateBtn')) return openStateDialog();
    if (e.target.closest('#aboutData')) return openAbout();
    if (e.target.closest('#slipToggle')) {
      const s = $('#slip'); s.classList.toggle('open');
      $('#slipToggle').setAttribute('aria-expanded', s.classList.contains('open'));
    }
  });
  document.addEventListener('input', e => {
    const ps = e.target.closest('[data-psearch]');
    if (!ps) return;
    S.propSearch.set(ps.dataset.psearch, ps.value);
    const pos = ps.selectionStart;
    renderGames();
    const again = document.querySelector(`[data-psearch="${CSS.escape(ps.dataset.psearch)}"]`);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* ignore */ } }
  });
  $('#stake').addEventListener('input', e => {
    const v = Number(e.target.value);
    S.stake = v > 0 ? v : 0;
    renderSlip();
  });
  $('#stateSel').addEventListener('change', e => { $('#statePreview').innerHTML = statePreview(e.target.value); });
  $('#stateDialog').addEventListener('close', () => setState($('#stateSel').value));

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
        $('#games').innerHTML = '<div class="game empty-msg">Live odds haven\'t been pulled yet. They appear here after the first update runs.</div>';
      }
    }
  }

  (async () => {
    try {
      S.avail = await loadJson('data/states.json');
      const sel = $('#stateSel');
      for (const [code, name] of Object.entries(S.avail.states).sort((a, b) => a[1].localeCompare(b[1]))) {
        sel.insertAdjacentHTML('beforeend', `<option value="${esc(code)}">${esc(name)}</option>`);
      }
      const saved = lsGet(STATE_KEY);
      if (saved && (saved === 'ALL' || S.avail.states[saved])) S.state = saved;
    } catch (err) { console.error('states.json', err); }
    await refresh(true);
    if (S.avail && !lsGet(STATE_KEY)) openStateDialog(); // first visit: ask where they're betting from
    setInterval(() => refresh(false), POLL_MS);
    setInterval(renderStatus, 30_000);
  })();
})();
