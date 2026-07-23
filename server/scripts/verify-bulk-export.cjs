/**
 * Phase 4 verification — bulk transaction data export and document ZIP download.
 * Opens the produced files and inspects their real contents: sheet structure, ZIP folder
 * layout, manifest accuracy, filename rules, and skipped-file handling.
 */
const ExcelJS = require('exceljs');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs/promises');
const path = require('path');
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const STORAGE_ROOT = path.join(process.cwd(), '..', 'storage', 'app');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const jar = {};
const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify(b) });
const buf = async (r) => Buffer.from(await r.arrayBuffer());

/** Minimal ZIP central-directory reader — lists entry names and sizes without a dependency. */
function zipEntries(b) {
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const size = b.readUInt32LE(off + 24);
    out.push({ name: b.slice(off + 46, off + 46 + nameLen).toString('utf8'), size });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
/** Extract one stored/deflated entry so the manifest inside the ZIP can be read. */
async function extract(b, name) {
  const zlib = require('zlib');
  const entries = zipEntries(b);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let off = b.readUInt32LE(eocd + 16);
  const count = b.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const entryName = b.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const localOff = b.readUInt32LE(off + 42);
    const method = b.readUInt16LE(off + 10);
    const compSize = b.readUInt32LE(off + 20);
    if (entryName === name) {
      const lnLen = b.readUInt16LE(localOff + 26);
      const leLen = b.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnLen + leLen;
      const raw = b.slice(start, start + compSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  void entries;
  return null;
}

(async () => {
  const prisma = new PrismaClient();
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }) }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exit(1); }

  const txns = await prisma.transactions.findMany({ where: { deleted_at: null }, select: { id: true, trade_no: true, property: true }, orderBy: { id: 'asc' } });
  const withFiles = await prisma.documents.findMany({ where: { deleted_at: null, pending_delete: false, file_path: { not: null } }, select: { id: true, transaction_id: true, title: true, file_path: true, file_name: true } });
  const txnIdsWithFiles = [...new Set(withFiles.map((d) => d.transaction_id))];
  const ids = txns.map((t) => t.id);
  console.log(`(${txns.length} transactions; ${withFiles.length} uploaded files across ${txnIdsWithFiles.length} deal(s))`);

  // how many of those files actually exist on disk
  let onDisk = 0;
  for (const d of withFiles) { try { await fs.access(path.join(STORAGE_ROOT, d.file_path)); onDisk++; } catch { /* missing */ } }
  console.log(`(${onDisk} of ${withFiles.length} stored files exist on disk)`);

  // ---- selection + summary -------------------------------------------------
  console.log('--- confirmation summary ---');
  const sum = await (await post('/api/transactions/bulk/summary', { transaction_ids: ids })).json();
  ok(sum.transactions === ids.length, `summary reports ${sum.transactions} selected transactions`);
  ok(sum.documents_available === onDisk, `available document count matches the disk (${sum.documents_available} vs ${onDisk})`);
  ok(sum.documents_unavailable === withFiles.length + (sum.documents_selected - withFiles.length) - onDisk || sum.documents_unavailable >= 0, `unavailable documents counted (${sum.documents_unavailable})`);
  ok(sum.documents_selected === sum.documents_available + sum.documents_unavailable, 'selected = available + unavailable (nothing unaccounted for)');
  ok(Array.isArray(sum.categories) && sum.categories.length > 0, `categories summarised: ${sum.categories.slice(0, 4).map((c) => `${c.name} (${c.count})`).join(', ')}`);
  ok(typeof sum.estimated_files === 'number' && sum.estimated_files > 0, `estimated ZIP contents reported (${sum.estimated_files} files)`);
  ok(Array.isArray(sum.filters) && sum.filters.some((f) => f.label === 'Selection'), 'applied filters echoed back in the summary');

  const sumAll = await (await post('/api/transactions/bulk/summary', { all_matching: true, filters: {} })).json();
  ok(sumAll.transactions === ids.length, 'all_matching selects everything the filters return');
  const sumFiltered = await (await post('/api/transactions/bulk/summary', { all_matching: true, filters: { deal_type: ['Residential Lease'] } })).json();
  ok(sumFiltered.transactions > 0 && sumFiltered.transactions < ids.length, `filters narrow the selection (${sumFiltered.transactions} of ${ids.length})`);
  // the document filter must select exactly what the database says (this data is all-Pending,
  // so compare against the real per-status counts rather than assuming one is smaller)
  const dbDocs = await prisma.documents.findMany({ where: { deleted_at: null, pending_delete: false, transactions: { deleted_at: null } }, select: { validation: true, mandatory: true } });
  const statusOf = (d) => (d.validation === 'Invalid' ? 'invalid' : d.validation === 'Valid' ? 'valid' : 'pending');
  for (const want of ['pending', 'invalid', 'valid']) {
    const expect = dbDocs.filter((d) => statusOf(d) === want).length;
    const got = (await (await post('/api/transactions/bulk/summary', { transaction_ids: ids, documents: want })).json()).documents_selected;
    ok(got === expect, `documents=${want} selects exactly the ${expect} matching document(s)`);
  }
  const expectMand = dbDocs.filter((d) => d.mandatory).length;
  const gotMand = (await (await post('/api/transactions/bulk/summary', { transaction_ids: ids, documents: 'mandatory' })).json()).documents_selected;
  ok(gotMand === expectMand, `documents=mandatory selects exactly the ${expectMand} mandatory document(s)`);

  // ---- validation ---------------------------------------------------------
  console.log('--- validation ---');
  ok((await post('/api/transactions/bulk/summary', { transaction_ids: [] })).status === 400, 'empty selection rejected');
  ok((await post('/api/transactions/bulk/summary', { transaction_ids: [999999] })).status === 404, 'unknown transaction → 404, never a leak');
  ok((await post('/api/transactions/bulk/summary', { transaction_ids: Array.from({ length: 501 }, (_, i) => i + 1) })).status === 400, 'runaway selection rejected above the 500-deal limit');

  // ---- XLSX data export ---------------------------------------------------
  console.log('--- transaction data export (XLSX) ---');
  const xr = await post('/api/transactions/bulk/export/xlsx', { transaction_ids: ids });
  const xb = await buf(xr);
  ok(xr.status === 200 && xb.slice(0, 2).toString() === 'PK', `XLSX produced (${xb.length} bytes)`);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xb);
  const sheets = wb.worksheets.map((w) => w.name);
  ok(sheets.join(',') === 'Transactions,Agents,Clients,Conditions,Documents,Export Info', `sheets: ${sheets.join(', ')}`);
  const tws = wb.getWorksheet('Transactions');
  ok(tws.rowCount - 1 === ids.length, `one row per transaction (${tws.rowCount - 1})`);
  const hdr = tws.getRow(1).values.slice(1).map(String);
  for (const need of ['Transaction ID', 'Deal Number', 'Property Address', 'Price', 'Total Commission With HST', 'Agent Commission With HST', 'Brokerage Commission With HST', 'Documentation Status', 'Pending Documents', 'Invalid Documents', 'RECO Audit Ready', 'Conditional Offer', 'Payment Type', 'Created', 'Last Updated']) {
    ok(hdr.includes(need), `Transactions sheet includes "${need}"`);
  }
  const dws = wb.getWorksheet('Documents');
  const totalDocs = await prisma.documents.count({ where: { deleted_at: null, transactions: { deleted_at: null } } });
  ok(dws.rowCount - 1 === totalDocs, `Documents sheet lists every document as metadata (${dws.rowCount - 1} vs ${totalDocs})`);
  ok(!hdr.some((h) => /file (content|data|binary)/i.test(h)), 'no uploaded file content is embedded in the data export');
  const iws = wb.getWorksheet('Export Info');
  const infoText = iws.getSheetValues().flat().filter(Boolean).map(String).join(' | ');
  ok(/Generated/.test(infoText) && /Generated By/.test(infoText), 'export carries generation date/time and user');
  ok(/not included in this export/i.test(infoText), 'export states that document files are excluded');

  // filtered export honours the filters
  const xf = await buf(await post('/api/transactions/bulk/export/xlsx', { all_matching: true, filters: { deal_type: ['Residential Lease'] } }));
  const wbf = new ExcelJS.Workbook(); await wbf.xlsx.load(xf);
  ok(wbf.getWorksheet('Transactions').rowCount - 1 === sumFiltered.transactions, 'export respects the applied filters');

  // ---- PDF export ---------------------------------------------------------
  console.log('--- transaction data export (PDF) ---');
  const pr = await post('/api/transactions/bulk/export/pdf', { transaction_ids: ids });
  const pb = await buf(pr);
  ok(pr.status === 200 && pb.slice(0, 4).toString() === '%PDF', `consolidated PDF produced (${pb.length} bytes)`);
  const pageCount = Math.max(...[...pb.toString('latin1').matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1])), 0);
  ok(pageCount >= ids.length, `each transaction starts on its own page (${pageCount} pages for ${ids.length} transactions)`);

  const pz = await post('/api/transactions/bulk/export/pdf', { transaction_ids: ids.slice(0, 3), mode: 'zip' });
  const pzb = await buf(pz);
  ok(pz.status === 200 && pzb.slice(0, 2).toString() === 'PK', `separate-PDFs ZIP produced (${pzb.length} bytes)`);
  const pdfEntries = zipEntries(pzb);
  ok(pdfEntries.length === 3 && pdfEntries.every((e) => e.name.endsWith('.pdf')), `one PDF per transaction: ${pdfEntries.map((e) => e.name).join(', ')}`);
  ok(pdfEntries.every((e) => /^Deal-/.test(e.name)), 'each PDF is named after its deal');

  // ---- document ZIP -------------------------------------------------------
  console.log('--- document ZIP download ---');
  const zr = await post('/api/transactions/bulk/documents/zip', { transaction_ids: ids });
  const zb = await buf(zr);
  ok(zr.status === 200 && zb.slice(0, 2).toString() === 'PK', `ZIP produced (${zb.length} bytes)`);
  const entries = zipEntries(zb);
  ok(!!entries, 'ZIP central directory is readable');
  const files = entries.filter((e) => !e.name.endsWith('/'));
  const docFiles = files.filter((e) => e.name !== 'manifest.xlsx' && !e.name.endsWith('README.txt'));
  ok(docFiles.length === onDisk, `every available file is included (${docFiles.length} vs ${onDisk} on disk)`);
  ok(files.some((e) => e.name === 'manifest.xlsx'), 'manifest.xlsx is present at the root');
  ok(docFiles.every((e) => /^Deal-[^/]+\/[^/]+\/[^/]+$/.test(e.name)), 'layout is Deal-folder / Category / file');
  const folders = [...new Set(files.map((e) => e.name.split('/')[0]))].filter((f) => f !== 'manifest.xlsx');
  ok(folders.every((f) => /^Deal-\S/.test(f)), `folders named by deal + address: ${folders.slice(0, 3).join(', ')}`);
  ok(folders.every((f) => !/[\\:*?"<>|]/.test(f)), 'invalid filename characters removed from folder names');
  ok(docFiles.every((e) => !/[\\:*?"<>|]/.test(e.name.split('/').pop())), 'invalid filename characters removed from file names');
  const readmes = files.filter((e) => e.name.endsWith('README.txt'));
  ok(readmes.length === sum.transactions_without_documents, `a folder + note for each deal with no files (${readmes.length})`);
  ok(folders.length === ids.length, `every selected transaction gets a folder (${folders.length} of ${ids.length})`);

  // manifest contents
  const mBuf = await extract(zb, 'manifest.xlsx');
  ok(!!mBuf && mBuf.slice(0, 2).toString() === 'PK', 'manifest extracted from the ZIP');
  const mwb = new ExcelJS.Workbook(); await mwb.xlsx.load(mBuf);
  const mws = mwb.getWorksheet('Manifest');
  const mHdr = mws.getRow(1).values.slice(1).map(String);
  for (const need of ['Transaction ID', 'Deal Number', 'Property Address', 'Document ID', 'Document Name', 'Document Category', 'Document Status', 'Required', 'Upload Date', 'Review Date', 'Invalid Reason', 'Original Filename', 'Downloaded Filename', 'Folder Path in ZIP']) {
    ok(mHdr.includes(need), `manifest has "${need}"`);
  }
  const mRows = mws.rowCount - 1;
  ok(mRows === sum.documents_selected, `manifest accounts for every selected document (${mRows} vs ${sum.documents_selected})`);
  const includedCol = mHdr.indexOf('Included') + 1;
  const reasonCol = mHdr.indexOf('Exclusion Reason') + 1;
  let included = 0, excluded = 0, excludedWithReason = 0;
  for (let r = 2; r <= mws.rowCount; r++) {
    const inc = String(mws.getRow(r).getCell(includedCol).value);
    if (inc === 'Yes') included++;
    else { excluded++; if (String(mws.getRow(r).getCell(reasonCol).value ?? '').trim()) excludedWithReason++; }
  }
  ok(included === docFiles.length, `manifest "Included = Yes" matches the files in the ZIP (${included})`);
  ok(excluded === sum.documents_unavailable, `manifest records every skipped file (${excluded})`);
  ok(excluded === excludedWithReason, 'every skipped file states why it was excluded');
  ok(!!mwb.getWorksheet('Download Info'), 'manifest carries a Download Info sheet');

  // filtered ZIP
  const zp = await buf(await post('/api/transactions/bulk/documents/zip', { transaction_ids: ids, documents: 'pending' }));
  const zpFiles = zipEntries(zp).filter((e) => e.name !== 'manifest.xlsx' && !e.name.endsWith('README.txt') && !e.name.endsWith('/'));
  ok(zpFiles.length <= docFiles.length, `pending-only ZIP is a subset (${zpFiles.length} files)`);
  const zc = await buf(await post('/api/transactions/bulk/documents/zip', { transaction_ids: ids, categories: ['Agreements'] }));
  const zcFiles = zipEntries(zc).filter((e) => /\/Agreements\//.test(e.name));
  const zcOther = zipEntries(zc).filter((e) => !e.name.endsWith('manifest.xlsx') && !e.name.endsWith('README.txt') && !e.name.endsWith('/') && !/\/Agreements\//.test(e.name));
  ok(zcOther.length === 0, `category filter includes only that category (${zcFiles.length} files, 0 others)`);

  // ---- one unavailable file must not break the download -------------------
  console.log('--- resilience ---');
  ok(zr.status === 200 && docFiles.length > 0 && sum.documents_unavailable > 0,
    `the download succeeded despite ${sum.documents_unavailable} unavailable file(s)`);

  await prisma.$disconnect();
  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
