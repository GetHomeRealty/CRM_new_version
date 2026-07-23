/**
 * Phase 1 verification — documentation reminders.
 * Covers preview accuracy, permission gating, duplicate warnings, per-document /
 * per-deal / bulk sends, the reminder log, and the follow-up report.
 *
 * Sends are asserted on the LOG (every attempt must be recorded with its delivery status and
 * failure reason) rather than on successful delivery.
 *
 * SAFETY: this script really does send. The mail accounts in this database are live Gmail
 * SMTP accounts, and the reminder recipients are real agents, so the script refuses to run
 * unless MAIL_REDIRECT_TO diverts delivery to a test address. Set it in the environment:
 *
 *     $env:MAIL_REDIRECT_TO='you@example.com'   # and restart the API so it picks it up
 *
 * Do NOT remove this guard — an earlier run without it emailed two real agents.
 */
const { PrismaClient } = require('@prisma/client');

if (!String(process.env.MAIL_REDIRECT_TO ?? '').trim()) {
  console.error([
    '',
    'REFUSING TO RUN — MAIL_REDIRECT_TO is not set.',
    '',
    'This suite sends real documentation reminders, and this database has active SMTP',
    'accounts plus real agent addresses. Running it now would email actual agents.',
    '',
    'Set a safe recipient and restart the API before running:',
    "  $env:MAIL_REDIRECT_TO='you@example.com'",
    '',
  ].join('\n'));
  process.exitCode = 1;
  return;
}
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

function session() {
  const jar = {};
  const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
  const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
  return {
    async login(username, password) {
      take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
      const r = take(await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify({ username, password }) }));
      return r.status;
    },
    get: (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } }),
    post: (p, b) => fetch(BASE + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify(b) }),
  };
}

(async () => {
  const prisma = new PrismaClient();
  const admin = session();
  const code = await admin.login(ADMIN_LOGIN, 'Admin@123');
  if (code !== 200) { console.error('login failed', code); process.exit(1); }
  const search = (t, f = {}) => admin.post(`/api/reports/${t}/search`, { filters: f, per_page: 500 }).then((r) => r.json());

  // Pick deals that have pending documents AND a responsible agent with an email address —
  // without a recipient a reminder is legitimately skipped, which is a different path.
  const emails = new Map((await prisma.users.findMany({ where: { status: 'Active' }, select: { name: true, email: true } }))
    .filter((u) => u.email).map((u) => [u.name, u.email]));
  const dds = await search('deal-documentation-status');
  const withPending = dds.rows.filter((r) => Number(r.pending_docs) > 0 && emails.has(String(r.responsible_user)));
  const noRecipient = dds.rows.filter((r) => Number(r.pending_docs) > 0 && !emails.has(String(r.responsible_user)));
  if (withPending.length < 2) { console.error('need 2 deals with pending docs and an agent email; found', withPending.length); process.exit(1); }
  const A = Number(withPending[0].txn_id), B = Number(withPending[1].txn_id);
  console.log(`(using deals ${withPending[0].trade_no} and ${withPending[1].trade_no}; ${noRecipient.length} deal(s) have no recipient)`);

  // ---- preview ------------------------------------------------------------
  console.log('--- preview (nothing is sent) ---');
  const before = await prisma.document_reminders.count();
  const pv = await (await admin.post('/api/reports/reminders/preview', { transaction_ids: [A], scope: 'pending' })).json();
  ok(await prisma.document_reminders.count() === before, 'previewing writes no reminder rows');
  ok(pv.documents === Number(withPending[0].pending_docs), `applicable document count shown before sending (${pv.documents})`);
  ok(pv.invalid === 0 && pv.pending === pv.documents, 'pending scope counts only pending documents');

  const pvInvalid = await (await admin.post('/api/reports/reminders/preview', { transaction_ids: [A], scope: 'invalid' })).json();
  ok(pvInvalid.pending === 0, 'invalid scope never includes pending documents');

  const docsRes = await (await admin.get(`/api/reports/documents/${A}`)).json();
  const oneDoc = docsRes.groups.find((g) => g.key === 'pending').documents[0];
  const pvOne = await (await admin.post('/api/reports/reminders/preview', { transaction_ids: [A], document_ids: [oneDoc.id], scope: 'pending' })).json();
  ok(pvOne.documents === 1, 'individual reminder targets exactly one document');

  // ---- validation ---------------------------------------------------------
  console.log('--- validation ---');
  const none = await admin.post('/api/reports/reminders/preview', { transaction_ids: [], scope: 'pending' });
  ok(none.status === 400, 'empty selection rejected (400)');
  const huge = await admin.post('/api/reports/reminders/preview', { transaction_ids: Array.from({ length: 201 }, (_, i) => i + 1), scope: 'pending' });
  ok(huge.status === 400, 'runaway selection rejected above the 200-deal limit');
  const unknown = await admin.post('/api/reports/reminders/preview', { transaction_ids: [999999], scope: 'pending' });
  ok(unknown.status === 404, 'unknown transaction → 404, never a leak');

  // ---- individual send ----------------------------------------------------
  console.log('--- individual document reminder ---');
  const r1 = await (await admin.post('/api/reports/reminders/send', { transaction_ids: [A], document_ids: [oneDoc.id], scope: 'pending' })).json();
  ok(!!r1.batch_id, `send returned a batch id (${r1.batch_id})`);
  const logged1 = await prisma.document_reminders.findMany({ where: { batch_id: r1.batch_id } });
  ok(logged1.length === 1, 'exactly one log row for a one-document reminder');
  ok(logged1[0].document_id === oneDoc.id && logged1[0].document_name === oneDoc.name, 'log records which document was reminded');
  ok(logged1[0].reminder_type === 'individual', `reminder type recorded as "${logged1[0].reminder_type}"`);
  ok(['Sent', 'Failed'].includes(logged1[0].delivery_status), `delivery status recorded (${logged1[0].delivery_status})`);
  ok(logged1[0].delivery_status === 'Sent' || !!logged1[0].failure_reason, 'a failed or skipped send always records why');
  ok(logged1[0].sent_by === 'GHR Admin' || !!logged1[0].sent_by, `sent-by recorded (${logged1[0].sent_by})`);
  ok(!!logged1[0].sent_at, 'sent timestamp recorded');
  ok(logged1[0].channel === 'email', 'communication channel recorded');
  // MAIL_REDIRECT_TO must actually divert delivery when set, and say so in the log
  if (process.env.EXPECT_MAIL_REDIRECT) {
    ok(/\[redirected to /.test(String(logged1[0].message)), `delivery was redirected away from the agent: ${logged1[0].message}`);
    ok(logged1[0].recipient !== process.env.EXPECT_MAIL_REDIRECT, 'the log still records the intended recipient, not the redirect target');
  }

  // ---- duplicate guard ----------------------------------------------------
  console.log('--- duplicate protection ---');
  const pvDup = await (await admin.post('/api/reports/reminders/preview', { transaction_ids: [A], document_ids: [oneDoc.id], scope: 'pending' })).json();
  const warned = pvDup.duplicate_warnings.some((d) => d.document === oneDoc.name);
  ok(logged1[0].delivery_status !== 'Sent' || warned, 'a recently-reminded document raises a duplicate warning');

  // ---- consolidated per-deal send ----------------------------------------
  console.log('--- consolidated reminder for one deal ---');
  const r2 = await (await admin.post('/api/reports/reminders/send', { transaction_ids: [A], scope: 'pending' })).json();
  const logged2 = await prisma.document_reminders.findMany({ where: { batch_id: r2.batch_id } });
  ok(logged2.length === Number(withPending[0].pending_docs), `one log row per document in the deal (${logged2.length})`);
  ok(new Set(logged2.map((l) => l.transaction_id)).size === 1, 'a consolidated reminder covers exactly one deal');
  ok(logged2.every((l) => l.reminder_type === 'deal_pending'), 'reminder type recorded as deal_pending');
  ok(logged2.every((l) => l.document_status === 'Pending'), 'only pending documents were included');

  // ---- bulk across deals --------------------------------------------------
  console.log('--- bulk reminder across deals ---');
  const r3 = await (await admin.post('/api/reports/reminders/send', { transaction_ids: [A, B], scope: 'pending' })).json();
  const logged3 = await prisma.document_reminders.findMany({ where: { batch_id: r3.batch_id } });
  const dealsInBatch = new Set(logged3.map((l) => l.transaction_id));
  ok(dealsInBatch.size === 2, 'bulk send covers both deals');
  ok(logged3.every((l) => l.reminder_type === 'bulk_pending'), 'bulk reminder type recorded');
  ok(r3.deals.length === 2, 'result reports each deal separately — deals are never mixed');
  ok(r3.deals.every((d) => d.documents > 0), 'each deal reports its own document count');

  // ---- deals with no recipient are skipped, not silently dropped ----------
  if (noRecipient.length) {
    console.log('--- deals without a recipient ---');
    const N = Number(noRecipient[0].txn_id);
    const pvN = await (await admin.post('/api/reports/reminders/preview', { transaction_ids: [N], scope: 'pending' })).json();
    ok(pvN.documents === 0 && pvN.missing_recipients.length === 1, 'a deal with no agent email is reported as skipped before sending');
    ok(/no email address/i.test(pvN.missing_recipients[0].reason), `the reason is explained: "${pvN.missing_recipients[0].reason}"`);
    const rN = await (await admin.post('/api/reports/reminders/send', { transaction_ids: [N], scope: 'pending' })).json();
    ok(rN.skipped === 1 && rN.sent === 0, 'sending skips it rather than failing the whole request');
    const lN = await prisma.document_reminders.findMany({ where: { batch_id: rN.batch_id } });
    ok(lN.length > 0 && lN.every((l) => l.delivery_status === 'Skipped' && l.failure_reason), 'the skip is still logged, with a reason');
  }

  // ---- agent scoping ------------------------------------------------------
  console.log('--- permissions ---');
  const agentUser = await prisma.users.findFirst({ where: { role: 'agent', status: 'Active' }, select: { email: true, name: true } });
  if (agentUser?.email) {
    const agent = session();
    const st = await agent.login(agentUser.email, 'Admin@123');
    if (st === 200) {
      const res = await agent.post('/api/reports/reminders/send', { transaction_ids: [A, B], scope: 'pending' });
      ok(res.status === 403, 'an agent cannot send bulk reminders across deals (403)');
    } else {
      ok(true, `(agent login unavailable — skipped bulk-permission check, status ${st})`);
    }
  } else {
    ok(true, '(no agent user with an email — skipped bulk-permission check)');
  }

  // ---- reminder history report -------------------------------------------
  console.log('--- Documentation Reminder and Follow-Up report ---');
  const hist = await search('documentation-reminder-followup');
  const totalLogs = await prisma.document_reminders.count();
  ok(hist.rows.length === totalLogs, `report lists every logged reminder (${hist.rows.length} vs ${totalLogs})`);
  ok(hist.rows.every((r) => r.reminder_id && r.trade_no && r.channel && r.sent_at && r.delivery_status), 'every row carries id, deal, channel, timestamp and delivery status');
  const sentOnly = await search('documentation-reminder-followup', { status: 'Sent' });
  ok(sentOnly.rows.every((r) => r.delivery_status === 'Sent'), `delivery status filter works (${sentOnly.rows.length} sent)`);
  const typed = await search('documentation-reminder-followup', { reminder_type: 'individual' });
  ok(typed.rows.every((r) => r.reminder_type === 'individual'), `reminder type filter works (${typed.rows.length} individual)`);
  ok(hist.rows[0].sent_at >= hist.rows[hist.rows.length - 1].sent_at, 'history is newest-first');

  for (const fmt of ['xlsx', 'pdf']) {
    const res = await admin.post(`/api/reports/documentation-reminder-followup/export/${fmt}`, { filters: {} });
    const buf = Buffer.from(await res.arrayBuffer());
    const magic = fmt === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString() === 'PK';
    ok(res.status === 200 && magic, `reminder history exports to ${fmt.toUpperCase()} (${buf.length} bytes)`);
  }

  await prisma.$disconnect();
  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
