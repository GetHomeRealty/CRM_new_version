// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/**
 * Golden parity test for the B4 read endpoints. Logs in on both the live Laravel
 * API and the NestJS API, GETs each endpoint, and diffs the JSON.
 *
 *   node scripts/golden-read.cjs [laravelBase] [nestBase] [username] [password]
 */
const LARAVEL = process.argv[2] || 'http://127.0.0.1:8000';
const NEST = process.argv[3] || 'http://127.0.0.1:8001';
const USER = process.argv[4] || ADMIN_LOGIN;
const PASS = process.argv[5] || 'Admin@123';

const ENDPOINTS = [
  '/api/transaction-types',
  '/api/agents',
  '/api/agent-emails',
  '/api/agent-commissions',
  '/api/agent-loans',
  '/api/suggestions/lawyers',
  '/api/suggestions/brokerages',
  '/api/dashboard/commissions',
  '/api/company-settings',
  '/api/agent-change-notifications',
  '/api/doc-notifications',
];

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

async function session(base) {
  const jar = {};
  let res = await fetch(base + '/sanctum/csrf-cookie', { headers: H });
  jarFrom(res, jar);
  const xsrf = decodeURIComponent(jar['XSRF-TOKEN'] || '');
  res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf, Cookie: cookieHeader(jar) },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  jarFrom(res, jar);
  return jar;
}

async function getAll(base) {
  const jar = await session(base);
  const results = {};
  for (const ep of ENDPOINTS) {
    const res = await fetch(base + ep, { headers: { ...H, Cookie: cookieHeader(jar) } });
    results[ep] = { status: res.status, body: await res.json().catch(() => null) };
  }
  return results;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failures = 0;

async function main() {
  const [lav, nst] = await Promise.all([getAll(LARAVEL), getAll(NEST)]);
  for (const ep of ENDPOINTS) {
    const ok = lav[ep].status === nst[ep].status && eq(lav[ep].body, nst[ep].body);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${ep}  (${lav[ep].status} vs ${nst[ep].status})`);
    if (!ok) {
      console.log('   laravel:', JSON.stringify(lav[ep].body)?.slice(0, 500));
      console.log('   nest   :', JSON.stringify(nst[ep].body)?.slice(0, 500));
    }
  }
  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('golden-read error:', e);
  process.exit(1);
});