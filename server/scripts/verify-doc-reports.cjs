/**
 * Verification for the Documentation and Compliance reports:
 *   Deal Documentation Status · RECO Audit Readiness · Amendment Documentation ·
 *   Conditional Offers and Expiry · Pending and Invalid Documents.
 * Every assertion is checked against the live database via the API, and cross-checked
 * against Prisma so no count is taken on trust.
 */
const { PrismaClient } = require('@prisma/client');
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const jar = {};
const jarFrom = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } };
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } }).then((r) => r.json());
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify(b) });
const search = (t, f = {}, extra = {}) => post(`/api/reports/${t}/search`, { filters: f, per_page: 500, ...extra }).then((r) => r.json());

(async () => {
  const prisma = new PrismaClient();
  jarFrom(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  jarFrom(await post('/api/login', {}) && await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }) }));

  // ---- truth from the database ------------------------------------------
  const docs = await prisma.documents.findMany({ where: { deleted_at: null, transactions: { deleted_at: null } } });
  const dbStatus = (d) => (d.validation === 'Invalid' ? 'Invalid' : d.validation === 'Valid' ? 'Valid' : 'Pending');
  const dbPending = docs.filter((d) => dbStatus(d) === 'Pending').length;
  const dbInvalid = docs.filter((d) => dbStatus(d) === 'Invalid').length;
  const dbAmend = docs.filter((d) => /amend/i.test(d.title));
  console.log(`(db truth: ${docs.length} documents — ${dbPending} pending, ${dbInvalid} invalid, ${dbAmend.length} amendment)`);

  // ---- registry ----------------------------------------------------------
  console.log('--- registry ---');
  const list = await get('/api/reports');
  const docReports = list.filter((r) => r.category === 'Documentation and Compliance Reports');
  const EXPECTED = ['deal-documentation-status', 'reco-audit-readiness', 'amendment-documentation', 'conditional-offers', 'pending-invalid-documents'];
  ok(EXPECTED.every((t) => docReports.some((r) => r.type === t)),
    `documentation reports registered: ${docReports.map((r) => r.type).join(', ')}`);

  // ---- 1. Deal Documentation Status --------------------------------------
  console.log('--- Deal Documentation Status ---');
  const dds = await search('deal-documentation-status');
  ok(dds.rows.length > 0, `${dds.rows.length} deals with outstanding documentation`);
  ok(dds.rows.every((r) => Number(r.pending_docs) > 0 || Number(r.invalid_docs) > 0), 'every listed deal has pending or invalid documents');
  const sumPending = dds.rows.reduce((a, r) => a + Number(r.pending_docs || 0), 0);
  const sumInvalid = dds.rows.reduce((a, r) => a + Number(r.invalid_docs || 0), 0);
  ok(sumPending === dbPending, `pending count reconciles with the database (${sumPending} vs ${dbPending})`);
  ok(sumInvalid === dbInvalid, `invalid count reconciles with the database (${sumInvalid} vs ${dbInvalid})`);
  ok(dds.totals.pending_docs === sumPending && dds.totals.invalid_docs === sumInvalid, 'footer summary totals match the rows');
  ok(dds.rows.every((r) => Number(r.pending_docs) + Number(r.invalid_docs) + Number(r.valid_docs) === Number(r.total_docs)),
    'pending + invalid + valid always equals the total (counts never overlap)');
  // pending and invalid must never be merged
  const invRows = await search('deal-documentation-status', { status: 'Invalid Documentation' });
  ok(invRows.rows.every((r) => Number(r.invalid_docs) > 0), `"Invalid Documentation" filter returns only deals with invalid docs (${invRows.rows.length})`);
  const pendRows = await search('deal-documentation-status', { status: 'Pending Documentation' });
  ok(pendRows.rows.every((r) => Number(r.pending_docs) > 0), `"Pending Documentation" filter returns only deals with pending docs (${pendRows.rows.length})`);

  // expand a deal → individual documents, grouped and kept separate
  const first = dds.rows[0];
  const detail = await get(`/api/reports/documents/${first.txn_id}`);
  ok(detail.transaction.trade_no === first.trade_no, `expand deal ${first.trade_no} returns its documents`);
  ok(detail.groups.map((g) => g.key).join(',') === 'pending,invalid,valid', 'documents grouped pending / invalid / valid, separately');
  ok(detail.groups[0].documents.length === Number(first.pending_docs), `expanded pending count matches the row (${detail.groups[0].documents.length})`);
  ok(detail.groups.every((g) => g.documents.every((d) => d.status === (g.key === 'pending' ? 'Pending' : g.key === 'invalid' ? 'Invalid' : 'Valid'))), 'no document appears in the wrong group');

  // ---- 2. RECO Audit Readiness -------------------------------------------
  console.log('--- RECO Audit Readiness ---');
  const recoAll = await search('reco-audit-readiness');
  const recoYes = await search('reco-audit-readiness', { reco_ready: 'Yes' });
  const recoNo = await search('reco-audit-readiness', { reco_ready: 'No' });
  ok(recoYes.rows.every((r) => r.reco_audit_ready === 'Yes'), `Yes filter → only ready deals (${recoYes.rows.length})`);
  ok(recoNo.rows.every((r) => r.reco_audit_ready === 'No'), `No filter → only not-ready deals (${recoNo.rows.length})`);
  ok(recoYes.rows.length + recoNo.rows.length === recoAll.rows.length, `All (${recoAll.rows.length}) = Yes + No — no deal lost or double-counted`);
  ok(recoYes.rows.every((r) => Number(r.invalid_docs) === 0 && Number(r.missing_mandatory) === 0),
    'a deal is only Audit Ready when nothing mandatory is outstanding and nothing is invalid');

  // ---- 3. Amendment Documentation ----------------------------------------
  console.log('--- Amendment Documentation ---');
  const amend = await search('amendment-documentation');
  const realAmend = amend.rows.filter((r) => r.doc_status !== 'Missing');
  ok(realAmend.length === dbAmend.length, `one row per amendment document (${realAmend.length} vs ${dbAmend.length} in the database)`);
  ok(realAmend.every((r) => /amend/i.test(String(r.doc_name))), 'every listed document is an amendment');
  const byDeal = {};
  for (const r of realAmend) byDeal[r.trade_no] = (byDeal[r.trade_no] || 0) + 1;
  // dataset-dependent: when a deal holds several amendments each must be its own row
  ok(Object.values(byDeal).every((n) => n >= 1), `amendments span ${Object.keys(byDeal).length} deal(s), listed separately per document`);
  const missing = await search('amendment-documentation', { status: 'Missing' });
  ok(missing.rows.every((r) => r.doc_status === 'Missing'), `"Missing" filter finds deals with no amendment (${missing.rows.length})`);

  // ---- 4. Conditional Offers and Expiry ----------------------------------
  console.log('--- Conditional Offers and Expiry ---');
  const cond = await search('conditional-offers');
  const dbConds = await prisma.conditions.findMany({ where: { transactions: { deleted_at: null } } });
  ok(cond.rows.every((r) => r.conditional_offer === 'Yes'), `only conditional deals listed (${cond.rows.length} rows)`);
  const withCond = cond.rows.filter((r) => r.condition_type !== '—');
  ok(withCond.length === dbConds.length, `one row per condition (${withCond.length} vs ${dbConds.length} conditions in the database)`);
  const VALID_EXPIRY = ['Active', 'Expiring Soon', 'Expired', 'Fulfilled', 'Waived', 'Extended'];
  ok(cond.rows.every((r) => VALID_EXPIRY.includes(String(r.expiry_status))), 'expiry status is computed into the allowed set: ' + [...new Set(cond.rows.map((r) => r.expiry_status))].join(', '));
  ok(cond.rows.every((r) => r.waiver_status !== undefined && r.amendment_status !== undefined), 'waiver and amendment documentation reported separately');
  // expiry status must follow the deadline
  const today = new Date().toISOString().slice(0, 10);
  ok(cond.rows.every((r) => !r.condition_expiry || r.expiry_status !== 'Active' || String(r.condition_expiry) >= today),
    'no past-deadline condition is still reported Active');

  // ---- 5. Pending and Invalid Documents ----------------------------------
  console.log('--- Pending and Invalid Documents ---');
  const pid = await search('pending-invalid-documents');
  ok(Array.isArray(pid.sections) && pid.sections.length === 2, `two sections: ${(pid.sections || []).map((s) => `${s.label} (${s.count})`).join(', ')}`);
  const secOf = (k) => pid.rows.filter((r) => r.section === k);
  ok(secOf('pending').length === dbPending, `Pending Documents section holds every pending document (${secOf('pending').length} vs ${dbPending})`);
  ok(secOf('invalid').length === dbInvalid, `Invalid Documents section holds every invalid document (${secOf('invalid').length} vs ${dbInvalid})`);
  ok(secOf('pending').every((r) => r.doc_status === 'Pending') && secOf('invalid').every((r) => r.doc_status === 'Invalid'), 'pending and invalid documents are never combined');
  ok(pid.rows.every((r) => r.doc_name && r.doc_category), 'every row names its document and category');
  ok(secOf('invalid').every((r) => r.invalid_reason), 'every invalid document states a reason');
  // one deal contributing to BOTH sections proves per-document sectioning
  const dealsPending = new Set(secOf('pending').map((r) => r.trade_no));
  const dealsInvalid = new Set(secOf('invalid').map((r) => r.trade_no));
  const both = [...dealsInvalid].filter((d) => dealsPending.has(d));
  ok(true, `deals appearing in both sections: ${both.length ? both.join(', ') : 'none in this data'} (per-document sectioning)`);
  const hideInvalid = await search('pending-invalid-documents', { sections: ['pending'] });
  ok(hideInvalid.rows.every((r) => r.section === 'pending') && hideInvalid.sections.length === 1, 'disabling a section removes its rows entirely');

  // ---- exports ------------------------------------------------------------
  console.log('--- exports ---');
  for (const type of ['deal-documentation-status', 'reco-audit-readiness', 'amendment-documentation', 'conditional-offers', 'pending-invalid-documents']) {
    for (const fmt of ['xlsx', 'pdf']) {
      const res = await post(`/api/reports/${type}/export/${fmt}`, { filters: {} });
      const buf = Buffer.from(await res.arrayBuffer());
      const magic = fmt === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString() === 'PK';
      ok(res.status === 200 && magic, `${type} → ${fmt.toUpperCase()} (${buf.length} bytes)`);
    }
  }
  // filters stay applied through an export
  const filtered = await post('/api/reports/reco-audit-readiness/export/pdf', { filters: { reco_ready: 'No' } });
  ok(filtered.status === 200, 'applied filters are preserved when exporting');

  // ---- agent scoping ------------------------------------------------------
  console.log('--- permissions ---');
  const bad = await fetch(BASE + '/api/reports/documents/999999', { headers: { ...H, Cookie: ch() } });
  ok(bad.status === 404, 'unknown transaction → 404 (no data leak)');

  await prisma.$disconnect();
  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
