/**
 * Phase 5 verification — Export & Download Centre.
 * Queues real background jobs, waits for them, downloads the produced files, and checks
 * status tracking, the audit log, secure links, expiry and duplicate prevention.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs/promises');
const path = require('path');
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const EXPORT_ROOT = path.join(process.cwd(), '..', 'storage', 'app', 'exports');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const jar = {};
const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } });
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify(b ?? {}) });
const del = (p) => fetch(BASE + p, { method: 'DELETE', headers: { ...H, 'X-XSRF-TOKEN': X(), Cookie: ch() } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll a job until it leaves Queued/Processing. */
async function settle(exportId, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    const j = await (await get(`/api/export-centre/job/${exportId}`)).json();
    if (!['Queued', 'Processing'].includes(j.status)) return j;
    if (Date.now() - started > timeoutMs) throw new Error(`job ${exportId} stuck in ${j.status}`);
    await sleep(250);
  }
}

(async () => {
  const prisma = new PrismaClient();
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }) }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exit(1); }

  const txns = await prisma.transactions.findMany({ where: { deleted_at: null }, select: { id: true } });
  const ids = txns.map((t) => t.id);
  const created = [];

  // ---- queueing ------------------------------------------------------------
  console.log('--- queueing a background job ---');
  const qr = await post('/api/export-centre/queue/transaction-data-xlsx', { transaction_ids: ids });
  ok(qr.status === 202, `queue returns 202 Accepted immediately (${qr.status})`);
  const job = await qr.json();
  created.push(job.export_id);
  ok(!!job.export_id && /^EXP-/.test(job.export_id), `export id issued (${job.export_id})`);
  ok(job.status === 'Queued', `job starts Queued (${job.status})`);
  ok(job.transaction_count === ids.length, `selected transaction count recorded (${job.transaction_count})`);
  ok(job.download_token === null, 'no download link while the job is still queued');
  ok(job.format === 'XLSX' && job.action_type === 'transaction-data-xlsx', 'action type and format recorded');

  const done = await settle(job.export_id);
  ok(done.status === 'Completed', `job reaches Completed (${done.status})`);
  ok(!!done.started_at && !!done.completed_at, 'start and completion timestamps recorded');
  ok(done.file_size > 0, `file size recorded (${done.file_size} bytes)`);
  ok(!!done.file_name && /\.xlsx$/.test(done.file_name), `file name recorded (${done.file_name})`);
  ok(!!done.expires_at, `expiry recorded (${done.expires_at})`);
  ok(!!done.download_token, 'a download link is issued once complete');
  ok(done.download_status === 'Not Downloaded', 'download status starts as Not Downloaded');

  // the file really exists on disk
  const onDisk = await fs.stat(path.join(EXPORT_ROOT, done.file_name)).then((s) => s.size).catch(() => -1);
  ok(onDisk === done.file_size, `generated file exists on disk with the recorded size (${onDisk})`);

  // ---- download ------------------------------------------------------------
  console.log('--- secure download ---');
  const dl = await get(`/api/export-centre/download/${done.download_token}`);
  const body = Buffer.from(await dl.arrayBuffer());
  ok(dl.status === 200 && body.slice(0, 2).toString() === 'PK', `file downloads via its token (${body.length} bytes)`);
  ok(body.length === done.file_size, 'downloaded bytes match the recorded size');
  ok(/attachment; filename=/.test(String(dl.headers.get('content-disposition'))), 'served as an attachment with a filename');
  const after = await (await get(`/api/export-centre/job/${done.export_id}`)).json();
  ok(after.download_status === 'Downloaded' && after.download_count === 1, 'download is tracked (status + count)');
  ok(!!after.downloaded_at, 'download timestamp recorded');
  await get(`/api/export-centre/download/${done.download_token}`);
  const after2 = await (await get(`/api/export-centre/job/${done.export_id}`)).json();
  ok(after2.download_count === 2, 'repeat downloads are counted');

  const bad = await get('/api/export-centre/download/' + 'f'.repeat(48));
  ok(bad.status === 404, 'an unknown token cannot reach any file (404)');

  // ---- duplicate prevention ------------------------------------------------
  console.log('--- duplicate request prevention ---');
  const d1 = await post('/api/export-centre/queue/documents-zip', { transaction_ids: ids });
  const j1 = await d1.json();
  created.push(j1.export_id);
  const d2 = await post('/api/export-centre/queue/documents-zip', { transaction_ids: ids });
  const j2 = await d2.json();
  ok(d2.status === 400 && /already (queued|processing)/i.test(j2.message ?? ''), `an identical in-flight request is refused: ${j2.message ?? d2.status}`);
  const zipJob = await settle(j1.export_id);
  // a different selection is NOT a duplicate
  const d3 = await post('/api/export-centre/queue/documents-zip', { transaction_ids: ids.slice(0, 2) });
  ok(d3.status === 202, 'a different selection queues normally');
  const j3 = await d3.json();
  created.push(j3.export_id);
  await settle(j3.export_id);

  // ---- partial completion --------------------------------------------------
  console.log('--- status honesty ---');
  ok(zipJob.status === 'Partially Completed', `a ZIP with unavailable files reports "${zipJob.status}"`);
  ok(zipJob.skipped_count > 0, `skipped file count recorded (${zipJob.skipped_count})`);
  ok(zipJob.document_count >= 0, `included document count recorded (${zipJob.document_count})`);
  const zdl = await get(`/api/export-centre/download/${zipJob.download_token}`);
  const zbuf = Buffer.from(await zdl.arrayBuffer());
  ok(zdl.status === 200 && zbuf.slice(0, 2).toString() === 'PK', `the partially-completed ZIP still downloads (${zbuf.length} bytes)`);

  // ---- all formats ---------------------------------------------------------
  console.log('--- every export type ---');
  for (const [action, magic] of [['transaction-data-pdf', '%PDF'], ['transaction-pdf-zip', 'PK']]) {
    const r = await post(`/api/export-centre/queue/${action}`, { transaction_ids: ids.slice(0, 3) });
    ok(r.status === 202, `${action} queued`);
    const j = await r.json();
    created.push(j.export_id);
    const f = await settle(j.export_id);
    ok(['Completed', 'Partially Completed'].includes(f.status), `${action} completed (${f.status})`);
    const b = Buffer.from(await (await get(`/api/export-centre/download/${f.download_token}`)).arrayBuffer());
    ok(b.slice(0, magic.length).toString() === magic, `${action} produced a valid ${magic === 'PK' ? 'ZIP' : 'PDF'} (${b.length} bytes)`);
  }

  // ---- validation ----------------------------------------------------------
  console.log('--- validation ---');
  ok((await post('/api/export-centre/queue/nonsense-type', { transaction_ids: ids })).status === 400, 'unknown export type rejected');
  ok((await post('/api/export-centre/queue/transaction-data-xlsx', { transaction_ids: [] })).status === 400, 'empty selection rejected before queueing');
  ok((await post('/api/export-centre/queue/transaction-data-xlsx', { transaction_ids: [999999] })).status === 404, 'unknown transaction rejected before queueing');

  // ---- history / audit log -------------------------------------------------
  console.log('--- export history (audit log) ---');
  const hist = await (await get('/api/export-centre')).json();
  ok(Array.isArray(hist) && hist.length >= created.length, `history lists every export (${hist.length})`);
  const h = hist.find((x) => x.export_id === done.export_id);
  for (const field of ['export_id', 'action_type', 'format', 'status', 'transaction_count', 'requested_by', 'requested_at', 'completed_at', 'file_size', 'expires_at', 'download_status', 'downloaded_at']) {
    ok(h[field] !== undefined && h[field] !== null, `history records ${field}`);
  }
  ok(Array.isArray(h.filters) && h.filters.length > 0, 'history records the applied filters');
  ok(hist[0].requested_at >= hist[hist.length - 1].requested_at, 'history is newest-first');
  const failedOnes = hist.filter((x) => x.status === 'Failed');
  ok(failedOnes.every((x) => !!x.failure_reason), 'any failed export records why');

  // ---- expiry --------------------------------------------------------------
  console.log('--- expiring links ---');
  const er = await post('/api/export-centre/queue/transaction-data-xlsx', { transaction_ids: ids.slice(0, 1), expiry_hours: 1 });
  const ej = await er.json();
  created.push(ej.export_id);
  const eDone = await settle(ej.export_id);
  const eFile = path.join(EXPORT_ROOT, eDone.file_name);
  ok(await fs.access(eFile).then(() => true).catch(() => false), 'generated file present before expiry');
  // force it into the past, then sweep
  await prisma.export_jobs.update({ where: { export_id: ej.export_id }, data: { expires_at: new Date(Date.now() - 60_000) } });
  const swept = await (await post('/api/export-centre/sweep')).json();
  ok(swept.swept >= 1, `sweep removed ${swept.swept} expired export(s)`);
  ok(!(await fs.access(eFile).then(() => true).catch(() => false)), 'the expired file is deleted from disk');
  const eAfter = await (await get(`/api/export-centre/job/${ej.export_id}`)).json();
  ok(eAfter.status === 'Expired' && eAfter.download_token === null, 'expired job reports Expired and offers no link');
  const eDl = await get(`/api/export-centre/download/${eDone.download_token}`);
  ok(eDl.status === 400 || eDl.status === 404, `an expired link no longer downloads (${eDl.status})`);
  ok(/expired|no longer available/i.test((await eDl.json()).message ?? ''), 'expired link explains why');

  // ---- deletion ------------------------------------------------------------
  console.log('--- deleting generated files ---');
  const target = hist.find((x) => x.status === 'Completed' && x.export_id !== ej.export_id);
  if (target) {
    const dr = await del(`/api/export-centre/${target.export_id}`);
    ok(dr.status === 200, 'an admin can delete a generated export');
    const gone = await (await get(`/api/export-centre/job/${target.export_id}`)).json();
    ok(gone.status === 'Expired', 'the deleted export is marked Expired');
    ok(!(await fs.access(path.join(EXPORT_ROOT, target.file_name)).then(() => true).catch(() => false)), 'its file is removed from disk');
  } else { ok(true, '(no completed export available to delete — skipped)'); }
  ok((await del('/api/export-centre/EXP-DOES-NOT-EXIST')).status === 404, 'deleting an unknown export → 404');

  // ---- cleanup -------------------------------------------------------------
  const rows = await prisma.export_jobs.findMany({ where: { export_id: { in: created } }, select: { file_name: true } });
  for (const r of rows) if (r.file_name) await fs.rm(path.join(EXPORT_ROOT, r.file_name), { force: true }).catch(() => {});
  await prisma.export_jobs.deleteMany({ where: { export_id: { in: created } } });
  console.log(`(cleaned up ${created.length} export job(s) and their files)`);

  await prisma.$disconnect();
  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
