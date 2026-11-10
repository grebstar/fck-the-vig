/* FCK The Vig — parlay price check across sportsbooks and prediction markets (docs/js/main.js).
   Reads data/odds.json and data/futures.json (written by the GitHub Action) and data/states.json (where each book is legal).
   Saved bets live in this browser and, when signed in, sync to the accounts API (worker/index.js). */
import { gradeBets, settle } from './grade.js?v=9';
import { loadBets, saveBets, mergeBets, newId, visible, tombstone, summarize, breakdown } from './bets.js?v=9';
import { MARKET_LABELS, mLabel, isProp, legLabel, effDec, findArbs, findValue, arbStakes, bestOffer } from './odds-math.js?v=9';
import { comboLink, COMBO_BOOKS } from './slip-links.js?v=9';
import { drawShareCard } from './share-card.js?v=1';

(() => {
  'use strict';

  const POLL_MS = 60_000;          // how often the page checks for a newer odds file
  const STALE_AFTER_H = 26;        // status turns red when the file is older than this
  const MAX_LEGS = 12;
  const STATE_KEY = 'ftv-state';
  const SESSION_KEY = 'ftv-session';
  const MYBOOKS_KEY = 'ftv-mybooks';   // {books: [...], at: ms} — the books the user has accounts with
  const ONLYMINE_KEY = 'ftv-onlymine';
  const GRADE_EVERY_MS = 10 * 60_000;
  const SYNC_EVERY_MS = 5 * 60_000;
  const NATIVE = location.protocol === 'capacitor:';   // running inside the iPhone app (Capacitor serves it from capacitor://localhost)
  const LOCAL = !NATIVE && ['localhost', '127.0.0.1'].includes(location.hostname);
  const DATA_BASE = NATIVE ? 'https://www.fckvig.com/' : '';   // the app reads the same live odds files as the site
  const AGE_KEY = 'ftv-21';
  if (NATIVE) document.documentElement.classList.add('native');
  const API_BASE = LOCAL ? 'http://localhost:8787' : 'https://api.fckvig.com';
  const GAME_TABS = new Set(['today', 'build', 'results']);
  // Membership. The real charge is whatever Price is set in Stripe; keep these labels in step with it.
  const PLAN_PRICE = { month: '$9.99', year: '$79.99', yearPerMonth: '$6.67', yearSave: '33%' };
  const COMPETITORS = [   // their App Store prices (App Pricing Lab / App Store listings, checked Apr–May 2026)
    ['Pikkit Pro', '$29.99/mo'],
    ['Action Network PRO', 'from $19.99/mo'],
    ['OddsJam (cheapest plan)', '$19.99/mo'],
  ];
  const VIEWS = new Set(['games', 'season', 'bets', 'money']);

  const BOOK_COLORS = {
    draftkings: '#1f9d55', fanduel: '#1f6feb', betmgm: '#a8852f', espnbet: '#e5532d', betrivers: '#1688c9',
    hardrockbet: '#6b4fd8', kalshi: '#0f9f8f', polymarket_us: '#3d5afe', polymarket: '#3d5afe', novig: '#c2378b', prophetx: '#d9822b',
  };
  const FALLBACK_EX = ['kalshi', 'polymarket_us', 'polymarket', 'novig', 'prophetx', 'betopenly', 'limitless'];

  const ICONS = {
    football: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><ellipse cx="12" cy="12" rx="9.5" ry="5.6" transform="rotate(-35 12 12)" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.6 14.4l4.8-4.8M10.4 11.2l1.4 1.4M11.8 9.8l1.4 1.4M9 12.6l1.4 1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    basketball: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3v18M5.7 5.7c3 3 3 9.6 0 12.6M18.3 5.7c-3 3-3 9.6 0 12.6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    bell: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    person: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  const S = {
    data: null, source: null, avail: null, sport: null,
    legs: [], stake: 10, state: 'ALL', events: new Map(), openProps: new Map(), propSearch: new Map(), tab: 'today',
    view: 'games', lastGameTab: 'today',
    futures: null, seasonSport: null, market: null, marketSearch: '',
    bets: [], betFilter: 'open', user: null, syncAt: null, syncErr: null, gradedAt: null,
    statsTab: 'sport', moneyTotal: 100, q: '', alerts: null, alertsErr: null, metaAt: null,
    myBooks: null, myBooksAt: 0, onlyMine: true, day: null,
    plan: null, quota: null, billing: null, admin: false, planInterval: 'month',
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
    const r = await fetch(`${DATA_BASE}${path}?t=${Date.now()}`, { cache: 'no-store' });
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
  // Some deep links come with placeholders ({state}, {wagerAmount}...). Fill in the state; for anything else, link
  // to the game page instead of a half-filled bet slip.
  function cleanLink(url) {
    if (!url) return null;
    let u = String(url);
    if (u.includes('{state}')) {
      if (S.state === 'ALL') return null;
      u = u.split('{state}').join(S.state.toLowerCase());
    }
    const i = u.indexOf('{');
    if (i >= 0) u = u.slice(0, i).replace(/\/oddsapi\/?$/, '').replace(/[?&#][^?&#=]*=?$/, '').replace(/[|/?&=#]+$/, '');
    try { return /^https?:$/.test(new URL(u).protocol) ? u : null; } catch { return null; }
  }
  const allowedBooks = () => new Set([...allBookKeys()].filter(k => availability(k) !== 'no'));

  // ---------- my books ----------
  // The books the user has accounts with. Saved in this browser and, when signed in, in their profile.
  const hasMine = () => !!S.myBooks && S.myBooks.size > 0;
  const mineOn = () => hasMine() && S.onlyMine;
  // The books we price a parlay at: legal in the chosen state and, with "My books" on, ones the user has.
  const pricedBooks = () => { const a = allowedBooks(); return mineOn() ? new Set([...a].filter(k => S.myBooks.has(k))) : a; };
  const BOOK_KEY_RE = /^[a-z0-9_]{2,30}$/;
  function loadMyBooks() {
    try {
      const v = JSON.parse(lsGet(MYBOOKS_KEY) || 'null');
      S.myBooks = Array.isArray(v?.books) ? new Set(v.books.filter(k => BOOK_KEY_RE.test(k))) : null;
      S.myBooksAt = Math.min(Number(v?.at) || 0, Date.now());   // a clock that ran fast once can't stay "newest" forever
    } catch { S.myBooks = null; S.myBooksAt = 0; }
    S.onlyMine = lsGet(ONLYMINE_KEY) !== '0';
  }
  function setMyBooks(keys, at = Date.now()) {
    S.myBooks = new Set(keys);
    S.myBooksAt = at;
    lsSet(MYBOOKS_KEY, JSON.stringify({ books: [...S.myBooks], at }));
  }
  function setOnlyMine(on) { S.onlyMine = on; lsSet(ONLYMINE_KEY, on ? '1' : '0'); }
  async function pushPrefs() {
    if (!S.user || !S.myBooks) return;
    try {
      const r = await api('/api/prefs', { prefs: { books: [...S.myBooks] }, updated_at: S.myBooksAt });
      // The account keeps whichever copy is newest; if that isn't ours, switch to it.
      if (r?.prefs && r.updated_at !== S.myBooksAt) { setMyBooks(r.prefs.books, r.updated_at); render(); }
    } catch (err) { if (err.status === 401) setSession(null); }
  }
  // Newest choice wins: the account's copy, or this browser's if it was changed more recently.
  async function pullPrefs() {
    if (!S.user) return;
    try {
      const r = await api('/api/prefs');
      if (r.prefs && r.updated_at > S.myBooksAt) { setMyBooks(r.prefs.books, r.updated_at); render(); renderAcctBox(); }
      else if (S.myBooks && S.myBooksAt > (r.updated_at || 0)) pushPrefs();
    } catch { /* older API or offline: keep this browser's copy */ }
  }
  function myBookNames() {
    return hasMine() ? [...S.myBooks].map(k => bookInfo(k).name).sort((a, b) => a.localeCompare(b)) : [];
  }
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
  function priceParlay(allowed = pricedBooks(), legsIn = S.legs) {
    const full = [], alt = [], missing = [];
    for (const bk of allowed) {
      let dec = 1, exact = true, ok = true;
      const legs = [];
      for (const leg of legsIn) {
        const b = S.events.get(leg.eventId)?.books[bk];
        const o = pickOutcome(b?.markets?.[leg.market], leg.name, leg.desc, leg.point);
        if (!o) { ok = false; break; }
        const sameLine = leg.point == null || o.point === leg.point;
        if (!sameLine) exact = false;
        dec *= toDec(o.price);
        legs.push({ price: o.price, point: o.point, same: sameLine, link: cleanLink(o.link) });
      }
      if (!ok) { missing.push(bk); continue; }
      const off = legs.reduce((t, l, k) => t + (l.same ? 0 : Math.abs((l.point ?? 0) - (legsIn[k].point ?? 0))), 0);
      const row = { ...bookInfo(bk), avail: availability(bk), dec, am: toAm(dec), payout: S.stake * dec, legs, off };
      (exact ? full : alt).push(row);
    }
    return {
      full: full.sort((a, b) => b.dec - a.dec),
      alt: alt.sort((a, b) => a.off - b.off || b.dec - a.dec),
      missing,
    };
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

  // ---------- date picker: Today, Tomorrow, ... as far ahead as the books have posted lines ----------
  const MAX_DAYS = 21;
  const pad2 = n => String(n).padStart(2, '0');
  const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const keyDate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const todayKey = () => dayKey(Date.now());
  const evDay = ev => dayKey(ev.commence_time);
  // Games that have already started leave the board: our prices are pregame and we don't carry live odds.
  // (They stay in S.events so parlay legs, shared links and My bets can still find them.)
  const hasStarted = ev => new Date(ev.commence_time).getTime() <= Date.now();
  const onDay = (ev, day = S.day) => !hasStarted(ev) && (day === 'all' || evDay(ev) === day);
  const upcomingCount = () => { let n = 0; for (const ev of S.events.values()) if (!hasStarted(ev)) n++; return n; };
  function normDay() {
    if (S.day !== 'all' && (!S.day || S.day < todayKey())) S.day = todayKey();
    return S.day;
  }
  // Every day from today through the last day with a game in any sport.
  function dayList() {
    const t = todayKey();
    let last = t;
    for (const ev of S.events.values()) { const k = evDay(ev); if (k > last) last = k; }
    const out = [], d = keyDate(t);
    for (let i = 0; i < MAX_DAYS; i++) {
      const k = dayKey(d);
      out.push(k);
      if (k >= last) break;
      d.setDate(d.getDate() + 1);
    }
    return out;
  }
  const wkShort = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
  const wkLong = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
  const mdFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  function dayName(k, long) {
    if (k === 'all') return 'All days';
    const t = todayKey();
    if (k === t) return 'Today';
    const tm = keyDate(t); tm.setDate(tm.getDate() + 1);
    if (k === dayKey(tm)) return 'Tomorrow';
    return (long ? wkLong : wkShort).format(keyDate(k));
  }
  const dayLong = k => (k === 'all' ? 'All days' : `${dayName(k, true)}, ${mdFmt.format(keyDate(k))}`);
  function countOn(day, sportKey) {
    let n = 0;
    for (const ev of S.events.values()) if ((!sportKey || ev.sport === sportKey) && onDay(ev, day)) n++;
    return n;
  }
  // Build strip counts games in the chosen sport; the phone Today strip counts every sport.
  function stripHtml(sportKey) {
    const days = dayList();
    const chip = (k, top, bottom, n) => `<button class="dchip${n ? '' : ' zero'}" data-day="${k}" aria-pressed="${k === S.day}" title="${esc(dayLong(k))}: ${n} game${n === 1 ? '' : 's'}">
        <span class="d-top">${esc(top)}</span><span class="d-bot">${esc(bottom)}<b>${n}</b></span></button>`;
    return days.map(k => chip(k, dayName(k), mdFmt.format(keyDate(k)), countOn(k, sportKey))).join('')
      + chip('all', 'All', `${days.length} days`, countOn('all', sportKey));
  }
  function renderDays() {
    normDay();
    for (const [el, sport] of [[$('#dayStrip'), S.sport], [$('#dayStripToday'), null]]) {
      if (!el) continue;
      const keep = el.scrollLeft;
      el.innerHTML = stripHtml(sport);
      el.scrollLeft = keep;
      // Only scroll when the chosen day is out of view, and leave the chip before it peeking in.
      const on = el.querySelector('[aria-pressed="true"]');
      if (!on || !el.clientWidth) continue;
      const x = on.offsetLeft - el.offsetLeft;
      if (x < el.scrollLeft || x + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, x - 48);
    }
  }
  function setDay(k) {
    S.day = k;
    render();
  }

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


  // Biggest best-vs-worst price differences for the same bet at the same line, across books legal here.
  function priceGaps(allowed) {
    const now = Date.now(), out = [];
    for (const ev of S.events.values()) {
      if (new Date(ev.commence_time).getTime() <= now || !onDay(ev)) continue;
      const sides = new Map();
      for (const [bk, b] of Object.entries(ev.books)) {
        if (!allowed.has(bk)) continue;
        for (const [mk, outs] of Object.entries(b.markets)) for (const o of outs) {
          const key = `${mk}|${o.name}|${o.desc || ''}|${o.point ?? ''}`;
          if (!sides.has(key)) sides.set(key, { mk, name: o.name, desc: o.desc || null, point: o.point ?? null, offers: [] });
          const side = sides.get(key);
          if (!side.offers.some(x => x.bk === bk)) side.offers.push({ bk, price: o.price });
        }
      }
      const perMarket = new Map();
      for (const side of sides.values()) {
        if (side.offers.length < 4) continue;
        if (side.offers.some(o => o.price < -400 || o.price > 400)) continue; // keep it to mainstream prices
        // Drop stale or thin quotes: anything more than 5 points of implied probability away from the median.
        const probs = side.offers.map(o => 1 / toDec(o.price)).sort((x, y) => x - y);
        const med = probs[Math.floor(probs.length / 2)];
        const offers = side.offers.filter(o => Math.abs(1 / toDec(o.price) - med) <= 0.05);
        if (offers.length < 4) continue;
        const best = offers.reduce((m, o) => (toDec(o.price) > toDec(m.price) ? o : m));
        const worst = offers.reduce((m, o) => (toDec(o.price) < toDec(m.price) ? o : m));
        // How much more you win at the best book vs the worst, in percent of profit.
        const gap = ((toDec(best.price) - 1) / (toDec(worst.price) - 1) - 1) * 100;
        if (gap < 1) continue;
        const mkey = `${side.mk}|${side.desc || ''}`; // one card per market per game
        const cur = perMarket.get(mkey);
        if (!cur || gap > cur.gap) perMarket.set(mkey, { ev, ...side, best, worst, gap, books: offers.length });
      }
      out.push(...perMarket.values());
    }
    return out.sort((a, b) => b.gap - a.gap).slice(0, 6);
  }

  // Average hold per book on two-way game lines (moneyline, spread, total) for upcoming games.
  function vigByBook(allowed) {
    const acc = new Map();
    const now = Date.now();
    for (const ev of S.events.values()) {
      if (new Date(ev.commence_time).getTime() <= now) continue;
      for (const [bk, b] of Object.entries(ev.books)) {
        if (!allowed.has(bk)) continue;
        const add = pair => {
          if (pair.length !== 2) return;
          const h = 1 / toDec(pair[0].price) + 1 / toDec(pair[1].price) - 1;
          if (h < -0.05 || h > 0.25) return;
          const a = acc.get(bk) || { sum: 0, n: 0 }; a.sum += h; a.n++; acc.set(bk, a);
        };
        const h2h = b.markets.h2h; if (h2h) add(h2h.slice(0, 2));
        for (const mk of ['spreads', 'totals']) {
          const groups = new Map();
          for (const o of b.markets[mk] || []) { const k = Math.abs(o.point ?? 0); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
          for (const g of groups.values()) add(g);
        }
      }
    }
    return [...acc.entries()].filter(([, a]) => a.n >= 3).map(([bk, a]) => ({ bk, vig: (a.sum / a.n) * 100 })).sort((x, y) => x.vig - y.vig);
  }

  function renderToday() {
    const allowed = allowedBooks();
    const games = countOn(S.day);
    const day = S.day === todayKey() ? wkLong.format(new Date()) : dayLong(S.day);
    $('#todaySub').textContent = `${day} · ${games} game${games === 1 ? '' : 's'} · ${allowed.size} books${S.state !== 'ALL' ? ' in ' + stateName(S.state) : ''}`;
    $('#todayTitle').textContent = S.day === todayKey() ? 'Biggest price gaps right now'
      : S.day === 'all' ? 'Biggest price gaps, all days' : `Biggest price gaps ${dayName(S.day, true) === 'Tomorrow' ? 'tomorrow' : 'on ' + dayName(S.day, true)}`;
    const gaps = priceGaps(allowed);
    $('#gaps').innerHTML = gaps.length ? gaps.map(g => {
      const leg = { market: g.mk, name: g.name, point: g.point, desc: g.desc };
      const on = S.legs.some(l => l.eventId === g.ev.id && l.market === g.mk && l.name === g.name && l.desc === g.desc);
      const when = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(g.ev.commence_time));
      return `<button class="gap${on ? ' on' : ''}" data-gev="${esc(g.ev.id)}" data-gmk="${esc(g.mk)}" data-gnm="${esc(g.name)}" data-gpt="${g.point ?? ''}" data-gds="${esc(g.desc || '')}" aria-pressed="${on}">
        <span class="gap-top"><span class="gap-pick">${esc(legLabel(leg))}</span><span class="gap-badge">Pays ${Math.round(g.gap)}% more</span></span>
        <span class="gap-game">${esc(g.ev.away)} @ ${esc(g.ev.home)} · ${esc(when)}</span>
        <span class="gap-row"><span>Best <strong>${fmtAm(g.best.price)} ${esc(bookInfo(g.best.bk).name)}</strong></span><span>Worst <strong>${fmtAm(g.worst.price)} ${esc(bookInfo(g.worst.bk).name)}</strong></span></span>
      </button>`;
    }).join('') : `<p class="none">No price gaps to show ${S.day === todayKey() ? 'right now' : S.day === 'all' ? 'yet' : dayName(S.day) === 'Tomorrow' ? 'for tomorrow' : 'for ' + esc(dayLong(S.day))}.</p>`;
    const vig = vigByBook(allowed);
    const max = Math.max(...vig.map(v => v.vig), 1);
    $('#vigList').innerHTML = vig.map(v => `<li class="${v.vig < 2 ? 'low' : ''}"><span>${esc(bookInfo(v.bk).name)}${bookInfo(v.bk).ex ? ' <span class="muted small">exchange</span>' : ''}</span><span class="pct">${v.vig.toFixed(1)}%</span><span class="bar"><i style="width:${Math.max(4, v.vig / max * 100).toFixed(0)}%"></i></span></li>`).join('');
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
      const count = sp.in_season === false ? 'off' : sp.events.filter(e => onDay(e)).length;
      return `<button class="tab" role="tab" data-sport="${esc(sp.key)}" aria-selected="${sp.key === S.sport}">${esc(sp.title)}<span class="count">${count}</span></button>`;
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

  // One game: a "Team bets" tab (spread / moneyline / total) and a "Player props" tab.
  function gameCard(ev, allowed) {
    const when = new Date(ev.commence_time);
    const started = when < new Date();
    const nBooks = Object.keys(ev.books).filter(k => allowed.has(k)).length;
    const mks = propMarkets(ev, allowed);
    const tab = S.openProps.get(ev.id) ? 'props' : 'team';
    const nPicked = S.legs.filter(l => l.eventId === ev.id && isProp(l.market)).length;
    const tabBtn = (k, label) => `<button class="gtab${k === 'props' && !mks.length ? ' none' : ''}" role="tab" data-gtab="${k}" data-gtev="${esc(ev.id)}" aria-selected="${tab === k}">${label}</button>`;
    const body = tab === 'team' ? `<div class="grid">
          <span></span><span class="h">Spread</span><span class="h">Money</span><span class="h">Total</span>
          <span class="team">${avatar(ev.away)}<span class="nm">${teamName(ev.away)}</span></span>
          ${pickBtn(ev, 'spreads', ev.away, allowed)}${pickBtn(ev, 'h2h', ev.away, allowed)}${pickBtn(ev, 'totals', 'Over', allowed, 'O')}
          <span class="team">${avatar(ev.home)}<span class="nm"><span class="at">@ </span>${teamName(ev.home)}</span></span>
          ${pickBtn(ev, 'spreads', ev.home, allowed)}${pickBtn(ev, 'h2h', ev.home, allowed)}${pickBtn(ev, 'totals', 'Under', allowed, 'U')}
        </div>` : propsBody(ev, allowed, mks);
    return `<article class="game" data-game="${esc(ev.id)}">
        <div class="game-meta"><span class="chip-time">${esc(timeFmt.format(when))}</span>${started ? '<span class="chip-live">● Started</span>' : ''}<span class="books-count">${nBooks} books</span></div>
        <div class="gtabs" role="tablist" aria-label="${esc(ev.away)} at ${esc(ev.home)}">
          <span class="gtitle">${esc(ev.away)} <span class="at">@</span> ${esc(ev.home)}</span>
          ${tabBtn('team', 'Team bets')}${tabBtn('props', `${ICONS.person}Player props${mks.length ? `<span class="count">${nPicked ? `${nPicked} picked` : mks.length}</span>` : ''}`)}
        </div>
        ${body}</article>`;
  }

  function renderGames() {
    if (!S.data) return;
    const box = $('#games');
    const allowed = allowedBooks();
    renderSearchNote();
    if (S.q.length >= 2) { box.innerHTML = searchHtml(allowed); return; }
    const sp = S.data.sports.find(s => s.key === S.sport);
    if (!sp || sp.in_season === false) { box.innerHTML = `<div class="game empty-msg">${esc(sp?.title || '')} is out of season.</div>`; return; }
    if (!sp.events.length) { box.innerHTML = `<div class="game empty-msg">No ${esc(sp.title)} lines posted yet.</div>`; return; }
    if (!allowed.size) { box.innerHTML = `<div class="game empty-msg">None of the books in this feed operate in ${esc(stateName(S.state))}.</div>`; return; }
    const evs = sp.events.filter(e => onDay(e));
    if (!evs.length) {
      const next = sp.events.filter(e => !hasStarted(e)).map(e => evDay(e)).filter(k => k > S.day).sort()[0];
      const when = S.day === todayKey() ? 'left today' : dayName(S.day) === 'Tomorrow' ? `tomorrow (${mdFmt.format(keyDate(S.day))})` : 'on ' + dayLong(S.day);
      box.innerHTML = `<div class="game empty-msg">No ${esc(sp.title)} games ${esc(when)}.${next ? ` <button class="link-btn jump" data-day="${next}">Next games: ${esc(dayLong(next))} →</button>` : ''}</div>`;
      return;
    }
    let lastDay = '', html = '';
    for (const e of evs) {
      const ev = S.events.get(e.id);
      const day = dayFmt.format(new Date(ev.commence_time));
      if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
      html += gameCard(ev, allowed);
    }
    box.innerHTML = html;
  }

  // ---------- search: type a team or player, across every sport ----------
  const normQ = v => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  function renderSearchNote() {
    const note = $('#searchNote');
    if (!note) return;
    note.hidden = S.q.length < 2;
    if (!note.hidden) note.innerHTML = `Results for <b>${esc(S.q)}</b> across every sport · <button class="link-btn" data-clearq>Clear</button>`;
    $('#sportTabs')?.classList.toggle('dim', S.q.length >= 2);
  }
  function searchHtml(allowed) {
    const q = normQ(S.q);
    const sportOrder = new Map(S.data.sports.map((sp, i) => [sp.key, i]));
    const evs = [...S.events.values()].filter(ev => !hasStarted(ev)).sort((a, b) => (sportOrder.get(a.sport) - sportOrder.get(b.sport)) || a.commence_time.localeCompare(b.commence_time));
    const games = evs.filter(ev => normQ(ev.home).includes(q) || normQ(ev.away).includes(q)).slice(0, 12);
    // Players: every prop market a matching player appears in, per game.
    const players = [];
    for (const ev of evs) {
      const found = new Map();
      for (const [bk, b] of Object.entries(ev.books)) {
        if (!allowed.has(bk)) continue;
        for (const [mk, outs] of Object.entries(b.markets)) {
          if (!isProp(mk)) continue;
          for (const o of outs) {
            if (!o.desc || !normQ(o.desc).includes(q)) continue;
            const k = `${o.desc}|${mk}`;
            if (!found.has(k)) found.set(k, { ev, desc: o.desc, mk, names: new Set() });
            found.get(k).names.add(o.name);
          }
        }
      }
      players.push(...found.values());
      if (players.length >= 40) break;
    }
    if (!games.length && !players.length) {
      return `<div class="game empty-msg">Nothing matches "${esc(S.q)}". Try a team name ("Lakers") or a player's last name. Player props only cover the next few games in each sport. <button type="button" class="link-btn" data-know="props">Why?</button></div>`;
    }
    let html = '';
    if (players.length) {
      const order = Object.keys(MARKET_LABELS);
      const byPlayer = new Map();
      for (const p of players) {
        const k = `${p.ev.id}|${p.desc}`;
        if (!byPlayer.has(k)) byPlayer.set(k, { ev: p.ev, desc: p.desc, rows: [] });
        byPlayer.get(k).rows.push(p);
      }
      html += `<div class="day">Players</div>`;
      for (const { ev, desc, rows } of byPlayer.values()) {
        rows.sort((a, b) => order.indexOf(a.mk) - order.indexOf(b.mk));
        html += `<article class="game"><div class="game-meta"><span class="chip-time">${esc(SPORT_NAMES[ev.sport] || '')}</span><span>${esc(ev.away)} @ ${esc(ev.home)} · ${esc(whenFmt.format(new Date(ev.commence_time)))}</span></div>
          <div class="sr-player">${ICONS.person}<b>${esc(desc)}</b></div><div class="prop-grid sr">${rows.map(r => {
            const yn = r.names.has('Yes') && !r.names.has('Over');
            return `<span class="player">${esc(mLabel(r.mk))}</span>${yn ? pickBtn(ev, r.mk, 'Yes', allowed, 'Yes', desc) + '<span></span>'
              : pickBtn(ev, r.mk, 'Over', allowed, 'O', desc) + pickBtn(ev, r.mk, 'Under', allowed, 'U', desc)}`;
          }).join('')}</div></article>`;
      }
    }
    if (games.length) {
      html += `<div class="day">Games</div>`;
      for (const ev of games) html += gameCard(ev, allowed);
    }
    return html;
  }

  function propMarkets(ev, allowed) {
    const mks = new Set();
    for (const [bk, b] of Object.entries(ev.books)) if (allowed.has(bk)) for (const k of Object.keys(b.markets)) if (isProp(k)) mks.add(k);
    const order = Object.keys(MARKET_LABELS);
    return [...mks].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  function propsBody(ev, allowed, mks) {
    if (!mks.length) {
      const hrs = (new Date(ev.commence_time) - Date.now()) / 3600e3;
      return `<div class="props-empty">${ICONS.person}<div><b>No player props for this game yet.</b><br>
        <span class="muted small">${hrs > 30 ? 'Props show up about a day before the game. ' : ''}We load props for upcoming games ${esc(pullFreq())}${ev.sport === 'basketball_ncaab' ? ' (college basketball props are off for now)' : ''}. <button type="button" class="link-btn" data-know="props">When do props show up?</button></span></div></div>`;
    }
    const open = S.openProps.get(ev.id);
    let html = '';
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
    const pct = Math.max(6, Math.min(100, (r.payout / bestPayout) * 100));
    const age = r.ex && r.minAge ? ` ${r.minAge}+` : '';
    return `<div class="row${i === 0 && isBestGroup ? ' best' : ''}">
      ${bchip(r)}
      <span class="bk"><span class="n">${esc(r.name)}</span><span class="badge ${r.ex ? 'ex' : 'book'}">${r.ex ? 'Exchange' + age : 'Book'}</span>${r.avail === 'check' ? '<span class="badge chk" title="Availability in your state is unclear right now">Verify</span>' : ''}<button class="betbtn" data-betbook="${esc(r.key)}" aria-label="Bet this at ${esc(r.name)}">Bet</button></span>
      <span class="money"><span class="pay">${money(r.payout)}</span><span class="odds">${fmtAm(r.am)}</span></span>
      <span class="meter"><span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span><span class="legp">${legs}</span></span>
    </div>`;
  }

  // Best price for one leg (exact line) across books legal here.
  function bestFor(leg) {
    let best = null;
    for (const bk of pricedBooks()) {
      const o = S.events.get(leg.eventId)?.books[bk]?.markets?.[leg.market]?.find(x => same(x, leg.name, leg.desc) && (leg.point == null || x.point === leg.point));
      if (o && (!best || toDec(o.price) > toDec(best))) best = o.price;
    }
    return best;
  }

  // "Pricing my books / all books" switch above the parlay results.
  function booksBar() {
    if (!hasMine()) {
      return `<div class="mine-bar"><span class="muted small">Pricing every book legal in ${esc(stateName(S.state))}.</span><button class="link-btn" data-mybooks>Pick my books</button></div>`;
    }
    const on = mineOn();
    return `<div class="mine-bar"><div class="seg" role="group" aria-label="Which books to price">
        <button data-mine="1" aria-pressed="${on}">My books · ${S.myBooks.size}</button><button data-mine="0" aria-pressed="${!on}">All books</button></div>
      <button class="link-btn" data-mybooks>Edit my books</button></div>`;
  }
  // With "My books" on, say so when a book the user doesn't have would pay more.
  function missedHtml(top) {
    if (!mineOn()) return '';
    const best = priceParlay(allowedBooks()).full[0];
    if (!best || S.myBooks.has(best.key) || best.payout - top.payout < 0.005) return '';
    return `<div class="note info"><strong>Best anywhere: ${esc(best.name)} pays ${money(best.payout)}</strong>, ${money(best.payout - top.payout)} more than your best book. <button class="link-btn" data-mine="0">Compare all books</button></div>`;
  }

  function renderSlip() {
    const n = S.legs.length;
    $('#legs').innerHTML = S.legs.map((l, i) => {
      const ev = S.events.get(l.eventId);
      const b = bestFor(l);
      return `<li class="leg"><span><span class="what">${esc(legLabel(l))}</span><span class="game-l">${esc(ev.away)} @ ${esc(ev.home)}</span></span>
        <span class="best">${b == null ? '' : fmtAm(b)}</span>
        <button class="bell" data-alert="${i}" aria-label="Alert me when ${esc(legLabel(l))} moves" title="Alert me when this moves">${ICONS.bell}</button>
        <button class="x" data-rm="${i}" aria-label="Remove ${esc(legLabel(l))}">×</button></li>`;
    }).join('');
    $('#empty').hidden = n > 0;
    $('#clearLegs').hidden = n === 0;
    $('#stakeRow').hidden = n === 0;
    $('#tabBadge').hidden = n === 0;
    $('#tabBadge').textContent = n;
    $('#resultsSub').textContent = n ? `${n === 1 ? 'Straight bet' : n + '-leg parlay'} · ${money(S.stake)} · ${stateName(S.state)}` : 'Step 2 · compare';
    for (const b of document.querySelectorAll('#stakeChips button')) b.classList.toggle('on', Number(b.dataset.stake) === S.stake);

    const warn = [];
    const perGame = new Map();
    for (const l of S.legs) perGame.set(l.eventId, (perGame.get(l.eventId) || 0) + 1);
    if ([...perGame.values()].some(c => c > 1)) {
      warn.push(`<div class="note warn"><strong>Same-game parlay.</strong> Books price these with their own correlation models, so the real payout in the app will usually differ (often lower) from the leg-by-leg math below.</div>`);
    }

    let res = '', seeBest = '';
    if (n > 0) {
      res += booksBar();
      const { full, alt, missing } = priceParlay();
      if (mineOn() && !full.length && !alt.length) {
        res += `<div class="note info">None of your books (${esc(myBookNames().join(', '))}) offer every leg in ${esc(stateName(S.state))}. <button class="link-btn" data-mine="0">Compare all books</button></div>`;
      }
      if (full.length) {
        const top = full[0], worst = full[full.length - 1];
        const edge = top.payout - worst.payout;
        seeBest = `See best payout · ${money(top.payout)}`;
        res += `<div class="payout">
          <span class="lbl">Best payout · ${esc(top.name)}</span>
          <span class="big">${money(top.payout)}</span>
          <span class="sub">${full.length > 1 && edge > 0.005 ? `+${money(edge)} more than ${esc(worst.name)}` : 'Only book with every leg at these lines'} · ${fmtAm(top.am)}</span>
        </div>`;
        res += `<div class="rank"><h3><span>Same lines</span><span>${full.length} book${full.length === 1 ? '' : 's'}</span></h3>${full.map((r, i) => rowHtml(r, i, true, top.payout)).join('')}</div>`;
        res += missedHtml(top);
        res += `<button class="cta light open-best" data-betbook="${esc(top.key)}">Bet this at ${esc(top.name)}</button>`;
        res += SAVE_BTN;
      } else {
        if (!(mineOn() && !alt.length)) res += `<div class="note info">No ${mineOn() ? 'book of yours' : 'book'} in ${esc(stateName(S.state))} has every leg at the exact same line.</div>`;
      }
      if (alt.length) {
        const ref = full[0]?.payout || alt.reduce((m, r) => Math.max(m, r.payout), 0);
        res += `<div class="rank"><h3><span>Different line on a leg</span><span>${alt.length}</span></h3>${alt.map((r, i) => rowHtml(r, i, false, ref)).join('')}</div>`;
        if (!full.length) res += SAVE_BTN;
      }
      if (full.length || alt.length) {
        res += `<p class="hint">Tap <b>Bet</b> on any book to fill in its bet slip. You place the bet in that book's app, where you're already signed in. A price with ↗ adds just that leg.</p>`;
      }
      if (missing.length) res += `<p class="missing">Not offering every leg: ${missing.map(k => esc(bookInfo(k).name)).join(', ')}</p>`;
      if ([...full, ...alt].some(r => r.ex)) {
        res += `<div class="note info"><strong>Prediction markets</strong> (Kalshi, Polymarket, Novig, ProphetX) are priced leg-by-leg. Trading fees aren't included, and a native combo there may be priced differently.</div>`;
      }
    }
    $('#warnings').innerHTML = warn.join('');
    $('#out').innerHTML = res;
    const sb = $('#seeBest');
    sb.hidden = !seeBest;
    sb.textContent = seeBest;
  }

  function setTab(t) {
    S.tab = t;
    S.view = GAME_TABS.has(t) ? 'games' : VIEWS.has(t) ? t : 'games';
    if (GAME_TABS.has(t)) S.lastGameTab = t;
    const app = $('.app');
    app.dataset.tab = t;
    app.dataset.view = S.view;
    for (const b of document.querySelectorAll('.tabbar [data-tab]')) {
      if (b.dataset.tab === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    for (const b of document.querySelectorAll('.views [data-view]')) {
      if (b.dataset.view === S.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    if (S.view === 'season') renderSeason();
    if (S.view === 'bets') { renderBets(); if (S.user) loadAlerts(); }
    if (S.view === 'money') renderMoney();
    if (window.matchMedia('(max-width: 860px)').matches) window.scrollTo(0, 0);
  }
  const setView = v => setTab(v === 'games' ? (S.lastGameTab || 'today') : v);

  function render() {
    renderDays();
    renderStatus();
    renderToday();
    renderBanner();
    renderTabs();
    renderGames();
    renderSlip();
    renderSeason();
    renderBets();
    renderMoney();
    if ($('#betDialog')?.open) renderBetDialog();
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

  // ---------- "Good to know": what the data can and can't show ----------
  // Numbers come from odds.json's `config` (written by scripts/fetch-odds.mjs), so the copy follows the Actions
  // variables and the plan. The defaults below are only used until a file with `config` exists.
  const KNOW_DEFAULTS = {
    days_ahead: 14, lines_hours: { basketball_ncaab: 168 }, min_books: { basketball_ncaab: 3 },
    lines_every_days: 1, props_runs_per_day: 12, lines_runs_per_day: 12, prop_window_hours: 30,
    run_every_hours: 2, run_minute: 17, quota_reset_day: 7,
    prop_games: { americanfootball_nfl: 16, basketball_nba: 15, americanfootball_ncaaf: 12, basketball_ncaab: 0 },
    prop_markets: {
      americanfootball_nfl: ['player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_anytime_td'],
      basketball_nba: ['player_points', 'player_rebounds', 'player_assists'],
      americanfootball_ncaaf: ['player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_anytime_td'],
      basketball_ncaab: ['player_points', 'player_rebounds', 'player_assists'],
    },
  };
  const RUN_UTC = [16, 47];   // the old once-a-day run (16:47 UTC), used only if config has no run_every_hours
  const knowConf = () => ({ ...KNOW_DEFAULTS, ...(S.data?.config || {}) });
  // "every 2 hours" / "once a day": how often the odds update, for copy around the site.
  const pullFreq = (C = knowConf()) => (C.run_every_hours > 0 ? (C.run_every_hours === 1 ? 'every hour' : `every ${C.run_every_hours} hours`) : 'once a day');
  const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const KNOW_SPORTS = { americanfootball_nfl: 'NFL', basketball_nba: 'NBA', americanfootball_ncaaf: 'college football', basketball_ncaab: 'college basketball' };
  const KNOW_SPORT_LIST = Object.keys(KNOW_SPORTS);
  const PROP_WORDS = {
    player_pass_yds: 'passing yards', player_rush_yds: 'rushing yards', player_reception_yds: 'receiving yards',
    player_receptions: 'receptions', player_pass_tds: 'passing TDs', player_anytime_td: 'anytime TD',
    player_points: 'points', player_rebounds: 'rebounds', player_assists: 'assists', player_threes: 'threes',
    player_points_rebounds_assists: 'points + rebounds + assists',
  };
  const knowWhen = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const knowTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const andList = a => (a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // Next scheduled run (lines only run on odd days of the month when they refresh every other day).
  function nextRun(linesOnly, C) {
    const now = new Date();
    if (C.run_every_hours > 0) {   // runs at :run_minute UTC on every hour divisible by run_every_hours
      const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), C.run_minute ?? 0));
      while (t <= now || t.getUTCHours() % C.run_every_hours) t.setUTCHours(t.getUTCHours() + 1);
      return t;
    }
    for (let i = 0; i < 40; i++) {
      const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i, RUN_UTC[0], RUN_UTC[1]));
      if (t <= now) continue;
      if (linesOnly && C.lines_every_days === 2 && t.getUTCDate() % 2 === 0) continue;
      return t;
    }
    return null;
  }

  function knowNow(C) {
    if (!S.data || S.source === 'sample') return '';
    const now = Date.now();
    const rows = [];
    for (const key of KNOW_SPORT_LIST) {
      const sp = S.data.sports?.find(s => s.key === key);
      if (!sp) continue;
      const name = SPORT_NAMES[key] || key;
      if (!sp.in_season) { rows.push(`<li><b>${esc(name)}</b><span class="muted">Out of season</span></li>`); continue; }
      const withProps = (sp.events || []).filter(e => new Date(e.commence_time).getTime() > now &&
        Object.values(e.books || {}).some(b => Object.keys(b.markets || {}).some(isProp)));
      const short = n => String(n).split(/\s+/).pop();
      const propsTxt = withProps.length
        ? `Props for ${esc(withProps.slice(0, 4).map(e => `${short(e.away)} @ ${short(e.home)}`).join(', '))}${withProps.length > 4 ? ` +${withProps.length - 4} more` : ''}`
        : (C.prop_games?.[key] ? 'No props loaded right now' : 'Props off for now');
      rows.push(`<li><b>${esc(name)}</b><span>Lines ${esc(ago(sp.lines_at) || 'not loaded')} · ${propsTxt}</span></li>`);
    }
    let next = '';
    if (C.run_every_hours > 0) {
      const t = nextRun(false, C);
      if (t) next = `<p class="muted small">Next update: lines and props ${esc(knowWhen.format(t))} (your time; it can run a few minutes late).</p>`;
    } else if (C.props_runs_per_day === 1 && [1, 2].includes(C.lines_every_days)) {
      const p = nextRun(false, C), l = nextRun(true, C);
      if (p && l) next = `<p class="muted small">Next update: ${p.getTime() === l.getTime() ? `lines and props ${esc(knowWhen.format(p))}` : `props ${esc(knowWhen.format(p))}, game lines ${esc(knowWhen.format(l))}`} (your time; it can run a few minutes late).</p>`;
    }
    return `<div class="know-now"><h4>Right now</h4><ul>${rows.join('')}</ul>${next}</div>`;
  }

  function knowSections(C) {
    const runLocal = knowTime.format(nextRun(false, C) || new Date());
    const often = C.run_every_hours > 0;
    const linesFreq = often && C.lines_runs_per_day > 0 ? pullFreq(C) : C.lines_every_days === 1 ? 'every day' : C.lines_every_days === 2 ? 'every other day' : `every ${C.lines_every_days} days`;
    const propsFreq = often ? pullFreq(C) : C.props_runs_per_day === 1 ? 'every day' : `${C.props_runs_per_day} times a day`;
    const resetTxt = ordinal(C.quota_reset_day || 1);
    const ncaabDays = Math.round((C.lines_hours?.basketball_ncaab ?? C.days_ahead * 24) / 24);
    const minBooks = C.min_books?.basketball_ncaab ?? 1;
    const win = C.prop_window_hours;
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    const pullTxt = linesFreq === propsFreq ? `game lines and player props ${linesFreq}` : `game lines ${linesFreq}, player props ${propsFreq}`;
    const propsAhead = win <= 36 ? 'about a day' : `about ${Math.round(win / 24)} days`;
    const on = KNOW_SPORT_LIST.filter(k => (C.prop_games?.[k] || 0) > 0);
    const off = KNOW_SPORT_LIST.filter(k => !(C.prop_games?.[k] > 0));
    const gamesTxt = andList(on.map(k => `${plural(C.prop_games[k], `${KNOW_SPORTS[k]} game`)}`));
    // Group sports that load the same prop types ("NFL and college football: ...").
    const groups = new Map();
    for (const k of on) {
      const words = (C.prop_markets?.[k] || []).map(m => PROP_WORDS[m] || mLabel(m).toLowerCase());
      const sig = words.join(', ');
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(KNOW_SPORTS[k]);
    }
    const typesTxt = [...groups].map(([w, sps]) => `${cap(andList(sps))}: ${w}`).join('. ');
    const loaded = new Set(on.flatMap(k => C.prop_markets?.[k] || []));
    const notYet = ['player_receptions', 'player_threes', 'player_points_rebounds_assists'].filter(m => !loaded.has(m)).map(m => PROP_WORDS[m]);
    const EXTRA_TITLES = { williamhill_us: 'Caesars', fanatics: 'Fanatics', bet365: 'bet365', ballybet: 'Bally Bet', fliff: 'Fliff', betparx: 'betPARX' };
    const books = (S.data?.bookmakers || Object.keys(BOOK_TITLES)).map(k => BOOK_TITLES[k] || EXTRA_TITLES[k] || bookInfo(k).name);
    const missingBooks = [['williamhill_us', 'Caesars'], ['fanatics', 'Fanatics']].filter(([k]) => !(S.data?.bookmakers || []).includes(k)).map(([, n]) => n);
    const asOf = S.avail?.as_of && /^\d{4}-\d{2}-\d{2}$/.test(S.avail.as_of) ? new Date(S.avail.as_of + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : S.avail?.as_of;
    const checked = asOf ? ` on ${esc(asOf)}` : '';

    return [
      { id: 'odds', title: 'How fresh the odds are', items: [
        ['It’s a snapshot, not a live feed.', often
          ? `We pull prices ${esc(pullFreq(C))} (next at about ${esc(runLocal)} your time): ${pullTxt}. Lines can move in between, especially after injury news, so check the “updated” time above each board.`
          : `We pull prices once a day at about ${esc(runLocal)} your time: ${pullTxt}. Lines can move a lot in between, especially after injury news, so check the “updated” time above each board.`],
        ['No live in-game odds.', 'Once a game starts, the prices here are pre-game and out of date. Don’t use them to bet live.'],
        ['Future days fill in as the books post them.', `We show game lines up to ${C.days_ahead} days out (${ncaabDays} for college basketball), but each book posts on its own schedule. NBA lines are often only a day or two out and NFL about a week, so a day that looks empty usually just hasn’t been posted yet.`],
        ['Main game lines only.', 'Moneyline, spread and total for the full game. No alternate lines, halves, quarters or team totals yet.'],
        ...(minBooks > 1 ? [['Small college basketball games are hidden.', `Games with fewer than ${minBooks} books pricing them don’t appear.`]] : []),
        ['Season-long bets update on their own clock.', `Kalshi futures refresh ${often ? esc(pullFreq(C)) : 'every day'}; sportsbook futures about once a week.`],
      ] },
      { id: 'props', title: 'Player props', items: [
        [`Props show up ${propsAhead} before the game.`, often
          ? `We load props for games that start within the next ${win} hours. Books often post props earlier; this is our limit, not theirs.`
          : `We only load props for games that start within ${win} hours of our daily pull.${win <= 36 ? ` So Sunday’s NFL props appear on Saturday or Sunday morning, and a night NBA game’s props appear that morning.` : ''} Books often post props earlier; this is our limit, not theirs.`],
        often
          ? ['Props refresh in rotation.', `We cover up to ${gamesTxt || 'a set number of games'} in that window. Each pull refreshes the games whose props are oldest, so on a busy slate some games’ props can be a few hours old.${off.length ? ` ${cap(andList(off.map(k => KNOW_SPORTS[k])))} props are off for now.` : ''}`]
          : ['Only the next few games in each sport.', `Each pull loads props for the next ${gamesTxt || 'few games'} starting in that window.${off.length ? ` ${cap(andList(off.map(k => KNOW_SPORTS[k])))} props are off for now.` : ''} On a busy day most games won’t have props here, even when the books have them.`],
        ['A short list of prop types.', `${esc(typesTxt)}.${` Not loaded yet: ${andList([...notYet, 'first TD scorer', 'alternate prop lines'])}.`}`],
        ['Late in the month we may load fewer.', `Our data plan resets on the ${resetTxt} of each month. If it runs low, we skip some prop games so the rest of the board keeps updating.`],
      ] },
      { id: 'parlay', title: 'Parlay payouts', items: [
        ['Standard parlay math.', 'We multiply each leg’s price, which is how books pay a regular parlay. If the prices haven’t moved, the payout should match.'],
        ['Same-game parlays will differ.', 'Books price legs from the same game with their own models, and the real payout is usually lower than ours. We flag these on your parlay.'],
        ['No boosts, promos or bonus bets.', 'Odds boosts, profit boosts, parlay insurance and each book’s maximum payout limits aren’t included.'],
        ['Check your bet slip.', 'Bet links open the book with your pick when they can. Some only reach the game page, and the one-tap whole-parlay link is still in beta.'],
      ] },
      { id: 'books', title: 'Books and states', items: [
        [`We compare ${books.length} books and exchanges.`, `${esc(andList(books))}.${missingBooks.length ? ` ${esc(andList([...missingBooks, 'some others']))} aren’t included yet.` : ''}`],
        ['It’s where you are, not where you live.', 'Books check your location when you bet. Pick the state you’ll be in when you place it.'],
        ['Laws change.', `We checked where each platform is legal${checked} and recheck about once a month. <button type="button" class="link-btn" id="knowStates">See every state and our sources</button>`],
        ['Prediction markets have fees and limits.', 'Kalshi, Polymarket, Novig and ProphetX prices are shown before their trading fees (Sports Book Arbitrage adds Kalshi’s estimated fee). The price shown may only be there for a small amount; a bigger bet can fill at a worse price.'],
      ] },
      { id: 'money', title: 'Sports Book Arbitrage', items: [
        ['These go fast.', 'Sure things and edges come from our last pull, and books often fix them within minutes. Check both prices in the apps before you bet either side.'],
        ['Most involve prediction markets.', 'Their fees and small available amounts can wipe out a thin edge.'],
        ['Books can limit you.', 'Sportsbooks sometimes cap or close accounts that regularly bet arbitrage.'],
      ] },
      { id: 'bets', title: 'My bets and alerts', items: [
        ['Grading happens while fckvig is open.', 'About 2½ hours after the start we check ESPN’s final box scores, then every 10 minutes while the site is open. If it’s closed, your bets are graded the next time you open it.'],
        ['Some bets need you.', 'Postponed games, players who didn’t play and anything we can’t confirm are marked Needs review. Futures settle by hand. Each book has its own rules for these, and the book’s result is the one that counts.'],
        ['Without an account, bets stay in this browser.', 'Clearing your browser data deletes them. Sign in to keep them on every device.'],
        ['Alerts aren’t instant.', `We check alerts right after each odds update, so about ${esc(pullFreq(C))}. A line can move and move back in between. On iPhone, push alerts need fckvig added to your Home Screen.`],
      ] },
    ];
  }

  function openKnow(section) {
    const C = { ...KNOW_DEFAULTS, ...(S.data?.config || {}) };
    const secs = knowSections(C);
    $('#knowJump').innerHTML = secs.map(s => `<button type="button" class="chip" data-know-jump="${s.id}">${esc(s.title)}</button>`).join('');
    $('#knowBody').innerHTML = knowNow(C) + secs.map(s => `<section class="know-sec" id="know-${s.id}"><h4 class="about-h">${esc(s.title)}</h4><ul class="know-list">${
      s.items.map(([h, t]) => `<li><b>${esc(h)}</b> ${t}</li>`).join('')}</ul></section>`).join('') +
      '<p class="muted small know-foot">Most of these limits come from our current data plan, which charges for every market we pull. We don’t take bets and aren’t affiliated with any book.</p>';
    const dlg = $('#knowDialog');
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
    knowJump(section);
  }
  function knowJump(id) {
    const card = $('#knowDialog .modal-card');
    const el = id && $(`#know-${id}`);
    if (!el) { card.scrollTop = 0; return; }
    card.scrollTop += el.getBoundingClientRect().top - card.getBoundingClientRect().top - 8;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  // ---------- season-long markets ----------
  const SAVE_BTN = `<div class="cta-row"><button class="cta ghost save-bet" data-save="parlay">Save to My bets</button><button class="cta ghost share-bet" data-share="parlay">${ICONS.share}<span>Share</span></button></div>`;
  const SPORT_ORDER = ['americanfootball_nfl', 'basketball_nba', 'americanfootball_ncaaf', 'basketball_ncaab'];
  const SPORT_NAMES = { americanfootball_nfl: 'NFL', basketball_nba: 'NBA', americanfootball_ncaaf: 'College Football', basketball_ncaab: 'College Basketball' };
  const GROUP_ORDER = ['Champion', 'Awards', 'Stat leaders', 'Win totals'];
  const MAX_ROWS = 80;
  const impl = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
  const okBook = k => availability(k) !== 'no';

  const BOOK_TITLES = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', espnbet: 'theScore Bet', betrivers: 'BetRivers', hardrockbet: 'Hard Rock Bet', kalshi: 'Kalshi', polymarket_us: 'Polymarket', novig: 'Novig', prophetx: 'ProphetX' };
  // Futures can list a book that has no game lines today, so fall back to a known display name.
  function futuresBookInfo(key) {
    const i = bookInfo(key);
    return i.name === key && BOOK_TITLES[key] ? { ...i, name: BOOK_TITLES[key] } : i;
  }

  // Prices for one outcome at books legal in the chosen state, best first.
  function outcomePrices(o) {
    return Object.entries(o.prices || {}).filter(([k, a]) => okBook(k) && Number.isFinite(a)).sort((a, b) => toDec(b[1]) - toDec(a[1]));
  }

  function renderSeason() {
    const list = $('#marketList'), view = $('#marketView');
    if (!list) return;
    const F = S.futures;
    if (!F) { list.innerHTML = '<p class="muted small">Loading season-long markets…</p>'; view.innerHTML = ''; return; }
    const markets = (F.markets || []).filter(m => m.outcomes?.some(o => outcomePrices(o).length));
    if (!markets.length) {
      $('#seasonSports').innerHTML = '';
      list.innerHTML = '';
      view.innerHTML = `<div class="game empty-msg">${F.missing ? 'Season-long markets appear here after the next data update.' : `No season-long markets are available in ${esc(stateName(S.state))} right now.`}</div>`;
      return;
    }
    const sports = SPORT_ORDER.filter(k => markets.some(m => m.sport === k));
    if (!sports.includes(S.seasonSport)) S.seasonSport = sports[0];
    $('#seasonSports').innerHTML = sports.map(k => `<button class="tab" role="tab" data-ssport="${k}" aria-selected="${k === S.seasonSport}">${esc(SPORT_NAMES[k])}<span class="count">${markets.filter(m => m.sport === k).length}</span></button>`).join('');
    const mine = markets.filter(m => m.sport === S.seasonSport);
    if (!mine.some(m => m.id === S.market)) S.market = mine[0].id;
    const groups = GROUP_ORDER.map(g => [g, mine.filter(m => m.group === g)]).filter(([, ms]) => ms.length);
    for (const m of mine) if (!GROUP_ORDER.includes(m.group) && !groups.some(([g]) => g === m.group)) groups.push([m.group, mine.filter(x => x.group === m.group)]);
    list.innerHTML = groups.map(([g, ms]) => `<div class="mgroup"><h3>${esc(g)}</h3><div class="mitems">${ms.map(m => {
      const books = new Set(m.outcomes.flatMap(o => outcomePrices(o).map(([k]) => k)));
      return `<button class="mitem" data-market="${esc(m.id)}" aria-pressed="${m.id === S.market}"><span>${esc(m.title)}</span><span class="mcount">${books.size} book${books.size === 1 ? '' : 's'}</span></button>`;
    }).join('')}</div></div>`).join('');
    const fresh = [F.kalshi_at && `Kalshi ${ago(F.kalshi_at)}`, F.books_at && `sportsbooks ${ago(F.books_at)}`].filter(Boolean).join(' · ');
    $('#seasonFresh').textContent = fresh ? `Updated: ${fresh}` : '';
    renderMarket();
  }

  function renderMarket() {
    const view = $('#marketView');
    const m = S.futures?.markets?.find(x => x.id === S.market);
    if (!m) { view.innerHTML = ''; return; }
    const q = S.marketSearch.trim().toLowerCase();
    const rows = [];
    m.outcomes.forEach((o, i) => {
      const ps = outcomePrices(o);
      if (!ps.length) return;
      if (q && !o.name.toLowerCase().includes(q)) return;
      rows.push({ o, i, ps });
    });
    const allBooks = new Set(m.outcomes.flatMap(o => Object.keys(o.prices || {})));
    const onlyKalshi = allBooks.size === 1 && allBooks.has('kalshi');
    const notes = [];
    if (m.type === 'ladder') notes.push('These are "at least N wins" contracts. A sportsbook over 10.5 wins is the same bet as 11+ wins here.');
    if (allBooks.has('kalshi')) notes.push('Kalshi prices are the current ask, before trading fees. Thin quotes are left out.');
    if (onlyKalshi) notes.push("Our sportsbook feed doesn't carry this market, so these are Kalshi prices only.");
    const shown = rows.slice(0, MAX_ROWS);
    view.innerHTML = `
      <div class="mhead"><div><h3 class="mtitle">${esc(m.title)}</h3><span class="muted small">${esc(SPORT_NAMES[m.sport] || '')}${m.season ? ` · ${esc(m.season)} season` : ''} · ${allBooks.size} source${allBooks.size === 1 ? '' : 's'}</span></div>
        <input id="fsearch" class="psearch" type="search" placeholder="${m.type === 'player' ? 'Search players' : 'Search teams'}" value="${esc(S.marketSearch)}" aria-label="Search this market"></div>
      ${notes.map(n => `<p class="note info">${esc(n)}</p>`).join('')}
      <div class="frows">${shown.map(({ o, i, ps }) => {
        const [bk, am] = ps[0];
        const info = futuresBookInfo(bk);
        const link = cleanLink(o.links?.[bk] || (bk === 'kalshi' ? m.links?.kalshi : null));
        const others = ps.slice(1, 7).map(([k, a]) => `<span class="lp" title="${esc(futuresBookInfo(k).name)}">${esc(futuresBookInfo(k).short)} ${fmtAm(a)}</span>`).join('');
        return `<div class="frow">
          <span class="fname">${esc(o.name)}</span>
          <span class="fbest">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">` : '<span>'}<b>${fmtAm(am)}</b> <span class="fbook">${esc(info.name)}${link ? ' ↗' : ''}</span>${link ? '</a>' : '</span>'}
            <span class="fpct">${Math.round(impl(am) * 100)}% implied</span></span>
          <span class="fothers legp">${others}</span>
          <button class="chip fsave" data-fsave="${i}" aria-label="Save ${esc(o.name)}">Save</button>
        </div>`;
      }).join('') || `<p class="muted">${q ? 'Nothing matches.' : 'No prices at books available in your state.'}</p>`}</div>
      ${rows.length > MAX_ROWS ? `<p class="hint">Showing ${MAX_ROWS} of ${rows.length}. Search to find the rest.</p>` : ''}`;
  }

  // ---------- saving a bet ----------
  let pending = null;
  const parseAm = v => {
    const n = Number(String(v).trim().replace(/^\+/, ''));
    return Number.isFinite(n) && Math.abs(n) >= 100 ? Math.round(n) : null;
  };

  function openSaveParlay(bookKey) {
    const { full, alt } = priceParlay(allowedBooks());
    const rows = [...full, ...alt];
    if (!rows.length || !S.legs.length) return;
    pending = {
      kind: 'parlay',
      legs: S.legs.map(l => ({ ...l })),
      opts: rows.map(r => ({ key: r.key, name: r.name, am: r.am, legs: r.legs, diff: !full.includes(r) })),
    };
    pending.best = pending.opts[0];
    if (bookKey) { const i = pending.opts.findIndex(o => o.key === bookKey); if (i > 0) pending.opts.unshift(...pending.opts.splice(i, 1)); }
    openSaveDialog(S.legs.length === 1 ? legLabel(S.legs[0]) : `${S.legs.length}-leg parlay`, S.legs.map(legLabel));
  }

  function openSaveFuture(idx) {
    const m = S.futures?.markets?.find(x => x.id === S.market);
    const o = m?.outcomes?.[idx];
    if (!o) return;
    const ps = outcomePrices(o);
    if (!ps.length) return;
    pending = { kind: 'future', market: m, outcome: o, opts: ps.map(([k, am]) => ({ key: k, name: futuresBookInfo(k).name, am, legs: [{ price: am }] })) };
    openSaveDialog(o.name, [`${m.title}${m.season ? ` (${m.season})` : ''}`]);
  }

  function openSaveDialog(title, lines) {
    if (!S.user) {   // saving needs an account (free accounts save a few a day)
      afterAuth = () => { if (pending) openSaveDialog(title, lines); };
      return openAcct('signup', `Create a free account to save bets. We'll grade them automatically and keep them on every device. Free accounts save ${FREE_N()} bets a day.`);
    }
    const q = S.quota;
    if (q && !q.unlimited && q.left <= 0 && Date.now() < q.resets_at) { pending = null; return openPlan('limit'); }
    $('#saveQuota').textContent = q && !q.unlimited ? `${q.left} of ${q.limit} free saves left today.` : '';
    $('#saveTitle').textContent = title;
    $('#saveLegs').innerHTML = lines.map(l => `<li>${esc(l)}</li>`).join('');
    $('#saveBook').innerHTML = pending.opts.map(o => `<option value="${esc(o.key)}">${esc(o.name)} · ${fmtAm(o.am)}${o.diff ? ' (different line)' : ''}</option>`).join('')
      + '<option value="watch">Not placed yet. Just track it</option>';
    $('#saveBook').value = pending.opts[0].key;
    $('#saveStake').value = S.stake || 10;
    $('#saveOdds').value = fmtAm(pending.opts[0].am);
    $('#saveErr').textContent = '';
    updateSaveDialog();
    const d = $('#saveDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }

  function updateSaveDialog(fromBook) {
    if (!pending) return;
    const sel = $('#saveBook').value;
    const watch = sel === 'watch';
    const opt = watch ? (pending.best || pending.opts[0]) : pending.opts.find(o => o.key === sel);
    if (fromBook) $('#saveOdds').value = fmtAm(opt.am);
    $('#saveOdds').disabled = watch;
    $('#saveOddsWrap').hidden = watch;
    const stake = Number($('#saveStake').value);
    const am = watch ? opt.am : parseAm($('#saveOdds').value);
    $('#saveWin').textContent = stake > 0 && am != null ? `Pays ${money(stake * toDec(am))} (${money(stake * toDec(am) - stake)} profit)` : '';
    $('#saveHint').textContent = watch ? `We'll track it at the best price (${opt.name} ${fmtAm(opt.am)}). It won't count toward your record.`
      : pending.kind === 'parlay' && S.legs.length > 1 ? 'If the book quoted a different total (same-game parlays, boosts), type the odds you actually got.' : '';
  }

  async function commitSave() {
    if (!pending) return false;
    if (!S.user) { afterAuth = null; openAcct('signin'); return true; }
    const sel = $('#saveBook').value;
    const watch = sel === 'watch';
    const opt = watch ? (pending.best || pending.opts[0]) : pending.opts.find(o => o.key === sel);
    const stake = Math.round(Number($('#saveStake').value) * 100) / 100;
    if (!(stake > 0) || stake > 1e7) { $('#saveErr').textContent = 'Enter a stake above $0.'; return false; }
    const am = watch ? opt.am : parseAm($('#saveOdds').value);
    if (am == null) { $('#saveErr').textContent = 'Enter American odds like -110 or +250.'; return false; }
    let legs;
    if (pending.kind === 'parlay') {
      legs = pending.legs.map((l, k) => {
        const ev = S.events.get(l.eventId);
        const lp = opt.legs[k] || {};
        const point = lp.point ?? l.point ?? null;
        return {
          t: isProp(l.market) ? 'prop' : 'game', sport: ev.sport, eventId: l.eventId, home: ev.home, away: ev.away,
          commence: ev.commence_time, market: l.market, name: l.name, desc: l.desc || null, point,
          price: lp.price, label: legLabel({ ...l, point }),
        };
      });
    } else {
      const m = pending.market, o = pending.outcome;
      legs = [{ t: 'future', sport: m.sport, market: m.id, title: m.title, season: m.season || null, name: o.name, price: opt.am, label: `${m.title}: ${o.name}` }];
    }
    const now = Date.now();
    const bet = {
      id: newId(), v: 1, created: new Date(now).toISOString(), updated: now,
      kind: pending.kind === 'future' ? 'future' : legs.length > 1 ? 'parlay' : 'single',
      placed: !watch, book: watch ? null : opt.key, bookName: watch ? null : opt.name,
      stake, odds: am, oddsEdited: !watch && am !== opt.am,
      status: 'open', payout: null, settledAt: null, manual: false, legs,
    };
    const btn = $('#saveSubmit');
    btn.disabled = true;
    try {
      const r = await api('/api/bets/save', { bet });
      if (r.quota) S.quota = r.quota;
    } catch (err) {
      if (err.status === 402) {
        if (err.data?.quota) S.quota = err.data.quota;
        pending = null;
        $('#saveDialog').close();
        renderBets();
        openPlan('limit');
        return false;
      }
      if (err.status === 401) { setSession(null); renderBets(); $('#saveDialog').close(); openAcct('signin', 'Your session expired. Sign in again to save this bet.'); return false; }
      $('#saveErr').textContent = err.status ? err.message : "Couldn't reach the server, so this bet isn't saved yet. Check your connection and try again.";
      return false;
    } finally { btn.disabled = false; }
    S.bets = mergeBets(S.bets, [bet]);
    persistBets();
    pending = null;
    const q = S.quota;
    const left = q && !q.unlimited ? ` · ${q.left ? `${q.left} free save${q.left === 1 ? '' : 's'} left today` : 'that was today\'s last free save'}` : '';
    toast((watch ? 'Saved. Tracking it in My bets' : 'Saved to My bets') + left);
    return true;
  }

  // ---------- membership ----------
  function setMembership(m) {
    if (!m || !m.plan) return;
    S.plan = m.plan; S.quota = m.quota; S.billing = m.billing; S.admin = !!m.admin;
  }

  function openPlan(why) {
    const d = $('#planDialog');
    if (!d) return;
    const q = S.quota;
    $('#planKicker').textContent = why === 'limit' && q ? `You've used today's ${q.limit} free saves. They reset at midnight Central.` : '';
    $('#planKicker').hidden = !$('#planKicker').textContent;
    $('#planErr').textContent = '';
    $('#planMsg').textContent = '';
    $('#planCode').value = '';
    $('#planCompare').innerHTML = `<tr class="me"><th scope="row">fck the vig Unlimited</th><td>${esc(PLAN_PRICE.month)}/mo</td></tr>`
      + COMPETITORS.map(([n, p]) => `<tr><th scope="row">${esc(n)}</th><td>${esc(p)}</td></tr>`).join('');
    renderPlan();
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }

  function renderPlan() {
    if (!$('#planDialog')) return;
    const unlimited = S.plan?.name === 'unlimited';
    const annual = !!S.billing?.annual;
    if (!annual) S.planInterval = 'month';
    $('#planIntervals').hidden = unlimited || !annual;
    for (const b of document.querySelectorAll('[data-interval]')) b.setAttribute('aria-pressed', b.dataset.interval === S.planInterval);
    $('#planYearLabel').textContent = `${PLAN_PRICE.year}/yr`;
    $('#planYearSub').textContent = `${PLAN_PRICE.yearPerMonth}/mo · save ${PLAN_PRICE.yearSave}`;
    $('#planMonthLabel').textContent = `${PLAN_PRICE.month}/mo`;
    $('#planFreeN').textContent = FREE_N();
    const buy = $('#planBuy');
    buy.disabled = false;
    if (unlimited) { buy.textContent = "You're on Unlimited"; buy.disabled = true; }
    else if (!S.user) buy.textContent = 'Create a free account first';
    else if (!S.billing?.ready) { buy.textContent = 'Payments open soon'; buy.disabled = true; }
    else buy.textContent = S.planInterval === 'year' ? `Go Unlimited · ${PLAN_PRICE.year}/year` : `Go Unlimited · ${PLAN_PRICE.month}/month`;
    $('#planBuyNote').textContent = unlimited ? '' : !S.user ? '' : S.billing?.ready ? 'Secure checkout by Stripe. Cancel anytime.' : 'Card payments are coming soon. Have a code? Enter it below.';
    $('#planCodeWrap').hidden = unlimited;
    if (NATIVE) {   // App Store rules: no outside payments or unlock codes inside the app
      for (const id of ['#planIntervals', '#planBuy', '#planCodeWrap', '#planCompareWrap']) $(id).hidden = true;
      $('#planBuyNote').textContent = unlimited ? '' : "Unlimited isn't available in the iPhone app yet.";
    }
  }

  async function startCheckout() {
    if (!S.user) { $('#planDialog').close(); afterAuth = () => openPlan(); return openAcct('signup', 'Create your free account, then you can go Unlimited.'); }
    const btn = $('#planBuy');
    btn.disabled = true;
    $('#planErr').textContent = '';
    try {
      const { url } = await api('/api/billing/checkout', { interval: S.planInterval });
      location.href = url;
    } catch (err) {
      $('#planErr').textContent = err.status ? err.message : "Couldn't reach the server. Try again.";
      btn.disabled = false;
    }
  }

  async function openBillingPortal(btn) {
    if (btn) btn.disabled = true;
    try { const { url } = await api('/api/billing/portal', {}); location.href = url; }
    catch (err) { toast(err.status ? err.message : "Couldn't reach the server. Try again."); if (btn) btn.disabled = false; }
  }

  async function redeem() {
    if (!S.user) { $('#planDialog').close(); afterAuth = () => openPlan(); return openAcct('signin', 'Sign in (or create a free account) to use your code.'); }
    const code = $('#planCode').value.trim();
    $('#planErr').textContent = ''; $('#planMsg').textContent = '';
    if (!code) { $('#planErr').textContent = 'Type your code first.'; return; }
    const btn = $('#planRedeem');
    btn.disabled = true;
    try {
      const m = await api('/api/redeem', { code });
      setMembership(m);
      renderBets(); renderPlan();
      $('#planMsg').textContent = m.plan.until ? `Code accepted. You're on Unlimited through ${longDate.format(new Date(m.plan.until))}.` : "Code accepted. You're on Unlimited.";
      toast("You're on Unlimited");
    } catch (err) {
      $('#planErr').textContent = err.status ? err.message : "Couldn't reach the server. Try again.";
    } finally { btn.disabled = false; }
  }

  // Back from Stripe Checkout (#upgraded). The webhook can land a few seconds after the redirect.
  async function welcomeBack() {
    history.replaceState(null, '', location.pathname + location.search);
    setTab('bets');
    if (!S.user) return;
    toast('Payment received. Turning on Unlimited…');
    for (let i = 0; i < 15; i++) {
      const me = await refreshMe();
      if (me?.plan?.name === 'unlimited') { toast("You're on Unlimited. Save as many bets as you want."); return; }
      await new Promise(r => setTimeout(r, 2000));
    }
    toast("Your payment went through. Unlimited can take a minute to switch on. Refresh soon.");
  }

  // ---------- my bets ----------
  const BADGE = { open: 'Open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void' };
  const ICON = { won: '✓', lost: '✗', push: '↺', void: '–', review: '!', open: '•' };
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const legState = l => l.result?.status || 'open';
  const needsReview = b => b.status === 'open' && b.legs.some(l => legState(l) === 'review');

  function persistBets() {
    saveBets(S.bets);
    renderBets();
    scheduleSync();
  }

  function betTitle(b) {
    if (b.kind === 'future' || b.legs.length === 1) return b.legs[0]?.label || 'Bet';
    return `${b.legs.length}-leg parlay`;
  }

  function renderBetsBadge() {
    const open = visible(S.bets).filter(b => b.status === 'open').length;
    for (const el of document.querySelectorAll('.bets-count')) { el.hidden = !open; el.textContent = open; }
  }

  function renderBets() {
    renderBetsBadge();
    renderAcctBtn();
    const box = $('#betList');
    if (!box) return;
    renderAcctBox();
    const all = visible(S.bets);
    const open = all.filter(b => b.status === 'open'), done = all.filter(b => b.status !== 'open');
    const s = summarize(S.bets);
    const sign = n => (n > 0.004 ? '+' : n < -0.004 ? '−' : '') + money(Math.abs(n));
    $('#betStats').innerHTML = all.length ? `
      <div class="stat"><span class="k">Record</span><span class="v">${s.won}–${s.lost}${s.push ? `–${s.push}` : ''}</span></div>
      <div class="stat"><span class="k">Profit</span><span class="v ${s.profit > 0.004 ? 'up' : s.profit < -0.004 ? 'down' : ''}">${sign(s.profit)}</span></div>
      <div class="stat"><span class="k">ROI</span><span class="v">${s.roi == null ? '—' : `${s.roi > 0 ? '+' : ''}${s.roi.toFixed(1)}%`}</span></div>
      <div class="stat"><span class="k">Open</span><span class="v">${s.open}</span></div>` : '';
    $('#betStats').hidden = !all.length;
    renderBreakdown();
    renderAlerts();
    for (const b of document.querySelectorAll('#betFilter [data-bfilter]')) {
      b.setAttribute('aria-pressed', b.dataset.bfilter === S.betFilter);
      const n = b.dataset.bfilter === 'open' ? open.length : b.dataset.bfilter === 'settled' ? done.length : all.length;
      b.querySelector('.count').textContent = n;
    }
    $('#betTools').hidden = !all.length;
    const list = S.betFilter === 'open' ? open : S.betFilter === 'settled' ? done : all;
    $('#betsSub').textContent = S.user ? `Synced to @${S.user.username}` : 'Saved on this device';
    if (!all.length) {
      box.innerHTML = `<div class="game empty-msg"><b>No saved bets yet.</b><br>Build a parlay or open Season, then tap <b>Save</b>. We'll grade game lines and player props automatically when the games end.</div>`;
      return;
    }
    if (!list.length) { box.innerHTML = `<p class="muted">${S.betFilter === 'open' ? 'No open bets.' : 'Nothing settled yet.'}</p>`; return; }
    box.innerHTML = list.map(betCard).join('');
  }

  function betCard(b) {
    const review = needsReview(b);
    const st = !b.placed && b.status === 'open' ? 'watch' : review ? 'review' : b.status;
    const badge = st === 'watch' ? 'Watching' : review ? 'Needs review' : BADGE[b.status] || b.status;
    const legs = b.legs.map(l => {
      const ls = legState(l);
      const when = l.commence ? dateFmt.format(new Date(l.commence)) : '';
      const sub = l.t === 'future' ? `${SPORT_NAMES[l.sport] || ''}${l.season ? ` · ${l.season} season` : ''} · settles at season end`
        : `${l.away} @ ${l.home} · ${when}`;
      return `<li class="bl ${ls}"><span class="ic" aria-label="${esc(ls)}">${ICON[ls] || '•'}</span>
        <span class="bl-main"><span class="bl-l">${esc(l.label)}</span><span class="bl-s">${esc(sub)}${l.result?.why ? ` · ${esc(l.result.why)}` : ''}</span></span>
        <span class="bl-p">${l.price != null ? fmtAm(l.price) : ''}</span></li>`;
    }).join('');
    const pays = b.stake * toDec(b.odds);
    const money2 = b.status === 'open'
      ? `<span>Stake <b>${money(b.stake)}</b></span><span>Pays <b>${money(pays)}</b></span>`
      : `<span>Stake <b>${money(b.stake)}</b></span><span>Returned <b>${money(b.payout || 0)}</b></span>`;
    const settleBtns = ['won', 'lost', 'push', 'void'].map(x => `<button class="chip" data-bact="${x}" data-bid="${esc(b.id)}">${BADGE[x]}</button>`).join('');
    return `<article class="bet st-${st}" data-bet="${esc(b.id)}">
      <div class="bet-top"><div class="bet-h"><span class="bet-title">${esc(betTitle(b))}</span>
        <span class="bet-meta">${b.placed ? esc(b.bookName || 'Placed') : 'Not placed'} · ${fmtAm(b.odds)}${b.oddsEdited ? ' (your odds)' : ''} · saved ${esc(dateFmt.format(new Date(b.created)))}</span></div>
        <span class="bet-badge b-${st}">${esc(badge)}</span></div>
      <ul class="bet-legs">${legs}</ul>
      <div class="bet-money">${money2}</div>
      <div class="bet-actions">
        ${b.manual ? `<button class="link-btn" data-bact="auto" data-bid="${esc(b.id)}">Undo result</button>` : `<details class="settle"><summary class="link-btn">Settle by hand</summary><div class="chips">${settleBtns}</div></details>`}
        <button class="link-btn" data-bact="edit" data-bid="${esc(b.id)}">Edit</button>
        ${b.kind !== 'future' && b.status === 'open' ? `<button class="link-btn" data-bact="share" data-bid="${esc(b.id)}">Share</button>` : ''}
        <button class="link-btn danger" data-bact="delete" data-bid="${esc(b.id)}">Delete</button>
      </div>
      <form class="bet-edit" data-editform="${esc(b.id)}" hidden>
        <label>Stake $<input name="stake" type="number" min="0.01" step="0.01" value="${b.stake}" inputmode="decimal"></label>
        <label>Odds <input name="odds" type="text" value="${fmtAm(b.odds)}" inputmode="text"></label>
        ${b.placed ? '' : '<label class="chk"><input name="placed" type="checkbox"> I placed it</label>'}
        <button class="chip" type="submit">Save changes</button>
      </form>
    </article>`;
  }

  function betAction(id, act, btn) {
    const b = S.bets.find(x => x.id === id);
    if (!b) return;
    const now = Date.now();
    if (act === 'delete') {
      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1'; btn.textContent = 'Tap again to delete';
        setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = 'Delete'; } }, 4000);
        return;
      }
      S.bets = S.bets.map(x => (x.id === id ? tombstone(x) : x));
      persistBets();
      toast('Bet deleted');
      return;
    }
    if (act === 'share') return shareLegs(b.legs.filter(l => l.t === 'game' || l.t === 'prop'), b.stake);
    if (act === 'edit') {
      const f = document.querySelector(`[data-editform="${CSS.escape(id)}"]`);
      if (f) f.hidden = !f.hidden;
      return;
    }
    if (act === 'auto') {
      b.manual = false;
      const s = settle(b);
      b.status = s.status; b.payout = s.payout; b.settledAt = s.status === 'open' ? null : new Date(now).toISOString();
    } else if (BADGE[act]) {
      b.manual = true;
      b.status = act;
      b.payout = act === 'won' ? Math.round(b.stake * toDec(b.odds) * 100) / 100 : act === 'lost' ? 0 : b.stake;
      b.settledAt = new Date(now).toISOString();
    }
    b.updated = now;
    persistBets();
  }

  function saveEdit(form) {
    const b = S.bets.find(x => x.id === form.dataset.editform);
    if (!b) return;
    const stake = Math.round(Number(form.stake.value) * 100) / 100;
    const am = parseAm(form.odds.value);
    if (!(stake > 0) || am == null) { toast('Enter a stake above $0 and odds like -110 or +250'); return; }
    const legsDec = b.legs.reduce((d, l) => d * (l.price != null ? toDec(l.price) : 1), 1);
    b.stake = stake;
    b.oddsEdited = b.oddsEdited || am !== b.odds;
    if (Math.abs(toDec(am) - legsDec) < 0.005) b.oddsEdited = false;
    b.odds = am;
    if (form.placed?.checked) { b.placed = true; b.bookName = b.bookName || 'Placed'; }
    if (b.manual) b.payout = b.status === 'won' ? Math.round(b.stake * toDec(b.odds) * 100) / 100 : b.status === 'lost' ? 0 : b.stake;
    else { const s = settle(b); b.status = s.status; b.payout = s.payout; }
    b.updated = Date.now();
    persistBets();
    toast('Bet updated');
  }

  // ---------- grading ----------
  let grading = false;
  async function runGrading(manual) {
    if (grading) return;
    grading = true;
    if (manual) $('#regrade').textContent = 'Checking…';
    try {
      const getJson = url => fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
      const changed = await gradeBets(S.bets, getJson);
      S.gradedAt = Date.now();
      if (changed) { S.bets = mergeBets(S.bets, []); persistBets(); }
      if (manual) toast(changed ? 'Results updated' : 'No new results yet');
    } catch (err) {
      console.error('grading', err);
      if (manual) toast("Couldn't reach the scores feed. Try again in a bit.");
    } finally {
      grading = false;
      if ($('#regrade')) $('#regrade').textContent = 'Check results now';
    }
  }

  // ---------- accounts ----------
  function loadSession() {
    try {
      const v = JSON.parse(lsGet(SESSION_KEY) || 'null');
      if (v && typeof v.token === 'string' && typeof v.username === 'string') S.user = v;
    } catch { /* ignore */ }
  }
  function setSession(u) {
    S.user = u;
    try { if (u) localStorage.setItem(SESSION_KEY, JSON.stringify(u)); else localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
  }

  async function api(path, body) {
    const res = await fetch(API_BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(S.user ? { Authorization: `Bearer ${S.user.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) { const e = new Error(data?.error || `Server error (${res.status})`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  let syncTimer = null, syncing = null;
  function scheduleSync() {
    if (!S.user) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 1200);
  }
  async function syncNow() {
    if (!S.user) return false;
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const sent = S.bets;
        const { bets, rejected, quota } = await api('/api/bets/sync', { bets: sent });
        if (quota) S.quota = quota;
        if (rejected?.length) {   // new bets over today's free limit never reached the account
          const drop = new Set(rejected);
          S.bets = S.bets.filter(b => !drop.has(b.id));
          toast(`${rejected.length === 1 ? '1 bet wasn\'t' : `${rejected.length} bets weren't`} saved: that's past today's free limit.`);
        }
        S.bets = mergeBets(S.bets, bets);
        saveBets(S.bets);
        S.syncAt = Date.now(); S.syncErr = null;
        renderBets();
        return true;
      } catch (err) {
        if (err.status === 401) { setSession(null); S.syncErr = 'Your session expired. Sign in again to keep syncing.'; }
        else S.syncErr = "Couldn't sync right now. Your bets are still saved on this device.";
        renderBets();
        return false;
      } finally { syncing = null; }
    })();
    return syncing;
  }

  function renderAcctBtn() {
    const t = $('#acctBtnText');
    if (t) t.textContent = S.user ? `@${S.user.username}` : 'Sign in';
  }

  function renderAcctBox() {
    const box = $('#acctBox');
    if (!box) return;
    if (S.user) {
      const status = S.syncErr ? esc(S.syncErr) : S.syncAt ? `Synced ${esc(ago(new Date(S.syncAt).toISOString()))}` : 'Syncing…';
      box.innerHTML = `<div><b>Signed in as @${esc(S.user.username)}</b><span class="muted small">${S.user.email ? `${esc(S.user.email)} · ` : ''}${status}</span></div>
        <div class="acct-actions"><button class="link-btn" data-acct="email">${S.user.email ? 'Change email' : 'Add email'}</button><button class="link-btn" data-acct="signout">Sign out</button><button class="link-btn danger" data-acct="delete">Delete account</button></div>${planLine()}${myBooksLine()}`;
    } else {
      box.innerHTML = `<div><b>Save and track your bets</b><span class="muted small">${S.syncErr ? esc(S.syncErr) : `A free account saves ${FREE_N()} bets a day and grades them for you on every device. Unlimited saves as many as you want.`}</span></div>
        <div class="acct-actions"><button class="chip" data-acct="signup">Create account</button><button class="link-btn" data-acct="signin">Sign in</button></div>${myBooksLine()}`;
    }
  }
  const FREE_N = () => S.quota?.limit ?? 2;
  const longDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  function planLine() {
    const p = S.plan, q = S.quota;
    if (!p) return '';
    const admin = S.admin && !NATIVE ? '<a class="link-btn" href="admin.html">Admin</a>' : '';
    if (p.name === 'unlimited') {
      const end = p.paid_through || p.until;
      const until = end ? `${p.renews ? 'renews' : 'through'} ${longDate.format(new Date(end))}` : 'no end date';
      const how = p.source === 'stripe' ? '' : p.source === 'code' ? ' · from a code' : ' · on the house';
      return `<div class="plan-line"><span class="small"><b class="plan-badge">Unlimited</b> <span class="muted">${esc(until)}${how}</span></span>
        <span class="acct-actions">${p.manage && !NATIVE ? '<button class="link-btn" data-plan="manage">Manage billing</button>' : ''}${admin}</span></div>`;
    }
    const left = q && !q.unlimited ? `${q.left} of ${q.limit} free saves left today` : 'Free plan';
    return `<div class="plan-line"><span class="small"><b>Free plan</b> <span class="muted">· ${esc(left)}</span></span>
      <span class="acct-actions">${admin}${NATIVE ? '' : '<button class="chip plan-chip" data-plan="open">Go Unlimited</button>'}</span></div>`;
  }

  function myBooksLine() {
    const names = myBookNames();
    return `<div class="mybooks-line"><span class="small"><b>My books:</b> <span class="muted">${names.length ? esc(names.join(', ')) : 'none picked yet. Pick the ones you have and we\'ll price parlays there.'}</span></span>
      <button class="chip" data-mybooks>${names.length ? 'Edit' : 'Pick my books'}</button></div>`;
  }

  // Fill in the account's email (login responses don't include it).
  async function refreshMe() {
    if (!S.user) return;
    try {
      const me = await api('/api/me');
      if (!S.user) return;
      setMembership(me);
      if (me.email !== S.user.email) setSession({ ...S.user, email: me.email || null });
      renderBets();
      return me;
    } catch (err) { if (err.status === 401) { setSession(null); renderBets(); } }
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const ACCT = {
    signin: { title: 'Sign in', lede: 'Sign in to sync your saved bets.', submit: 'Sign in', user: 'Username or email', pass: 'Password', fields: ['user', 'pass'] },
    signup: { title: 'Create your account', lede: 'Pick a username and password, and add your email so you can reset your password if you ever forget it. We only use your email for that.', submit: 'Create account', user: 'Username', pass: 'Password (8+ characters)', fields: ['user', 'email', 'pass', 'adult'] },
    forgot: { title: 'Reset your password', lede: 'Enter the email or username on your account. We\'ll email you a link to set a new password.', submit: 'Email me a reset link', user: 'Email or username', fields: ['user'] },
    reset: { title: 'Set a new password', lede: 'Choose a new password. This also signs you out on your other devices.', submit: 'Save new password', pass: 'New password (8+ characters)', fields: ['pass', 'pass2'] },
    email: { title: 'Your email', lede: 'This is where password reset links go. Enter your password to confirm.', submit: 'Save email', pass: 'Password', fields: ['email', 'pass'] },
    delete: { title: 'Delete your account', lede: 'This permanently deletes your account and every bet saved to it, on all devices. Enter your password to confirm.', submit: 'Delete everything', pass: 'Password', fields: ['pass'] },
  };

  let acctMode = 'signin';
  let resetToken = null;
  let afterAuth = null;   // e.g. reopen the Save dialog once the person has an account
  function openAcct(mode, lede) {
    const c = ACCT[mode];
    if (!c || !$('#acctEmailWrap')) return;   // page still loading the new layout
    acctMode = mode;
    $('#acctForm').reset();
    $('#acctTitle').textContent = c.title;
    $('#acctLede').textContent = lede || c.lede;
    const show = { user: '#acctUserWrap', email: '#acctEmailWrap', pass: '#acctPassWrap', pass2: '#acctPass2Wrap', adult: '#acctAdultWrap' };
    for (const [k, sel] of Object.entries(show)) $(sel).hidden = !c.fields.includes(k);
    if (c.user) $('#acctUserLabel').textContent = c.user;
    if (c.pass) $('#acctPassLabel').textContent = c.pass;
    $('#acctUser').autocomplete = mode === 'signup' ? 'username' : 'username email';
    $('#acctPass').autocomplete = mode === 'signup' || mode === 'reset' ? 'new-password' : 'current-password';
    if (mode === 'email' && S.user?.email) $('#acctEmail').value = S.user.email;
    $('#acctSubmit').textContent = c.submit;
    $('#acctSubmit').hidden = false;
    $('#acctSubmit').classList.toggle('danger-cta', mode === 'delete');
    $('#acctSwitch').innerHTML = mode === 'signup' ? 'Have an account? <button type="button" class="link-btn" data-acct="signin">Sign in</button>'
      : mode === 'signin' ? '<button type="button" class="link-btn" data-acct="forgot">Forgot password?</button> · New here? <button type="button" class="link-btn" data-acct="signup">Create an account</button>'
        : mode === 'forgot' ? 'Remembered it? <button type="button" class="link-btn" data-acct="signin">Sign in</button>' : '';
    $('#acctErr').textContent = '';
    $('#acctMsg').textContent = '';
    const d = $('#acctDialog');
    if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
    const first = { user: '#acctUser', email: '#acctEmail', pass: '#acctPass' }[c.fields[0]];
    setTimeout(() => $(first)?.focus(), 50);
  }

  function acctProblem(v) {
    const f = ACCT[acctMode].fields;
    if (f.includes('user')) {
      if (acctMode === 'signup' && !/^[a-z0-9_]{3,20}$/i.test(v.user)) return 'Usernames are 3–20 letters, numbers or underscores.';
      if (!v.user) return acctMode === 'forgot' ? 'Enter your email or username.' : 'Enter your username or email.';
    }
    if (f.includes('email') && !EMAIL_RE.test(v.email)) return 'Enter a valid email address.';
    if (f.includes('pass')) {
      if (!v.pass) return 'Enter your password.';
      if ((acctMode === 'signup' || acctMode === 'reset') && v.pass.length < 8) return 'Passwords need at least 8 characters.';
    }
    if (f.includes('pass2') && v.pass !== v.pass2) return "The two passwords don't match.";
    if (f.includes('adult') && !v.adult) return 'Please confirm you are of legal betting age.';
    return '';
  }

  async function signedIn(data, email, message) {
    setSession({ username: data.username, token: data.token, email: email || null });
    S.syncErr = null;
    $('#acctDialog').close();
    toast(message);
    renderBets();
    await syncNow();
    await refreshMe();
    loadAlerts();
    pullPrefs();
    const next = afterAuth; afterAuth = null;
    if (next) next();
  }

  async function submitAcct() {
    const btn = $('#acctSubmit');
    const v = {
      user: $('#acctUser').value.trim(), email: $('#acctEmail').value.trim(), pass: $('#acctPass').value,
      pass2: $('#acctPass2').value, adult: $('#acctAdult').checked,
    };
    $('#acctErr').textContent = '';
    $('#acctMsg').textContent = '';
    const problem = acctProblem(v);
    if (problem) { $('#acctErr').textContent = problem; return; }
    btn.disabled = true;
    const prev = S.user;
    try {
      if (acctMode === 'delete') {
        await api('/api/account/delete', { password: v.pass });
        try { const sub = await currentSub(); if (sub) await sub.unsubscribe(); } catch { /* ignore */ }
        setSession(null);
        S.alerts = null;
        S.bets = []; saveBets(S.bets); S.syncAt = null; S.syncErr = null;
        $('#acctDialog').close();
        renderBets();
        toast('Account deleted');
      } else if (acctMode === 'email') {
        const r = await api('/api/account/email', { email: v.email, password: v.pass });
        setSession({ ...S.user, email: r.email });
        $('#acctDialog').close();
        renderBets();
        toast('Email saved');
      } else if (acctMode === 'forgot') {
        S.user = null;
        try { await api('/api/password/forgot', { who: v.user }); } finally { S.user = prev; }
        $('#acctMsg').textContent = "If that account exists, we've emailed a reset link. It works for 60 minutes, so check your inbox (and spam) now.";
        btn.hidden = true;
      } else if (acctMode === 'reset') {
        S.user = null;
        let data;
        try { data = await api('/api/password/reset', { token: resetToken, password: v.pass }); } catch (e) { S.user = prev; throw e; }
        resetToken = null;
        await signedIn(data, null, `Password updated. Signed in as @${data.username}`);
      } else {
        const signup = acctMode === 'signup';
        S.user = null;   // never send an old token with a login
        let data;
        try {
          data = await api(signup ? '/api/signup' : '/api/login',
            signup ? { username: v.user, email: v.email, password: v.pass, adult: v.adult } : { username: v.user, password: v.pass });
        } catch (e) { S.user = prev; throw e; }
        await signedIn(data, signup ? v.email.toLowerCase() : null, signup ? `Welcome, @${data.username}` : `Signed in as @${data.username}`);
      }
    } catch (err) {
      $('#acctErr').textContent = err.status ? err.message : "Couldn't reach the server. Check your connection and try again.";
    } finally {
      btn.disabled = false;
    }
  }

  async function signOut() {
    const synced = await syncNow();
    await disablePush();
    S.alerts = null;
    try { await api('/api/logout', {}); } catch { /* token may already be gone */ }
    setSession(null);
    S.syncAt = null; S.syncErr = null;
    S.plan = S.quota = S.billing = null; S.admin = false;
    if (synced) {
      S.bets = []; saveBets(S.bets);
      S.myBooks = null; S.myBooksAt = 0;   // they're saved in the account; don't hand them to the next person on this browser
      try { localStorage.removeItem(MYBOOKS_KEY); } catch { /* private mode */ }
      render();
    }
    renderBets();
    toast(synced ? 'Signed out. Your bets are saved in your account.' : 'Signed out. Bets that didn\'t sync are still on this device.');
  }

  // ---------- sharing a parlay ----------
  const b64u = str => { let bin = ''; for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = str => new TextDecoder().decode(Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
  const SITE = LOCAL ? `${location.origin}${location.pathname}` : 'https://www.fckvig.com/';

  function shareUrl(legs, stake) {
    const packed = legs.map(l => [l.eventId, l.market, l.name, l.point ?? null, l.desc || null]);
    return `${SITE}#p=${b64u(JSON.stringify(packed))}${stake > 0 ? `&s=${stake}` : ''}`;
  }

  // Sharing makes a short link (api.fckvig.com/s/<id>) whose text preview is a picture of this bet, drawn here
  // with the prices we have right now. If that fails, the plain #p= link still works (with the generic picture).
  const shareWhen = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const gameWhen = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  function shareCard(legs, stake) {
    const st = stake > 0 ? stake : 10;
    const card = {
      kind: legs.length === 1 ? 'single' : 'parlay', stake: st, best: null, rows: [], extra: 0, logoSrc: 'logo.svg',
      legs: legs.map(l => {
        const ev = S.events.get(l.eventId);
        return { label: legLabel(l), sub: ev ? `${ev.away} @ ${ev.home} · ${gameWhen.format(new Date(ev.commence_time))}` : '' };
      }),
    };
    // "as of" = the oldest price this bet relies on (game lines and props refresh on different schedules)
    let asOf = Infinity;
    for (const l of legs) {
      const ev = S.events.get(l.eventId);
      const t = Date.parse((isProp(l.market) && ev?.props_at) || ev?.lines_at || S.data?.generated_at || '');
      if (Number.isFinite(t)) asOf = Math.min(asOf, t);
    }
    card.asOf = shareWhen.format(Number.isFinite(asOf) ? new Date(asOf) : new Date());
    if (S.data && legs.every(l => S.events.has(l.eventId))) {
      // every book legal in the sender's state (not just "My books": whoever opens it may use other books)
      const rows = priceParlay(allowedBooks(), legs).full;
      card.rows = rows.map(r => ({ name: r.name, color: r.color, am: r.am, payout: st * r.dec }));
      if (card.rows.length) {
        card.best = card.rows[0];
        card.extra = card.rows[0].payout - card.rows[card.rows.length - 1].payout;
      }
    }
    return card;
  }
  function shareMeta(legs, card) {
    const labels = legs.map(legLabel);
    const b = card.best;
    const title = card.kind === 'single'
      ? (b ? `${labels[0]}: ${fmtAm(b.am)} at ${b.name}` : labels[0])
      : (b ? `${legs.length}-leg parlay: ${Number.isInteger(card.stake) ? `$${card.stake}` : money(card.stake)} pays ${money(b.payout)} at ${b.name}` : `${legs.length}-leg parlay on fck the vig`);
    const desc = `${card.kind === 'single' ? (card.legs[0].sub ? card.legs[0].sub + '. ' : '') : labels.join(' · ') + '. '}Prices as of ${card.asOf}. Compare it at every book legal in your state.`;
    return { title, desc };
  }
  const blobB64 = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

  let shareJob = 0, shareImgUrl = null, shareNow = null;
  async function shareLegs(legs, stake) {
    legs = legs.filter(l => l.eventId && l.market && l.name);
    if (!legs.length) return toast('Nothing to share');
    const job = ++shareJob;
    const text = legs.length === 1 ? legLabel(legs[0]) : `${legs.length}-leg parlay: ${legs.map(legLabel).join(' · ')}`;
    let url = shareUrl(legs, stake);
    shareNow = { text, url: null };
    $('#shareText').textContent = text;
    $('#shareUrl').value = '';
    $('#shareUrl').placeholder = 'Making your link…';
    $('#shareCopy').textContent = 'Copy link';
    $('#shareCopy').disabled = true;
    $('#shareNative').hidden = !navigator.share;
    $('#shareNative').disabled = true;
    $('#shareImg').hidden = true;
    $('#shareStatus').hidden = false;
    $('#shareStatus').textContent = 'Making your preview…';
    $('#sharePreview').classList.add('loading');
    const d = $('#shareDialog');
    if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }

    let note = '';
    try {
      const card = shareCard(legs, stake);
      const { blob, mime } = await drawShareCard(card);
      if (job !== shareJob) return;
      if (shareImgUrl) URL.revokeObjectURL(shareImgUrl);
      shareImgUrl = URL.createObjectURL(blob);
      $('#shareImg').src = shareImgUrl;
      $('#shareImg').hidden = false;
      $('#shareStatus').hidden = true;
      $('#sharePreview').classList.remove('loading');
      const { title, desc } = shareMeta(legs, card);
      const packed = legs.map(l => [l.eventId, l.market, l.name, l.point ?? null, l.desc || null]);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const res = await fetch(`${API_BASE}/api/share`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
          body: JSON.stringify({ legs: packed, stake: stake > 0 ? stake : null, title, desc, img: await blobB64(blob), mime }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.url) throw new Error(data?.error || `Server error (${res.status})`);
        url = data.url;
      } finally { clearTimeout(timer); }
    } catch (err) {
      console.warn('share preview', err);
      note = "Couldn't save the preview picture, so this link will show the standard one.";
    }
    if (job !== shareJob) return;
    shareNow.url = url;
    $('#shareUrl').value = url;
    $('#shareCopy').disabled = false;
    $('#shareNative').disabled = false;
    if (note) { $('#shareStatus').hidden = false; $('#shareStatus').textContent = note; $('#sharePreview').classList.remove('loading'); }
    if (d.open && !window.matchMedia('(pointer: coarse)').matches) setTimeout(() => $('#shareUrl').select(), 50);
  }
  async function nativeShare() {
    if (!shareNow?.url || !navigator.share) return;
    try { await navigator.share({ title: 'fck the vig', text: `${shareNow.text}. Compare the payout at every book:`, url: shareNow.url }); }
    catch { /* cancelled */ }
  }

  async function copyShare() {
    const input = $('#shareUrl');
    if (!input.value) return;
    try { await navigator.clipboard.writeText(input.value); }
    catch { input.select(); try { document.execCommand('copy'); } catch { /* user can copy by hand */ } }
    $('#shareCopy').textContent = 'Copied ✓';
  }

  // A shared link looks like https://www.fckvig.com/#p=<legs>&s=<stake>. Legs load once the odds are in.
  let pendingShare = null;
  function readShareHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h.startsWith('p=')) return false;
    const q = new URLSearchParams(h);
    try {
      const legs = JSON.parse(unb64u(q.get('p') || ''));
      if (Array.isArray(legs) && legs.length) pendingShare = { legs: legs.slice(0, MAX_LEGS), stake: Number(q.get('s')) || null };
    } catch { toast('That share link looks broken.'); }
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }
  function applyShare() {
    if (!pendingShare || !S.data) return;
    const { legs, stake } = pendingShare;
    pendingShare = null;
    const next = [];
    for (const x of legs) {
      if (!Array.isArray(x)) continue;
      const [eventId, market, name, point, desc] = x;
      if (typeof eventId !== 'string' || typeof market !== 'string' || typeof name !== 'string' || !S.events.has(eventId)) continue;
      if (next.some(l => l.eventId === eventId && l.market === market && l.desc === (desc || null))) continue;
      const pt = point == null || point === '' ? null : Number(point);
      next.push({ eventId, market, name, point: Number.isFinite(pt) ? pt : null, desc: typeof desc === 'string' ? desc : null });
    }
    S.legs = next;
    if (stake > 0 && stake <= 1e6) { S.stake = stake; $('#stake').value = stake; }
    if (next.length) { const ev0 = S.events.get(next[0].eventId); S.sport = ev0.sport; S.day = evDay(ev0); }
    render();
    setTab('results');
    const miss = legs.length - next.length;
    if (!next.length) toast("Those games aren't on the board anymore (they've started or finished).");
    else toast(miss ? `Loaded ${next.length} of ${legs.length} legs. ${miss} game${miss > 1 ? 's are' : ' is'} no longer on the board.` : `Loaded a shared ${next.length === 1 ? 'bet' : `${next.length}-leg parlay`}`);
  }

  // ---------- stats breakdown ----------
  function renderBreakdown() {
    const box = $('#betBreakdown');
    if (!box) return;
    const bd = breakdown(S.bets, mLabel);
    if (!bd.count && !bd.props.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const tabs = [['sport', 'By sport'], ['type', 'By bet type'], ['props', 'Player props']];
    if (!tabs.some(([k]) => k === S.statsTab)) S.statsTab = 'sport';
    const sign = n => (n > 0.004 ? '+' : n < -0.004 ? '−' : '') + money(Math.abs(n));
    const cls = n => (n > 0.004 ? 'up' : n < -0.004 ? 'down' : '');
    const rec = r => `${r.won}–${r.lost}${r.push ? `–${r.push}` : ''}`;
    let table;
    if (S.statsTab === 'props') {
      const rows = [...bd.props, ...(bd.sides.length ? [{ sep: true }] : []), ...bd.sides];
      table = bd.props.length ? `<table class="bd-table"><thead><tr><th>Stat</th><th>Legs hit</th><th>Hit rate</th></tr></thead><tbody>${rows.map(r => r.sep ? '<tr class="sep"><td colspan="3"></td></tr>'
        : `<tr><td>${esc(r.key)}</td><td>${r.won} of ${r.won + r.lost}</td><td class="${r.rate >= 50 ? 'up' : 'down'}">${r.rate == null ? '—' : `${Math.round(r.rate)}%`}</td></tr>`).join('')}</tbody></table>
        <p class="hint">Every graded player-prop leg you placed, including legs inside parlays. Pushes and voids aren't counted.</p>`
        : '<p class="muted small">No graded player props yet.</p>';
    } else {
      const rows = S.statsTab === 'sport' ? bd.bySport : bd.byType;
      table = rows.length ? `<table class="bd-table"><thead><tr><th>${S.statsTab === 'sport' ? 'Sport' : 'Bet type'}</th><th>Record</th><th>Staked</th><th>Profit</th><th>ROI</th></tr></thead><tbody>${rows.map(r =>
        `<tr><td>${esc(r.key)}</td><td>${rec(r)}</td><td>${money(r.staked)}</td><td class="${cls(r.profit)}">${sign(r.profit)}</td><td class="${cls(r.profit)}">${r.roi == null ? '—' : `${r.roi > 0 ? '+' : ''}${r.roi.toFixed(1)}%`}</td></tr>`).join('')}</tbody></table>
        <p class="hint">Settled bets you placed. Bets you're only tracking don't count.</p>`
        : '<p class="muted small">No settled bets yet.</p>';
    }
    box.innerHTML = `<div class="bd-head"><h3>Breakdown</h3><div class="chips">${tabs.map(([k, t]) => `<button class="chip" data-stats="${k}" aria-pressed="${k === S.statsTab}">${t}</button>`).join('')}</div></div>${table}`;
  }

  // ---------- sports book arbitrage board ----------
  const SPORT_SHORT = { americanfootball_nfl: 'NFL', basketball_nba: 'NBA', americanfootball_ncaaf: 'CFB', basketball_ncaab: 'CBB' };
  const whenFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
  const MK_NAME = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' };
  const exNote = bk => (bk === 'kalshi' ? 'incl. est. fee' : bookInfo(bk).ex ? 'before fees' : '');

  function moneyBookCell(o) {
    const info = bookInfo(o.bk);
    const link = cleanLink(o.link);
    const name = `${bchip(info)}<span class="mb-name">${esc(info.name)}</span>`;
    return link ? `<a class="mb-book" href="${esc(link)}" target="_blank" rel="noopener">${name}<span class="ext">↗</span></a>` : `<span class="mb-book">${name}</span>`;
  }

  function renderMoney() {
    const box = $('#moneyBody');
    if (!box) return;
    if (!S.data) { box.innerHTML = '<p class="muted">Loading odds…</p>'; return; }
    const allowed = allowedBooks();
    const events = [...S.events.values()];
    const arbs = findArbs(events, allowed).slice(0, 25);
    const values = findValue(events, allowed).slice(0, 25);
    const total = S.moneyTotal > 0 ? S.moneyTotal : 100;
    const asOf = S.data.generated_at ? `${timeFmt.format(new Date(S.data.generated_at))} (${ago(S.data.generated_at)})` : 'unknown';
    $('#moneySub').textContent = `${stateName(S.state)} · ${allowed.size} books · odds from ${asOf}`;
    const sideRow = (ev, mk, o, stake) => `<div class="mb-side">
        <span class="mb-pick"><b>${esc(legLabel({ market: mk, name: o.name, desc: o.desc, point: o.point }))}</b></span>
        <span class="mb-price">${fmtAm(o.price)}${exNote(o.bk) ? `<span class="mb-fee">${exNote(o.bk)}</span>` : ''}</span>
        ${moneyBookCell(o)}
        ${stake != null ? `<span class="mb-stake">Bet <b>${money(stake)}</b></span>` : ''}
      </div>`;
    const game = ev => `${esc(ev.away)} @ ${esc(ev.home)} · ${esc(SPORT_SHORT[ev.sport] || '')} · ${esc(whenFmt.format(new Date(ev.commence_time)))}`;
    const arbHtml = arbs.length ? arbs.map(a => {
      const split = arbStakes(a.sides, total);
      return `<article class="mb-card">
        <div class="mb-top"><span class="mb-game">${game(a.ev)}</span><span class="mb-badge">+${pct(a.profit, 2)} locked</span></div>
        <div class="mb-mk">${esc(MK_NAME[a.mk] || mLabel(a.mk))}</div>
        ${a.sides.map((o, i) => sideRow(a.ev, a.mk, o, split.stakes[i])).join('')}
        <div class="mb-foot">Either way you get back about <b>${money(split.minReturn)}</b> on ${money(split.spent)}: <b class="up">+${money(Math.max(0, split.profit))}</b></div>
      </article>`;
    }).join('') : `<p class="none">No sure things at books legal in ${esc(stateName(S.state))} right now. They're rare and usually close within minutes, so check back after the next odds update.</p>`;
    const valueHtml = values.length ? values.map(v => {
      const o = v.offer;
      const spec = { market: v.mk, name: o.name, desc: o.desc, point: o.point };
      const on = S.legs.some(l => l.eventId === v.ev.id && l.market === v.mk && l.name === o.name && l.desc === (o.desc || null));
      return `<article class="mb-card value">
        <div class="mb-top"><span class="mb-game">${game(v.ev)}</span><span class="mb-badge">+${pct(v.edge)} edge</span></div>
        ${sideRow(v.ev, v.mk, o, null)}
        <div class="mb-foot">Fair price ${fmtAm(v.fairAm)} (no-vig average of ${v.books} books) · ${esc(legLabel(spec))} wins ${pct(v.fair, 0)} of the time if the market's right.</div>
        <div class="mb-actions"><button class="chip" data-vadd="${esc(v.ev.id)}" data-mk="${esc(v.mk)}" data-nm="${esc(o.name)}" data-pt="${o.point ?? ''}" data-ds="${esc(o.desc || '')}" aria-pressed="${on}">${on ? 'In your parlay' : 'Add to parlay'}</button>
          <button class="link-btn" data-valert="${esc(v.ev.id)}" data-mk="${esc(v.mk)}" data-nm="${esc(o.name)}" data-pt="${o.point ?? ''}" data-ds="${esc(o.desc || '')}">${ICONS.bell} Alert me</button></div>
      </article>`;
    }).join('') : '<p class="none">No prices beat the market by 2% or more right now.</p>';
    box.innerHTML = `
      <div class="note warn"><strong>Odds from ${esc(asOf)}.</strong> These come from our last odds update, and books move fast. Open both apps and check the prices before you bet a dollar.</div>
      <section class="mb-sec">
        <div class="mb-sec-h"><div><h3>Sure things</h3><p class="muted small">Back both sides at different books and profit whichever side wins (arbitrage).</p></div>
          <label class="stake-wrap mb-total">Total $<input id="moneyTotal" type="number" min="1" step="1" value="${total}" inputmode="decimal" aria-label="Total to split across both bets"></label></div>
        <div class="mb-list">${arbHtml}</div>
      </section>
      <section class="mb-sec">
        <div class="mb-sec-h"><div><h3>Beat the market</h3><p class="muted small">Prices better than the fair odds every other book implies. Not guaranteed, but bets like these win you money over time.</p></div></div>
        <div class="mb-list">${valueHtml}</div>
      </section>
      <p class="hint">Kalshi prices include its estimated trading fee (about 7% × price × (1 − price) per contract). Other prediction markets are shown before their fees. Books can limit or void bets on obvious errors.</p>`;
  }

  // ---------- line-move alerts ----------
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const STANDALONE = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const keyBytes = k => Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const sameKey = (buf, k) => { if (!buf) return false; const a = new Uint8Array(buf), b = keyBytes(k); return a.length === b.length && a.every((x, i) => x === b[i]); };
  let pushState = 'unknown';   // 'on' | 'off' | 'blocked' | 'unsupported' | 'ios-home'

  async function currentSub() {
    if (!pushSupported()) return null;
    try { const reg = await navigator.serviceWorker.getRegistration(); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
  }
  async function refreshPushState() {
    if (!pushSupported()) pushState = NATIVE ? 'app' : IS_IOS && !STANDALONE ? 'ios-home' : 'unsupported';
    else if (Notification.permission === 'denied') pushState = 'blocked';
    else pushState = (await currentSub()) ? 'on' : 'off';
    return pushState;
  }
  // Must start from a tap: browsers only show the permission prompt in response to one.
  async function enablePush() {
    if (!pushSupported()) throw new Error(NATIVE ? 'Push alerts in the app are coming in the next update. Use email alerts for now.' : IS_IOS && !STANDALONE
      ? 'On iPhone, add fckvig to your Home Screen first (Share → Add to Home Screen), open it from there, then turn alerts on.'
      : "This browser can't show push notifications. Use email alerts instead.");
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser settings, then try again.');
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const { key } = await api('/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    await api('/api/push/subscribe', sub.toJSON());
    pushState = 'on';
    return sub;
  }
  async function disablePush() {
    const sub = await currentSub();
    if (sub) {
      try { await api('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* signed out already */ }
      try { await sub.unsubscribe(); } catch { /* ignore */ }
    }
    pushState = pushSupported() ? 'off' : pushState;
  }

  async function loadAlerts() {
    if (!S.user) { S.alerts = null; return renderAlerts(); }
    try { const r = await api('/api/alerts'); S.alerts = r.alerts || []; S.alertsErr = null; }
    catch (err) { S.alertsErr = err.status === 401 ? null : "Couldn't load your alerts right now."; if (err.status === 401) { setSession(null); renderBets(); } }
    await refreshPushState();
    renderAlerts();
  }

  const ALERT_STATUS = { active: 'Watching', sent: 'Sent', expired: 'Game started' };
  function renderAlerts() {
    const box = $('#alertsBox');
    if (!box) return;
    if (!S.user) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const list = S.alerts || [];
    const pushLine = {
      on: 'Push is <b>on</b> for this device. <button class="link-btn" data-push="test">Send a test</button> · <button class="link-btn" data-push="off">Turn off</button>',
      off: 'Push is <b>off</b> for this device. <button class="link-btn" data-push="on">Turn on</button>',
      blocked: 'Notifications are blocked for this site in your browser settings.',
      unsupported: "This browser can't do push notifications, so alerts come by email.",
      app: 'Push alerts in the app are coming in the next update. Alerts come by email for now.',
      'ios-home': 'On iPhone, add fckvig to your Home Screen (Share → Add to Home Screen) and open it from there to get push alerts.',
      unknown: '',
    }[pushState] || '';
    const items = list.map(a => {
      const st = a.status === 'active' ? 'active' : a.status;
      const what = a.mode === 'target' ? `When the best price reaches ${fmtAm(a.target)} or better` : 'When the line or price moves';
      const sub = a.status === 'sent' ? `${esc(a.message || '')} · ${esc(ago(new Date(a.sent_at).toISOString()) || '')}` : `${what} · ${esc(a.spec.away)} @ ${esc(a.spec.home)}`;
      return `<li class="al st-${st}"><span class="al-main"><span class="al-l">${esc(a.spec.label || legLabel(a.spec))}</span><span class="al-s">${sub}</span></span>
        <span class="al-badge">${esc(ALERT_STATUS[a.status] || a.status)}</span>
        <button class="x" data-aldel="${a.id}" aria-label="Delete alert">×</button></li>`;
    }).join('');
    box.innerHTML = `<div class="al-head"><h3>${ICONS.bell} Line-move alerts</h3></div>
      <p class="muted small">${pushLine}${S.user.email ? ` Email alerts go to ${esc(S.user.email)}.` : ' Add an email to your account to get alerts by email.'}</p>
      ${S.alertsErr ? `<p class="form-err">${esc(S.alertsErr)}</p>` : ''}
      ${list.length ? `<ul class="al-list">${items}</ul>` : '<p class="muted small">No alerts yet. Tap the bell next to any leg in your parlay, or on a Sports Book Arbitrage pick.</p>'}
      <p class="hint">We check your alerts every time the odds update (right now that's ${esc(pullFreq())}), so a move can take ${knowConf().run_every_hours > 0 ? 'up to a couple of hours' : 'a few hours'} to reach you.</p>`;
  }

  let alertDraft = null;
  function openAlert(leg) {
    const ev = S.events.get(leg.eventId);
    if (!ev) return;
    const allowed = allowedBooks();
    const best = bestOffer(ev, leg, allowed) || bestOffer(ev, { ...leg, point: null }, allowed);
    alertDraft = { leg: { ...leg, point: leg.point ?? best?.point ?? null }, ev, best };
    const d = $('#alertDialog');
    $('#alertLeg').textContent = legLabel(alertDraft.leg);
    $('#alertGame').textContent = `${ev.away} @ ${ev.home} · ${whenFmt.format(new Date(ev.commence_time))}`;
    $('#alertErr').textContent = '';
    const signedOut = !S.user;
    $('#alertSignin').hidden = !signedOut;
    $('#alertForm').querySelectorAll('.al-field').forEach(el => { el.hidden = signedOut; });
    $('#alertSubmit').hidden = signedOut;
    if (!signedOut) {
      $('#alertBest').textContent = best ? `Best right now: ${fmtAm(best.price)} at ${bookInfo(best.bk).name}` : 'No book is pricing this right now.';
      const target = best ? (best.price > 0 ? best.price + 10 : best.price + 10 >= -100 ? 100 : best.price + 10) : 100;
      $('#alertTarget').value = fmtAm(target);
      $('#alertModeTarget').checked = true;
      const push = $('#alertPush'), mail = $('#alertEmail');
      push.disabled = pushState === 'unsupported' || pushState === 'blocked' || pushState === 'app';
      push.checked = !push.disabled;
      $('#alertPushNote').textContent = pushState === 'app' ? 'Coming in the next app update.' : pushState === 'ios-home' ? 'iPhone: add fckvig to your Home Screen first.' : pushState === 'blocked' ? 'Blocked in your browser settings.' : pushState === 'unsupported' ? 'Not supported in this browser.' : '';
      mail.disabled = !S.user.email;
      mail.checked = !!S.user.email && push.disabled;
      $('#alertEmailNote').textContent = S.user.email ? S.user.email : 'Add an email to your account first.';
    }
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }

  async function submitAlert() {
    if (!alertDraft || !S.user) return;
    const btn = $('#alertSubmit');
    const err = $('#alertErr');
    err.textContent = '';
    const mode = $('#alertModeMove').checked ? 'move' : 'target';
    const target = mode === 'target' ? parseAm($('#alertTarget').value) : null;
    if (mode === 'target' && target == null) { err.textContent = 'Enter American odds like -105 or +150.'; return; }
    const channels = [];
    if ($('#alertPush').checked) channels.push('push');
    if ($('#alertEmail').checked) channels.push('email');
    if (!channels.length) { err.textContent = 'Pick push, email or both.'; return; }
    btn.disabled = true;
    try {
      if (channels.includes('push') && pushState !== 'on') await enablePush();
      const { leg, ev, best } = alertDraft;
      const spec = { sport: ev.sport, eventId: ev.id, home: ev.home, away: ev.away, commence: ev.commence_time,
        market: leg.market, name: leg.name, desc: leg.desc || null, point: leg.point ?? null, label: legLabel(leg) };
      await api('/api/alerts', { spec, mode, target, base_price: best?.price ?? null, base_point: leg.point ?? null,
        books: [...allowedBooks()], channels });
      $('#alertDialog').close();
      toast(mode === 'target' ? `We'll tell you when it hits ${fmtAm(target)}` : "We'll tell you when it moves");
      loadAlerts();
    } catch (e) {
      err.textContent = e.status ? e.message : e.message || "Couldn't save the alert. Try again.";
    } finally { btn.disabled = false; }
  }

  async function pushAction(what) {
    try {
      if (what === 'on') { await enablePush(); toast('Push alerts are on for this device'); }
      else if (what === 'off') { await disablePush(); toast('Push alerts are off for this device'); }
      else if (what === 'test') { const r = await api('/api/push/test', {}); toast(r.sent ? 'Test sent. It should pop up in a few seconds.' : 'No devices to send to. Turn push on first.'); }
    } catch (e) { toast(e.message || 'Something went wrong'); }
    renderAlerts();
  }

  // ---------- bet slip: fill in a book's slip for the current parlay ----------
  let betKey = null;
  const betAdded = new Set();
  function betRow(key) {
    const { full, alt } = priceParlay(allowedBooks());
    return [...full, ...alt].find(r => r.key === key) || null;
  }
  function openBet(key) {
    betKey = key;
    betAdded.clear();
    if (!renderBetDialog()) return;
    const d = $('#betDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  function legLine(lg, l) {
    if (l.point == null) return '';
    return lg.market === 'spreads' ? fmtPt(l.point) : `${lg.name === 'Over' ? 'o' : 'u'}${l.point}`;
  }
  function renderBetDialog() {
    const r = betRow(betKey);
    const n = S.legs.length;
    if (!r || !n) { $('#betDialog').close?.(); return false; }
    const combo = n > 1 ? comboLink(r.key, r.legs.map(l => l.link)) : null;
    const beta = combo && !COMBO_BOOKS[r.key]?.tested;
    const what = n === 1 ? 'Straight bet' : `${n}-leg parlay`;
    const links = r.legs.filter(l => l.link).length;
    const items = r.legs.map((l, i) => {
      const lg = S.legs[i];
      const ev = S.events.get(lg.eventId);
      const off = l.same ? '' : ` · ${esc(r.name)} has ${esc(legLine(lg, l))}`;
      const done = betAdded.has(i);
      const btn = l.link
        ? `<a class="chip slip-add${done ? ' done' : ''}" href="${esc(l.link)}" target="_blank" rel="noopener" data-slipleg="${i}">${done ? 'Added ✓' : 'Add ↗'}</a>`
        : '<span class="muted small">Find it in the app</span>';
      return `<li><span class="sl-what"><b>${esc(legLabel(lg))}</b><span class="muted small">${ev ? `${esc(ev.away)} @ ${esc(ev.home)}` : ''}${off}</span></span><span class="sl-px">${fmtAm(l.price)}</span>${btn}</li>`;
    }).join('');
    const how = r.ex
      ? `On ${esc(r.name)} each leg is its own trade, so check each price before you buy.`
      : n > 1
        ? `${esc(r.name)} keeps your slip between taps. When every leg is on it, pick <b>Parlay</b>, check the odds, enter ${money(S.stake)} and place it.`
        : `Check the odds on ${esc(r.name)}'s slip, enter ${money(S.stake)} and place it.`;
    $('#betBody').innerHTML = `
      <h3>Bet this at ${esc(r.name)}</h3>
      <p class="muted">${what} · ${money(S.stake)} pays <b class="hl">${money(r.payout)}</b> (${fmtAm(r.am)})</p>
      ${combo ? `<a class="cta slip-all" href="${esc(combo)}" target="_blank" rel="noopener">Put all ${n} legs on the slip ↗</a>
        ${beta ? `<p class="muted small">New: we're still confirming this one-tap link with ${esc(r.name)}. If any leg is missing from the slip, add it below.</p>` : ''}` : ''}
      <h4 class="slip-h">${combo ? 'Or add them one at a time' : n > 1 ? 'Add each leg to your slip' : 'Add it to your slip'}</h4>
      <ol class="slip-legs">${items}</ol>
      ${links ? '' : `<p class="note info">${esc(r.name)} doesn't give us bet slip links, so search for each leg in the app. Copy slip puts the list on your clipboard.</p>`}
      <p class="muted small">${how} You're signed in to ${esc(r.name)} on your own phone or computer. We never see your account.</p>`;
    return true;
  }
  function slipText() {
    const r = betRow(betKey);
    if (!r) return '';
    const lines = r.legs.map((l, i) => {
      const lg = S.legs[i], ev = S.events.get(lg.eventId);
      return `${i + 1}. ${legLabel(lg)}${l.same ? '' : ` (${legLine(lg, l)} here)`}${ev ? ` (${ev.away} @ ${ev.home})` : ''} ${fmtAm(l.price)}`;
    });
    const n = S.legs.length;
    return [`${r.name} · ${n === 1 ? 'straight bet' : `${n}-leg parlay`} · ${fmtAm(r.am)}`, ...lines,
      `${money(S.stake)} pays ${money(r.payout)}`, 'Compared on fckvig.com'].join('\n');
  }
  async function copySlip() {
    const text = slipText();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast('Slip copied'); }
    catch { toast("Couldn't copy. Your browser blocked it."); }
  }

  // ---------- my books picker ----------
  function myBooksList() {
    const keys = new Map();   // key -> exchange?
    for (const k of Object.keys(S.avail?.books || {})) keys.set(k, false);
    for (const k of Object.keys(S.avail?.exchanges || {})) keys.set(k, true);
    for (const k of allBookKeys()) if (!keys.has(k)) keys.set(k, bookInfo(k).ex);
    const list = [...keys].map(([k, ex]) => ({ ...bookInfo(k), ex, avail: availability(k) }));
    return list.sort((a, b) => a.ex - b.ex || a.name.localeCompare(b.name));
  }
  function openMyBooks() {
    const list = myBooksList();
    const box = b => `<label class="mb-item${b.avail === 'no' ? ' na' : ''}"><input type="checkbox" name="mb" value="${esc(b.key)}"${S.myBooks?.has(b.key) ? ' checked' : ''}>
      ${bchip(b)}<span class="mb-name">${esc(b.name)}</span>${b.avail === 'no' ? `<span class="muted small">Not in ${esc(S.state)}</span>` : ''}</label>`;
    const books = list.filter(b => !b.ex), exch = list.filter(b => b.ex);
    $('#mbList').innerHTML = `<h4 class="slip-h">Sportsbooks</h4><div class="mb-grid">${books.map(box).join('')}</div>`
      + (exch.length ? `<h4 class="slip-h">Prediction markets</h4><div class="mb-grid">${exch.map(box).join('')}</div>` : '');
    $('#mbNote').textContent = S.user ? `Saved to your profile (@${S.user.username}), so it follows you to every device.`
      : 'Saved in this browser. Sign in to keep it on every device.';
    const d = $('#myBooksDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  function saveMyBooksForm() {
    const keys = [...document.querySelectorAll('#mbList input[name="mb"]:checked')].map(i => i.value).filter(k => BOOK_KEY_RE.test(k));
    setMyBooks(keys);
    setOnlyMine(keys.length > 0);
    $('#myBooksDialog').close();
    render();
    renderAcctBox();
    pushPrefs();
    toast(keys.length ? `Saved. Parlays now price your ${keys.length} book${keys.length === 1 ? '' : 's'}.` : 'Cleared. Parlays price every book again.');
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  // ---------- events ----------
  document.addEventListener('click', e => {
    const pick = e.target.closest('.pick[data-ev]');
    if (pick) {
      const pt = pick.dataset.pt === '' ? null : Number(pick.dataset.pt);
      return toggleLeg(pick.dataset.ev, pick.dataset.mk, pick.dataset.nm, pt, pick.dataset.ds || null);
    }
    const gt = e.target.closest('[data-gtab]');
    if (gt) {
      const id = gt.dataset.gtev;
      if (gt.dataset.gtab === 'props') { if (!S.openProps.get(id)) S.openProps.set(id, true); }
      else S.openProps.delete(id);
      return renderGames();
    }
    if (e.target.closest('[data-clearq]')) { S.q = ''; $('#boardSearch').value = ''; return renderGames(); }
    const chip = e.target.closest('[data-pmk]');
    if (chip) { S.openProps.set(chip.dataset.pev, chip.dataset.pmk); return renderGames(); }
    const dc = e.target.closest('[data-day]');
    if (dc) { S.q = ''; $('#boardSearch').value = ''; return setDay(dc.dataset.day); }
    const tab = e.target.closest('.tab[data-sport]');
    if (tab) { S.sport = tab.dataset.sport; S.q = ''; $('#boardSearch').value = ''; return render(); }
    const rm = e.target.closest('[data-rm]');
    if (rm) { S.legs.splice(Number(rm.dataset.rm), 1); return render(); }
    const sc = e.target.closest('[data-stake]');
    if (sc) { S.stake = Number(sc.dataset.stake); $('#stake').value = S.stake; return renderSlip(); }
    if (e.target.closest('#clearLegs')) { S.legs = []; return render(); }
    if (e.target.closest('#stateBtn')) return openStateDialog();
    if (e.target.closest('#aboutData')) return openAbout();
    if (e.target.closest('#knowBtn')) return openKnow('');
    const kn = e.target.closest('[data-know]');
    if (kn) { e.preventDefault(); return openKnow(kn.dataset.know); }
    const kj = e.target.closest('[data-know-jump]');
    if (kj) return knowJump(kj.dataset.knowJump);
    if (e.target.closest('#knowStates')) { e.preventDefault(); return openAbout(); }
    const tb = e.target.closest('.tabbar [data-tab]');
    if (tb) return setTab(tb.dataset.tab);
    if (e.target.closest('#seeBest')) return setTab('results');
    const gp = e.target.closest('.gap[data-gev]');
    if (gp) {
      const pt = gp.dataset.gpt === '' ? null : Number(gp.dataset.gpt);
      return toggleLeg(gp.dataset.gev, gp.dataset.gmk, gp.dataset.gnm, pt, gp.dataset.gds || null);
    }
    const vw = e.target.closest('.views [data-view]');
    if (vw) return setView(vw.dataset.view);
    if (e.target.closest('[data-save="parlay"]')) return openSaveParlay();
    const bt = e.target.closest('[data-betbook]');
    if (bt) return openBet(bt.dataset.betbook);
    const sa = e.target.closest('.slip-add[data-slipleg]');
    if (sa) { betAdded.add(Number(sa.dataset.slipleg)); setTimeout(renderBetDialog, 0); return; }   // let the link open first
    if (e.target.closest('#betCopy')) return copySlip();
    if (e.target.closest('#betSave')) { const k = betKey; $('#betDialog').close(); return openSaveParlay(k); }
    if (e.target.closest('#betClose')) return $('#betDialog').close();
    const mo = e.target.closest('[data-mine]');
    if (mo) { setOnlyMine(mo.dataset.mine === '1'); return render(); }
    if (e.target.closest('[data-mybooks]')) return openMyBooks();
    if (e.target.closest('#mbCancel')) return $('#myBooksDialog').close();
    if (e.target.closest('#mbClear')) { for (const i of document.querySelectorAll('#mbList input[name="mb"]')) i.checked = false; return; }
    if (e.target.closest('[data-share="parlay"]')) return shareLegs(S.legs, S.stake);
    if (e.target.closest('#shareCopy')) return copyShare();
    if (e.target.closest('#shareNative')) return nativeShare();
    if (e.target.closest('#shareClose')) return $('#shareDialog').close();
    const st = e.target.closest('[data-stats]');
    if (st) { S.statsTab = st.dataset.stats; return renderBreakdown(); }
    const al = e.target.closest('[data-alert]');
    if (al) { const leg = S.legs[Number(al.dataset.alert)]; return leg && openAlert(leg); }
    const va = e.target.closest('[data-valert], [data-vadd]');
    if (va) {
      const leg = { eventId: va.dataset.valert || va.dataset.vadd, market: va.dataset.mk, name: va.dataset.nm, point: va.dataset.pt === '' ? null : Number(va.dataset.pt), desc: va.dataset.ds || null };
      if (va.dataset.valert) return openAlert(leg);
      toggleLeg(leg.eventId, leg.market, leg.name, leg.point, leg.desc);
      return toast(S.legs.some(l => l.eventId === leg.eventId && l.market === leg.market && l.name === leg.name) ? 'Added to your parlay' : 'Removed from your parlay');
    }
    const ad = e.target.closest('[data-aldel]');
    if (ad) { ad.disabled = true; return api('/api/alerts/delete', { id: Number(ad.dataset.aldel) }).then(loadAlerts).catch(err => { ad.disabled = false; toast(err.message); }); }
    const pa = e.target.closest('[data-push]');
    if (pa) return pushAction(pa.dataset.push);
    if (e.target.closest('#alertCancel, .al-cancel')) { alertDraft = null; return $('#alertDialog').close(); }
    if (e.target.closest('#alertSigninBtn')) { $('#alertDialog').close(); return openAcct('signin'); }
    const ss = e.target.closest('[data-ssport]');
    if (ss) { S.seasonSport = ss.dataset.ssport; S.market = null; S.marketSearch = ''; return renderSeason(); }
    const mi = e.target.closest('[data-market]');
    if (mi) { S.market = mi.dataset.market; S.marketSearch = ''; renderSeason(); return $('#marketView').scrollIntoView({ block: 'nearest' }); }
    const fs = e.target.closest('[data-fsave]');
    if (fs) return openSaveFuture(Number(fs.dataset.fsave));
    const bf = e.target.closest('[data-bfilter]');
    if (bf) { S.betFilter = bf.dataset.bfilter; return renderBets(); }
    if (e.target.closest('#regrade')) return runGrading(true);
    const ba = e.target.closest('[data-bact]');
    if (ba) return betAction(ba.dataset.bid, ba.dataset.bact, ba);
    if (e.target.closest('#acctBtn')) return S.user ? setView('bets') : openAcct('signin');
    const ac = e.target.closest('[data-acct]');
    if (ac) {
      const m = ac.dataset.acct;
      if (m === 'signout') return signOut();
      return openAcct(m);
    }
    if (e.target.closest('#privacyLink')) { const d = $('#privacyDialog'); return d.showModal ? d.showModal() : d.setAttribute('open', ''); }
    if (e.target.closest('#saveCancel')) { pending = null; return $('#saveDialog').close(); }
    if (e.target.closest('#acctCancel')) { afterAuth = null; return $('#acctDialog').close(); }
    const pl = e.target.closest('[data-plan]');
    if (pl) {
      const a = pl.dataset.plan;
      if (a === 'open') return openPlan();
      if (a === 'manage') return openBillingPortal(pl);
      if (a === 'close') return $('#planDialog').close();
    }
    const iv = e.target.closest('[data-interval]');
    if (iv) { S.planInterval = iv.dataset.interval; return renderPlan(); }
    if (e.target.closest('#planBuy')) return startCheckout();
    if (e.target.closest('#planRedeem')) return redeem();
  });
  document.addEventListener('submit', e => {
    const f = e.target;
    if (f.id === 'saveForm') { e.preventDefault(); commitSave().then(ok => { if (ok) $('#saveDialog').close(); }); return; }
    if (f.id === 'planForm') { e.preventDefault(); return redeem(); }
    if (f.id === 'acctForm') { e.preventDefault(); return submitAcct(); }
    if (f.id === 'alertForm') { e.preventDefault(); return submitAlert(); }
    if (f.id === 'myBooksForm') { e.preventDefault(); return saveMyBooksForm(); }
    if (f.dataset.editform) { e.preventDefault(); return saveEdit(f); }
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'fsearch') {
      S.marketSearch = e.target.value;
      const pos = e.target.selectionStart;
      renderMarket();
      const again = $('#fsearch');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* ignore */ } }
      return;
    }
    if (e.target.id === 'saveStake' || e.target.id === 'saveOdds') return updateSaveDialog();
    if (e.target.id === 'moneyTotal') {
      const v = Number(e.target.value);
      if (!(v > 0)) return;
      S.moneyTotal = Math.min(v, 1e6);
      const pos = e.target.selectionStart;
      renderMoney();
      const again = $('#moneyTotal');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* number inputs */ } }
      return;
    }
    if (e.target.id === 'boardSearch') {
      S.q = e.target.value.trim();
      return renderGames();
    }
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
  $('#saveBook').addEventListener('change', () => updateSaveDialog(true));
  window.addEventListener('storage', e => {
    if (e.key === 'ftv-bets') { S.bets = loadBets(); renderBets(); }
    if (e.key === SESSION_KEY) { loadSession(); if (!lsGet(SESSION_KEY)) S.user = null; renderBets(); }
    if (e.key === MYBOOKS_KEY || e.key === ONLYMINE_KEY) { loadMyBooks(); render(); }
  });

  // ---------- boot + polling ----------
  // data/meta.json is tiny and says when odds.json / futures.json last changed, so the page only downloads the
  // big files when there's something new. Without it (older deploys), fall back to a full reload every 10 minutes.
  let lastFull = 0;
  async function whatChanged() {
    try {
      const m = await loadJson('data/meta.json');
      return { meta: true, odds: m.odds_at !== S.data?.generated_at, futures: !!m.futures_at && m.futures_at !== S.futures?.generated_at };
    } catch { return { meta: false, odds: Date.now() - lastFull > 10 * 60_000, futures: false }; }
  }

  async function refresh(first) {
    try {
      if (!first && S.data) {
        const c = await whatChanged();
        if (c.futures) loadFutures();
        if (!c.odds) { renderStatus(); return; }
      }
      lastFull = Date.now();
      const { d, source } = await loadOdds();
      if (!first && S.data && d.generated_at === S.data.generated_at) { renderStatus(); return; }
      S.data = d; S.source = source;
      indexEvents();
      normDay();
      if (!S.sport || !S.data.sports.some(s => s.key === S.sport)) {
        S.sport = (S.data.sports.find(s => s.in_season !== false && s.events.some(e => onDay(e)))
          || S.data.sports.find(s => s.in_season !== false && s.events.length) || S.data.sports[0])?.key;
      }
      render();
      applyShare();
    } catch (err) {
      console.error(err);
      if (first) {
        $('#statusText').textContent = 'Waiting for first odds update';
        $('#games').innerHTML = '<div class="game empty-msg">Live odds haven\'t been pulled yet. They appear here after the first update runs.</div>';
      }
    }
  }

  // Password reset links look like https://www.fckvig.com/#reset=<token>.
  function checkResetLink() {
    const h = location.hash.replace('#', '');
    if (!h.startsWith('reset=')) return;
    resetToken = h.slice(6);
    history.replaceState(null, '', location.pathname + location.search);   // keep the one-time link out of history
    openAcct('reset');
  }

  async function loadFutures() {
    try {
      const f = await loadJson('data/futures.json');
      if (!S.futures || f.generated_at !== S.futures.generated_at) { S.futures = f; renderSeason(); }
    } catch {
      if (!S.futures) { S.futures = { markets: [], missing: true }; renderSeason(); }
    }
  }

  // ---------- 21+ gate (iPhone app only; the site shows 21+ in the footer) ----------
  function ageGate() {
    if (!NATIVE || lsGet(AGE_KEY) === '1') return Promise.resolve();
    const d = $('#ageDialog');
    d.addEventListener('cancel', e => e.preventDefault());   // no Escape / swipe-away
    return new Promise(resolve => {
      d.addEventListener('click', e => {
        const b = e.target.closest('[data-age]');
        if (!b) return;
        e.preventDefault();
        if (b.dataset.age === 'yes') { lsSet(AGE_KEY, '1'); d.close(); resolve(); }
        else { $('#ageNo').hidden = false; $('#ageBtns').hidden = true; }
      });
      d.showModal ? d.showModal() : d.setAttribute('open', '');
    });
  }

  (async () => {
    await ageGate();
    S.bets = loadBets();
    loadSession();
    loadMyBooks();
    renderAcctBtn();
    renderBetsBadge();
    const hash = location.hash.replace('#', '');
    if (hash === 'bets' || hash === 'season' || hash === 'money') setTab(hash);
    checkResetLink();
    readShareHash();
    const upgraded = hash === 'upgraded';
    window.addEventListener('hashchange', () => { checkResetLink(); if (readShareHash()) applyShare(); });
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
    if (S.avail && !lsGet(STATE_KEY) && !resetToken) openStateDialog(); // first visit: ask where they're betting from
    await loadFutures();
    runGrading(false);
    if (S.user) { syncNow(); if (upgraded) welcomeBack(); else refreshMe(); loadAlerts(); pullPrefs(); } else { refreshPushState(); if (upgraded) welcomeBack(); }
    setInterval(() => refresh(false), POLL_MS);
    setInterval(renderStatus, 30_000);
    // Take games off the board as they tip off, even when no new odds file has landed.
    let upcoming = upcomingCount();
    setInterval(() => { const n = upcomingCount(); if (n !== upcoming) { upcoming = n; render(); } }, 60_000);
    setInterval(loadFutures, 30 * 60_000);
    setInterval(() => runGrading(false), GRADE_EVERY_MS);
    setInterval(() => { if (S.user) syncNow(); }, SYNC_EVERY_MS);
  })();
})();
