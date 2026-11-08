/* fck the vig admin page (docs/admin.html): secret codes, giving Unlimited by hand, member numbers.
   Uses the same sign-in as the site. The API only answers for the pinned admin account (worker/index.js). */
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE = LOCAL ? 'http://localhost:8787' : 'https://api.fckvig.com';
const SESSION_KEY = 'ftv-session';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
const fmtDay = ms => (ms ? day.format(new Date(ms)) : '');

let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { /* private mode */ }

async function api(path, body) {
  const res = await fetch(API_BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error(data?.error || `Server error (${res.status})`); e.status = res.status; throw e; }
  return data;
}

function gate(html) { $('#app').hidden = true; $('#gate').hidden = false; $('#gate').innerHTML = html; }

const gives = c => (c.grant_days ? `${c.grant_days} days` : 'Forever');
const used = c => `${c.uses} / ${c.max_uses == null ? '∞' : c.max_uses}`;
const howLabel = { stripe: 'Paying', code: 'Code', admin: 'Given by you' };

let data = null;
async function load() {
  if (!session?.token) return gate('<p><b>Sign in first.</b></p><p class="muted">Sign in on the site with your admin account, then come back to this page.</p><p><a class="link-btn" href="./">Go to the site</a></p>');
  try { data = await api('/api/admin/overview'); }
  catch (err) {
    if (err.status === 401) return gate('<p><b>Your session expired.</b></p><p class="muted">Sign in again on the site, then come back.</p><p><a class="link-btn" href="./">Go to the site</a></p>');
    if (err.status === 403) return gate(`<p><b>This account isn't the admin.</b></p><p class="muted">You're signed in as @${esc(session.username)}.</p><p><a class="link-btn" href="./">Back to the site</a></p>`);
    return gate(`<p><b>Couldn't load.</b></p><p class="muted">${esc(err.message)}</p>`);
  }
  $('#gate').hidden = true;
  $('#app').hidden = false;
  render();
}

function render() {
  const u = data.users;
  const tiles = [['Accounts', u.total], ['New this week', u.new_7d], ['On Unlimited', u.unlimited], ['Paying', u.paying], ['From codes', u.by_code], ['Given by you', u.by_admin], ['Saves today (free)', data.saves_today]];
  $('#tiles').innerHTML = tiles.map(([k, v]) => `<div class="tile"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  $('#billingNote').textContent = `Free accounts get ${data.free_limit} saves a day. Card payments: ${data.billing_ready ? 'on (Stripe is connected).' : "off. Stripe isn't connected yet, so codes and gifts are the only way onto Unlimited."}`;

  $('#codes').innerHTML = data.codes.length ? data.codes.map(c => {
    const full = c.max_uses != null && c.uses >= c.max_uses, expired = c.expires_at && c.expires_at < Date.now();
    const status = `<span class="pill${c.revoked || full || expired ? '' : ' on'}">${c.revoked ? 'Turned off' : full ? 'Used up' : expired ? 'Expired' : 'Active'}</span>`;
    return `<tr class="${c.revoked ? 'off' : ''}"><td><b>${esc(c.hint)}</b><br>${status}</td><td>${esc(c.label)}<br><span class="hint">made ${esc(fmtDay(c.created_at))}</span></td>
      <td>${esc(used(c))}</td><td>${esc(gives(c))}</td><td>${c.expires_at ? esc(fmtDay(c.expires_at)) : '<span class="muted">No deadline</span>'}</td>
      <td>${c.revoked ? '' : `<button class="link-btn danger" data-revoke="${c.id}">Turn off</button><div class="confirm" data-confirm="${c.id}" hidden>
        <button class="chip" data-revoke-go="${c.id}" data-down="0">Turn off (people keep Unlimited)</button>
        <button class="chip" data-revoke-go="${c.id}" data-down="1">Turn off and move its people back to Free</button>
        <button class="link-btn" data-revoke-cancel="${c.id}">Cancel</button></div>`}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="muted">No codes yet.</td></tr>';

  $('#members').innerHTML = data.members.length ? data.members.map(m => `<tr><td><b>@${esc(m.username)}</b><br><span class="hint">${esc(m.email || '')}</span></td>
    <td>${esc(howLabel[m.plan_source] || m.plan_source || '')}${m.plan_source === 'stripe' && m.stripe_status ? ` <span class="hint">(${esc(m.stripe_status)})</span>` : ''}</td>
    <td>${m.plan_until ? esc(fmtDay(m.plan_until)) : 'Forever'}</td><td>${esc(fmtDay(m.created_at))}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">Nobody yet.</td></tr>';

  $('#redemptions').innerHTML = data.redemptions.length ? data.redemptions.map(r => `<tr><td>${esc(when.format(new Date(r.at)))}</td><td>@${esc(r.username)}</td><td>${esc(r.hint)} · ${esc(r.label)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No redemptions yet.</td></tr>';
}

$('#cUsesMode').addEventListener('change', e => { $('#cUsesWrap').hidden = e.target.value !== 'n'; });
$('#cDaysMode').addEventListener('change', e => { $('#cDaysWrap').hidden = e.target.value !== 'custom'; });

$('#codeForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#codeErr').textContent = '';
  const usesMode = $('#cUsesMode').value, daysMode = $('#cDaysMode').value;
  const body = {
    label: $('#cLabel').value.trim(),
    code: $('#cCode').value.trim() || undefined,
    max_uses: usesMode === '1' ? 1 : usesMode === 'n' ? Number($('#cUses').value) : null,
    grant_days: daysMode === 'forever' ? null : daysMode === 'custom' ? Number($('#cDays').value) : Number(daysMode),
    expires: $('#cExpires').value || undefined,
  };
  if (!body.label) { $('#codeErr').textContent = "Add a note so you remember who it's for."; return; }
  const btn = $('#codeBtn');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/codes', body);
    const share = `Here's a code for free Unlimited on fck the vig: ${r.code}\nSign in at https://www.fckvig.com, tap your account, then Go Unlimited → Have a code?`;
    $('#newCode').hidden = false;
    $('#newCode').innerHTML = `<div class="small muted">New code for ${esc(body.label)}. Copy it now: this is the only time the whole code is shown.</div>
      <div class="code">${esc(r.code)}</div>
      <div class="row"><button class="chip" data-copy="${esc(r.code)}">Copy code</button><button class="chip" data-copy="${esc(share)}">Copy a message with it</button></div>`;
    $('#codeForm').reset();
    $('#cUsesWrap').hidden = true; $('#cDaysWrap').hidden = true;
    await load();
  } catch (err) { $('#codeErr').textContent = err.message; }
  finally { btn.disabled = false; }
});

async function grant(remove) {
  $('#grantErr').textContent = ''; $('#grantMsg').textContent = '';
  const username = $('#gUser').value.trim();
  if (!username) { $('#grantErr').textContent = 'Enter a username or email.'; return; }
  const days = $('#gDays').value ? Number($('#gDays').value) : null;
  try {
    const r = await api('/api/admin/grant', remove ? { username, remove: true } : { username, days });
    $('#grantMsg').textContent = remove ? `@${r.username} is back on Free.` : `@${r.username} is on Unlimited ${r.until ? `through ${fmtDay(r.until)}` : 'forever'}.`;
    await load();
  } catch (err) { $('#grantErr').textContent = err.message; }
}
$('#grantForm').addEventListener('submit', e => { e.preventDefault(); grant(false); });
$('#ungrant').addEventListener('click', () => grant(true));

document.addEventListener('click', async e => {
  const cp = e.target.closest('[data-copy]');
  if (cp) {
    try { await navigator.clipboard.writeText(cp.dataset.copy); cp.textContent = 'Copied'; } catch { cp.textContent = 'Select it and copy'; }
    return;
  }
  const rv = e.target.closest('[data-revoke]');
  if (rv) { rv.hidden = true; document.querySelector(`[data-confirm="${rv.dataset.revoke}"]`).hidden = false; return; }
  const rc = e.target.closest('[data-revoke-cancel]');
  if (rc) return render();
  const go = e.target.closest('[data-revoke-go]');
  if (go) {
    go.disabled = true;
    try {
      const r = await api('/api/admin/codes/revoke', { id: Number(go.dataset.revokeGo), downgrade: go.dataset.down === '1' });
      await load();
      if (r.dropped) alertLine(`Turned off. ${r.dropped} ${r.dropped === 1 ? 'person is' : 'people are'} back on Free.`);
    } catch (err) { go.disabled = false; alertLine(err.message); }
  }
});
function alertLine(msg) { $('#billingNote').textContent = msg; }

load();
