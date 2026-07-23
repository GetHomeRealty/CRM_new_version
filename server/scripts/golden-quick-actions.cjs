// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Golden parity for NoticeOfSale (show/save/send), DepositReceipt (send), TradeSheet (send).
 *  Deterministic JSON responses are diffed; per-request timestamps (sent_at) are normalized;
 *  shared state (notice_of_sale) is restored afterward. */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const send = (base, jar, method, path, body) => fetch(base + path, { method, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (base, jar, path) => send(base, jar, 'GET', path);

let failures = 0;
const eq = (m, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { console.log('  PASS ' + m); return true; } failures++; console.log('  FAIL ' + m); console.log('    laravel:', JSON.stringify(a)?.slice(0, 400)); console.log('    nest   :', JSON.stringify(b)?.slice(0, 400)); return false; };
const stripTs = (o) => JSON.parse(JSON.stringify(o).replace(/"sent_at":"[^"]*"/g, '"sent_at":"TS"'));

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const ltx = await get(LARAVEL, lj, '/api/transactions');
  const target = ltx.body.data.find((t) => !/PARITY|Fakestreet|RECYCLE/.test(t.property || ''));
  const id = target.id; // ids are ETL-aligned for existing rows
  console.log('target transaction #', id, '(trade', target.trade_no + ')');

  console.log('--- notice-of-sale show ---');
  const [ls, ns] = await Promise.all([get(LARAVEL, lj, `/api/transactions/${id}/notice-of-sale`), get(NEST, nj, `/api/transactions/${id}/notice-of-sale`)]);
  eq('show', ls.body, ns.body);
  const original = ls.body;

  console.log('--- notice-of-sale save ---');
  const saveBody = { buyers: ['  Jane Buyer ', ''], sellers: ['John Seller'], date: '2026-07-20', agents: {} };
  const [lsv, nsv] = await Promise.all([send(LARAVEL, lj, 'PUT', `/api/transactions/${id}/notice-of-sale`, saveBody), send(NEST, nj, 'PUT', `/api/transactions/${id}/notice-of-sale`, saveBody)]);
  eq('save (buyers trimmed/filtered, agents={})', lsv.body, nsv.body);

  console.log('--- notice-of-sale send ---');
  const [lsn, nsn] = await Promise.all([send(LARAVEL, lj, 'POST', `/api/transactions/${id}/notice-of-sale/send`, { agents: ['Nonexistent Agent'] }), send(NEST, nj, 'POST', `/api/transactions/${id}/notice-of-sale/send`, { agents: ['Nonexistent Agent'] })]);
  eq('send (sent_at stamps normalized)', stripTs(lsn.body), stripTs(nsn.body));

  // restore original notice_of_sale (buyers/sellers/date; agents map back to original)
  const restore = { buyers: original.buyers, sellers: original.sellers, date: original.date, agents: original.agents };
  await Promise.all([send(LARAVEL, lj, 'PUT', `/api/transactions/${id}/notice-of-sale`, restore), send(NEST, nj, 'PUT', `/api/transactions/${id}/notice-of-sale`, restore)]);
  console.log('  (notice-of-sale restored)');

  console.log('--- deposit-receipt send (best-effort email → deterministic {ok,email,cc}) ---');
  const [ld, nd] = await Promise.all([send(LARAVEL, lj, 'POST', `/api/transactions/${id}/deposit-receipt/send`, { email: 'buyer@example.com', cc: 'a@x.com, b@y.com' }), send(NEST, nj, 'POST', `/api/transactions/${id}/deposit-receipt/send`, { email: 'buyer@example.com', cc: 'a@x.com, b@y.com' })]);
  eq('deposit-receipt send', { s: ld.status, b: ld.body }, { s: nd.status, b: nd.body });

  console.log('--- deposit-receipt validation (missing email → 422) ---');
  const [ldv, ndv] = await Promise.all([send(LARAVEL, lj, 'POST', `/api/transactions/${id}/deposit-receipt/send`, { cc: 'x@y.com' }), send(NEST, nj, 'POST', `/api/transactions/${id}/deposit-receipt/send`, { cc: 'x@y.com' })]);
  eq('deposit-receipt missing email (422)', { s: ldv.status, b: ldv.body }, { s: ndv.status, b: ndv.body });

  // trade-sheet send success mutates trade_sheet_sent_at (no restore path) and always dispatches
  // a real email — so verify only its validation path (deterministic, non-sending). Its success
  // logic shares the same verified MailerService as deposit-receipt.
  console.log('--- trade-sheet validation (missing email → 422) ---');
  const [lt, nt] = await Promise.all([send(LARAVEL, lj, 'POST', `/api/transactions/${id}/trade-sheet/send`, { pdf: null }), send(NEST, nj, 'POST', `/api/transactions/${id}/trade-sheet/send`, { pdf: null })]);
  eq('trade-sheet missing email (422 validation)', { s: lt.status, b: lt.body }, { s: nt.status, b: nt.body });

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });