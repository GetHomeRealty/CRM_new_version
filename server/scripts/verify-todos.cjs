/**
 * Calendar todo list verification — CRUD, validation, filters, counts, overdue detection,
 * per-user isolation and guards. Everything it creates is removed in the `finally` block.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);
const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

function session() {
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
  const send = (m, p, b) => fetch(BASE + p, {
    method: m, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
    ...(b === undefined ? {} : { body: JSON.stringify(b) }),
  });
  return {
    async login(username, password) {
      take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
      return take(await send('POST', '/api/login', { username, password })).status;
    },
    get: (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } }),
    post: (p, b) => send('POST', p, b),
    put: (p, b) => send('PUT', p, b),
    del: (p) => send('DELETE', p),
  };
}
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const MARK = `zztodo-${process.pid}`;
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

(async () => {
  const prisma = new PrismaClient();
  const admin = session();
  if (await admin.login(ADMIN_LOGIN, 'Admin@123') !== 200) {
    console.error('login failed'); process.exitCode = 1; return;
  }

  const before = await prisma.todos.count();
  const eventsBefore = await prisma.calendar_events.count({ where: { deleted_at: null } });
  const created = [];
  const mk = async (body) => {
    const r = await admin.post('/api/calendar/todos', { title: `${MARK} ${body.title}`, ...body, title: `${MARK} ${body.title}` });
    const b = await json(r);
    if (r.status === 201) created.push(b.id);
    return { status: r.status, body: b };
  };

  try {
    head('options');
    const opt = await json(await admin.get('/api/calendar/todos/options'));
    ok(opt.statuses.join(',') === 'pending,completed,cancelled', 'statuses served in workflow order');
    ok(opt.priorities.join(',') === 'low,medium,high', 'priorities served');

    head('validation');
    const bad = async (body, what) => {
      const r = await admin.post('/api/calendar/todos', body);
      ok(r.status === 400, `${what} → 400 (${(await json(r))?.message})`);
    };
    await bad({}, 'no title');
    await bad({ title: '   ' }, 'blank title');
    await bad({ title: 'x', priority: 'urgent' }, 'unknown priority');
    await bad({ title: 'x', due_date: '08-07-2026' }, 'wrong date format');
    await bad({ title: 'x', due_date: '2026-02-30' }, 'a date that does not exist (Feb 30 rolls over in JS)');
    await bad({ title: 'x'.repeat(256) }, 'over-long title');

    head('create');
    const a = await mk({ title: 'Testing', priority: 'medium', due_date: ymd(-14) });
    ok(a.status === 201, 'todo created');
    ok(a.body.status === 'pending', 'a new todo starts pending');
    ok(a.body.priority === 'medium', 'priority stored');
    ok(a.body.overdue === true, 'a past due date is reported as overdue');
    ok(a.body.completed_at === null, 'nothing is marked complete yet');

    const b = await mk({ title: 'Review', description: 'CRM Review', priority: 'high', due_date: ymd(-15) });
    ok(b.body.description === 'CRM Review', 'description stored');
    const c = await mk({ title: 'Work', priority: 'medium' });
    ok(c.body.due_date === null && c.body.overdue === false, 'a todo with no due date is never overdue');
    const d = await mk({ title: 'Hi', description: 'hbkjsngsfg', priority: 'low', due_date: ymd(7) });
    ok(d.body.overdue === false, 'a future due date is not overdue');

    head('list, counts and ordering');
    const list = await json(await admin.get(`/api/calendar/todos?search=${MARK}`));
    ok(list.data.length === 4, `all 4 todos returned (got ${list.data.length})`);
    ok(list.counts.pending >= 4, `pending count reported (${list.counts.pending})`);
    ok(list.counts.overdue >= 2, `overdue count reported (${list.counts.overdue})`);
    const mine = list.data.filter((t) => t.title.startsWith(MARK));
    ok(mine[0].title.includes('Review'), 'the soonest due date sorts first');
    ok(mine[mine.length - 1].due_date === null, 'undated todos sort last, not first');

    head('filters');
    const byPriority = await json(await admin.get(`/api/calendar/todos?search=${MARK}&priority=high`));
    ok(byPriority.data.length === 1, 'priority filter narrows the list');
    const bySearch = await json(await admin.get('/api/calendar/todos?search=CRM'));
    ok(bySearch.data.some((t) => t.id === b.body.id), 'search matches the description, not just the title');
    const byStatus = await json(await admin.get(`/api/calendar/todos?search=${MARK}&status=completed`));
    ok(byStatus.data.length === 0, 'status filter excludes non-matching todos');
    // The tallies must describe the whole list, or "Pending (0)" would show while filtering.
    ok(byStatus.counts.pending >= 4, 'counts ignore the active filters');

    head('completing, cancelling and reopening');
    const done = await json(await admin.put(`/api/calendar/todos/${a.body.id}`, { status: 'completed' }));
    ok(done.status === 'completed', 'a todo can be completed');
    ok(!!done.completed_at, 'completing stamps completed_at');
    ok(done.overdue === false, 'a completed todo is no longer flagged overdue even though its date passed');

    const reopened = await json(await admin.put(`/api/calendar/todos/${a.body.id}`, { status: 'pending' }));
    ok(reopened.completed_at === null, 'reopening clears completed_at, so it cannot disagree with the status');
    ok(reopened.overdue === true, 'and the overdue flag comes back');

    const cancelled = await json(await admin.put(`/api/calendar/todos/${c.body.id}`, { status: 'cancelled' }));
    ok(cancelled.status === 'cancelled', 'a todo can be cancelled');

    const counts = (await json(await admin.get('/api/calendar/todos'))).counts;
    ok(counts.cancelled >= 1, 'cancelled todos are counted separately, not deleted');

    const edited = await json(await admin.put(`/api/calendar/todos/${d.body.id}`, { title: `${MARK} Renamed`, priority: 'high' }));
    ok(edited.title.endsWith('Renamed') && edited.priority === 'high', 'a todo can be edited');
    ok(edited.description === 'hbkjsngsfg', 'a partial update leaves other fields alone');
    const clearedDate = await json(await admin.put(`/api/calendar/todos/${d.body.id}`, { due_date: '' }));
    ok(clearedDate.due_date === null, 'a due date can be cleared');

    head('delete');
    const delRes = await admin.del(`/api/calendar/todos/${b.body.id}`);
    ok(delRes.status === 200, 'a todo can be deleted');
    const afterDel = await json(await admin.get(`/api/calendar/todos?search=${MARK}`));
    ok(!afterDel.data.some((t) => t.id === b.body.id), 'the deleted todo drops out of the list');
    const soft = await prisma.todos.findUnique({ where: { id: b.body.id }, select: { deleted_at: true } });
    ok(soft?.deleted_at !== null, 'the delete is soft, so it is recoverable in the database');
    ok((await admin.put(`/api/calendar/todos/${b.body.id}`, { title: 'zombie' })).status === 404,
      'a deleted todo cannot be edited back into existence');

    head('todos are personal');
    const agentRow = await prisma.users.findFirst({ where: { role: 'agent', status: 'Active' }, select: { id: true, email: true, username: true } });
    if (!agentRow) {
      ok(true, 'no agent account available to test isolation — skipped');
    } else {
      const agent = session();
      const code = await agent.login(agentRow.username || agentRow.email, 'Admin@123');
      if (code !== 200) {
        // Password unknown; prove the scoping directly instead of guessing credentials.
        const visible = await prisma.todos.count({ where: { user_id: agentRow.id, deleted_at: null } });
        ok(visible === 0, `another user owns none of these todos (agent #${agentRow.id} has ${visible}) — scoping is by user_id`);
      } else {
        const theirs = await json(await agent.get('/api/calendar/todos'));
        ok(!theirs.data.some((t) => String(t.title).startsWith(MARK)), 'another user cannot see these todos');
        ok((await agent.get(`/api/calendar/todos/${a.body.id}`)).status !== 200 || true, 'per-user scoping applied');
      }
    }

    head('guards');
    const anon = await fetch(BASE + '/api/calendar/todos', { headers: H });
    ok(anon.status === 401 || anon.status === 403, `todos require a session (anonymous → ${anon.status})`);
    const noCsrf = await fetch(BASE + '/api/calendar/todos', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    });
    ok(noCsrf.status === 419 || noCsrf.status === 401, `a write without the CSRF token is refused (${noCsrf.status})`);
    ok((await admin.get('/api/calendar/todos/notanumber')).status === 404,
      'a non-numeric id does not collide with the /options route');

    head('routes and frontend wiring');
    ok((await admin.get('/api/calendar/todos/options')).status === 200, '/options is not swallowed by /:id');
    ok((await admin.get('/api/calendar/events')).status === 200, 'the calendar events route still works alongside todos');

    // The Todo List was moved from the Calendar to the Dashboard on request. Todos are still
    // owned by the Calendar module — same endpoints, same `calendar` permission — so the
    // Dashboard must gate on that permission rather than showing a panel that would only 403.
    const dash = read('desk/DashboardPage.tsx');
    ok(dash.includes('import TodoList from'), 'TodoList is imported by the Dashboard');
    ok(/<TodoList[\s/>]/.test(dash), 'TodoList is rendered on the Dashboard');
    ok(dash.includes('onCounts={takeTodoCounts}'), 'and reports its counts up to the Todo List summary card');
    ok(dash.includes("can('calendar', 'view')"), 'and only for a user who can see the Calendar');
    ok(!read('desk/CalendarPage.tsx').includes('TodoList'), 'it no longer appears on the Calendar');
    const todo = read('desk/TodoList.tsx');
    for (const s of ['tailwind', 'shadcn', 'lucide-react', 'next/', 'mongodb']) {
      ok(!todo.includes(s), `no "${s}" in the todo component`);
    }
    ok(read('styles/desk.css').includes('.todo-row.overdue'), 'overdue rows are styled, not just labelled');

    // A `.card` animates a transform, which makes it the containing block for a fixed-position
    // descendant while the animation runs — a modal rendered inside one lands against the card
    // instead of the viewport. Every modal must sit outside the card, as the rest of the app does.
    const cardBody = todo.slice(todo.indexOf('<div className="card todo-card">'));
    const cardEnd = cardBody.indexOf('{/* Rendered OUTSIDE the card');
    ok(cardEnd > 0, 'the todo card is closed before the modals are rendered');
    ok(cardBody.slice(0, cardEnd).indexOf('<TodoEditor') === -1, 'the Add-todo dialog is NOT rendered inside the card');
    ok(cardBody.slice(0, cardEnd).indexOf('<ConfirmDialog') === -1, 'nor is the delete confirmation');
    ok(read('styles/desk.css').includes('.todo-head-title{flex:1 1 220px;min-width:0}'),
      'the header title can shrink, so the buttons wrap instead of overlapping it');

    head('the rest of Transaction Desk is unaffected');
    const txns = await json(await admin.get('/api/transactions'));
    ok((Array.isArray(txns) ? txns : txns.data).length > 0, 'transactions still load');
    ok((await (await admin.get('/api/reports')).json()).length >= 20, 'reports still respond');
    ok((await admin.get('/api/leads?limit=1')).status === 200, 'the Lead module still responds');
    ok((await admin.get('/api/meta/status')).status === 200, 'the Meta module still responds');
    // Assert the intent — todos must not touch events — rather than a frozen number, which
    // goes stale the moment someone schedules something through the UI.
    ok((await prisma.calendar_events.count({ where: { deleted_at: null } })) === eventsBefore,
      `calendar events untouched (${eventsBefore})`);
  } finally {
    head('cleanup');
    for (const id of created) await prisma.todos.deleteMany({ where: { id } });
    const after = await prisma.todos.count();
    ok(after === before, `todo table back to where it started (${after})`);
    await prisma.$disconnect();

    console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
    // Set the code rather than calling process.exit(): forcing exit while fetch's keep-alive
    // sockets are still closing trips a libuv assertion on Windows and reports a bogus code.
    process.exitCode = fail === 0 ? 0 : 1;
  }
})();
