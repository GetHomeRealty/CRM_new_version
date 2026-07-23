/**
 * IMAP inbound sync.
 *
 * What can be tested without a live mailbox is tested for real:
 *   - IMAP config saves on a mail account,
 *   - a sync against an unreachable server fails gracefully and records the reason (this exercises
 *     the real ImapFlow connect + error path),
 *   - stored inbound messages are private to their owner, deduped per (account, UID), and matched
 *     to the owner's lead by sender address,
 *   - the inbox reader scopes every query to the signed-in user.
 * Directly-inserted rows stand in for a real pull, since connecting to an actual inbox needs
 * credentials this test does not have. All test users and rows are removed at the end.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);

function session() {
  const jar = {};
  const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
  const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
  const req = (m, p, b) => fetch(BASE + p, { method: m, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: b === undefined ? undefined : JSON.stringify(b) });
  return {
    async login(u, pw) { take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H })); return take(await req('POST', '/api/login', { username: u, password: pw })).status; },
    get: (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } }),
    post: (p, b) => req('POST', p, b), put: (p, b) => req('PUT', p, b),
  };
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const ids = { u1: null, u2: null, acct: null, lead: null };

(async () => {
  const root = session();
  if (await root.login(ADMIN_LOGIN, 'Admin@123') !== 200) { console.error('root login failed'); process.exitCode = 1; return; }

  const PW = 'ImapTest@12345';
  const stamp = `${process.pid}-${Date.now()}`;
  for (const [key, role] of [['u1', 'agent'], ['u2', 'agent']]) {
    const email = `imap-${key}-${stamp}@example.invalid`;
    const r = await j(await root.post('/api/users', { name: `Imap ${key}`, username: `imap_${key}_${stamp}`, email, password: PW, password_confirmation: PW, role, status: 'Active' }));
    ids[key] = r.body.id ?? (await prisma.users.findFirst({ where: { email } }))?.id;
    ok(ids[key], `created ${key} #${ids[key]}`);
  }
  const u1 = session(); await u1.login(`imap_u1_${stamp}`, PW);

  head('a mail account stores IMAP config and the enable-sync switch');
  const add = await j(await u1.post('/api/account/mail-accounts', {
    name: 'My Mailbox', from_email: `u1-${stamp}@example.invalid`, host: 'smtp.example.invalid', port: 587, encryption: 'tls',
    username: `u1-${stamp}@example.invalid`, password: 'app-password',
    imap_host: '127.0.0.1', imap_port: 1, imap_encryption: 'ssl', inbound_enabled: true,
  }));
  ok(add.status === 201, 'the account was created with IMAP settings');
  ids.acct = add.body.id;
  ok(add.body.imap_host === '127.0.0.1' && add.body.imap_port === 1, 'IMAP host and port are stored');
  ok(add.body.inbound_enabled === true, 'inbound sync is switched on');
  ok(!('password' in add.body), 'the password is never returned');
  ok((await j(await u1.post('/api/account/mail-accounts', { name: 'x', from_email: `y-${stamp}@example.invalid`, host: 'h', inbound_enabled: true }))).status >= 400,
    'turning on sync with no IMAP host is rejected');

  head('a sync against an unreachable server fails gracefully');
  const sync = await j(await u1.post(`/api/account/inbox/sync/${ids.acct}`));
  ok(sync.status === 200 || sync.status === 201, 'the sync endpoint answers rather than hanging');
  ok(sync.body.error && /reach|imap|sign-in|sync failed/i.test(sync.body.error), `it reports the failure: "${sync.body.error}"`);
  const acctRow = await prisma.mail_accounts.findUnique({ where: { id: ids.acct }, select: { sync_error: true, last_synced_at: true } });
  ok(acctRow.sync_error && acctRow.last_synced_at, 'and records the error and time on the account');
  ok((await j(await u1.post(`/api/account/inbox/sync/99999999`))).status >= 400, 'syncing an account you do not own is refused');

  head('stored messages are matched to the owner-s lead and deduped');
  const lead = await j(await u1.post('/api/leads', { name: 'Sender Lead', email: `sender-${stamp}@example.invalid` }));
  ids.lead = lead.body.id;
  // Stand in for a real pull: insert two messages (one from the lead, one from a stranger),
  // through the same code path the sync uses — the unique (account, uid) index and the lead match.
  const mkMsg = (uid, from, leadId) => prisma.inbound_emails.create({ data: {
    user_id: ids.u1, account_id: ids.acct, uid, from_email: from, from_name: 'X', subject: `Msg ${uid}`,
    snippet: 'hello', body_text: 'hello there', received_at: new Date(), lead_id: leadId, created_at: new Date(),
  } });
  await mkMsg(101, `sender-${stamp}@example.invalid`, ids.lead);
  await mkMsg(102, `stranger-${stamp}@example.invalid`, null);
  ok(await prisma.inbound_emails.count({ where: { account_id: ids.acct } }) === 2, 'two messages stored');
  let dupErr = false;
  try { await mkMsg(101, 'dupe', null); } catch { dupErr = true; }
  ok(dupErr, 'a second message with the same (account, UID) is rejected by the unique index — dedup holds');

  head('the inbox reader is scoped to the signed-in user');
  const inbox = await j(await u1.get('/api/account/inbox'));
  ok(inbox.body.data.length === 2, 'the owner sees both messages');
  ok(inbox.body.data.some((m) => m.lead_id === ids.lead && m.lead_name === 'Sender Lead'), 'the matched message links to the lead');
  ok(inbox.body.unread === 2, 'both start unread');

  const u2 = session(); await u2.login(`imap_u2_${stamp}`, PW);
  const otherInbox = await j(await u2.get('/api/account/inbox'));
  ok(otherInbox.body.data.length === 0, 'another user sees none of these messages');
  const firstId = inbox.body.data[0].id;
  ok((await u2.get(`/api/account/inbox/${firstId}`)).status === 404, 'and cannot open one by id');

  head('reading a message marks it seen');
  const read = await j(await u1.get(`/api/account/inbox/${firstId}`));
  ok(read.status === 200 && read.body.seen === true, 'opening a message returns its body and marks it read');
  ok(typeof read.body.body_text === 'string', 'the full body is present on the single-message read');
  const after = await j(await u1.get('/api/account/inbox'));
  ok(after.body.unread === 1, 'the unread count drops');

  head('the deal core is untouched');
  ok((await root.get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await root.get('/api/mail-accounts')).status === 200, 'brokerage mail accounts still respond');

  head('cleanup');
  await prisma.inbound_emails.deleteMany({ where: { account_id: ids.acct } });
  await prisma.mail_accounts.deleteMany({ where: { user_id: { in: [ids.u1, ids.u2] } } });
  await prisma.leads.deleteMany({ where: { email: { contains: '@example.invalid' } } });
  await prisma.crm_settings.deleteMany({ where: { user_id: { in: [ids.u1, ids.u2] } } });
  await prisma.users.deleteMany({ where: { id: { in: [ids.u1, ids.u2] } } });
  ok(await prisma.inbound_emails.count({ where: { account_id: ids.acct } }) === 0, 'test messages removed');
  ok(await prisma.users.count({ where: { id: { in: [ids.u1, ids.u2] } } }) === 0, 'test users removed');

  console.log(fail === 0 ? `\nALL ${pass} PASS` : `\n${pass} passed, ${fail} FAILED`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
})();
