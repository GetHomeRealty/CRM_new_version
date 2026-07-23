// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Golden parity for invoice reads: /api/invoices (list), each /api/invoices/:id, /api/customers. */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const get = (base, jar, path) => fetch(base + path, { headers: { ...H, Cookie: cookieHeader(jar) } }).then((r) => r.json());
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failures = 0;
function check(name, a, b) { const ok = eq(a, b); if (!ok) { failures++; console.log('FAIL ', name); const ka = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]); for (const k of ka) if (!eq(a?.[k], b?.[k])) { console.log(`   key "${k}":`); console.log('     laravel:', JSON.stringify(a?.[k])?.slice(0, 300)); console.log('     nest   :', JSON.stringify(b?.[k])?.slice(0, 300)); } } else console.log('PASS ', name); }

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const [ll, nl] = await Promise.all([get(LARAVEL, lj, '/api/invoices'), get(NEST, nj, '/api/invoices')]);
  const okList = Array.isArray(ll) && Array.isArray(nl) && ll.length === nl.length && ll.every((r, i) => eq(r, nl[i]));
  console.log(`${okList ? 'PASS' : 'FAIL'}  GET /api/invoices (${ll.length} rows)`);
  if (!okList) { failures++; for (let i = 0; i < Math.max(ll.length, nl.length); i++) if (!eq(ll[i], nl[i])) check(`  invoice row ${i}`, ll[i], nl[i]); }

  for (const inv of ll) {
    const [ld, nd] = await Promise.all([get(LARAVEL, lj, '/api/invoices/' + inv.id), get(NEST, nj, '/api/invoices/' + inv.id)]);
    check(`GET /api/invoices/${inv.id}`, ld, nd);
  }

  const [lc, nc] = await Promise.all([get(LARAVEL, lj, '/api/customers'), get(NEST, nj, '/api/customers')]);
  const okC = eq(lc, nc);
  console.log(`${okC ? 'PASS' : 'FAIL'}  GET /api/customers (${Array.isArray(lc) ? lc.length : '?'} rows)`);
  if (!okC) { failures++; console.log('   laravel:', JSON.stringify(lc)?.slice(0, 400)); console.log('   nest   :', JSON.stringify(nc)?.slice(0, 400)); }

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });