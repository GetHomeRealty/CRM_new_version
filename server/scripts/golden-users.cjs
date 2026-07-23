// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Golden parity for the Users module: index / catalog / deal-history reads, plus a full
 *  create → update → delete round-trip (payload compared with id stripped, then cleaned up). */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const send = (base, jar, method, path, body) => fetch(base + path, { method, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (base, jar, path) => send(base, jar, 'GET', path);

let failures = 0;
function eq(label, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { failures++; console.log(`  FAIL ${label}`); console.log('    laravel:', JSON.stringify(a)?.slice(0, 400)); console.log('    nest   :', JSON.stringify(b)?.slice(0, 400)); } else console.log(`  PASS ${label}`); }
const noId = (u) => { const { id, ...rest } = u; return rest; };

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);

  // index — compare by email key (ids may drift), payload minus id.
  const [li, ni] = await Promise.all([get(LARAVEL, lj, '/api/users'), get(NEST, nj, '/api/users')]);
  console.log('index:', li.status, 'vs', ni.status);
  const lmap = Object.fromEntries(li.body.map((u) => [u.email, noId(u)]));
  const nmap = Object.fromEntries(ni.body.map((u) => [u.email, noId(u)]));
  eq('index user set (by email, id-stripped)', lmap, nmap);
  eq('index order (emails)', li.body.map((u) => u.email), ni.body.map((u) => u.email));

  // catalog
  const [lc, nc] = await Promise.all([get(LARAVEL, lj, '/api/users/catalog'), get(NEST, nj, '/api/users/catalog')]);
  eq('catalog', lc.body, nc.body);

  // deal-history for every agent-role user (ids differ per DB → look up by email on each side).
  const agents = li.body.filter((u) => u.role === 'agent');
  for (const a of agents.slice(0, 6)) {
    const lu = li.body.find((u) => u.email === a.email), nu = ni.body.find((u) => u.email === a.email);
    if (!lu || !nu) continue;
    const [ld, nd] = await Promise.all([get(LARAVEL, lj, `/api/users/${lu.id}/deal-history`), get(NEST, nj, `/api/users/${nu.id}/deal-history`)]);
    eq(`deal-history ${a.email} (${ld.body.length} deals)`, ld.body, nd.body);
  }

  // create → update → delete round-trip
  const email = 'parity.user.' + '630' + '@example.com';
  const createBody = { name: 'Parity Test User', username: 'parity_test_630', email, password: 'secretpw123', password_confirmation: 'secretpw123', role: 'agent', status: 'Active', profile: { agent_comm_pct: 85, brok_comm_pct: 15 }, permissions: { invoice: 'view', reports: 'edit' } };
  const [lcr, ncr] = await Promise.all([send(LARAVEL, lj, 'POST', '/api/users', createBody), send(NEST, nj, 'POST', '/api/users', createBody)]);
  console.log('create:', lcr.status, 'vs', ncr.status);
  eq('created payload (id-stripped)', noId(lcr.body), noId(ncr.body));

  const lid = lcr.body.id, nid = ncr.body.id;
  const updateBody = { name: 'Parity Test User Renamed', email, role: 'accounting', status: 'Inactive', profile: { agent_comm_pct: 80 }, permissions: { invoice: 'edit' } };
  const [lup, nup] = await Promise.all([send(LARAVEL, lj, 'PUT', '/api/users/' + lid, updateBody), send(NEST, nj, 'PUT', '/api/users/' + nid, updateBody)]);
  console.log('update:', lup.status, 'vs', nup.status);
  eq('updated payload (id-stripped)', noId(lup.body), noId(nup.body));

  const [ldl, ndl] = await Promise.all([send(LARAVEL, lj, 'DELETE', '/api/users/' + lid), send(NEST, nj, 'DELETE', '/api/users/' + nid)]);
  console.log('delete:', ldl.status, 'vs', ndl.status);
  eq('delete message', ldl.body, ndl.body);

  // validation parity: duplicate email + short password + bad role
  const badBody = { name: '', email: 'not-an-email', password: 'x', password_confirmation: 'y', role: 'wizard' };
  const [lb, nb] = await Promise.all([send(LARAVEL, lj, 'POST', '/api/users', badBody), send(NEST, nj, 'POST', '/api/users', badBody)]);
  console.log('validation:', lb.status, 'vs', nb.status);
  eq('validation errors', lb.body, nb.body);

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });