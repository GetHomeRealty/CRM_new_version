/**
 * Per-user Settings: profile, personal mail accounts, email preferences, integrations.
 *
 * Real sessions for two throwaway users (an admin and an agent) prove each manages their OWN
 * settings and that neither sees or touches the other's mail account. Nothing is emailed: the
 * account points at an unroutable host and is never sent through — only the metadata round-trip
 * and the ownership scoping are checked. All test users and rows are removed at the end.
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
    post: (p, b) => req('POST', p, b), put: (p, b) => req('PUT', p, b), del: (p) => req('DELETE', p),
  };
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const ids = { admin2: null, agent1: null };

(async () => {
  const root = session();
  if (await root.login(ADMIN_LOGIN, 'Admin@123') !== 200) { console.error('root login failed'); process.exitCode = 1; return; }

  const PW = 'AcctTest@12345';
  const stamp = `${process.pid}-${Date.now()}`;
  for (const [key, role] of [['admin2', 'admin'], ['agent1', 'agent']]) {
    const email = `acct-${role}-${stamp}@example.invalid`;
    const r = await j(await root.post('/api/users', { name: `Acct ${role}`, username: `acct_${role}_${stamp}`, email, password: PW, password_confirmation: PW, role, status: 'Active' }));
    ids[key] = r.body.id ?? (await prisma.users.findFirst({ where: { email } }))?.id;
    ok(ids[key], `created ${key} (${role}) #${ids[key]}`);
  }
  const admin2 = session(); await admin2.login(`acct_admin_${stamp}`, PW);
  const agent1 = session(); await agent1.login(`acct_agent_${stamp}`, PW);

  head('an agent can reach Settings without the admin settings screen');
  ok((await agent1.get('/api/account/profile')).status === 200, 'the agent can read their own profile');
  ok((await agent1.get('/api/crm-settings')).status === 403, 'but the admin CRM Settings screen is still forbidden to them');

  head('Personal Information');
  const saved = await j(await agent1.put('/api/account/profile', { name: 'Akhil Renamed', username: `akhil_${stamp}`, phone: '416-555-0100' }));
  ok(saved.status === 200 && saved.body.name === 'Akhil Renamed', 'the agent saved their name');
  ok(saved.body.phone === '416-555-0100', 'and their phone');
  ok((await j(await agent1.put('/api/account/profile', { name: '', username: 'x' }))).status === 400, 'an empty name is rejected');
  await agent1.put('/api/account/profile', { name: 'Akhil Renamed', username: `akhil_${stamp}`, phone: '1', role: 'admin' });
  ok((await prisma.users.findUnique({ where: { id: ids.agent1 }, select: { role: true } })).role === 'agent', 'role cannot be escalated through the profile form');

  head('Email Preferences (signature, reply template, auto sync)');
  const pr = await j(await agent1.put('/api/account/settings', { emailSettings: { signature: 'Akhil GHR', replyTemplate: 'Hi there,', autoSync: true } }));
  ok(pr.status === 200, 'preferences save');
  const rd = await j(await agent1.get('/api/account/settings'));
  ok(rd.body.emailSettings.signature === 'Akhil GHR', 'the signature round-trips');
  ok(rd.body.emailSettings.autoSync === true, 'auto sync round-trips');
  ok(rd.body.integrations && typeof rd.body.integrations.meta === 'object', 'integration status is included');

  head('personal mail accounts are private to each user');
  const add = await j(await agent1.post('/api/account/mail-accounts', {
    name: 'Agent Gmail', from_email: `agent-${stamp}@example.invalid`, host: 'smtp.example.invalid', port: 587, encryption: 'tls', username: 'agent', password: 'app-password',
  }));
  ok(add.status === 201, 'the agent connected a mail account');
  const acctId = add.body.id;
  ok(add.body.is_default === true, 'their first account becomes their default automatically');
  ok(add.body.has_password === true && !('password' in add.body), 'the password is stored, never returned');

  const agentList = (await j(await agent1.get('/api/account/mail-accounts'))).body;
  ok(agentList.some((a) => a.id === acctId), 'the agent sees their own account');
  const admin2List = (await j(await admin2.get('/api/account/mail-accounts'))).body;
  ok(!admin2List.some((a) => a.id === acctId), 'another user does NOT see it');
  ok((await admin2.put(`/api/account/mail-accounts/${acctId}`, { name: 'hijack' })).status === 404, 'nor can they edit it');
  ok((await admin2.del(`/api/account/mail-accounts/${acctId}`)).status === 404, 'nor delete it');
  ok((await admin2.post(`/api/account/mail-accounts/${acctId}/default`, {})).status === 404, 'nor make it their default');

  head('a personal account never appears in admin Email Settings (brokerage accounts only)');
  const brokerage = (await j(await root.get('/api/mail-accounts'))).body;
  const brokerageRows = Array.isArray(brokerage) ? brokerage : brokerage.data;
  ok(!brokerageRows.some((a) => a.id === acctId), 'the agent personal account is not in the brokerage list');

  head('the deal core and existing email sending are unaffected');
  ok((await root.get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await root.get('/api/mail-accounts')).status === 200, 'brokerage mail accounts still respond');

  head('cleanup');
  await prisma.mail_accounts.deleteMany({ where: { user_id: { in: [ids.admin2, ids.agent1] } } });
  await prisma.crm_settings.deleteMany({ where: { user_id: { in: [ids.admin2, ids.agent1] } } });
  await prisma.users.deleteMany({ where: { id: { in: [ids.admin2, ids.agent1] } } });
  ok(await prisma.mail_accounts.count({ where: { user_id: { in: [ids.admin2, ids.agent1] } } }) === 0, 'test mail accounts removed');
  ok(await prisma.users.count({ where: { id: { in: [ids.admin2, ids.agent1] } } }) === 0, 'test users removed');

  console.log(fail === 0 ? `\nALL ${pass} PASS` : `\n${pass} passed, ${fail} FAILED`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
})();
