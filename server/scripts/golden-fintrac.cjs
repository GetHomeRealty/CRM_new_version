// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Golden parity for FINTRAC Form 630 (ClientIdentification). Verifies the Laravel Encrypter
 *  port by diffing `show` (decrypted PII) on the 2 real encrypted records, plus an update
 *  round-trip (encrypt→store→decrypt→present) restored afterward, and extract validation. */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const send = (base, jar, method, path, body) => fetch(base + path, { method, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (base, jar, path) => send(base, jar, 'GET', path);

let failures = 0;
const eq = (m, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { console.log('  PASS ' + m); return true; } failures++; console.log('  FAIL ' + m); console.log('    laravel:', JSON.stringify(a)?.slice(0, 360)); console.log('    nest   :', JSON.stringify(b)?.slice(0, 360)); return false; };

const RECS = [{ txn: 97, client: 'Akhilesh Marpina' }, { txn: 104, client: 'kkarthik p' }];

async function main() {
  const [lj, nj] = await Promise.all([session(LARAVEL), session(NEST)]);

  console.log('--- show (decrypt existing encrypted PII) ---');
  for (const r of RECS) {
    const q = `/api/transactions/${r.txn}/identifications?client_name=${encodeURIComponent(r.client)}`;
    const [l, n] = await Promise.all([get(LARAVEL, lj, q), get(NEST, nj, q)]);
    eq(`show txn ${r.txn} / ${r.client}`, l.body, n.body);
  }

  console.log('--- update round-trip (encrypt→store→decrypt), restored after ---');
  const target = RECS[0];
  // capture original decrypted values to restore
  const orig = (await get(LARAVEL, lj, `/api/transactions/${target.txn}/identifications?client_name=${encodeURIComponent(target.client)}`)).body;
  const upd = { client_name: target.client, full_legal_name: 'PARITY TEST NAME', address: '1 Parity St', dob: '1990-01-01', occupation: 'Tester', id_type: "Driver's Licence", id_number: 'D1234', issuing_jurisdiction: 'ON', country: 'Canada', expiry_date: '2030-01-01', verified: true };
  const [lu, nu] = await Promise.all([send(LARAVEL, lj, 'PUT', `/api/transactions/${target.txn}/identifications`, upd), send(NEST, nj, 'PUT', `/api/transactions/${target.txn}/identifications`, upd)]);
  eq('update response', lu.body, nu.body);

  // Verify Nest-written ciphertext is Laravel-decryptable: re-show on LARAVEL after NEST wrote... not possible (separate DBs).
  // Instead: re-show on each side and confirm both still match (round-trips through each own crypt).
  const [ls, ns] = await Promise.all([get(LARAVEL, lj, `/api/transactions/${target.txn}/identifications?client_name=${encodeURIComponent(target.client)}`), get(NEST, nj, `/api/transactions/${target.txn}/identifications?client_name=${encodeURIComponent(target.client)}`)]);
  eq('re-show after update (both decrypt their own ciphertext)', ls.body, ns.body);

  // restore originals on both
  const restore = { client_name: target.client, verified: orig.verified };
  for (const f of ['full_legal_name', 'address', 'dob', 'occupation', 'id_type', 'id_number', 'issuing_jurisdiction', 'country', 'expiry_date']) restore[f] = orig[f];
  await Promise.all([send(LARAVEL, lj, 'PUT', `/api/transactions/${target.txn}/identifications`, restore), send(NEST, nj, 'PUT', `/api/transactions/${target.txn}/identifications`, restore)]);
  console.log('  (original FINTRAC values restored on both)');

  console.log('--- extract validation (missing file → 422) ---');
  // Use a document id that has no client file — expect 422 {ok:false,message} (compare message only; abort adds debug trace on Laravel)
  const docs = await get(LARAVEL, lj, `/api/transactions/${target.txn}/documents`);
  const anyDoc = docs.body.documents[0];
  const body = { client_name: 'NOBODY PARITY', document_id: anyDoc ? anyDoc.id : 1 };
  const [le, ne] = await Promise.all([send(LARAVEL, lj, 'POST', `/api/transactions/${target.txn}/identifications/extract`, body), send(NEST, nj, 'POST', `/api/transactions/${target.txn}/identifications/extract`, body)]);
  eq('extract no-file (status+message)', { s: le.status, m: le.body.message, ok: le.body.ok }, { s: ne.status, m: ne.body.message, ok: ne.body.ok });

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });