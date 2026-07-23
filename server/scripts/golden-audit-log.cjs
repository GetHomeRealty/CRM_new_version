// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Golden parity for the global audit trail (GET /api/audit-logs). Verifies meta/categories
 *  on an unfiltered page and exact item parity on narrow filtered queries (< 1 page, so no
 *  pagination-boundary nondeterminism), canonicalizing tie order by (stamp desc, id desc). */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const get = (base, jar, path) => fetch(base + path, { headers: { ...H, Cookie: cookieHeader(jar) } }).then(async (r) => ({ status: r.status, body: await r.json() }));

const canon = (items) => [...items].sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : b.id - a.id));

let failures = 0;
function eq(label, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { failures++; console.log(`  FAIL ${label}:`); console.log('    laravel:', JSON.stringify(a)?.slice(0, 300)); console.log('    nest   :', JSON.stringify(b)?.slice(0, 300)); } else console.log(`  PASS ${label}`); }

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);

  // 1) Page 1 bounded to stable historical data (≤ 2026-07-17 excludes this session's own
  //    store-test creations) — meta + categories must match exactly.
  const [l1, n1] = await Promise.all([get(LARAVEL, lj, '/api/audit-logs?to=2026-07-17'), get(NEST, nj, '/api/audit-logs?to=2026-07-17')]);
  console.log('page 1 (to=2026-07-17):', l1.status, 'vs', n1.status);
  eq('meta', l1.body.meta, n1.body.meta);
  eq('categories', l1.body.categories, n1.body.categories);
  eq('page item count', l1.body.data.length, n1.body.data.length);

  // 2) Narrow filters that return < 50 rows → single page, exact item parity. All bounded to
  //    stable historical data so the comparison isolates code, not this session's test rows.
  const queries = [
    '/api/audit-logs?category=Users',
    '/api/audit-logs?category=Settings',
    '/api/audit-logs?category=Invoice&to=2026-07-17',
    '/api/audit-logs?category=Transactions&user_id=1&to=2026-07-17',
    '/api/audit-logs?q=created&to=2026-07-17',
    '/api/audit-logs?from=2026-07-01&to=2026-07-31&category=Settings',
  ];
  for (const path of queries) {
    const [l, n] = await Promise.all([get(LARAVEL, lj, path), get(NEST, nj, path)]);
    if (l.body.meta.total >= 50) { console.log(`  SKIP ${path} (>=50 rows, page boundary)`); continue; }
    eq(`items ${path} (total ${l.body.meta.total})`, canon(l.body.data), canon(n.body.data));
    eq(`meta  ${path}`, l.body.meta, n.body.meta);
  }

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });