/** Golden parity for the transaction store fuzzy-duplicate guard: create A on both, then
 *  attempt a near-duplicate B (extra trailing word) → both must 422 with the same message. */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const send = (base, jar, method, path, body) => fetch(base + path, { method, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = { type: 'Residential Buying', status: 'Secured Firm', comm_type: '%', comm_value: '2.5', price: '412345', deposit: '10000', offer_date: '2026-05-17', closing_date: '2026-08-01' };
const A = { ...BASE, property: '987 Fakestreet Parity West' };
const B = { ...BASE, property: '987 Fakestreet Parity West Rd' }; // extra trailing word → prefix-subset match

const scrubMsg = (m) => (m || '').replace(/Trade #\d+/g, 'Trade #');

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const [la, na] = await Promise.all([send(LARAVEL, lj, 'POST', '/api/transactions', A), send(NEST, nj, 'POST', '/api/transactions', A)]);
  let failures = 0;
  console.log('create A:', la.status, 'vs', na.status);
  if (la.status !== 201 || na.status !== 201) { console.log('  FAIL: A not created', JSON.stringify(la.body).slice(0, 200), JSON.stringify(na.body).slice(0, 200)); failures++; }

  const [lb, nb] = await Promise.all([send(LARAVEL, lj, 'POST', '/api/transactions', B), send(NEST, nj, 'POST', '/api/transactions', B)]);
  console.log('dup B  :', lb.status, 'vs', nb.status);
  if (lb.status !== nb.status || lb.status !== 422) { failures++; console.log('  FAIL: expected 422/422'); }
  const lm = scrubMsg(lb.body?.message), nm = scrubMsg(nb.body?.message);
  if (lm !== nm) { failures++; console.log('  laravel msg:', lm); console.log('  nest    msg:', nm); }
  else console.log('  message identical:', lm);

  // cleanup: soft-delete A on both (B was rejected, never created)
  const lid = la.body?.data?.id, nid = na.body?.data?.id;
  if (lid) await send(LARAVEL, lj, 'DELETE', '/api/transactions/' + lid);
  if (nid) await send(NEST, nj, 'DELETE', '/api/transactions/' + nid);
  console.log('  (transaction A soft-deleted on both)');
  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
