// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/**
 * Golden parity test for the full transactions endpoints: GET /api/transactions
 * (list) and GET /api/transactions/{id} (detail), diffed field-by-field against
 * live Laravel.
 *
 *   node scripts/golden-transactions.cjs [laravelBase] [nestBase] [user] [pass]
 */
const LARAVEL = process.argv[2] || 'http://127.0.0.1:8000';
const NEST = process.argv[3] || 'http://127.0.0.1:8001';
const USER = process.argv[4] || ADMIN_LOGIN;
const PASS = process.argv[5] || 'Admin@123';

const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of cookies) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) {
  const jar = {};
  let res = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(res, jar);
  const xsrf = decodeURIComponent(jar['XSRF-TOKEN'] || '');
  res = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) });
  jarFrom(res, jar);
  return jar;
}
const getJson = (base, jar, path) => fetch(base + path, { headers: { ...H, Cookie: cookieHeader(jar) } }).then((r) => r.json());

// Laravel returns statuses and same-second audit ties in an index-plan-dependent
// (non-deterministic) order — even inconsistently between its own list and show
// endpoints. Canonicalize those collections before comparing so we validate the
// DATA is identical, not the arbitrary source order.
function canon(row) {
  if (!row || typeof row !== 'object') return row;
  const r = { ...row };
  if (Array.isArray(r.statuses)) r.statuses = [...r.statuses].sort();
  for (const k of ['audit_logs', 'agent_changes', 'edit_requests']) {
    if (Array.isArray(r[k])) r[k] = [...r[k]].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }
  return r;
}
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

let failures = 0;
function diffObj(label, a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (!eq(a?.[k], b?.[k])) {
      console.log(`   ↳ ${label} key "${k}":`);
      console.log('      laravel:', JSON.stringify(a?.[k])?.slice(0, 300));
      console.log('      nest   :', JSON.stringify(b?.[k])?.slice(0, 300));
    }
  }
}

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const [ll, nl] = await Promise.all([getJson(LARAVEL, lj, '/api/transactions'), getJson(NEST, nj, '/api/transactions')]);
  const la = ll.data || ll, na = nl.data || nl;

  const okList = la.length === na.length && la.every((r, i) => eq(r, na[i]));
  console.log(`${okList ? 'PASS' : 'FAIL'}  GET /api/transactions (list, ${la.length} rows)`);
  if (!okList) {
    failures++;
    for (let i = 0; i < Math.max(la.length, na.length); i++) {
      if (!eq(la[i], na[i])) { console.log(`  row ${i} (id ${la[i]?.id ?? na[i]?.id}):`); diffObj('list', la[i], na[i]); }
    }
  }

  for (const t of la) {
    const [ls, ns] = await Promise.all([getJson(LARAVEL, lj, '/api/transactions/' + t.id), getJson(NEST, nj, '/api/transactions/' + t.id)]);
    const ld = ls.data || ls, nd = ns.data || ns;
    const ok = eq(ld, nd);
    console.log(`${ok ? 'PASS' : 'FAIL'}  GET /api/transactions/${t.id} (${t.type})`);
    if (!ok) { failures++; diffObj('show', ld, nd); }
  }

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });