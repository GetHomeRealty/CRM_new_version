// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/**
 * Golden parity test for PUT /api/transactions/{id}: applies an identical change to
 * BOTH stacks, diffs the resulting show() (including the audit entries the update
 * generates — compared by CONTENT since auto-increment ids differ), then reverts.
 *
 *   node scripts/golden-update.cjs [txnId] [field] [value]
 */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const TXN = Number(process.argv[2] || 96);
const FIELD = process.argv[3] || 'mls_num';
const VALUE = process.argv[4] || 'GOLDEN-UPDATE-TEST';

const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const get = (base, jar, path) => fetch(base + path, { headers: { ...H, Cookie: cookieHeader(jar) } }).then((r) => r.json());
const put = (base, jar, path, body) => fetch(base + path, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

const stripAudit = (a) => { const { id, stamp, ...rest } = a; return rest; };
const bySig = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
function canon(row) {
  const r = { ...(row.data || row) };
  if (Array.isArray(r.statuses)) r.statuses = [...r.statuses].sort();
  for (const k of ['audit_logs', 'agent_changes']) if (Array.isArray(r[k])) r[k] = r[k].map(stripAudit).sort(bySig);
  return r;
}
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

let failures = 0;
function check(name, a, b) { const ok = eq(a, b); if (!ok) { failures++; console.log('FAIL ', name); const ca = canon(a), cb = canon(b); for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) if (JSON.stringify(ca[k]) !== JSON.stringify(cb[k])) { console.log(`   key "${k}":`); console.log('     laravel:', JSON.stringify(ca[k])?.slice(0, 400)); console.log('     nest   :', JSON.stringify(cb[k])?.slice(0, 400)); } } else console.log('PASS ', name); }

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const [lo, no] = await Promise.all([get(LARAVEL, lj, `/api/transactions/${TXN}`), get(NEST, nj, `/api/transactions/${TXN}`)]);
  const orig = lo.data[FIELD];
  console.log(`original ${FIELD} =`, JSON.stringify(orig));

  const [lu, nu] = await Promise.all([put(LARAVEL, lj, `/api/transactions/${TXN}`, { [FIELD]: VALUE }), put(NEST, nj, `/api/transactions/${TXN}`, { [FIELD]: VALUE })]);
  console.log('PUT status:', lu.status, 'vs', nu.status);
  if (lu.status !== nu.status) failures++;
  check('PUT response (show)', lu.body, nu.body);

  const [lg, ng] = await Promise.all([get(LARAVEL, lj, `/api/transactions/${TXN}`), get(NEST, nj, `/api/transactions/${TXN}`)]);
  check('GET after update', lg, ng);
  if (String(lg.data[FIELD]) !== String(ng.data[FIELD])) { failures++; console.log('FAIL  applied values differ:', lg.data[FIELD], ng.data[FIELD]); }

  // revert
  await Promise.all([put(LARAVEL, lj, `/api/transactions/${TXN}`, { [FIELD]: orig }), put(NEST, nj, `/api/transactions/${TXN}`, { [FIELD]: orig })]);
  const [lr, nr] = await Promise.all([get(LARAVEL, lj, `/api/transactions/${TXN}`), get(NEST, nj, `/api/transactions/${TXN}`)]);
  check('GET after revert', lr, nr);
  if (lr.data[FIELD] !== orig || nr.data[FIELD] !== orig) { failures++; console.log('FAIL  not reverted:', lr.data[FIELD], nr.data[FIELD]); }

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });