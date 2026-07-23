// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Golden parity for the Documents module: index (seed/normalize/payload), bulkUpdate add+remove,
 *  a file-upload round-trip, and send-reminders validation. Document ids can drift between the two
 *  DBs (independent auto-increment since seeding), so items are compared with id stripped. */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const send = (base, jar, method, path, body) => fetch(base + path, { method, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (base, jar, path) => send(base, jar, 'GET', path);
async function upload(base, jar, path, filename, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'application/pdf' }), filename);
  const r = await fetch(base + path, { method: 'POST', headers: { ...H, 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: fd });
  return { status: r.status, body: await r.json() };
}

let failures = 0;
const pass = (m) => console.log('  PASS ' + m);
const stripIds = (p) => ({ ...p, documents: (p.documents || []).map((d) => { const { id, ...rest } = d; return rest; }), deleted_documents: (p.deleted_documents || []).map((d) => { const { id, ...rest } = d; return rest; }) });
const eq = (m, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) return pass(m); failures++; console.log('  FAIL ' + m); const A = JSON.stringify(a), B = JSON.stringify(b); console.log('    laravel:', A?.slice(0, 400)); console.log('    nest   :', B?.slice(0, 400)); };

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);
  const [ltx, ntx] = await Promise.all([get(LARAVEL, lj, '/api/transactions'), get(NEST, nj, '/api/transactions')]);
  // pick a transaction present on both (by trade_no) that isn't one of this session's test rows
  const lIds = ltx.body.data.filter((t) => !/PARITY|Fakestreet|RECYCLE/.test(t.property || ''));
  const target = lIds[0];
  const nTarget = ntx.body.data.find((t) => t.trade_no === target.trade_no);
  console.log(`target transaction: laravel #${target.id} / nest #${nTarget.id} (trade ${target.trade_no})`);
  const lid = target.id, nid = nTarget.id;

  console.log('--- index (seed/normalize/payload) ---');
  const [li, ni] = await Promise.all([get(LARAVEL, lj, `/api/transactions/${lid}/documents`), get(NEST, nj, `/api/transactions/${nid}/documents`)]);
  eq('index payload (doc ids stripped)', stripIds(li.body), stripIds(ni.body));

  console.log('--- bulkUpdate: add a manual document ---');
  const toRows = (docs) => docs.map((d) => ({ id: d.id, title: d.title, mandatory: d.mandatory, status: d.status, validation: d.validation, drive_uploaded: d.drive_uploaded, remarks: d.remarks, reminder: d.reminder, agent_accepted: d.agent_accepted }));
  const lAdd = { documents: [...toRows(li.body.documents), { title: 'PARITY TEST DOC' }] };
  const nAdd = { documents: [...toRows(ni.body.documents), { title: 'PARITY TEST DOC' }] };
  const [lb, nb] = await Promise.all([send(LARAVEL, lj, 'PUT', `/api/transactions/${lid}/documents`, lAdd), send(NEST, nj, 'PUT', `/api/transactions/${nid}/documents`, nAdd)]);
  eq('bulkUpdate add (ids stripped)', stripIds(lb.body), stripIds(nb.body));
  const lNew = lb.body.documents.find((d) => d.title === 'PARITY TEST DOC');
  const nNew = nb.body.documents.find((d) => d.title === 'PARITY TEST DOC');

  console.log('--- uploadFile round-trip on the new doc ---');
  const [lu, nu] = await Promise.all([
    upload(LARAVEL, lj, `/api/transactions/${lid}/documents/${lNew.id}/file`, 'parity.pdf', 'PARITY-PDF-CONTENT'),
    upload(NEST, nj, `/api/transactions/${nid}/documents/${nNew.id}/file`, 'parity.pdf', 'PARITY-PDF-CONTENT'),
  ]);
  console.log('  upload status:', lu.status, 'vs', nu.status);
  eq('uploadFile payload (ids stripped)', stripIds(lu.body), stripIds(nu.body));

  console.log('--- cleanup: remove the test doc (soft-delete via bulkUpdate) ---');
  const [lc, nc] = await Promise.all([send(LARAVEL, lj, 'PUT', `/api/transactions/${lid}/documents`, { documents: toRows(li.body.documents) }), send(NEST, nj, 'PUT', `/api/transactions/${nid}/documents`, { documents: toRows(ni.body.documents) })]);
  eq('post-cleanup payload matches original index (ids stripped)', stripIds(lc.body), stripIds(ni.body));

  console.log('--- send-reminders validation (no flagged docs → 422) ---');
  // Laravel abort(422) adds exception/file/line/trace under APP_DEBUG=true (dev only); production
  // returns just {message}. Compare status + message (the production-visible shape).
  const [lr, nr] = await Promise.all([send(LARAVEL, lj, 'POST', `/api/transactions/${lid}/documents/send-reminders`), send(NEST, nj, 'POST', `/api/transactions/${nid}/documents/send-reminders`)]);
  eq('send-reminders (status+message)', { s: lr.status, m: lr.body.message }, { s: nr.status, m: nr.body.message });

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });