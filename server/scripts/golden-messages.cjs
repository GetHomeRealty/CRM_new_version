// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Parity smoke test for transaction chat: POST a message to both stacks, compare
 *  the returned thread's last-message shape (id/at normalized away). */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const TXN = process.argv[2] || 96;
const BODY = 'PARITY-TEST ' + (process.argv[3] || 'x');
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
async function post(base, jar) { const r = await fetch(base + `/api/transactions/${TXN}/messages`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: JSON.stringify({ body: BODY }) }); return { status: r.status, body: await r.json() }; }
const shape = (arr) => { const m = arr[arr.length - 1]; return { keys: Object.keys(m), author: m.author, body: m.body, mine: m.mine, isArray: Array.isArray(arr) }; };

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const [l, n] = await Promise.all([post(LARAVEL, lj), post(NEST, nj)]);
  console.log('laravel status', l.status, '| nest status', n.status);
  const ls = shape(l.body), ns = shape(n.body);
  const ok = l.status === n.status && JSON.stringify(ls) === JSON.stringify(ns);
  console.log('laravel last-message:', JSON.stringify(ls));
  console.log('nest    last-message:', JSON.stringify(ns));
  console.log(ok ? '\nPASS ✅ (shape + author/body/mine identical)' : '\nFAIL ❌');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });