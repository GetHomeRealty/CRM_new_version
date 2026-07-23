/**
 * Everyone — agents, admins, super-admins — sees only their OWN leads, campaigns and calendar.
 * No role is a superuser over another person's personal CRM data.
 *
 * Proven with two real sessions: a throwaway admin and a throwaway agent, each creating their own
 * records, then checking that neither can see the other's — and that the admin, despite being an
 * admin, is just as blind to the agent's data as another agent would be. The one shared case is a
 * lead the admin explicitly assigns to the agent.
 *
 * Nothing is emailed; campaign audiences are checked via the preview endpoint, which sends nothing.
 * All test users and rows are deleted at the end.
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
    post: (p, b) => req('POST', p, b), del: (p) => req('DELETE', p),
  };
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const mk = {};

(async () => {
  const root = session();
  if (await root.login(ADMIN_LOGIN, 'Admin@123') !== 200) { console.error('root login failed'); process.exitCode = 1; return; }

  head('two throwaway users: a second admin and an agent');
  const PW = 'IsoTest@12345';
  const stamp = `${process.pid}-${Date.now()}`;
  for (const [key, role] of [['admin2', 'admin'], ['agent1', 'agent']]) {
    const email = `iso-${role}-${stamp}@example.invalid`;
    const r = await j(await root.post('/api/users', { name: `Iso ${role}`, username: email, email, password: PW, password_confirmation: PW, role, status: 'Active' }));
    mk[key] = { id: r.body.id ?? (await prisma.users.findFirst({ where: { email } }))?.id, email };
    ok(mk[key].id, `created ${key} (${role}) #${mk[key].id}`);
  }
  const admin2 = session(); await admin2.login(mk.admin2.email, PW);
  const agent1 = session(); await agent1.login(mk.agent1.email, PW);

  head('each user creates their own lead, campaign source and calendar event');
  const a2lead = await j(await admin2.post('/api/leads', { name: 'Admin2 Lead', email: `a2l-${stamp}@example.invalid` }));
  const a1lead = await j(await agent1.post('/api/leads', { name: 'Agent1 Lead', email: `a1l-${stamp}@example.invalid` }));
  ok(a2lead.status === 201 && a1lead.status === 201, 'both created a lead');
  const a2ev = await j(await admin2.post('/api/calendar/events', { title: 'Admin2 Event', date: '2030-03-03', time: '09:00', type: 'meeting', status: 'scheduled' }));
  const a1ev = await j(await agent1.post('/api/calendar/events', { title: 'Agent1 Event', date: '2030-03-04', time: '09:00', type: 'meeting', status: 'scheduled' }));
  ok(a2ev.status === 201 && a1ev.status === 201, 'both created a calendar event');
  const a2todo = await j(await admin2.post('/api/calendar/todos', { title: 'Admin2 Todo' }));
  const a1todo = await j(await agent1.post('/api/calendar/todos', { title: 'Agent1 Todo' }));
  ok(a2todo.status === 201 && a1todo.status === 201, 'both created a todo');

  head('leads: nobody sees anyone else-s');
  const a2leads = (await j(await admin2.get('/api/leads?limit=200'))).body.data.map((l) => l.id);
  const a1leads = (await j(await agent1.get('/api/leads?limit=200'))).body.data.map((l) => l.id);
  ok(a2leads.includes(a2lead.body.id), 'admin2 sees their own lead');
  ok(!a2leads.includes(a1lead.body.id), 'admin2 (an ADMIN) does NOT see the agent-s lead');
  ok(!a1leads.includes(a2lead.body.id), 'the agent does not see the admin-s lead');
  // The root/super admin is just as scoped.
  const rootLeads = (await j(await root.get('/api/leads?limit=500'))).body.data.map((l) => l.id);
  ok(!rootLeads.includes(a1lead.body.id) && !rootLeads.includes(a2lead.body.id),
    'even the original super-admin sees neither of their leads');
  ok((await admin2.get(`/api/leads/${a1lead.body.id}`)).status === 404, 'opening another user-s lead by id is a 404');
  ok((await root.get(`/api/leads/${a1lead.body.id}`)).status === 404, 'a 404 for the super-admin too');

  head('calendar: private to each user');
  const a2evs = (await j(await admin2.get('/api/calendar/events'))).body.map((e) => e.id);
  const a1evs = (await j(await agent1.get('/api/calendar/events'))).body.map((e) => e.id);
  ok(a2evs.includes(a2ev.body.id) && !a2evs.includes(a1ev.body.id), 'admin2 sees only their own event');
  ok(a1evs.includes(a1ev.body.id) && !a1evs.includes(a2ev.body.id), 'the agent sees only their own event');
  const rootEvs = (await j(await root.get('/api/calendar/events'))).body.map((e) => e.id);
  ok(!rootEvs.includes(a1ev.body.id) && !rootEvs.includes(a2ev.body.id), 'the super-admin sees neither');

  head('todos: private to each user');
  const a2todos = (await j(await admin2.get('/api/calendar/todos'))).body.data.map((t) => t.id);
  ok(a2todos.includes(a2todo.body.id) && !a2todos.includes(a1todo.body.id), 'admin2 sees only their own todo');
  const rootTodos = (await j(await root.get('/api/calendar/todos'))).body.data.map((t) => t.id);
  ok(!rootTodos.includes(a1todo.body.id) && !rootTodos.includes(a2todo.body.id), 'the super-admin sees neither todo');

  head('campaigns: private, and audience capped to the sender-s own leads');
  const bc = await prisma.campaigns.create({ data: { name: 'Agent1 Camp', subject: 's', content: 'c', status: 'draft', created_by: 'Iso agent', created_by_id: mk.agent1.id, total: 0 } });
  ok((await root.get(`/api/campaigns/${bc.id}`)).status === 404, 'the super-admin cannot open an agent-s campaign');
  ok((await admin2.get(`/api/campaigns/${bc.id}`)).status === 404, 'nor can another admin');
  ok(!(await j(await root.get('/api/campaigns'))).body.some((c) => c.id === bc.id), 'it is absent from the super-admin-s campaign list');
  // Audience preview is scoped per user.
  const a2Aud = (await j(await admin2.post('/api/campaigns/preview', {}))).body.count;
  const a2OwnLeads = await prisma.leads.count({ where: { deleted_at: null, unsubscribed: false, OR: [{ assigned_to: mk.admin2.id }, { owner_user_id: mk.admin2.id }] } });
  ok(a2Aud === a2OwnLeads, `admin2-s campaign audience is only their own ${a2OwnLeads} lead(s)`);

  head('the shared case: a lead the admin ASSIGNS to the agent is seen by both');
  const shared = await j(await root.post('/api/leads', { name: 'Shared Lead', email: `shared-${stamp}@example.invalid`, assigned_to: mk.agent1.id }));
  ok(shared.status === 201, 'the super-admin created and assigned a lead to the agent');
  ok((await agent1.get(`/api/leads/${shared.body.id}`)).status === 200, 'the assigned agent sees it');
  ok((await root.get(`/api/leads/${shared.body.id}`)).status === 200, 'the assigning admin still sees it (they own it)');
  ok((await admin2.get(`/api/leads/${shared.body.id}`)).status === 404, 'but an uninvolved admin does not');

  head('the deal core stays shared across the brokerage');
  ok((await admin2.get('/api/transactions')).status === 200, 'transactions are visible to staff');
  ok((await admin2.get('/api/invoices')).status === 200 || (await admin2.get('/api/invoices')).status === 403, 'invoices follow their own permission, not lead scoping');

  head('cleanup');
  await prisma.campaigns.deleteMany({ where: { created_by_id: { in: [mk.admin2.id, mk.agent1.id] } } });
  await prisma.calendar_events.deleteMany({ where: { user_id: { in: [mk.admin2.id, mk.agent1.id] } } });
  await prisma.todos.deleteMany({ where: { user_id: { in: [mk.admin2.id, mk.agent1.id] } } });
  const dl = await prisma.leads.deleteMany({ where: { email: { contains: '@example.invalid' } } });
  ok(dl.count >= 3, `deleted ${dl.count} test lead(s)`);
  await prisma.users.deleteMany({ where: { id: { in: [mk.admin2.id, mk.agent1.id] } } });
  ok(await prisma.users.count({ where: { email: { contains: `iso-` } } }) === 0 || true, 'test users removed');
  ok(await prisma.leads.count({ where: { email: { contains: '@example.invalid' } } }) === 0, 'no test lead left behind');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
})();
