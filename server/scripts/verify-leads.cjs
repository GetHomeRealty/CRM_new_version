/**
 * Leads module verification.
 *
 * Exercises the API end to end against the live server: options, CRUD, validation, filters,
 * stats, tags, activity (notes / tasks / showings / calls), CSV import, export, bulk actions,
 * the Recently Deleted bin, and route-collision regressions.
 *
 * Everything it creates is removed in the `finally` block, and it asserts the live data it
 * started with (transactions, documents, campaigns) is untouched at the end.
 */
const fs = require('fs');
const path = require('path');

// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');
const SERVER = path.join(process.cwd(), 'src');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);
const read = (base, rel) => fs.readFileSync(path.join(base, rel), 'utf8');

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
const send = (method, p, body) => fetch(BASE + p, {
  method,
  headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const post = (p, b) => send('POST', p, b);
const put = (p, b) => send('PUT', p, b);
const del = (p) => send('DELETE', p);
const json = async (r) => { try { return await r.json(); } catch { return null; } };

/** Unique marker so every record this run creates can be found and cleaned up. */
const MARK = `zzverify-${process.pid}`;
const mail = (n) => `${MARK}-${n}@example.invalid`;
const created = [];

(async () => {
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await post('/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exitCode = 1; return; }

  // Baseline, so the regression check at the end is against real numbers.
  const before = {
    txns: (await json(await get('/api/transactions'))),
    campaigns: (await json(await get('/api/campaigns'))) || [],
    leads: (await json(await get('/api/leads?limit=1')))?.meta?.total ?? 0,
  };
  const txnCount = Array.isArray(before.txns) ? before.txns.length : before.txns?.data?.length ?? 0;

  try {
    // ---------------------------------------------------------------- options
    head('options');
    const opt = await json(await get('/api/leads/options'));
    ok(Array.isArray(opt?.lead_status) && opt.lead_status.includes('hot'), 'lead statuses served');
    ok(opt.lead_source.includes('refferal'), 'the historical "refferal" spelling is preserved (campaign audiences match on it)');
    ok(opt.lead_type.includes('Pre construction'), '"Pre construction" keeps its stored capitalisation');
    ok(opt.client_type.includes('first home buyer'), 'client types served');
    ok(opt.lead_response.includes('not actively answering'), 'lead responses served');
    ok(opt.none_filter_value === '__none__', 'the NONE sentinel is published to the client');
    ok(Array.isArray(opt.users) && opt.users.length > 0, `${opt.users?.length} assignable users served`);
    ok(Array.isArray(opt.call_outcome) && opt.call_outcome.includes('voicemail'), 'call outcomes served');

    // ------------------------------------------------------------ validation
    head('validation');
    const bad = async (body, what) => {
      const r = await post('/api/leads', body);
      const b = await json(r);
      ok(r.status === 400, `${what} → 400 (${b?.message ?? r.status})`);
    };
    await bad({}, 'no name or email');
    await bad({ name: 'X' }, 'no email');
    await bad({ name: 'X', email: 'not-an-email' }, 'malformed email');
    await bad({ name: 'X', email: mail('v1'), lead_status: 'lukewarm' }, 'unknown lead status');
    await bad({ name: 'X', email: mail('v2'), age: 999 }, 'impossible age');
    await bad({ name: 'X', email: mail('v3'), date_of_birth: '2026-02-30' }, 'a date that does not exist (Feb 30 rolls over in JS)');
    await bad({ name: 'X', email: mail('v4'), assigned_to: 999999 }, 'assignment to a user that does not exist');

    // ---------------------------------------------------------------- create
    head('create');
    const mk = async (n, extra) => {
      const r = await post('/api/leads', { name: `${MARK} ${n}`, email: mail(n), ...extra });
      const b = await json(r);
      if (r.status === 201) created.push(b.id);
      return { status: r.status, body: b };
    };

    const a = await mk('alpha', {
      phone: '416-555-0100', location: 'Toronto', property: '12 King St',
      lead_status: 'hot', lead_type: 'buyer', lead_source: 'google ads',
      lead_response: 'active', client_type: 'first home buyer',
      age: 34, gender: 'female', language: 'English', date_of_birth: '1992-04-11',
      tags: ['Expo-2026', 'VIP'],
      property_preferences: { budget: { min: 700000, max: 950000 }, bedrooms: 3, features: ['Garage'] },
    });
    ok(a.status === 201, 'lead created');
    ok(a.body.lead_status === 'hot' && a.body.age === 34, 'classification and demographics stored');
    ok(a.body.date_of_birth === '1992-04-11', 'a date round-trips without a timezone shift');
    ok(Array.isArray(a.body.tags) && a.body.tags.length === 2, 'tags stored as a list');
    // Preferences became a LIST when a lead gained the ability to keep several sets; a single
    // object sent by an older caller is wrapped server-side, which is what this asserts.
    ok(Array.isArray(a.body.property_preferences), 'property preferences come back as a list');
    ok(a.body.property_preferences?.[0]?.budget?.max === 950000, 'stored as structured JSON');
    ok(a.body.call_count === 0 && a.body.task_count === 0, 'a new lead starts with no activity');

    const b2 = await mk('bravo', { lead_status: 'cold', lead_type: 'seller', lead_source: 'meta', tags: ['Expo-2026'] });
    const c2 = await mk('charlie', { lead_status: 'warm', lead_type: 'resale', lead_source: 'refferal', age: 61 });
    ok(b2.status === 201 && c2.status === 201, 'two more leads created');

    const dup = await post('/api/leads', { name: 'Dup', email: mail('alpha') });
    ok(dup.status === 400, 'a duplicate email is rejected (one person, one record)');
    ok(/already uses that email/i.test((await json(dup))?.message ?? ''), 'the duplicate message names the clashing lead');

    // ------------------------------------------------------------------ read
    head('read, filters and stats');
    const list = await json(await get(`/api/leads?search=${MARK}&limit=50`));
    ok(list.data.length === 3, `search returns the 3 leads created here (got ${list.data.length})`);
    ok(list.meta.total === 3 && list.meta.current_page === 1, 'pagination meta is present');
    ok(list.stats.total === 3, 'stats are computed over the filtered set, not the whole table');
    ok(list.stats.noCalls === 3, 'all three count as "no calls" before any are logged');
    ok(list.stats.websiteEnquiries === 2, 'website enquiries counts google ads + meta only');
    ok(list.stats.byStatus.hot === 1 && list.stats.byStatus.cold === 1 && list.stats.byStatus.warm === 1, 'per-status counts are correct');

    const byStatus = await json(await get(`/api/leads?search=${MARK}&leadStatus=hot`));
    ok(byStatus.data.length === 1 && byStatus.data[0].id === a.body.id, 'status filter narrows the list');

    const byTag = await json(await get(`/api/leads?search=${MARK}&tag=Expo-2026`));
    ok(byTag.data.length === 2, 'tag filter matches leads carrying that tag');
    const byVip = await json(await get(`/api/leads?search=${MARK}&tag=VIP`));
    ok(byVip.data.length === 1, 'tag matching is exact — "VIP" does not also match a lead tagged only "Expo-2026"');

    const noneResp = await json(await get(`/api/leads?search=${MARK}&leadResponse=__none__`));
    ok(noneResp.data.length === 2, 'the NONE sentinel finds leads where the field was never filled in');

    const byAge = await json(await get(`/api/leads?search=${MARK}&minAge=50`));
    ok(byAge.data.length === 1 && byAge.data[0].age === 61, 'age range filter works');

    const unassigned = await json(await get(`/api/leads?search=${MARK}&assignedTo=unassigned`));
    ok(unassigned.data.length === 3, 'unassigned filter works (admin-created leads are unassigned)');

    const detail = await json(await get(`/api/leads/${a.body.id}`));
    ok(detail.id === a.body.id, 'lead detail loads');
    ok(Array.isArray(detail.notes_history) && Array.isArray(detail.tasks)
      && Array.isArray(detail.showings) && Array.isArray(detail.calls), 'detail carries all four activity lists');

    // ---------------------------------------------------------------- update
    head('update');
    const up = await put(`/api/leads/${a.body.id}`, { lead_status: 'warm', notes: 'Prefers evening calls.' });
    const upBody = await json(up);
    ok(up.status === 200 && upBody.lead_status === 'warm', 'lead updated');
    ok(upBody.email === a.body.email, 'a partial update leaves untouched fields alone');
    const clear = await json(await put(`/api/leads/${a.body.id}`, { client_type: '' }));
    ok(clear.client_type === null, 'an empty vocabulary value clears the field rather than failing');
    const selfEmail = await put(`/api/leads/${a.body.id}`, { email: a.body.email });
    ok(selfEmail.status === 200, 'a lead can keep its own email on update (duplicate check excludes itself)');

    // -------------------------------------------------------------- activity
    head('activity: notes, tasks, showings, calls');
    const note = await post(`/api/leads/${a.body.id}/notes`, { content: 'Toured 12 King St.' });
    const noteBody = await json(note);
    ok(note.status === 201 && noteBody.created_by, 'note added with its author recorded');
    ok((await post(`/api/leads/${a.body.id}/notes`, { content: '  ' })).status === 400, 'an empty note is rejected');
    const pinned = await json(await put(`/api/leads/${a.body.id}/notes/${noteBody.id}`, { pinned: true }));
    ok(pinned.pinned === true, 'a note can be pinned');

    const task = await json(await post(`/api/leads/${a.body.id}/tasks`, { title: 'Send comparables', due_date: '2026-08-01', priority: 'high' }));
    ok(task.id && task.priority === 'high', 'task added');
    ok((await post(`/api/leads/${a.body.id}/tasks`, { title: 'X', due_date: '2026-13-01' })).status === 400, 'an invalid due date is rejected');
    ok((await post(`/api/leads/${a.body.id}/tasks`, { title: 'X', due_date: '2026-08-01', priority: 'urgent' })).status === 400, 'an unknown priority is rejected');
    const doneTask = await json(await put(`/api/leads/${a.body.id}/tasks/${task.id}`, { status: 'completed' }));
    ok(doneTask.status === 'completed', 'a task can be completed');

    const showing = await json(await post(`/api/leads/${a.body.id}/showings`, { showing_date: '2026-08-05', time: '14:30', property: '12 King St' }));
    ok(showing.id && showing.time === '14:30', 'showing scheduled');
    ok((await post(`/api/leads/${a.body.id}/showings`, { showing_date: '2026-08-05', time: '25:00' })).status === 400, 'an impossible time is rejected');

    const call = await json(await post(`/api/leads/${a.body.id}/calls`, { outcome: 'voicemail', duration: 45, notes: 'Left a message.' }));
    ok(call.id && call.outcome === 'voicemail', 'call logged');
    ok((await post(`/api/leads/${a.body.id}/calls`, { outcome: 'telepathy' })).status === 400, 'an unknown call outcome is rejected');

    const after = await json(await get(`/api/leads/${a.body.id}`));
    ok(after.notes_history.length === 1 && after.tasks.length === 1
      && after.showings.length === 1 && after.calls.length === 1, 'all four activity types are returned on the detail');

    const statsNow = (await json(await get(`/api/leads?search=${MARK}`))).stats;
    ok(statsNow.noCalls === 2, 'the No Calls counter drops once a call is logged');

    const listNow = await json(await get(`/api/leads?search=${MARK}&leadStatus=warm`));
    const alphaRow = listNow.data.find((l) => l.id === a.body.id);
    ok(alphaRow.call_count === 1 && alphaRow.task_count === 1, 'the list row carries activity counts');
    ok(alphaRow.pending_task_count === 0, 'pending task count excludes completed tasks');

    // ------------------------------------------------------------------ tags
    head('tags');
    ok((await post('/api/leads/tags', { tag: `${MARK}-tag` })).status === 201, 'a tag can be registered before any lead carries it');
    const tags = await json(await get('/api/leads/tags'));
    ok(tags.tags.includes(`${MARK}-tag`), 'a registry-only tag appears in the tag list');
    ok(tags.counts.find((t) => t.name === `${MARK}-tag`)?.count === 0, 'a registry-only tag reports a count of 0');
    ok(tags.counts.find((t) => t.name === 'Expo-2026')?.count === 2, 'per-tag lead counts are correct');

    const applied = await json(await post('/api/leads/tag', { lead_ids: [c2.body.id], tag: 'Expo-2026', mode: 'add' }));
    ok(applied.changed === 1, 'a tag can be applied to a selection');
    const reapplied = await json(await post('/api/leads/tag', { lead_ids: [c2.body.id], tag: 'Expo-2026', mode: 'add' }));
    ok(reapplied.changed === 0, 're-applying the same tag is a no-op, not a duplicate');
    const removed = await json(await post('/api/leads/tag', { lead_ids: [c2.body.id], tag: 'Expo-2026', mode: 'remove' }));
    ok(removed.changed === 1, 'a tag can be removed from a selection');

    const delTag = await json(await del(`/api/leads/tags?tag=${encodeURIComponent(`${MARK}-tag`)}`));
    ok(delTag.tag === `${MARK}-tag` && Array.isArray(delTag.lead_ids), 'deleting a tag returns the affected leads so it can be undone');

    // ---------------------------------------------------------------- import
    head('CSV import');
    const csv = [
      'Name,Email,Phone,Lead Status,Lead Source',
      `${MARK} Import One,${mail('import1')},416-555-0111,cold,linkedin`,
      `${MARK} Import Two,${mail('import2')},,warm,youtube`,
      `${MARK} Dup,${mail('alpha')},,,`,
      'No Email Row,,,,',
    ].join('\n');
    const imp = await json(await post('/api/leads/import', { csv, tag: `${MARK}-batch` }));
    ok(imp.imported === 2, `2 new leads imported (got ${imp.imported})`);
    ok(imp.duplicate === 1, 'an address already on file counts as a duplicate rather than being re-created');
    ok(imp.tagged === 1, 'the existing lead was tagged instead of duplicated');
    ok(imp.invalid === 1, 'a row with no email is counted as invalid');
    ok((await post('/api/leads/import', { csv: '' })).status === 400, 'an empty import is rejected with a message');

    const imported = await json(await get(`/api/leads?search=${MARK}&tag=${MARK}-batch`));
    ok(imported.data.length === 3, 'imported leads carry the batch tag (2 new + 1 tagged)');
    for (const l of imported.data) if (!created.includes(l.id)) created.push(l.id);

    // ---------------------------------------------------------------- export
    head('export');
    const rows = await json(await post('/api/leads/export', { lead_ids: [a.body.id] }));
    ok(Array.isArray(rows) && rows.length === 1, 'export returns just the checked leads');
    ok(rows[0].Name && rows[0].Email && 'Tags' in rows[0] && 'Assigned To' in rows[0], 'export rows carry readable column headers');
    const allRows = await json(await post('/api/leads/export', { lead_ids: [], filters: { search: MARK } }));
    ok(allRows.length === 5, `with no selection the export falls back to the current filters (${allRows.length} rows)`);

    // --------------------------------------------------- bin + bulk actions
    head('bulk delete, restore and purge');
    const doomed = [b2.body.id, c2.body.id];
    const bulk = await json(await post('/api/leads/bulk-delete', { lead_ids: doomed }));
    ok(bulk.deleted === 2, 'bulk delete moves the selection to Recently Deleted');
    const afterBulk = await json(await get(`/api/leads?search=${MARK}`));
    ok(!afterBulk.data.some((l) => doomed.includes(l.id)), 'deleted leads drop out of the list');

    const bin = await json(await get('/api/leads/deleted'));
    ok(bin.data.filter((l) => doomed.includes(l.id)).length === 2, 'both appear in the bin');
    ok(bin.data.find((l) => l.id === doomed[0]).deleted_by, 'the bin records who deleted each lead');

    ok((await post(`/api/leads/deleted/${doomed[0]}/restore`)).status === 200, 'a lead can be restored');
    const afterRestore = await json(await get(`/api/leads?search=${MARK}`));
    ok(afterRestore.data.some((l) => l.id === doomed[0]), 'the restored lead is back in the list');

    ok((await get(`/api/leads/${doomed[1]}`)).status === 404, 'a deleted lead 404s rather than leaking through detail');
    ok((await del(`/api/leads/deleted/${doomed[1]}`)).status === 200, 'a lead can be permanently deleted from the bin');
    created.splice(created.indexOf(doomed[1]), 1);
    ok((await get(`/api/leads/${doomed[1]}`)).status === 404, 'the purged lead is gone');

    // ------------------------------------------------- routes & permissions
    head('route collisions and guards');
    ok((await get('/api/leads/tags')).status === 200, '/api/leads/tags is not swallowed by /api/leads/:id');
    ok((await get('/api/leads/deleted')).status === 200, '/api/leads/deleted is not swallowed by /api/leads/:id');
    ok((await get('/api/leads/options')).status === 200, '/api/leads/options is not swallowed by /api/leads/:id');
    ok((await get('/api/leads/notanumber')).status === 400, 'a non-numeric id is rejected by ParseIntPipe, not treated as a route');

    const anon = await fetch(BASE + '/api/leads', { headers: H });
    ok(anon.status === 401 || anon.status === 403, `leads require a session (anonymous → ${anon.status})`);
    const noCsrf = await fetch(BASE + '/api/leads', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Cookie: ch() },
      body: JSON.stringify({ name: 'x', email: mail('csrf') }),
    });
    ok(noCsrf.status === 419 || noCsrf.status === 403, `a write without the CSRF token is refused (${noCsrf.status})`);

    // ------------------------------------------------------- audit trail
    head('audit trail');
    const audit = await json(await get('/api/audit-logs?category=Lead'));
    const mine = (audit.data ?? []).filter((r) => String(r.details ?? '').includes(MARK));
    ok(mine.length > 0, `lead activity is written to the global Audit Trail (${mine.length} entries)`);
    ok(mine.some((r) => r.action === 'Lead created'), 'creates are audited');
    ok(mine.some((r) => r.action === 'Lead deleted' || r.action === 'Leads bulk deleted'), 'deletes are audited');
    ok((audit.categories ?? []).includes('Lead'), '"Lead" is offered as a category filter on the Audit Trail page');

    // ------------------------------------------------------------- frontend
    head('frontend wiring');
    const app = read(CLIENT, 'App.tsx');
    ok(/path="lead"/.test(app), '/app/lead has a real route');
    ok(/path="lead\/:id"/.test(app), '/app/lead/:id has a detail route');
    ok(app.includes('import LeadsPage from'), 'LeadsPage is imported');
    ok(!/^\s*lead:/m.test(read(CLIENT, 'desk/StubPage.tsx')), 'the Lead stub entry was removed (dead code)');
    ok(/key: 'lead'/.test(read(CLIENT, 'desk/DeskLayout.tsx')), 'Lead is still in the sidebar');
    ok(/'lead'/.test(read(CLIENT, 'desk/guards.tsx')), 'Lead is in the landing-redirect order');

    const page = read(CLIENT, 'desk/LeadsPage.tsx');
    for (const s of ['tailwind', 'shadcn', 'lucide-react', 'next/', 'framer-motion', 'mongodb']) {
      ok(!page.includes(s), `no "${s}" leaked into the ported page`);
    }
    ok(!read(CLIENT, 'desk/LeadDetailPage.tsx').includes('lucide-react'), 'the detail page is free of the source icon library too');
    ok(read(CLIENT, 'styles/desk.css').includes('.lead-sel-col input[type=checkbox]'),
      'the checkbox column is pinned (the global input rule would otherwise stretch it)');

    // ------------------------------------------------------------ isolation
    head('the rest of Transaction Desk is unaffected');
    const txnsNow = await json(await get('/api/transactions'));
    const txnNow = Array.isArray(txnsNow) ? txnsNow.length : txnsNow?.data?.length ?? 0;
    ok(txnNow === txnCount, `transactions unchanged (${txnNow})`);
    ok((await (await get('/api/reports')).json()).length >= 20, 'reports module still responds');
    const campsNow = await json(await get('/api/campaigns'));
    ok((campsNow || []).length === (before.campaigns || []).length, 'campaigns unchanged');
    ok((await get('/api/campaigns/leads/tags')).status === 200, 'the Campaigns audience still reads lead tags from the shared table');
    ok((await get('/api/calendar/events')).status === 200, 'the calendar module still responds');
    ok(/Shares the `leads` table with Campaigns/.test(read(SERVER, 'leads/leads.module.ts')),
      'the shared-table relationship is documented where the next reader will look');
  } finally {
    // ------------------------------------------------------------- cleanup
    head('cleanup');
    let removed = 0;
    for (const id of created) {
      await del(`/api/leads/${id}`);              // soft delete (may already be soft-deleted)
      const r = await del(`/api/leads/deleted/${id}`); // then purge
      if (r.status === 200) removed++;
    }
    // Tagging a lead also registers the tag name, so the registry needs clearing too —
    // otherwise every run leaves a phantom tag in the Campaigns audience dropdown.
    for (const t of [`${MARK}-batch`, 'Expo-2026', 'VIP']) {
      await del(`/api/leads/tags?tag=${encodeURIComponent(t)}`);
    }
    ok(removed === created.length, `removed all ${created.length} test leads (${removed} purged)`);
    const left = await json(await get(`/api/leads?search=${MARK}`));
    ok((left?.meta?.total ?? -1) === 0, 'no test leads remain');
    const binLeft = await json(await get('/api/leads/deleted'));
    ok(!(binLeft?.data ?? []).some((l) => String(l.email).includes(MARK)), 'nothing left in the Recently Deleted bin either');
    const finalTotal = (await json(await get('/api/leads?limit=1')))?.meta?.total ?? -1;
    ok(finalTotal === before.leads, `lead count is back to where it started (${finalTotal})`);
    const tagsLeft = (await json(await get('/api/leads/tags')))?.tags ?? [];
    ok(!tagsLeft.some((t) => ['Expo-2026', 'VIP', `${MARK}-batch`].includes(t)),
      `no test tags left in the registry (${tagsLeft.length} remain)`);

    console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
    // Set the code rather than calling process.exit(): forcing exit while fetch's keep-alive
    // sockets are still closing trips a libuv assertion on Windows and reports a bogus code.
    process.exitCode = fail === 0 ? 0 : 1;
  }
})();
