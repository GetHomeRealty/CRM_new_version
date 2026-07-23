// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/**
 * Golden parity test for the auth spine: runs the exact Sanctum SPA flow
 * (csrf-cookie → login → /user → logout) against BOTH the live Laravel API and
 * the NestJS API, then diffs the responses. Also checks the bad-credentials 422
 * and unauthenticated 401 shapes.
 *
 *   node scripts/golden-auth.cjs [laravelBase] [nestBase] [username] [password]
 */
const LARAVEL = process.argv[2] || 'http://127.0.0.1:8000';
const NEST = process.argv[3] || 'http://127.0.0.1:8001';
const USER = process.argv[4] || ADMIN_LOGIN;
const PASS = process.argv[5] || 'Admin@123';

const H = {
  Accept: 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
  Origin: 'http://localhost:5173',
  Referer: 'http://localhost:5173/',
};

function jarFrom(res, jar) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of cookies) {
    const nv = c.split(';')[0];
    const i = nv.indexOf('=');
    if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1);
  }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function flow(base, username, password) {
  const jar = {};
  // Re-read the XSRF-TOKEN cookie before each state-changing request — exactly
  // what axios does (Laravel rotates it on login via session regeneration).
  const xsrf = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');

  let res = await fetch(base + '/sanctum/csrf-cookie', { headers: H });
  jarFrom(res, jar);

  res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf(), Cookie: cookieHeader(jar) },
    body: JSON.stringify({ username, password }),
  });
  const login = { status: res.status, body: await res.json().catch(() => null) };
  jarFrom(res, jar);

  res = await fetch(base + '/api/user', { headers: { ...H, Cookie: cookieHeader(jar) } });
  const me = { status: res.status, body: await res.json().catch(() => null) };
  jarFrom(res, jar);

  res = await fetch(base + '/api/logout', {
    method: 'POST',
    headers: { ...H, 'X-XSRF-TOKEN': xsrf(), Cookie: cookieHeader(jar) },
  });
  const logout = { status: res.status, body: await res.json().catch(() => null) };

  return { login, me, logout };
}

async function badLogin(base) {
  const jar = {};
  let res = await fetch(base + '/sanctum/csrf-cookie', { headers: H });
  jarFrom(res, jar);
  const xsrf = decodeURIComponent(jar['XSRF-TOKEN'] || '');
  res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf, Cookie: cookieHeader(jar) },
    body: JSON.stringify({ username: USER, password: 'definitely-wrong' }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function unauth(base) {
  const res = await fetch(base + '/api/user', { headers: H });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failures = 0;
function check(name, a, b) {
  const ok = eq(a, b);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log('   laravel:', JSON.stringify(a));
    console.log('   nest   :', JSON.stringify(b));
  }
}

async function main() {
  const [lav, nst] = await Promise.all([flow(LARAVEL, USER, PASS), flow(NEST, USER, PASS)]);
  check('login status', lav.login.status, nst.login.status);
  check('login body { user }', lav.login.body, nst.login.body);
  check('/api/user status', lav.me.status, nst.me.status);
  check('/api/user payload', lav.me.body, nst.me.body);
  check('logout status', lav.logout.status, nst.logout.status);
  check('logout body', lav.logout.body, nst.logout.body);

  const [lb, nb] = await Promise.all([badLogin(LARAVEL), badLogin(NEST)]);
  check('bad-login status', lb.status, nb.status);
  check('bad-login body', lb.body, nb.body);

  const [lu, nu] = await Promise.all([unauth(LARAVEL), unauth(NEST)]);
  check('unauth status', lu.status, nu.status);
  check('unauth body', lu.body, nu.body);

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('golden test error:', e);
  process.exit(1);
});