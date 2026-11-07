// Checks everyone's line-move alerts against the odds this run just pulled, then tells the accounts API
// (worker/index.js) which alerts to send and which games already started. Runs in GitHub Actions after
// fetch-odds.mjs. It proves who it is with the workflow's GitHub OIDC token, so there's no secret to manage.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { checkAlert } from '../docs/js/odds-math.js';

const API = (process.env.ALERTS_API || 'https://api.fckvig.com').replace(/\/$/, '');
const ODDS = process.env.OUT_FILE || 'docs/data/odds.json';

async function oidcToken() {
  if (process.env.ALERTS_TOKEN) return process.env.ALERTS_TOKEN;        // local tests only
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, tok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !tok) throw new Error('No GitHub OIDC token available (the workflow needs "id-token: write").');
  const r = await fetch(`${url}&audience=fckvig-api`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`OIDC token request failed: HTTP ${r.status}`);
  return (await r.json()).value;
}

// Pure: which alerts fire and which games have started.
export function evaluate(alerts, data, now = Date.now()) {
  const events = new Map();
  for (const sp of data.sports || []) for (const ev of sp.events || []) events.set(ev.id, ev);
  const fired = [], expired = [];
  for (const a of alerts) {
    if (!a.spec || !(a.commence > now)) { expired.push(a.id); continue; }
    const ev = events.get(a.spec.eventId);
    if (!ev) continue;                       // not in this snapshot (props not refreshed yet, etc.)
    const hit = checkAlert(a, ev);
    if (hit) fired.push({ id: a.id, ...hit });
  }
  return { fired, expired };
}

async function main() {
  const token = await oidcToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const r = await fetch(`${API}/api/alerts/active`, { headers });
  if (!r.ok) throw new Error(`GET /api/alerts/active: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const { alerts } = await r.json();
  const data = JSON.parse(await readFile(ODDS, 'utf8'));
  const { fired, expired } = evaluate(alerts || [], data);
  console.log(`Alerts: ${alerts?.length || 0} active, ${fired.length} to send, ${expired.length} expired`);
  if (!fired.length && !expired.length) return;
  for (let i = 0; i < Math.max(fired.length, 1); i += 50) {
    const res = await fetch(`${API}/api/alerts/fire`, {
      method: 'POST', headers,
      body: JSON.stringify({ fired: fired.slice(i, i + 50), expired: i === 0 ? expired : [] }),
    });
    const out = await res.text();
    if (!res.ok) throw new Error(`POST /api/alerts/fire: HTTP ${res.status} ${out.slice(0, 200)}`);
    console.log(`Sent: ${out}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message || err); process.exit(1); });
}
