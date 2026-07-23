/**
 * Capture the live Laravel /api/transactions/{id} responses for every transaction
 * as golden fixtures (used to verify the CommissionService + resource ports).
 * Writes an { id: showBody } map to the given output file.
 *
 *   node scripts/capture-show.cjs <outFile> [laravelBase] [username] [password]
 */
const fs = require('fs');

// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const OUT = process.argv[2] || 'laravel-show.json';
const LARAVEL = process.argv[3] || 'http://127.0.0.1:8000';
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

async function main() {
  const jar = {};
  let res = await fetch(LARAVEL + '/sanctum/csrf-cookie', { headers: H });
  jarFrom(res, jar);
  const xsrf = decodeURIComponent(jar['XSRF-TOKEN'] || '');
  res = await fetch(LARAVEL + '/api/login', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf, Cookie: cookieHeader(jar) },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  jarFrom(res, jar);

  const list = await (await fetch(LARAVEL + '/api/transactions', { headers: { ...H, Cookie: cookieHeader(jar) } })).json();
  console.log('list top-level shape:', Array.isArray(list) ? 'array' : 'object keys=' + Object.keys(list).join(','));
  const arr = Array.isArray(list) ? list : list.data || [];
  const ids = arr.map((t) => t.id);
  const out = {};
  for (const id of ids) {
    const body = await (await fetch(LARAVEL + '/api/transactions/' + id, { headers: { ...H, Cookie: cookieHeader(jar) } })).json();
    out[id] = body;
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`captured ${ids.length} transactions -> ${OUT}`);
  console.log('types:', ids.map((id) => `${id}:${out[id].type}`).join(', '));
}
main().catch((e) => { console.error(e); process.exit(1); });