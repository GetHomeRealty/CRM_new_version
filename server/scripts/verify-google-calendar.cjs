/**
 * Google Calendar OAuth wiring.
 *
 * No Google credentials are configured on this machine, and that is exactly one of the states
 * that must behave correctly: unconfigured, Connect must decline cleanly (not hang, not fake a
 * consent screen), and the endpoints must be per-user and auth-guarded. The real consent screen
 * is Google's own and only appears once GOOGLE_CLIENT_ID/SECRET are set — which cannot be
 * exercised here. The OAuth state signing (the security-critical part) is tested directly.
 *
 * All test users are removed at the end.
 */
const fs = require('fs');
const path = require('path');
const { createHmac } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const SRV = path.join(process.cwd(), 'src');
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);
const readSrv = (rel) => fs.readFileSync(path.join(SRV, rel), 'utf8');
const readCli = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

function session() {
  const jar = {};
  const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
  const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
  const req = (m, p, b) => fetch(BASE + p, { method: m, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { async login(u, pw) { take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H })); return take(await req('POST', '/api/login', { username: u, password: pw })).status; },
    get: (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } }), post: (p, b) => req('POST', p, b) };
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

(async () => {
  const root = session();
  if (await root.login(ADMIN_LOGIN, 'Admin@123') !== 200) { console.error('login failed'); process.exitCode = 1; return; }
  const stamp = `${process.pid}-${Date.now()}`;
  const email = `gcal-${stamp}@example.invalid`;
  const mk = await j(await root.post('/api/users', { name: 'GCal', username: `gcal_${stamp}`, email, password: 'GCal@12345', password_confirmation: 'GCal@12345', role: 'agent', status: 'Active' }));
  const uid = mk.body.id ?? (await prisma.users.findFirst({ where: { email } }))?.id;
  const agent = session(); await agent.login(`gcal_${stamp}`, 'GCal@12345');

  head('status is honest about not being configured');
  const st = await j(await agent.get('/api/google/calendar/status'));
  ok(st.status === 200, 'an agent can read Google status');
  ok(st.body.configured === false, 'it reports Google sign-in is not set up here');
  ok(st.body.connected === false, 'and that they are not connected');
  ok(/GOOGLE_CLIENT_ID/.test(st.body.setup_hint || ''), 'the hint names the missing credentials');
  ok((await fetch(BASE + '/api/google/calendar/status', { headers: H })).status === 401, 'status needs a session');

  head('connect declines cleanly when unconfigured — it never fakes a consent screen');
  const conn = await j(await agent.get('/api/google/calendar/connect'));
  ok(conn.status === 200 && conn.body.configured === false, 'connect returns "not configured", not a URL');
  ok(!conn.body.url, 'no auth URL is produced without credentials');

  head('the OAuth state signing is tamper-proof');
  // The callback trusts the signed state to know which user is connecting. Forge one and it must
  // be rejected — otherwise anyone could bind a Google account to another user.
  const secret = (process.env.APP_KEY || process.env.SESSION_SECRET || 'google-state').trim();
  const sign = (p) => createHmac('sha256', secret).update(p).digest('base64url');
  const good = (() => { const p = `${uid}.${Date.now()}.abcdefghijkl`; return `${p}.${sign(p)}`; })();
  const forged = `${uid}.${Date.now()}.abcdefghijkl.not-a-real-signature`;
  // A forged/for-nothing callback (no real Google code) must redirect back with an error, never 500.
  const cbForged = await fetch(`${BASE}/api/google/callback?code=x&state=${encodeURIComponent(forged)}`, { redirect: 'manual', headers: H });
  ok(cbForged.status >= 300 && cbForged.status < 400, 'a forged-state callback redirects (does not error out)');
  ok(/google_error=invalid_state/.test(cbForged.headers.get('location') || ''), 'and reports invalid_state');
  const cbNoCode = await fetch(`${BASE}/api/google/callback?state=${encodeURIComponent(good)}`, { redirect: 'manual', headers: H });
  ok(/google_error=missing_code/.test(cbNoCode.headers.get('location') || ''), 'a callback with no code is rejected');
  // A validly-signed state with a code still fails at the token exchange (not configured), and
  // must land on an error redirect, not a crash.
  const cbGood = await fetch(`${BASE}/api/google/callback?code=fake&state=${encodeURIComponent(good)}`, { redirect: 'manual', headers: H });
  ok(cbGood.status >= 300 && cbGood.status < 400 && /google_error=/.test(cbGood.headers.get('location') || ''), 'a validly-signed callback with no real code fails gracefully');
  ok((cbGood.headers.get('location') || '').includes('/app/account'), 'and always lands back in the SPA');

  head('the callback is public but CSRF-exempt, and tokens never leave the server');
  ok(readSrv('auth/guards/csrf.guard.ts').includes('/api/google/callback'), 'the callback is CSRF-exempt (Google has no session)');
  const pub = readSrv('google/google-public.controller.ts');
  ok(!/@UseGuards/.test(pub), 'the callback carries no AuthGuard — it is trusted via signed state');
  ok(pub.includes('this.state.verify'), 'and verifies the state before storing anything');
  ok(readSrv('google/google-connection.service.ts').includes('encryptToken'), 'tokens are stored encrypted');
  ok(!/access_token/.test(JSON.stringify(st.body)), 'no token is present in the status response');

  head('two-way sync is wired');
  ok(readSrv('google/google-calendar-sync.service.ts').includes('applyGoogleEvent'), 'Google events pull into the CRM calendar');
  ok(readSrv('google/google-calendar-sync.service.ts').includes('async pushEvent'), 'and CRM events push to Google');
  ok(readSrv('calendar/calendar.service.ts').includes('this.googleSync.pushEvent'), 'a new CRM event is mirrored to Google');
  ok(readSrv('google/google-calendar-sync.service.ts').includes("ev.status === 'cancelled'"), 'a cancelled Google event removes its CRM copy');

  head('frontend: real consent redirect, no fake screen');
  const page = readCli('desk/AccountSettingsPage.tsx');
  ok(page.includes('function GoogleCalendarRow'), 'the Google Calendar row exists');
  ok(page.includes('window.location.href = res.url'), 'Connect navigates to Google\'s own consent URL');
  ok(!/wants to access your Google Account/i.test(page), 'the app never renders a fake Google consent screen');
  ok(page.includes('google_connected') && page.includes('google_error'), 'it handles the return from Google');
  ok(readCli('lib/accountApi.ts').includes('/api/google/calendar/connect'), 'the client calls the real connect endpoint');

  head('the deal core is untouched');
  ok((await root.get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await root.get('/api/calendar/events')).status === 200, 'the calendar still responds');

  head('cleanup');
  await prisma.google_connections.deleteMany({ where: { user_id: uid } });
  await prisma.users.delete({ where: { id: uid } });
  ok(await prisma.users.count({ where: { id: uid } }) === 0, 'test user removed');

  console.log(fail === 0 ? `\nALL ${pass} PASS` : `\n${pass} passed, ${fail} FAILED`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
})();
