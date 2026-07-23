// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/**
 * Golden parity test for PUT /api/company-settings: applies an identical change to
 * BOTH Laravel and NestJS, diffs the result (ignoring updated_at), then reverts.
 *
 *   node scripts/golden-settings-update.cjs [laravelBase] [nestBase] [user] [pass]
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
  jar.xsrf = decodeURIComponent(jar['XSRF-TOKEN'] || '');
  res = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': jar.xsrf, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) });
  jarFrom(res, jar);
  return jar;
}
const get = (base, jar, path) => fetch(base + path, { headers: { ...H, Cookie: cookieHeader(jar) } }).then((r) => r.json());
const put = (base, jar, path, body) => fetch(base + path, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: JSON.stringify(body) }).then((r) => r.json());

const RULE_FIELDS = ['name', 'address', 'phone', 'email', 'hst_number', 'bank_beneficiary', 'bank_name', 'transit_no', 'account_no', 'institution_no', 'currency', 'default_tax_rate', 'invoice_prefix', 'next_invoice_no', 'default_terms', 'thank_you_note', 'deposit_heading'];
const payloadFrom = (s, overrides) => {
  const p = {};
  for (const f of RULE_FIELDS) p[f] = s[f];
  p.default_tax_rate = Number(s.default_tax_rate); // GET returns the decimal as a string
  return { ...p, ...overrides };
};
const strip = (o) => { const { updated_at, ...rest } = o || {}; return rest; };
const eq = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

let failures = 0;
function check(name, a, b) { const ok = eq(a, b); if (!ok) { failures++; console.log('FAIL ', name); console.log('   laravel:', JSON.stringify(strip(a))); console.log('   nest   :', JSON.stringify(strip(b))); } else console.log('PASS ', name); }

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const [lOrig, nOrig] = await Promise.all([get(LARAVEL, lj, '/api/company-settings'), get(NEST, nj, '/api/company-settings')]);
  check('originals match', lOrig, nOrig);

  const change = { phone: '905-000-TEST', thank_you_note: 'PARITY TEST NOTE' };
  const [lUpd, nUpd] = await Promise.all([put(LARAVEL, lj, '/api/company-settings', payloadFrom(lOrig, change)), put(NEST, nj, '/api/company-settings', payloadFrom(nOrig, change))]);
  check('PUT response matches', lUpd, nUpd);
  if (lUpd.phone !== '905-000-TEST' || nUpd.phone !== '905-000-TEST') { failures++; console.log('FAIL  change not applied'); }

  const [lGet, nGet] = await Promise.all([get(LARAVEL, lj, '/api/company-settings'), get(NEST, nj, '/api/company-settings')]);
  check('GET after update matches', lGet, nGet);

  // Revert to the originals.
  await Promise.all([put(LARAVEL, lj, '/api/company-settings', payloadFrom(lOrig, {})), put(NEST, nj, '/api/company-settings', payloadFrom(nOrig, {}))]);
  const [lRev, nRev] = await Promise.all([get(LARAVEL, lj, '/api/company-settings'), get(NEST, nj, '/api/company-settings')]);
  check('reverted to original (laravel)', strip(lOrig), strip(lRev));
  check('reverted to original (nest)', strip(nOrig), strip(nRev));

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });