/**
 * Send-email-per-lead, and repeatable property preferences with a multi-select property type.
 *
 * SAFETY: this script never sends an email. The one lead in this database is a real person who
 * has already been contacted twice by accident from verification runs. Every email assertion here
 * exercises a path that is REJECTED BEFORE SMTP is reached — missing subject, empty body,
 * unsubscribed recipient, unknown lead. The success path is verified by reading the code, not by
 * putting a message in someone's inbox.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');
const SRV = path.join(process.cwd(), 'src');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);
const readCli = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const readSrv = (rel) => fs.readFileSync(path.join(SRV, rel), 'utf8');

const jar = {};
const take = (r) => {
  for (const c of (r.headers.getSetCookie?.() || [])) {
    const nv = c.split(';')[0], i = nv.indexOf('=');
    if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1);
  }
  return r;
};
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } });
const send = (m, p, b) => fetch(BASE + p, {
  method: m,
  headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
  body: b === undefined ? undefined : JSON.stringify(b),
});

(async () => {
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await send('POST', '/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exitCode = 1; return; }

  // A throwaway lead, so nothing here touches the real one.
  const made = await (await send('POST', '/api/leads', {
    // Unique per run: a previous run that died before its cleanup must not block the next one.
    name: 'Preference Verification', email: `verify-${process.pid}-${Date.now()}@example.invalid`, lead_status: 'warm',
  })).json();
  ok(made.id > 0, `created test lead #${made.id} (example.invalid — unroutable by design)`);
  const emailRowsAtStart = await prisma.lead_emails.count();

  head('several sets of property preferences on one lead');
  const two = [
    { budget: { min: 400000, max: 600000 }, propertyType: ['Condo'], bedrooms: 2, features: ['Balcony'] },
    { budget: { min: 900000, max: null }, propertyType: ['Detached', 'Duplex'], bedrooms: 4, lotSize: '50x120' },
  ];
  ok((await send('PUT', `/api/leads/${made.id}`, { property_preferences: two })).status === 200,
    'a list of preference sets is accepted');
  let detail = await (await get(`/api/leads/${made.id}`)).json();
  ok(Array.isArray(detail.property_preferences), 'and comes back as a list');
  ok(detail.property_preferences.length === 2, 'with both sets intact');
  ok(detail.property_preferences[0].bedrooms === 2 && detail.property_preferences[1].bedrooms === 4,
    'in the order they were given — "2nd Preference" stays the second one');

  head('property type takes several values, including ones outside the vocabulary');
  ok(detail.property_preferences[1].propertyType.length === 2, 'two types on one set');
  const custom = [{ propertyType: ['Condo', 'Tiny home on wheels'] }];
  ok((await send('PUT', `/api/leads/${made.id}`, { property_preferences: custom })).status === 200,
    'a custom type is accepted');
  detail = await (await get(`/api/leads/${made.id}`)).json();
  ok(detail.property_preferences[0].propertyType.includes('Tiny home on wheels'),
    'and stored verbatim, so a preference the brokerage has no word for still survives');
  const opts = await (await get('/api/leads/options')).json();
  ok(!opts.property_types.includes('Tiny home on wheels'), 'without polluting the shared vocabulary');

  head('older single-object preferences still load');
  // Rows written before preferences could repeat hold a bare object; those must not break.
  ok((await send('PUT', `/api/leads/${made.id}`, { property_preferences: { bedrooms: 3 } })).status === 200,
    'a bare object is still accepted');
  detail = await (await get(`/api/leads/${made.id}`)).json();
  ok(Array.isArray(detail.property_preferences) && detail.property_preferences[0].bedrooms === 3,
    'and is wrapped into a list, so the client has one shape to render');
  ok((await send('PUT', `/api/leads/${made.id}`, { property_preferences: [] })).status === 200
    && (await (await get(`/api/leads/${made.id}`)).json()).property_preferences === null,
    'an empty list clears them rather than storing an empty shell');

  head('emailing one lead — every check that runs BEFORE SMTP');
  ok((await get(`/api/leads/${made.id}`)).status === 200, 'the lead detail carries an emails list');
  ok(Array.isArray((await (await get(`/api/leads/${made.id}`)).json()).emails), 'which starts empty');

  /*
   * The lead is marked unsubscribed FIRST, and only then are the email requests made.
   *
   * `unsubscribed` is not writable through the lead API — it is set by the unsubscribe link — so
   * this goes straight to the database. Doing it first is the safety measure that matters: the
   * unsubscribe check runs before anything else in sendEmail, so from here on no request in this
   * script can reach SMTP even if its subject and body are perfectly valid. An earlier version
   * of this script left it until later and did put a message on the wire.
   */
  await prisma.leads.update({ where: { id: made.id }, data: { unsubscribed: true, unsubscribed_at: new Date() } });

  const blocked = await send('POST', `/api/leads/${made.id}/email`, { subject: 'x', body: 'y' });
  ok(blocked.status === 400, 'an unsubscribed lead cannot be emailed');
  ok(/unsubscrib/i.test(JSON.stringify(await blocked.json())), 'and the refusal says why');

  ok((await send('POST', `/api/leads/${made.id}/email`, { body: 'x' })).status === 400, 'a missing subject is refused');
  ok((await send('POST', `/api/leads/${made.id}/email`, { subject: 'x' })).status === 400, 'an empty body is refused');
  ok((await send('POST', `/api/leads/${made.id}/email`, { subject: 'x'.repeat(300), body: 'x' })).status === 400,
    'an over-long subject is refused');
  ok((await send('POST', '/api/leads/99999999/email', { subject: 'x', body: 'y' })).status === 404,
    'a missing lead is a 404');
  ok((await send('POST', `/api/leads/${made.id}/email`, { subject: 'x', body: 'y', account_id: 'nope' })).status === 400,
    'a nonsense mail account is refused');

  ok((await (await get(`/api/leads/${made.id}`)).json()).emails.length === 0,
    'none of the refused attempts wrote a history row');
  // The real safety net: a row exists only when sendDirect was called, so zero rows created
  // during this run proves nothing was put on the wire.
  ok(await prisma.lead_emails.count() === emailRowsAtStart,
    `no email left the server during this run (${emailRowsAtStart} row(s) before and after)`);

  head('the send path itself, read rather than exercised');
  // Deliberately not sent: the deliverable addresses in this database belong to real people.
  const svc = readSrv('leads/lead-activity.service.ts');
  ok(svc.includes('this.mailer.sendDirect'), 'it goes out through the SMTP account Email Settings manages');
  ok(/unsubscribed\)\s*\{/.test(svc), 'the unsubscribe check is in the service, not only in the UI');
  ok(/status = 'failed'/.test(svc) && /error = String/.test(svc), 'a failure is recorded with its reason');
  ok(svc.includes('lead_emails.create'), 'and a row is written either way, so the history is not success-only');
  ok(!/tracking|pixel|unsubscribe_link/i.test(svc.slice(svc.indexOf('async sendEmail'), svc.indexOf('presentEmail'))),
    'no campaign tracking is bolted onto a one-to-one email');

  head('frontend wiring');
  const page = readCli('desk/LeadDetailPage.tsx');
  ok(page.includes('Send Email'), 'the lead has a Send Email action');
  ok(page.includes('function EmailComposer'), 'with a composer');
  ok(page.includes('lead.unsubscribed'), 'disabled for an unsubscribed lead');
  ok(page.includes('Email History'), 'and the sent history is shown on the lead');
  ok(page.includes('escapeHtml'), 'the typed message is escaped, so it cannot inject markup');
  ok(page.includes('prefHeading(i)'), 'preference blocks are numbered on the detail');

  const editor = readCli('desk/LeadEditorModal.tsx');
  ok(editor.includes('+ Add Preference'), 'the editor can add another preference set');
  ok(editor.includes('function PropertyTypePicker'), 'property type is its own multi-select control');
  ok(editor.includes('type="checkbox"'), 'chosen with checkboxes, not a ctrl-click multi-select');
  ok(editor.includes('+ Custom'), 'with a Custom option');
  ok(editor.includes('type-chosen'), 'and the selection is echoed back below');
  ok(editor.includes("prefHeading"), 'blocks are labelled Property Preferences, 2nd Preference, …');

  head('assignment is already shown');
  // Reported as already present rather than built twice.
  ok(page.includes('k="Assigned To"'), 'the lead detail shows who it is assigned to');
  ok(readCli('desk/LeadsPage.tsx').includes('l.assigned_to_name'), 'and so does the Leads list');
  ok(readCli('desk/LeadsPage.tsx').includes('Unassigned'), 'with an explicit Unassigned when nobody owns it');
  const listed = await (await get('/api/leads')).json();
  ok('assigned_to_name' in listed.data[0], 'the API supplies the assignee name on every row');

  head('the deal core is untouched');
  ok((await get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await get('/api/invoices')).status === 200, 'invoices still respond');
  ok((await get('/api/dashboard/commissions')).status === 200, 'the dashboard still responds');

  head('cleanup');
  ok((await send('DELETE', `/api/leads/${made.id}`)).status === 200, 'the test lead is deleted');
  ok((await send('DELETE', `/api/leads/deleted/${made.id}`)).status === 200, 'and purged from the bin');
  const left = await (await get('/api/leads')).json();
  ok(!left.data.some((l) => l.id === made.id), 'no test lead is left behind');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
})();
