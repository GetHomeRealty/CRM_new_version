/**
 * Meta integration completion verification — the parts added on top of verify-meta.cjs:
 * field mapping, duplicate rules, webhook idempotency, token lifecycle, sync history,
 * the lead↔calendar link, and the Settings embed.
 *
 * Nothing here contacts Facebook: there are no Meta credentials in this environment, so the
 * Graph calls themselves stay unverifiable and are reported as such rather than claimed.
 * Everything below runs against the live API and the real database.
 */
const fs = require('fs');
const path = require('path');
const { createHmac } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { mapMetaLead, normalizePhone } = require('../dist/meta/meta-lead-mapper');

// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');
const SECRET = process.env.META_WEBHOOK_SECRET || 'shh';
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'verify-me';

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const skip = (m) => { skipped++; console.log('  SKIP ' + m); };
const head = (t) => console.log(`\n--- ${t} ---`);
const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

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
  method: m, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }),
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const sign = (raw) => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
const webhook = (raw, signature) => fetch(BASE + '/api/meta/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
  body: raw,
});

const MARK = `zzmeta-${process.pid}`;
const createdLeads = [];
const createdEvents = [];

(async () => {
  const prisma = new PrismaClient();
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  if (take(await send('POST', '/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' })).status !== 200) {
    console.error('login failed'); process.exitCode = 1; return;
  }

  const leadsBefore = await prisma.leads.count();
  const txnsBefore = await prisma.transactions.count();

  // The webhook checks need the API started with the same secrets this script signs with.
  const probe = await fetch(`${BASE}/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=X`);
  const webhookReady = probe.status === 200;
  if (!webhookReady) {
    console.log(`\nNOTE  the API was not started with META_WEBHOOK_VERIFY_TOKEN='${VERIFY_TOKEN}' /`);
    console.log('      META_WEBHOOK_SECRET, so the delivery checks are skipped.');
  }

  try {
    head('lead-form field mapping (Meta forms are user-defined, so mapping must be forgiving)');
    const m = mapMetaLead([
      { name: 'first_name', values: ['Ada'] },
      { name: 'last_name', values: ['Lovelace'] },
      { name: 'email', values: ['ada@example.invalid'] },
      { name: 'phone_number', values: ['+1 (416) 555-0100'] },
      { name: 'what_is_your_budget?', values: ['$800k'] },
      { name: 'how_soon_are_you_looking_to_move', values: ['3 months'] },
      { name: 'which_city_do_you_prefer', values: ['Toronto'] },
      { name: 'do_you_have_an_agent', values: ['No'] },
    ]);
    ok(m.first_name === 'Ada' && m.last_name === 'Lovelace', 'first and last name captured separately');
    ok(m.name === 'Ada Lovelace', 'and combined into the display name');
    ok(m.email === 'ada@example.invalid', 'email mapped');
    ok(m.budget === '$800k', 'a custom-worded budget question still maps to budget');
    ok(m.timeline === '3 months', 'a custom-worded timeline question maps to timeline');
    ok(m.location === 'Toronto', 'a custom-worded city question maps to location');
    ok(m.custom_fields['do_you_have_an_agent'] === 'No', 'an unmapped answer is preserved, not dropped');
    ok(m.phone_normalized === '4165550100', `phone normalised (${m.phone_normalized})`);

    const split = mapMetaLead([{ name: 'full_name', values: ['Grace Hopper'] }]);
    ok(split.first_name === 'Grace' && split.last_name === 'Hopper', 'a single full-name answer is split');
    ok(mapMetaLead([]).name === 'Meta lead', 'a form with no answers still yields an identifiable lead');
    ok(mapMetaLead([{ name: 'email', values: ['x@y.co'] }]).name === 'x@y.co', 'the email becomes the name when none was collected');

    head('phone normalisation (duplicate rule 3)');
    ok(normalizePhone('416-555-0100') === normalizePhone('+1 416 555 0100'), 'two formats of one number match');
    ok(normalizePhone('4165550100') === normalizePhone('(416) 555-0100'), 'punctuation is irrelevant');
    ok(normalizePhone('123') === null, 'a too-short string is not treated as a phone number');
    ok(normalizePhone('') === null, 'an empty value normalises to null, not a match-all');

    head('the Leads module keeps the normalised phone in step');
    const created = await json(await send('POST', '/api/leads', {
      name: `${MARK} Existing Person`, email: `${MARK}-dupe@example.invalid`, phone: '(416) 555-0142',
    }));
    createdLeads.push(created.id);
    const stored = await prisma.leads.findUnique({ where: { id: created.id }, select: { phone_normalized: true } });
    ok(stored.phone_normalized === '4165550142', `a manually created lead stores the normalised phone (${stored.phone_normalized})`);
    await send('PUT', `/api/leads/${created.id}`, { phone: '+1-416-555-0199' });
    const after = await prisma.leads.findUnique({ where: { id: created.id }, select: { phone_normalized: true } });
    ok(after.phone_normalized === '4165550199', 'and updates it when the phone changes');

    head('webhook idempotency');
    if (!webhookReady) {
      skip('a repeated delivery is recorded once');
      skip('the retry is counted on the same row');
      skip('an unconnected form is ignored rather than failed');
    } else {
      const payload = JSON.stringify({
        object: 'page',
        entry: [{ id: '777', changes: [{ field: 'leadgen', value: { leadgen_id: `L-${MARK}`, form_id: 'F-UNKNOWN', page_id: '777' } }] }],
      });
      await webhook(payload, sign(payload));
      await webhook(payload, sign(payload));
      const events = await prisma.meta_webhook_events.findMany({ where: { leadgen_id: `L-${MARK}` } });
      ok(events.length === 1, `a repeated delivery creates ONE event row, not two (${events.length})`);
      ok(events[0].attempts === 2, `the retry is counted on the same row (attempts=${events[0].attempts})`);
      ok(events[0].status === 'ignored', 'an unconnected form is recorded as ignored, not failed');
      ok(events[0].lead_id === null, 'and no lead was created');
      ok((await prisma.leads.count()) === leadsBefore + 1, 'only the one lead this suite created exists');
    }

    head('webhook health and sync history');
    const health = await json(await get('/api/meta/webhook-health'));
    ok(typeof health.total === 'number' && Array.isArray(health.events), 'webhook health is reported');
    ok('failed' in health && 'last_received_at' in health, 'including failures and the last delivery time');
    ok(Array.isArray(await json(await get('/api/meta/sync-history'))), 'sync history is reported');

    head('token lifecycle, permissions and errors in status');
    const st = await json(await get('/api/meta/status'));
    for (const k of ['connected_forms', 'token_expires_at', 'token_days_left', 'token_expired',
      'needs_reconnect', 'granted_scopes', 'missing_permissions', 'ad_account_id',
      'last_error', 'last_error_at', 'last_webhook_at']) {
      ok(k in st, `status reports "${k}"`);
    }
    ok(!JSON.stringify(st).includes('access_token'), 'status never carries an access token');

    head('ad accounts degrade rather than fail the import');
    ok((await get('/api/meta/ad-accounts')).status === 400, 'ad accounts need a connection (400 while disconnected)');
    ok((await send('POST', '/api/meta/ad-accounts/select', { id: 'act_1' })).status === 400, 'selecting one needs a connection too');

    head('calendar follow-up linked to a lead');
    const ev = await json(await send('POST', '/api/calendar/events', {
      title: `${MARK} follow-up`, date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      time: '10:00', type: 'follow-up', lead_id: created.id,
    }));
    if (ev?.id) createdEvents.push(ev.id);
    ok(ev.id > 0 && ev.lead_id === created.id, 'an event can be linked to a lead');
    ok((await json(await get(`/api/calendar/events?lead_id=${created.id}`))).some((e) => e.id === ev.id), 'and found by that lead');
    ok((await send('POST', '/api/calendar/events', {
      title: 'x', date: '2026-09-01', time: '10:00', type: 'follow-up', lead_id: 999999,
    })).status === 400, 'linking to a lead that does not exist is rejected');
    const plain = await json(await send('POST', '/api/calendar/events', {
      title: `${MARK} plain`, date: '2026-09-02', time: '11:00', type: 'meeting',
    }));
    if (plain?.id) createdEvents.push(plain.id);
    ok(plain.lead_id === null, 'an ordinary calendar event is unaffected and has no lead');

    head('Meta attribution on the lead record');
    const leadRow = await json(await get(`/api/leads/${created.id}`));
    ok('meta' in leadRow && leadRow.meta === null, 'a manually created lead reports meta = null');
    ok('source' in leadRow && 'first_name' in leadRow && 'facebook_lead_id' in leadRow, 'provenance fields are exposed');
    ok(leadRow.lead_source !== 'meta', 'its existing lead_source value is untouched');

    head('frontend wiring');
    ok(read('desk/CrmSettingsPanel.tsx').includes('<MetaConnectionPanel'), 'the Meta panel is embedded in Settings');
    const panel = read('desk/MetaConnectionPanel.tsx');
    for (const bit of ['Test Connection', 'Reconnect', 'Disconnect', 'Sync Now', 'Token expires', 'Last webhook', 'Leads imported']) {
      ok(panel.includes(bit), `the panel exposes "${bit}"`);
    }
    ok(!/access_token/.test(panel), 'the panel never handles an access token');
    const detail = read('desk/LeadDetailPage.tsx');
    ok(detail.includes('Meta / Facebook Source'), 'the lead detail shows Meta attribution');
    ok(detail.includes('Schedule Follow-up'), 'and offers a calendar follow-up');
    ok(read('desk/EmailSettingsPage.tsx').includes('CrmSettingsPanel'), 'Email Settings still hosts the settings panel');

    head('data-deletion callback (required by Meta)');
    const del = await fetch(BASE + '/api/meta/data-deletion', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signed_request: 'bogus.payload' }),
    });
    ok(del.status === 200, 'the callback answers 200 so Meta does not retry forever');
    const delBody = await json(del);
    ok(typeof delBody.url === 'string' && typeof delBody.confirmation_code === 'string',
      'and returns the url + confirmation_code Meta requires');
    ok(delBody.confirmation_code === 'invalid-request', 'an unsigned request is rejected, not acted on');

    head('the deal core is untouched');
    ok((await prisma.transactions.count()) === txnsBefore, `transactions unchanged (${txnsBefore})`);
    const txns = await json(await get('/api/transactions'));
    ok((Array.isArray(txns) ? txns : txns.data).length > 0, 'transactions still load');
    ok((await (await get('/api/reports')).json()).length >= 20, 'reports still respond');
    ok((await get('/api/mail-accounts')).status === 200, 'Transaction Desk mail accounts still respond');
    ok((await get('/api/email-templates')).status === 200, 'Transaction Desk email templates still respond');
    ok((await get('/api/company-settings')).status === 200, 'company settings still respond');
    ok((await get('/api/invoices')).status === 200, 'invoices still respond');
  } finally {
    head('cleanup');
    for (const id of createdEvents) await prisma.calendar_events.deleteMany({ where: { id } });
    for (const id of createdLeads) await prisma.leads.deleteMany({ where: { id } });
    await prisma.meta_webhook_events.deleteMany({ where: { leadgen_id: { contains: MARK } } });
    ok((await prisma.leads.count()) === leadsBefore, `lead count back to ${leadsBefore}`);
    ok((await prisma.meta_webhook_events.count({ where: { leadgen_id: { contains: MARK } } })) === 0, 'test webhook events removed');
    await prisma.$disconnect();

    const note = skipped ? ` (${skipped} skipped — see the NOTE above)` : '';
    console.log(fail === 0 ? `\nALL ${pass} PASS ✅${note}` : `\n${pass} passed, ${fail} FAILED ❌${note}`);
    // Set the code rather than calling process.exit(): forcing exit while fetch's keep-alive
    // sockets are still closing trips a libuv assertion on Windows and reports a bogus code.
    process.exitCode = fail === 0 ? 0 : 1;
  }
})();
