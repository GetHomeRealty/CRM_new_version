// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Golden parity for transaction CREATE: create identically on both, diff the resulting
 *  show() (stripping volatile ids/trade_no/timestamps), then soft-delete both. */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const send = (base, jar, method, path, body) => fetch(base + path, { method, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

const PAYLOAD = { type: 'Residential Buying', property: 'PARITY-TEST STORE', status: 'Secured Firm', comm_type: '%', comm_value: '2.5', price: '500000', deposit: '25000', offer_date: '2026-07-01', closing_date: '2026-08-01' };

// Strip fields that legitimately differ between DBs (ids, trade_no, timestamps, generated invoice identity).
function norm(d) {
  const { id, trade_no, created_at, ...rest } = d;
  delete rest.unread_messages;
  if (Array.isArray(rest.audit_logs)) rest.audit_logs = rest.audit_logs.map(({ id, stamp, ...a }) => a);
  if (Array.isArray(rest.invoices)) rest.invoices = rest.invoices.map(({ id, invoice_no, ...i }) => i);
  return rest;
}

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const [lc, nc] = await Promise.all([send(LARAVEL, lj, 'POST', '/api/transactions', PAYLOAD), send(NEST, nj, 'POST', '/api/transactions', PAYLOAD)]);
  let failures = 0;
  console.log('POST status:', lc.status, 'vs', nc.status);
  if (lc.status !== nc.status) failures++;
  const ld = lc.body.data || lc.body, nd = nc.body.data || nc.body;
  // The two DBs have drifted by one trade number (Laravel MySQL is ahead of the Postgres
  // snapshot); scrub trade_no-derived strings (GHR-00x invoice numbers, "Trade #00x" audit
  // details) so the comparison isolates real serialization differences.
  const scrub = (o, tn) => JSON.parse(JSON.stringify(o).split('GHR-' + tn).join('GHR-#').split('Trade #' + tn).join('Trade #'));
  const la = scrub(norm(ld), ld.trade_no), na = scrub(norm(nd), nd.trade_no);
  const ok = JSON.stringify(la) === JSON.stringify(na);
  if (!ok) { failures++; const keys = new Set([...Object.keys(la), ...Object.keys(na)]); for (const k of keys) if (JSON.stringify(la[k]) !== JSON.stringify(na[k])) { console.log(`  key "${k}":`); console.log('    laravel:', JSON.stringify(la[k])?.slice(0, 250)); console.log('    nest   :', JSON.stringify(na[k])?.slice(0, 250)); } }
  console.log(ok ? 'PASS  created transaction show identical (incl. commission + auto-invoice)' : 'FAIL  differs');
  console.log('  trade_no:', ld.trade_no, '/', nd.trade_no, '| invoices:', (ld.invoices || []).length, '/', (nd.invoices || []).length, '| commission.total:', ld.commission?.total);

  await Promise.all([send(LARAVEL, lj, 'DELETE', '/api/transactions/' + ld.id), send(NEST, nj, 'DELETE', '/api/transactions/' + nd.id)]);
  console.log('  (created transactions soft-deleted)');
  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });