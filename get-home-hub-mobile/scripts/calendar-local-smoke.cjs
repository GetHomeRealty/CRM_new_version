// Explicitly limited to the disposable database and loopback API. No reminders are enabled.
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { PrismaClient } = require('../../server/node_modules/@prisma/client');
const dbUrl = process.env.DATABASE_URL || '';
const parsed = new URL(dbUrl);
assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname === '/gh_mobile_test', 'Requires isolated gh_mobile_test database');
const db = new PrismaClient();
const token = randomBytes(32).toString('base64url');
const sid = 'mobile:' + createHash('sha256').update(token).digest('hex');
const title = 'Calendar local smoke ' + randomBytes(6).toString('hex');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch('http://127.0.0.1:8000/api/calendar/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
(async () => {
  try {
    assert.equal(await db.google_connections.count(), 0, 'Refusing event tests with connected Google accounts');
    await db.user_sessions.create({ data: { sid, sess: { userId: 1, mobile: true }, expire: new Date(Date.now() + 300000) } });
    const event = await request('events?area=desk', 'POST', { title, date: '2030-02-01', time: '09:00', end_time: '10:00', type: 'meeting', status: 'scheduled', enable_reminder: false, recur_freq: 'weekly', recur_count: 3 }, 201);
    assert.equal(event.recurrence.occurrences, 3);
    const overlapping = { title, date: '2030-02-01', time: '09:30', end_time: '10:30', type: 'meeting', status: 'scheduled', enable_reminder: false };
    const conflict = await request('events?area=desk', 'POST', overlapping, 400);
    assert.equal(conflict.conflict.id, event.id);
    const override = await request('events?area=desk', 'POST', { ...overlapping, allow_overlap: true }, 201);
    await request(`events/${override.id}?area=desk`, 'DELETE');
    const list = await request('events?area=desk&from=2030-02-01&to=2030-02-28');
    assert.equal(list.filter(row => row.title === title).length, 3);
    const crm = await request('events?area=crm&from=2030-02-01&to=2030-02-28');
    assert.equal(crm.filter(row => row.title === title).length, 0);
    await request(`events/${event.id}?area=crm`, 'PUT', { title: 'Wrong area' }, 404);
    await request(`events/${event.id}?area=desk&scope=series`, 'PUT', { version: event.version, location: 'Local test room' });
    await request(`events/${event.id}?area=desk`, 'PUT', { version: event.version, location: 'Stale write' }, 409);
    const changed = await request('events?area=desk&from=2030-02-01&to=2030-02-28');
    assert.equal(changed.filter(row => row.title === title).length, 3);
    assert.ok(changed.filter(row => row.title === title).every(row => row.location === 'Local test room' && row.enable_reminder === false));
    await request(`events/${event.id}?area=desk&scope=series`, 'DELETE');
    const remaining = await request('events?area=desk&from=2030-02-01&to=2030-02-28');
    assert.equal(remaining.filter(row => row.title === title).length, 0);
    console.log('PASS: recurring create/read, CRM isolation, wrong-area rejection, series update/delete, stale-version rejection');
  } finally {
    // Cleanup is scoped to this run's unique title even if an assertion failed.
    await db.calendar_events.updateMany({ where: { title }, data: { deleted_at: new Date(), enable_reminder: false } });
    await db.user_sessions.deleteMany({ where: { sid } });
    await db.$disconnect();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
