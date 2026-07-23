/**
 * Google Calendar via secret iCal link (the no-OAuth option).
 *
 * What's tested for real: the URL guard (https + Google's host only, so the server-side fetch
 * can't be pointed at an internal address), per-user scoping, that events pulled from a feed land
 * on the user's calendar tagged so they never clash with OAuth events, and disconnect. Parsing a
 * live Google feed needs a real secret URL this test doesn't have, so the ICS→calendar mapping is
 * exercised by inserting a feed row and a matching event directly. Test users/rows are removed.
 */
const fs = require('fs');
const path = require('path');
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
  const email = `ical-${stamp}@example.invalid`;
  const mk = await j(await root.post('/api/users', { name: 'Ical', username: `ical_${stamp}`, email, password: 'Ical@12345', password_confirmation: 'Ical@12345', role: 'agent', status: 'Active' }));
  const uid = mk.body.id ?? (await prisma.users.findFirst({ where: { email } }))?.id;
  const agent = session(); await agent.login(`ical_${stamp}`, 'Ical@12345');
  const other = session(); // a second admin session (root) is reused for isolation checks

  head('status starts disconnected and is auth-guarded');
  const st = await j(await agent.get('/api/calendar/ical/status'));
  ok(st.status === 200 && st.body.connected === false, 'not connected to start');
  ok((await fetch(BASE + '/api/calendar/ical/status', { headers: H })).status === 401, 'status needs a session');

  head('the URL guard is strict (SSRF-safe)');
  ok((await agent.post('/api/calendar/ical/connect', { url: 'http://calendar.google.com/x/basic.ics' })).status >= 400, 'http (not https) is rejected');
  ok((await agent.post('/api/calendar/ical/connect', { url: 'https://evil.example.com/x.ics' })).status >= 400, 'a non-Google host is rejected');
  ok((await agent.post('/api/calendar/ical/connect', { url: 'https://127.0.0.1/x.ics' })).status >= 400, 'localhost is rejected — no SSRF to internal hosts');
  ok((await agent.post('/api/calendar/ical/connect', { url: 'not a url' })).status >= 400, 'garbage is rejected');
  const gErr = await j(await agent.post('/api/calendar/ical/connect', { url: 'https://calendar.google.com/calendar/ical/does-not-exist/basic.ics' }));
  ok(gErr.status >= 400, 'a Google-hosted but invalid link is refused (it is fetched and fails), not stored');
  ok((await agent.get('/api/calendar/ical/status')).status === 200 && !(await j(await agent.get('/api/calendar/ical/status'))).body.connected,
    'and nothing was connected by the failed attempts');

  head('a feed maps into the user-s calendar, tagged so it never clashes with OAuth events');
  // Stand in for a successful parse: create the feed + a synced event exactly as the service does.
  const feed = await prisma.ical_feeds.create({ data: { user_id: uid, url: 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics', name: 'My Google Calendar', last_sync: new Date(), created_at: new Date(), updated_at: new Date() } });
  ok(feed.id > 0, 'a feed is stored per user');
  const tag = `ical:${stamp}-uid`;
  await prisma.calendar_events.create({ data: { title: 'From Google (link)', date: new Date('2030-05-05'), time: '10:00', type: 'meeting', status: 'scheduled', google_calendar_id: tag, user_id: uid, created_by: 'Google Calendar (link)', created_at: new Date(), updated_at: new Date() } });
  const evs = await j(await agent.get('/api/calendar/events'));
  ok(evs.body.some((e) => e.title === 'From Google (link)'), 'the feed event shows on the agent-s calendar');
  ok((await j(await agent.get('/api/calendar/ical/status'))).body.connected === true, 'status now reports connected');

  head('feeds and their events are private to the user');
  const rootEvs = await j(await root.get('/api/calendar/events'));
  ok(!rootEvs.body.some((e) => e.title === 'From Google (link)'), 'another user does not see the feed event');
  ok((await j(await root.get('/api/calendar/ical/status'))).body.connected === false, 'nor is another user shown as connected');

  head('read-only by nature — nothing pushes back through a link');
  const svc = readSrv('google/ical-feed.service.ts');
  ok(!/insertEvent|pushEvent/.test(svc), 'the iCal service has no push path (it cannot write to Google)');
  ok(/ALLOWED_HOSTS/.test(svc) && /calendar\.google\.com/.test(svc), 'the host allowlist is present');
  ok(svc.includes("`ical:${"), 'feed events are tagged with an ical: prefix, distinct from OAuth events');

  head('disconnect');
  ok([200, 201].includes((await agent.post('/api/calendar/ical/disconnect', {})).status), 'the feed can be disconnected');
  ok(await prisma.ical_feeds.count({ where: { user_id: uid } }) === 0, 'and the feed row is gone');

  head('frontend wiring');
  const page = readCli('desk/AccountSettingsPage.tsx');
  ok(page.includes('function IcalFeedRow'), 'the calendar-link row exists');
  ok(page.includes('Secret address in iCal format'), 'it tells the user where to find the link');
  ok(page.includes('/basic.ics'), 'and what the link looks like');
  ok(readCli('lib/accountApi.ts').includes('/api/calendar/ical/connect'), 'the client calls the real connect endpoint');
  // Both options coexist.
  ok(page.includes('function GoogleCalendarRow') && page.includes('<IcalFeedRow />'), 'both the OAuth and the link options are offered');

  head('the deal core is untouched');
  ok((await root.get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await root.get('/api/calendar/events')).status === 200, 'the calendar still responds');

  head('cleanup');
  await prisma.calendar_events.deleteMany({ where: { user_id: uid } });
  await prisma.ical_feeds.deleteMany({ where: { user_id: uid } });
  await prisma.users.delete({ where: { id: uid } });
  ok(await prisma.users.count({ where: { id: uid } }) === 0, 'test user removed');

  console.log(fail === 0 ? `\nALL ${pass} PASS` : `\n${pass} passed, ${fail} FAILED`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
})();
