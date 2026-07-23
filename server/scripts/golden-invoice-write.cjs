// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Golden parity for invoice CREATE: post an identical invoice to both stacks, diff the
 *  computed detail (ignoring id/invoice_no/timestamps), then soft-delete both. */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const send = (base, jar, method, path, body) => fetch(base + path, { method, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

const PAYLOAD = {
  invoice_date: '2026-07-18', terms: 'Net 30', customer_name: 'PARITY TEST CUSTOMER',
  customer_country: 'Canada', discount: 10, tax_rate: 13, status: 'Draft',
  line_items: [{ description: 'Item A', qty: 2, rate: 100, is_taxable: true }, { description: 'Item B', qty: 1, rate: 50, is_taxable: false }],
};
// Strip identity/time fields that legitimately differ between the two databases.
function norm(inv) {
  const { id, invoice_no, ...rest } = inv;
  rest.line_items = (rest.line_items || []).map(({ id, ...l }) => l);
  rest.payments = (rest.payments || []).map(({ id, ...p }) => p);
  return rest;
}

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const [lc, nc] = await Promise.all([send(LARAVEL, lj, 'POST', '/api/invoices', PAYLOAD), send(NEST, nj, 'POST', '/api/invoices', PAYLOAD)]);
  let failures = 0;
  console.log('POST status:', lc.status, 'vs', nc.status);
  if (lc.status !== nc.status) failures++;
  const la = norm(lc.body), na = norm(nc.body);
  const ok = JSON.stringify(la) === JSON.stringify(na);
  if (!ok) { failures++; const keys = new Set([...Object.keys(la), ...Object.keys(na)]); for (const k of keys) if (JSON.stringify(la[k]) !== JSON.stringify(na[k])) { console.log(`  key "${k}": laravel=${JSON.stringify(la[k])?.slice(0, 150)} nest=${JSON.stringify(na[k])?.slice(0, 150)}`); } }
  console.log(ok ? 'PASS  invoice detail (computed totals/mapped fields identical)' : 'FAIL  invoice detail differs');
  console.log('  totals:', JSON.stringify({ sub_total: lc.body.sub_total, tax_total: lc.body.tax_total, total: lc.body.total, balance_due: lc.body.balance_due, status: lc.body.status }));

  // cleanup: soft-delete both
  await Promise.all([send(LARAVEL, lj, 'DELETE', '/api/invoices/' + lc.body.id, { reason: 'parity test' }), send(NEST, nj, 'DELETE', '/api/invoices/' + nc.body.id, { reason: 'parity test' })]);
  console.log('  (created invoices soft-deleted)');
  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });