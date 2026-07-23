/**
 * Lead tasks on the Dashboard.
 *
 * The table is fed by GET /api/leads/tasks, which is scoped through the lead exactly like the
 * lead lists are. What matters: the route resolves (it is registered before `:id`), it returns
 * every column the table shows, it is ordered open-first-then-due, and the deal core is untouched.
 */
const fs = require('fs');
const path = require('path');

const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
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
  method: m,
  headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
  body: b === undefined ? undefined : JSON.stringify(b),
});

(async () => {
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await send('POST', '/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exitCode = 1; return; }

  head('the route resolves as a literal path, not as a lead id');
  const res = await get('/api/leads/tasks');
  ok(res.status === 200, `GET /api/leads/tasks responds 200 (not swallowed by /:id)`);
  const tasks = await res.json();
  ok(Array.isArray(tasks), `it returns an array — ${tasks.length} task(s) exist`);

  head('every column the Dashboard table shows is present');
  // Assert against a task this script creates, so the shape is checked even on an empty database.
  const leads = await (await get('/api/leads')).json();
  const lead = leads.data[0];
  if (!lead) { console.error('no leads to attach a task to'); process.exitCode = 1; return; }
  const made = await (await send('POST', `/api/leads/${lead.id}/tasks`, {
    title: 'Verification task — safe to delete', due_date: '2020-01-02',
    description: 'Created by verify-dashboard-lead-tasks.cjs', priority: 'high', status: 'pending',
  })).json();
  ok(made.id > 0, `a task was created on lead #${lead.id}`);

  const after = await (await get('/api/leads/tasks')).json();
  const row = after.find((t) => t.id === made.id);
  ok(!!row, 'the new task appears in the dashboard feed');
  for (const f of ['status', 'title', 'due_date', 'priority', 'description']) {
    ok(f in row, `the row carries ${f}`);
  }
  ok(row.lead_id === lead.id && row.lead_name === lead.name, 'and names the lead it belongs to, so the row can link to it');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(row.due_date), 'the due date is a plain calendar date');

  head('ordering: open tasks first, then by due date');
  const rank = (s) => (s === 'pending' ? 0 : s === 'cancelled' ? 2 : 1);
  ok(after.every((t, i) => i === 0 || rank(after[i - 1].status) <= rank(t.status)), 'open tasks come before finished ones');
  const pending = after.filter((t) => t.status === 'pending').map((t) => t.due_date);
  ok(pending.every((d, i) => i === 0 || pending[i - 1] <= d), 'within the open ones, the earliest due date is first');
  ok(after[0].id === made.id || after[0].due_date <= row.due_date, 'the overdue verification task sorts to the top');

  head('the deal core is untouched');
  ok((await get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await get('/api/invoices')).status === 200, 'invoices still respond');
  ok((await get('/api/dashboard/commissions')).status === 200, 'the commission aggregates still respond');
  ok((await get('/api/leads/deleted')).status === 200, 'the other literal lead routes still resolve');
  ok((await get(`/api/leads/${lead.id}`)).status === 200, 'and /api/leads/:id still resolves');

  head('frontend wiring');
  const dash = read('desk/DashboardPage.tsx');
  ok(dash.includes('function LeadTasksPanel'), 'the Dashboard renders a Lead Tasks panel');
  for (const c of ['<th>Status</th>', '<th>Title</th>', '<th>Due Date</th>', '<th>Priority</th>', '<th>Description</th>']) {
    ok(dash.includes(c), `the table has the ${c.replace(/<\/?th>/g, '')} column`);
  }
  ok(dash.includes('listAllLeadTasks'), 'it reads the real endpoint rather than deriving tasks locally');
  ok(dash.includes('.catch(() => setTasks([]))'), 'a user without the Leads screen still gets the rest of the dashboard');

  head('the summary cards at the top');
  // Plain apostrophe: this is a JSX attribute, not text content, so it needs no entity escape.
  for (const c of ['Total Tasks', 'Total Leads', "Today's Tasks", 'Todo List']) {
    ok(dash.includes(`label="${c}"`), `there is a "${c}" card`);
  }
  ok(dash.includes('function Breakdown'), 'the cards can show a status split under the number');
  ok(/Total Tasks[\s\S]{0,400}pending[\s\S]{0,120}completed[\s\S]{0,120}cancelled/.test(dash),
    'Total Tasks splits into pending / completed / cancelled');
  ok(/Todo List[\s\S]{0,300}todoCounts\.pending[\s\S]{0,160}todoCounts\.completed/.test(dash),
    'Todo List splits into pending / completed');
  ok(dash.includes('onCounts={takeTodoCounts}'), 'the Todo card reads the same numbers the list does, so they cannot drift');
  ok(dash.includes("can('lead', 'view')"), 'the lead cards are hidden from a user without the Leads screen');
  ok(dash.includes("can('calendar', 'view')"), 'and the todo card from a user without the Calendar screen');

  // The card counts are computed in the browser from the same feed the table renders, so the
  // arithmetic is checked here against the API rather than trusted.
  const todayIso = new Date().toISOString().slice(0, 10);
  const split = (s) => after.filter((t) => t.status === s).length;
  ok(split('pending') + split('completed') + split('cancelled') === after.length,
    `the three statuses account for all ${after.length} task(s) — no row falls outside the split`);
  console.log(`  NOTE  right now: ${after.length} total, ${split('pending')} pending, ${split('completed')} completed, ${split('cancelled')} cancelled,`
    + ` ${after.filter((t) => t.due_date === todayIso && t.status === 'pending').length} due today,`
    + ` ${after.filter((t) => t.due_date < todayIso && t.status === 'pending').length} overdue.`);

  const todos = await (await get('/api/calendar/todos')).json();
  ok(todos.counts && typeof todos.counts.pending === 'number' && typeof todos.counts.completed === 'number',
    'the todo endpoint supplies the pending/completed counts the card shows');
  ok(todos.counts.pending + todos.counts.completed + todos.counts.cancelled === todos.counts.total,
    'and those counts add up to its total');

  const leadPage = await (await get('/api/leads?page=1&limit=1')).json();
  ok(typeof leadPage.stats.total === 'number', `the Total Leads card has a real figure to show (${leadPage.stats.total})`);

  head('Total Leads breaks down by source');
  const src = leadPage.stats.bySource;
  ok(src && ['google', 'meta', 'website', 'referral', 'other'].every((k) => typeof src[k] === 'number'),
    'the stats carry a per-source count for each label on the card');
  ok(src.google + src.meta + src.website + src.referral + src.other === leadPage.stats.total,
    `the parts reconcile with the total (${src.google}+${src.meta}+${src.website}+${src.referral}+${src.other} = ${leadPage.stats.total})`);
  console.log(`  NOTE  google ${src.google}, meta ${src.meta}, website ${src.website}, referral ${src.referral}, other ${src.other}.`);

  // The counts are per stored `lead_source` value. 'refferal' is misspelt in the source system
  // and in existing rows, so the query must use that spelling while the card says "referral".
  const opts = await (await get('/api/leads/options')).json();
  ok(opts.lead_source.includes('website'), '"website" is a selectable lead source, so the count can be non-zero');
  ok(opts.lead_source.includes('refferal'), 'the stored referral spelling is unchanged, so existing rows still match');
  ok(opts.lead_source.includes('google ads') && opts.lead_source.includes('meta'), 'google and meta are unchanged');

  // Cross-check one bucket against a filtered query rather than trusting the aggregate.
  const metaOnly = await (await get('/api/leads?page=1&limit=1&lead_source=meta')).json();
  ok(metaOnly.meta.total === src.meta, `filtering by meta returns the same count the card shows (${src.meta})`);

  const dashSrc = dash;
  for (const s of ['google', 'meta', 'website', 'referral']) {
    ok(dashSrc.includes(`</strong> ${s}</span>`), `the card lists "${s}"`);
  }
  ok(dashSrc.includes('by.other > 0 &&'), 'and shows "other" only when something falls outside those four');

  head('cancelling a task');
  // Cancelled was always a valid status server-side; until now nothing in the UI could set it,
  // so the Dashboard's "cancelled" count could never be anything but zero.
  const cancelled = await send('PUT', `/api/leads/${lead.id}/tasks/${made.id}`, { status: 'cancelled' });
  ok(cancelled.status === 200, 'a task can be cancelled');
  ok((await cancelled.json()).status === 'cancelled', 'and comes back cancelled');
  const withCancelled = await (await get('/api/leads/tasks')).json();
  ok(withCancelled.find((t) => t.id === made.id).status === 'cancelled', 'the dashboard feed reflects it');
  ok(withCancelled.filter((t) => t.status === 'cancelled').length >= 1, 'so the Total Tasks card has a non-zero cancelled figure to show');
  ok(withCancelled[withCancelled.length - 1].status !== 'pending', 'cancelled tasks sort below the open ones');
  ok((await send('PUT', `/api/leads/${lead.id}/tasks/${made.id}`, { status: 'reopened' })).status === 400,
    'an invented status is still rejected');
  ok((await send('PUT', `/api/leads/${lead.id}/tasks/${made.id}`, { status: 'pending' })).status === 200,
    'and a cancelled task can be reopened');

  const detail = read('desk/LeadDetailPage.tsx');
  ok(detail.includes("{ status: 'cancelled' }"), 'the lead Tasks panel can set the cancelled status');
  ok(detail.includes('>\n                          Cancel\n                        </button>') || /Cancel\s*<\/button>/.test(detail),
    'it renders a Cancel button');
  ok(/status === 'pending' \? \(/.test(detail), 'the buttons offered depend on the task state');
  ok(detail.includes("t.status === 'pending' ? '' : 'done'"), 'a cancelled task reads as struck through, like a completed one');

  head('cleaning up the verification row');
  ok((await send('DELETE', `/api/leads/${lead.id}/tasks/${made.id}`)).status === 200, 'the verification task is deleted');
  const end = await (await get('/api/leads/tasks')).json();
  ok(!end.some((t) => t.id === made.id), 'and is gone from the dashboard feed');
  ok(end.length === tasks.length, `the task list is back to its original ${tasks.length} row(s)`);

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
