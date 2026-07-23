/**
 * Verifies the Calendar module: CRUD, validation, filtering, deal linking, scoping and
 * soft delete. Every event this script creates is removed again in a finally block.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const jar = {};
const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } });
const send = (m, p, b) => fetch(BASE + p, { method: m, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: b ? JSON.stringify(b) : undefined });
const TAG = 'CALVERIFY-' + Date.now().toString(36).toUpperCase();

(async () => {
  const prisma = new PrismaClient();
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }) }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exit(1); }

  try {
    const deal = await prisma.transactions.findFirst({ where: { deleted_at: null }, select: { id: true, trade_no: true } });

    // ---- options -----------------------------------------------------------
    console.log('--- event vocabularies ---');
    const opts = await (await get('/api/calendar/options')).json();
    const types = opts.types.map((t) => t.value);
    ok(types.length === 7, `7 event types offered: ${types.join(', ')}`);
    for (const t of ['viewing', 'meeting', 'open-house', 'follow-up', 'call', 'showing', 'task']) {
      ok(types.includes(t), `type "${t}" available`);
    }
    const statuses = opts.statuses.map((s) => s.value);
    ok(['scheduled', 'completed', 'cancelled', 'rescheduled'].every((s) => statuses.includes(s)), `statuses: ${statuses.join(', ')}`);

    // ---- create ------------------------------------------------------------
    console.log('--- create ---');
    const body = {
      title: `${TAG} viewing`,
      date: '2026-08-14', time: '14:30', type: 'viewing', status: 'scheduled',
      location: '123 Main Street', attendees: 'Buyer, Agent',
      contact_phone: '416-555-0100', contact_email: 'client@example.com',
      description: 'Second viewing before offer', property_details: '3 bed / 2 bath',
      notes: 'Bring the disclosure package', enable_reminder: true,
      transaction_id: deal ? deal.id : null,
    };
    const cr = await send('POST', '/api/calendar/events', body);
    ok(cr.status === 201, `created (${cr.status})`);
    const ev = await cr.json();
    ok(ev.id > 0, `event id issued (${ev.id})`);
    // every field round-trips
    for (const [k, v] of Object.entries(body)) {
      if (k === 'transaction_id') continue;
      ok(ev[k] === v, `${k} stored as sent (${JSON.stringify(ev[k])})`);
    }
    ok(ev.date === '2026-08-14', 'the date is not shifted by a timezone');
    ok(ev.created_by === 'GHR Admin', `records who created it (${ev.created_by})`);
    if (deal) {
      ok(ev.transaction_id === deal.id && ev.trade_no === deal.trade_no, `linked to deal #${ev.trade_no}`);
      const logged = await prisma.audit_logs.findFirst({ where: { transaction_id: deal.id, section: 'Calendar' }, orderBy: { id: 'desc' } });
      ok(!!logged && /Event created/.test(logged.action ?? ''), 'linked events are written to the deal audit trail');
    }

    // ---- validation --------------------------------------------------------
    console.log('--- validation ---');
    const bad = async (payload, field, label) => {
      const r = await send('POST', '/api/calendar/events', payload);
      const j = await r.json();
      ok(r.status === 400 && !!j.errors?.[field], `${label} → 400 with a ${field} error: ${j.errors?.[field]?.[0] ?? j.message}`);
    };
    await bad({ ...body, title: '' }, 'title', 'missing title');
    await bad({ ...body, date: '14/08/2026' }, 'date', 'wrong date format');
    await bad({ ...body, date: '2026-02-30' }, 'date', 'impossible date');
    await bad({ ...body, time: '25:00' }, 'time', 'invalid time');
    await bad({ ...body, time: '2:30 PM' }, 'time', '12-hour time');
    await bad({ ...body, type: 'party' }, 'type', 'unknown type');
    await bad({ ...body, status: 'maybe' }, 'status', 'unknown status');
    await bad({ ...body, contact_email: 'not-an-email' }, 'contact_email', 'invalid email');
    await bad({ ...body, transaction_id: 999999 }, 'transaction_id', 'unknown deal');
    const multi = await send('POST', '/api/calendar/events', { title: '', date: 'x', time: 'y' });
    const mj = await multi.json();
    ok(multi.status === 400 && /and \d+ more error/.test(mj.message), `multiple errors summarised: "${mj.message}"`);

    // ---- read / filter -----------------------------------------------------
    console.log('--- read & filter ---');
    const all = await (await get('/api/calendar/events')).json();
    ok(Array.isArray(all) && all.some((e) => e.id === ev.id), `list returns the event (${all.length} total)`);
    const one = await (await get(`/api/calendar/events/${ev.id}`)).json();
    ok(one.id === ev.id, 'fetch by id works');
    const win = await (await get('/api/calendar/events?from=2026-08-01&to=2026-08-31')).json();
    ok(win.some((e) => e.id === ev.id), `date window returns it (${win.length} in August)`);
    const outside = await (await get('/api/calendar/events?from=2026-09-01&to=2026-09-30')).json();
    ok(!outside.some((e) => e.id === ev.id), 'a window that excludes it does not return it');
    const typed = await (await get('/api/calendar/events?type=viewing')).json();
    ok(typed.every((e) => e.type === 'viewing'), `type filter works (${typed.length} viewings)`);
    ok((await (await get('/api/calendar/events')).json()).every((e, i, a) => i === 0 || a[i - 1].date <= e.date), 'events come back in date order');

    // ---- update ------------------------------------------------------------
    console.log('--- update ---');
    const up = await send('PUT', `/api/calendar/events/${ev.id}`, { title: `${TAG} updated`, status: 'completed', time: '09:00' });
    ok(up.status === 200, `updated (${up.status})`);
    const upd = await up.json();
    ok(upd.title === `${TAG} updated` && upd.status === 'completed' && upd.time === '09:00', 'changed fields applied');
    ok(upd.location === '123 Main Street', 'untouched fields are preserved on a partial update');
    const badUp = await send('PUT', `/api/calendar/events/${ev.id}`, { time: 'nonsense' });
    ok(badUp.status === 400, 'update is validated too');

    // ---- delete (soft) -----------------------------------------------------
    console.log('--- delete ---');
    const del = await send('DELETE', `/api/calendar/events/${ev.id}`);
    ok(del.status === 200, `deleted (${del.status})`);
    ok(!(await (await get('/api/calendar/events')).json()).some((e) => e.id === ev.id), 'the deleted event is gone from the list');
    ok((await get(`/api/calendar/events/${ev.id}`)).status === 404, 'fetching it now 404s');
    const rowAfter = await prisma.calendar_events.findUnique({ where: { id: ev.id } });
    ok(!!rowAfter && !!rowAfter.deleted_at, 'the row is soft-deleted, not destroyed');
    ok((await send('DELETE', `/api/calendar/events/${ev.id}`)).status === 404, 'deleting twice 404s');
    ok((await get('/api/calendar/events/999999')).status === 404, 'unknown id 404s');

    // ---- deal link survives a deleted deal ---------------------------------
    console.log('--- referential safety ---');
    const fk = await prisma.$queryRawUnsafe(
      "SELECT confdeltype FROM pg_constraint WHERE conname = 'calendar_events_transaction_id_fkey'",
    );
    ok(fk[0]?.confdeltype === 'n', 'deleting a transaction nulls the link instead of deleting the appointment');

    // ---- Canadian holidays & festivals --------------------------------------
    console.log('--- holidays ---');
    const hol = await (await get('/api/calendar/holidays?year=2026')).json();
    const byName = (n) => hol.data.find((h) => h.name === n);
    ok(Array.isArray(hol.data) && hol.data.length > 0, `${hol.data.length} holidays served for 2026`);
    ok(hol.province === 'ON', 'Ontario is the default province (the brokerage is in Ontario)');
    ok(byName('Canada Day')?.date === '2026-07-01', 'Canada Day is on July 1');
    ok(byName('Victoria Day')?.date === '2026-05-18', 'Victoria Day uses the Monday-before-May-25 rule');
    ok(byName('Thanksgiving')?.date === '2026-10-12', 'Thanksgiving is the second Monday of October');
    ok(byName('Good Friday')?.date === '2026-04-03', 'Good Friday is derived from Easter');
    ok(byName('Diwali')?.date === '2026-11-08', 'Diwali is served from the festival table');
    ok(byName('Diwali')?.approximate === true, 'and flagged approximate, since it follows a lunar calendar');
    ok(byName('Canada Day')?.approximate === false, 'a computed statutory date is not flagged approximate');
    ok(!byName('Remembrance Day'), 'Remembrance Day is not a statutory holiday in Ontario, so it is absent');

    const bc = await (await get('/api/calendar/holidays?year=2026&province=BC')).json();
    ok(bc.data.some((h) => h.name === 'Remembrance Day'), 'but it IS returned for British Columbia');
    ok(bc.data.some((h) => h.name === 'Canada Day'), 'and national holidays appear in every province');

    const range = await (await get('/api/calendar/holidays?from=2025-12-28&to=2026-01-03')).json();
    ok(range.data.some((h) => h.name === "New Year's Day"), 'a range spanning a year boundary works');
    ok(range.data.every((h) => h.date >= '2025-12-28' && h.date <= '2026-01-03'), 'and returns nothing outside it');

    const far = await (await get('/api/calendar/holidays?year=2099')).json();
    ok(far.data.some((h) => h.name === 'Canada Day'), 'statutory holidays are computed for any year');
    ok(!far.data.some((h) => h.name === 'Diwali'), 'festivals are NOT invented for a year with no data');
    ok(Array.isArray(hol.festival_years) && hol.festival_years.length > 0,
      `the festival years are published so the UI can explain the gap (${hol.festival_years.join(', ')})`);

    ok((await get('/api/calendar/holidays?year=abc')).status === 200, 'a junk year falls back to the current one');
    ok((await get('/api/calendar/holidays?year=1200')).status === 400, 'an out-of-range year is rejected');
    // Holidays are computed on request, never written into the events table.
    ok((await prisma.calendar_events.count({ where: { title: 'Canada Day' } })) === 0,
      'no holiday was written into calendar_events — they stay separate from real appointments');

    // ---- frontend wiring ---------------------------------------------------
    console.log('--- frontend ---');
    const page = fs.readFileSync(path.join(CLIENT, 'desk', 'CalendarPage.tsx'), 'utf8');
    ok(!/listTransactions/.test(page), 'the old transaction-dates calendar is gone');
    ok(/calendarApi/.test(page), 'the page uses the calendar API');
    ok(page.includes('listHolidays'), 'the page fetches holidays for the visible month');
    // The "Pick a date" grid marks holidays with a dot (cal-hol-dot); the name shows in the
    // event cards / on hover, keeping the compact grid clean.
    ok(page.includes('cal-hol-dot'), 'and marks them on the day cells');
    // Two cards only — Today's Events and Upcoming Events (the separate day panel was removed).
    for (const feature of ['cal-grid pick', "Today&apos;s Events", 'Upcoming Events', 'Pick a date']) {
      ok(page.includes(feature), `page renders "${feature.replace('&apos;', "'")}"`);
    }
    // Quick Actions was removed on request — assert it stays gone rather than dropping the check.
    ok(!page.includes('Quick Actions'), 'the Quick Actions card is gone');
    // The Todo List moved to the Dashboard on request; same here, assert it stays moved.
    ok(!page.includes('TodoList'), 'the Todo List no longer lives on the Calendar');
    ok(/<TodoList[\s/>]/.test(fs.readFileSync(path.join(CLIENT, 'desk', 'DashboardPage.tsx'), 'utf8')),
      'it is rendered on the Dashboard instead');
    ok(fs.existsSync(path.join(CLIENT, 'desk', 'EventEditorModal.tsx')), 'the event editor exists');
    const modal = fs.readFileSync(path.join(CLIENT, 'desk', 'EventEditorModal.tsx'), 'utf8');
    for (const f of ['title', 'date', 'time', 'type', 'status', 'location', 'attendees', 'contact_phone', 'contact_email', 'description', 'property_details', 'notes', 'enable_reminder']) {
      ok(modal.includes(f), `editor has the "${f}" field`);
    }
    const css = fs.readFileSync(path.join(CLIENT, 'styles', 'desk.css'), 'utf8');
    ok(/\.cal-grid\{/.test(css) && /\.ev-viewing\{/.test(css), 'calendar styles are in desk.css (no Tailwind)');
    ok(!/tailwind|shadcn|lucide-react/i.test(page + modal), 'no Tailwind/shadcn/lucide imports leaked in from the source files');
  } finally {
    const doomed = await prisma.calendar_events.findMany({ where: { title: { contains: TAG } }, select: { id: true } });
    await prisma.calendar_events.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
    await prisma.audit_logs.deleteMany({ where: { section: 'Calendar', details: { contains: TAG } } });
    console.log(`(cleaned up ${doomed.length} test event(s))`);
    await prisma.$disconnect();
  }

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
