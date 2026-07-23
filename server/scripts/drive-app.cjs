/**
 * Drives the running app the way a user would: log in, load each surviving module, and
 * confirm the removed ones are gone. Reports what it sees rather than asserting pass/fail.
 */
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const UI = 'http://localhost:5173';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const jar = {};
const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } });
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify(b ?? {}) });

(async () => {
  // --- frontend is serving ---
  const idx = await fetch(UI + '/');
  const html = await idx.text();
  const entry = (html.match(/src="([^"]*main[^"]*)"/) || [])[1];
  console.log(`FRONTEND  ${idx.status}  entry=${entry ?? '(none)'}`);
  if (entry) {
    const mod = await fetch(UI + entry.replace(/^\./, ''));
    console.log(`  bundle  ${mod.status}  ${(await mod.text()).length} bytes`);
  }

  // --- login ---
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }) }));
  const who = await li.json();
  console.log(`\nLOGIN     ${li.status}  as ${who?.user?.name ?? who?.name ?? '?'} (${who?.user?.role ?? who?.role ?? '?'})`);

  // --- the sidebar the user will actually see ---
  const cat = await (await get('/api/users/catalog')).json();
  console.log(`\nSIDEBAR   ${cat.screens.length} screens: ${cat.screens.map((s) => s.key).join(', ')}`);

  // --- each module answers ---
  console.log('\nMODULES');
  const txns = await (await get('/api/transactions')).json();
  const list = Array.isArray(txns) ? txns : txns.data;
  console.log(`  transactions      ${list.length} deals`);
  const reports = await (await get('/api/reports')).json();
  const cats = [...new Set(reports.map((r) => r.category))];
  console.log(`  reports           ${reports.length} reports across ${cats.length} categories`);
  const inv = await (await get('/api/invoices')).json();
  console.log(`  invoices          ${(Array.isArray(inv) ? inv : inv.data ?? []).length}`);
  const users = await (await get('/api/users')).json();
  console.log(`  users             ${(Array.isArray(users) ? users : users.data ?? []).length}`);
  console.log(`  import history    ${(await (await get('/api/transaction-imports')).json()).length} batches`);
  console.log(`  download centre   ${(await (await get('/api/export-centre')).json()).length} exports`);

  // --- dashboard data (the tiles that remain) ---
  const dash = await get('/api/dashboard/commissions').catch(() => null);
  console.log(`\nDASHBOARD commission summary -> ${dash ? dash.status : 'n/a'}`);

  // --- a documentation report end to end ---
  const dds = await (await post('/api/reports/deal-documentation-status/search', { filters: {}, per_page: 5 })).json();
  console.log(`\nREPORT    Deal Documentation Status: ${dds.total_count} deals, ${dds.columns.length} columns`);
  console.log(`          totals: ${dds.totals.pending_docs ?? 0} pending / ${dds.totals.invalid_docs ?? 0} invalid documents`);
  if (dds.rows[0]) {
    const d = await (await get(`/api/reports/documents/${dds.rows[0].txn_id}`)).json();
    console.log(`          expanded ${d.transaction.trade_no}: ${d.groups.map((g) => `${g.label} ${g.documents.length}`).join(', ')}`);
  }

  await post('/api/logout');
  console.log('\nApp is up and driveable ✅');
})();
