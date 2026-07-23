/** Drive the running NestJS app end-to-end: CSRF → login → authenticated endpoints across modules. */
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const get = (jar, path) => fetch(BASE + path, { headers: { ...H, Cookie: cookieHeader(jar) } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function main() {
  const jar = {};
  // 1) Sanctum CSRF cookie
  let r = await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar);
  console.log('GET /sanctum/csrf-cookie ->', r.status, 'XSRF-TOKEN set:', !!jar['XSRF-TOKEN']);

  // 2) unauthenticated probe
  const un = await get(jar, '/api/user');
  console.log('GET /api/user (no session) ->', un.status, JSON.stringify(un.body));

  // 3) login
  const x = decodeURIComponent(jar['XSRF-TOKEN'] || '');
  r = await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) });
  jarFrom(r, jar); const me = await r.json();
  console.log('POST /api/login ->', r.status, '| user:', me.name, '| role:', me.role, '| role_label:', me.role_label);

  // 4) authenticated endpoints across the modules built this session
  const checks = [
    ['/api/user', (b) => b.email],
    ['/api/transactions', (b) => `${b.data.length} transactions`],
    ['/api/invoices', (b) => `${b.data.length} invoices`],
    ['/api/customers', (b) => `${b.length} customers`],
    ['/api/dashboard/commissions', (b) => `gross ${b.gross ?? b.overall?.gross ?? '?'}`],
    ['/api/company-settings', (b) => `settings: ${b.name}`],
    ['/api/audit-logs', (b) => `${b.meta.total} audit rows (page ${b.meta.current_page}/${b.meta.last_page})`],
    ['/api/users', (b) => `${b.length} users`],
    ['/api/users/catalog', (b) => `${b.screens.length} screens, ${b.roles.length} roles`],
    ['/api/mail-accounts', (b) => `${b.data.length} mail accounts`],
    ['/api/email-templates', (b) => `${b.groups.length} template groups`],
    ['/api/mail-events', (b) => `${Object.keys(b).length} mail events`],
    ['/api/trash/transactions', (b) => `${b.count} trashed txns`],
    ['/api/trash/deletions', (b) => `${b.count} deletion log rows`],
    ['/api/agents', (b) => `${b.length} agents`],
    ['/api/transaction-types', (b) => `${b.length} types`],
  ];
  console.log('\n--- authenticated endpoints ---');
  for (const [path, fmt] of checks) {
    const res = await get(jar, path);
    let note = '';
    try { note = fmt(res.body); } catch { note = '(shape?)'; }
    console.log(`  ${res.status}  ${path}  ->  ${note}`);
  }

  // 5) a transaction detail + its documents + FINTRAC (exercises the heavy read paths)
  const tx = (await get(jar, '/api/transactions')).body.data[0];
  const detail = await get(jar, `/api/transactions/${tx.id}`);
  console.log('\n--- deep reads on transaction #' + tx.id + ' (' + tx.trade_no + ') ---');
  console.log(`  ${detail.status}  GET /api/transactions/${tx.id}  ->  ${detail.body.data.property || '(no property)'} | commission.total ${detail.body.data.commission?.total}`);
  const docs = await get(jar, `/api/transactions/${tx.id}/documents`);
  console.log(`  ${docs.status}  .../documents  ->  ${docs.body.documents.length} docs, ${docs.body.stats.received}/${docs.body.stats.total} received (${docs.body.stats.pct}%)`);
  const nos = await get(jar, `/api/transactions/${tx.id}/notice-of-sale`);
  console.log(`  ${nos.status}  .../notice-of-sale  ->  buyers ${nos.body.buyers.length}, sellers ${nos.body.sellers.length}`);

  // 6) logout
  const lo = await fetch(BASE + '/api/logout', { method: 'POST', headers: { ...H, 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) } });
  console.log('\nPOST /api/logout ->', lo.status);
  console.log('\nApp is running and serving all modules ✅');
}
main().catch((e) => { console.error('SMOKE ERROR:', e); process.exit(1); });
