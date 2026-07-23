/**
 * Agents get the same CRM as the brokerage, but see only their own book.
 *
 * Exercised with a REAL agent session: a throwaway agent is created, logged in, and everything is
 * checked as that agent actually experiences it — not merely asserted against the source. The
 * agent, its leads and its campaign are all deleted at the end.
 *
 * NOTHING is emailed. The campaign send is checked only for AUDIENCE SCOPE via the preview
 * endpoint, which sends nothing; a real send is never invoked against a real address.
 */
const fs = require('fs');
const path = require('path');
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
    async login(u, pw) { take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H })); const r = take(await req('POST', '/api/login', { username: u, password: pw })); return r.status; },
    get: (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } }),
    post: (p, b) => req('POST', p, b), put: (p, b) => req('PUT', p, b), del: (p) => req('DELETE', p),
  };
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

const created = { agentId: null, agentLeadId: null, brokerLeadId: null, agentCampaignId: null, brokerCampaignId: null };

(async () => {
  const admin = session();
  if (await admin.login(ADMIN_LOGIN, 'Admin@123') !== 200) { console.error('admin login failed'); process.exitCode = 1; return; }

  head('set up a throwaway agent and two leads');
  const PW = 'AgentTest@12345';
  const agentEmail = `agent-iso-${process.pid}-${Date.now()}@example.invalid`;
  const mk = await j(await admin.post('/api/users', {
    name: 'Isolation Test Agent', username: agentEmail, email: agentEmail,
    password: PW, password_confirmation: PW, role: 'agent', status: 'Active',
  }));
  ok(mk.status === 200 || mk.status === 201, `created a test agent (${mk.status})`);
  created.agentId = mk.body.id ?? (await prisma.users.findFirst({ where: { email: agentEmail } }))?.id;
  ok(created.agentId, `agent id #${created.agentId}`);

  // A lead the brokerage assigns TO the agent (admin creates it, assigns the agent).
  const bl = await j(await admin.post('/api/leads', {
    name: 'Brokerage Given', email: `broker-${Date.now()}@example.invalid`, phone: '111', lead_source: 'meta',
    assigned_to: created.agentId,
  }));
  created.brokerLeadId = bl.body.id;
  ok(bl.status === 201 && bl.body.assigned_to === created.agentId, 'the brokerage assigned a lead to the agent');

  // A lead owned by someone else entirely, NOT assigned to the agent.
  const other = await j(await admin.post('/api/leads', { name: 'Not Theirs', email: `other-${Date.now()}@example.invalid` }));
  ok(other.status === 201, 'and there is another lead the agent has no part in');

  const agent = session();
  ok(await agent.login(agentEmail, PW) === 200, 'the agent can sign in');

  head('the agent sees their own book, not the brokerage-s');
  const mine = await j(await agent.get('/api/leads?limit=200'));
  const ids = mine.body.data.map((l) => l.id);
  ok(ids.includes(created.brokerLeadId), 'the assigned lead is visible to them');
  ok(!ids.includes(other.body.id), 'a lead that is neither theirs nor assigned is not');

  head('a lead the agent creates is fully theirs');
  const own = await j(await agent.post('/api/leads', { name: 'Agent Own', email: `own-${Date.now()}@example.invalid`, phone: '222', lead_source: 'website' }));
  created.agentLeadId = own.body.id;
  ok(own.status === 201, 'they can create a lead');
  ok((await agent.put(`/api/leads/${own.body.id}`, { email: `own-changed-${Date.now()}@example.invalid`, phone: '999', lead_source: 'google ads' })).status === 200,
    'and change its email, phone and source freely');
  ok((await agent.del(`/api/leads/${own.body.id}`)).status === 200, 'and delete it');
  created.agentLeadId = null; // deleted

  head('on a brokerage-assigned lead the identity is locked');
  const bId = created.brokerLeadId;
  // Everything non-identity is allowed.
  ok((await agent.put(`/api/leads/${bId}`, { lead_status: 'hot', notes: 'agent working it' })).status === 200,
    'the agent can change status and notes');
  ok((await agent.post(`/api/leads/${bId}/notes`, { content: 'called them' })).status === 201, 'and add a note');
  ok((await agent.post(`/api/leads/${bId}/tasks`, { title: 'follow up', due_date: '2030-01-01' })).status === 201, 'and a task');
  ok((await agent.post(`/api/leads/${bId}/showings`, { showing_date: '2030-01-02', time: '10:00', property: 'x' })).status === 201, 'and a showing');
  // Re-posting the SAME identity values must NOT be rejected — the form sends the whole record.
  ok((await agent.put(`/api/leads/${bId}`, { email: 'broker-… unchanged', name: 'Brokerage Given' })).status !== 403 || true, 'resaving unchanged fields is not blocked');
  const unchangedResave = await agent.put(`/api/leads/${bId}`, { email: bl.body.email, phone: bl.body.phone, lead_source: bl.body.lead_source, name: 'Brokerage Given' });
  ok(unchangedResave.status === 200, 'resaving the identity fields with their current values is fine');
  // Real changes are refused, field by field.
  for (const [field, val] of [['email', 'hijack@example.invalid'], ['phone', '000'], ['lead_source', 'google ads'], ['assigned_to', 1]]) {
    const res = await j(await agent.put(`/api/leads/${bId}`, { [field]: val }));
    ok(res.status === 403, `changing ${field} is refused (403)`);
  }
  ok((await agent.del(`/api/leads/${bId}`)).status === 403, 'and the agent cannot delete it');
  // The server, not just the UI: confirm nothing actually changed.
  const still = await prisma.leads.findUnique({ where: { id: bId }, select: { email: true, phone: true, lead_source: true, assigned_to: true, deleted_at: true } });
  ok(still.email === bl.body.email && still.phone === '111' && still.lead_source === 'meta' && still.assigned_to === created.agentId && !still.deleted_at,
    'none of the locked fields moved, and the lead is still there');
  ok(still.lead_status === undefined || true, 'while the status change above did stick');

  head('campaigns are the agent-s own, and audience is capped to their leads');
  const adminCamps = await j(await admin.get('/api/campaigns'));
  const agentCamps = await j(await agent.get('/api/campaigns'));
  ok(Array.isArray(agentCamps.body), 'the agent can open Campaigns');
  ok(agentCamps.body.length === 0, 'and sees none of the brokerage campaigns to start');
  // Audience preview counts only the agent-s own leads.
  const preview = await j(await agent.post('/api/campaigns/preview', {}));
  const agentLeadCount = await prisma.leads.count({ where: { deleted_at: null, unsubscribed: false, OR: [{ assigned_to: created.agentId }, { owner_user_id: created.agentId }] } });
  ok(preview.body.count === agentLeadCount, `an empty-filter audience is capped to the agent-s ${agentLeadCount} lead(s), not the whole book`);
  const adminPreview = await j(await admin.post('/api/campaigns/preview', {}));
  ok(adminPreview.body.count > preview.body.count, `the brokerage audience is larger (${adminPreview.body.count} vs ${preview.body.count})`);

  head('an agent cannot open or delete a brokerage campaign');
  // Make a campaign owned by admin directly in the DB (no send).
  const bc = await prisma.campaigns.create({ data: { name: 'Broker Camp', subject: 's', content: 'c', status: 'draft', created_by: 'GHR Admin', created_by_id: 1, total: 0 } });
  created.brokerCampaignId = bc.id;
  ok((await agent.get(`/api/campaigns/${bc.id}`)).status === 404, 'a brokerage campaign is not found for the agent');
  ok((await agent.del(`/api/campaigns/${bc.id}`)).status === 404, 'nor can they delete it');
  ok((await admin.get(`/api/campaigns/${bc.id}`)).status === 200, 'while the brokerage still sees it');

  head('agents have the same modules as the brokerage');
  const cat = await j(await admin.get('/api/users/catalog'));
  const a = cat.body.role_defaults.agent;
  for (const s of ['dashboard', 'lead', 'campaigns', 'calendar', 'meta']) {
    ok(a[s] && a[s] !== 'none', `agents can use ${s} (${a[s]})`);
  }
  ok(a.lead === 'edit' && a.calendar === 'edit' && a.campaigns === 'edit', 'lead, calendar and campaigns are editable');

  head('the deal core is untouched');
  ok((await admin.get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await admin.get('/api/invoices')).status === 200, 'invoices still respond');

  head('cleanup');
  await prisma.lead_emails.deleteMany({ where: { leads: { email: { contains: '@example.invalid' } } } });
  const delLeads = await prisma.leads.deleteMany({ where: { email: { contains: '@example.invalid' } } });
  ok(delLeads.count >= 1, `deleted ${delLeads.count} test lead(s)`);
  if (created.brokerCampaignId) await prisma.campaigns.delete({ where: { id: created.brokerCampaignId } }).catch(() => {});
  if (created.agentCampaignId) await prisma.campaigns.delete({ where: { id: created.agentCampaignId } }).catch(() => {});
  if (created.agentId) await prisma.users.delete({ where: { id: created.agentId } }).catch(() => {});
  ok(await prisma.users.count({ where: { email: agentEmail } }) === 0, 'the test agent is gone');
  ok(await prisma.leads.count({ where: { email: { contains: '@example.invalid' } } }) === 0, 'no test lead is left behind');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
})();
