/**
 * Three changes to the Leads module and to what an agent may do.
 *
 *   1. A "Recent" tab beside the status tabs, counting leads that arrived in the last 30 days.
 *   2. Export made reachable without first ticking rows.
 *   3. Agents given edit on Lead and Calendar, so they can add events, tasks, notes and showings.
 *
 * The agent change is asserted against the permission catalogue the app itself serves, and
 * against the override table — a role default only takes effect where no per-user override pins
 * it to something else, so both have to be checked.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);
const readCli = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

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

  head('Recent: last 30 days');
  const opts = await (await get('/api/leads/options')).json();
  ok(opts.recent_days === 30, `the window is ${opts.recent_days} days, as asked`);

  const all = await (await get('/api/leads?page=1&limit=200')).json();
  ok(typeof all.stats.recent === 'number', `the counter is served with the list (${all.stats.recent})`);

  const cutoff = Date.now() - opts.recent_days * 24 * 60 * 60 * 1000;
  const expected = all.data.filter((l) => l.created_at && Date.parse(l.created_at) >= cutoff).length;
  ok(all.stats.recent === expected, `the count matches the rows themselves (${expected})`);

  const recent = await (await get('/api/leads?page=1&limit=200&recent=true')).json();
  ok(recent.meta.total === all.stats.recent, 'filtering by Recent returns exactly that many leads');
  ok(recent.data.every((l) => l.created_at && Date.parse(l.created_at) >= cutoff),
    'and every row really did arrive inside the window');
  ok(recent.data.length <= all.data.length, 'it narrows the list rather than widening it');

  // Recent is a different axis from status: both may be on at once.
  const recentHot = await (await get('/api/leads?recent=true&leadStatus=hot')).json();
  ok(recentHot.data.every((l) => l.lead_status === 'hot'), 'Recent combines with a status rather than replacing it');

  const page = readCli('desk/LeadsPage.tsx');
  ok(page.includes('lead-tab recent'), 'it is rendered as a tab beside the status tabs');
  ok(page.includes('{stats.recent}'), 'showing the count');
  ok((page.match(/🆕 Recent/g) || []).length === 1, 'and only once — the old duplicate counter chip is gone');

  head('Export is reachable without ticking a row');
  const exported = await (await send('POST', '/api/leads/export', { ids: [], filters: {} })).json();
  ok(Array.isArray(exported) || Array.isArray(exported.data), 'the export endpoint answers with no selection');
  const rows = Array.isArray(exported) ? exported : exported.data;
  ok(rows.length === all.meta.total, `it falls back to the whole filtered set (${rows.length} row(s))`);
  ok(/Export \{selected\.size \? `Selected/.test(page), 'the toolbar button says what it will export');
  ok(page.includes('onClick={doExport}'), 'and is wired to the same export the bulk bar uses');
  const toolbarIdx = page.indexOf('⬇ Export');
  ok(toolbarIdx > 0 && toolbarIdx < page.indexOf('lead-bulk'), 'the button sits in the toolbar, not only in the selection bar');

  head('agents can add events, tasks, notes and showings');
  const cat = await (await get('/api/users/catalog')).json();
  const agent = cat.role_defaults.agent;
  ok(agent.lead === 'edit', 'an agent has edit on Lead — notes, tasks and showings');
  ok(agent.calendar === 'edit', 'and edit on Calendar — they can book their own appointments');
  ok(agent.transactions === 'edit', 'transactions is unchanged');
  for (const s of ['invoice', 'audit', 'users', 'settings']) {
    ok(agent[s] === 'none', `${s} stays hidden from agents`);
  }
  ok(cat.role_defaults.admin.lead === 'edit' && cat.role_defaults.manager.calendar === 'edit',
    'admin and manager are unaffected');

  // A role default only applies where no per-user override pins it to something else.
  const overrides = await prisma.user_permissions.findMany({ where: { screen: { in: ['lead', 'calendar'] } } });
  const agents = await prisma.users.findMany({ where: { role: 'agent' }, select: { id: true, name: true } });
  const pinned = overrides.filter((o) => o.level !== 'edit' && agents.some((a) => a.id === o.user_id));
  ok(pinned.length === 0,
    `none of the ${agents.length} agent account(s) has an override pinning Lead or Calendar to view`);
  if (pinned.length) console.log('  NOTE  pinned:', JSON.stringify(pinned));

  // Owner scoping is what makes `edit` safe: an agent still only reaches their own records.
  const svc = fs.readFileSync(path.join(process.cwd(), 'src', 'calendar', 'calendar.service.ts'), 'utf8');
  ok(/update\([\s\S]{0,220}scopeWhere\(user\)/.test(svc), 'editing an event is still scoped to its owner');
  ok(/remove\([\s\S]{0,220}scopeWhere\(user\)/.test(svc), 'so is deleting one');
  const leadSvc = fs.readFileSync(path.join(process.cwd(), 'src', 'leads', 'leads.service.ts'), 'utf8');
  ok(leadSvc.includes('private scopeWhere'), 'and leads remain owner-scoped for agents');

  head('the deal core is untouched');
  ok((await get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await get('/api/invoices')).status === 200, 'invoices still respond');
  ok((await get('/api/dashboard/commissions')).status === 200, 'the dashboard still responds');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
})();
