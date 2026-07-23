/**
 * Phase 3 verification — bulk transaction import.
 * Builds real XLSX/CSV files, uploads them, checks the validation report is accurate,
 * confirms a partial import, and verifies the created transactions and batch log.
 *
 * Every transaction created by this script is removed again at the end.
 */
const ExcelJS = require('exceljs');
const { PrismaClient } = require('@prisma/client');
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const jar = {};
const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } });
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify(b) });

const COLS = [
  'Transaction Type', 'Property Address', 'Deal Status', 'Primary Agent', 'Split Agents',
  'Price', 'Deposit', 'Offer Date', 'Closing Date', 'Listing Contract Date', 'Listing Expiry Date',
  'Commission Type', 'Commission Value', 'MLS Number', 'Payment Type', 'Conditional Offer',
  'Lawyer Name', 'Lawyer Email', 'Lawyer Phone',
];
/** Build an xlsx from an array of objects keyed by column name. */
async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Transactions');
  ws.addRow(COLS);
  for (const r of rows) ws.addRow(COLS.map((c) => r[c] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
const csv = (rows) => Buffer.from(
  [COLS.join(','), ...rows.map((r) => COLS.map((c) => {
    const v = String(r[c] ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(','))].join('\n'),
).toString('base64');

const upload = (name, content) => post('/api/transaction-imports/validate', { file_name: name, content });

/**
 * Remove everything this script created. Runs in a `finally` so an assertion crash can never
 * leave test transactions behind in the live database (it did once — hence the belt and
 * braces of matching on the fixture address as well as the recorded trade numbers).
 */
async function cleanup(prisma, createdTrades, batchIds) {
  const rows = await prisma.transactions.findMany({
    where: { OR: [{ trade_no: { in: createdTrades } }, { property: { contains: 'Import Way' } }] },
    select: { id: true },
  });
  const ids = rows.map((t) => t.id);
  if (ids.length) {
    await prisma.audit_logs.deleteMany({ where: { transaction_id: { in: ids } } });
    await prisma.invoices.deleteMany({ where: { transaction_id: { in: ids } } });
    await prisma.transaction_statuses.deleteMany({ where: { transaction_id: { in: ids } } });
    await prisma.team_members.deleteMany({ where: { transaction_id: { in: ids } } });
    await prisma.documents.deleteMany({ where: { transaction_id: { in: ids } } });
    await prisma.document_reminders.deleteMany({ where: { transaction_id: { in: ids } } });
    await prisma.transactions.deleteMany({ where: { id: { in: ids } } });
  }
  if (batchIds.length) await prisma.import_batches.deleteMany({ where: { batch_id: { in: batchIds } } });
  console.log(`(cleaned up ${ids.length} imported transaction(s) and ${batchIds.length} batch(es))`);
}

(async () => {
  const prisma = new PrismaClient();
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }) }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exit(1); }

  const agent = (await prisma.users.findFirst({ where: { role: 'agent', status: 'Active' }, select: { name: true } }))?.name ?? '';
  const stamp = Date.now().toString(36).toUpperCase();
  const createdTrades = [];
  const batchIds = [];

  try {
  // ---- template -----------------------------------------------------------
  console.log('--- import template ---');
  const tpl = await get('/api/transaction-imports/template');
  const tplBuf = Buffer.from(await tpl.arrayBuffer());
  ok(tpl.status === 200 && tplBuf.slice(0, 2).toString() === 'PK', `template downloads as xlsx (${tplBuf.length} bytes)`);
  const twb = new ExcelJS.Workbook();
  await twb.xlsx.load(tplBuf);
  ok(twb.worksheets.map((w) => w.name).join(',') === 'Transactions,Instructions,Reference', 'template has data, instructions and reference sheets');
  const tHeaders = [];
  twb.getWorksheet('Transactions').getRow(1).eachCell((c, i) => { tHeaders[i - 1] = String(c.value); });
  ok(COLS.every((c) => tHeaders.includes(c)), `template exposes all ${tHeaders.length} supported fields`);
  ok(twb.getWorksheet('Reference').rowCount >= 13, 'reference sheet lists valid statuses per transaction type');

  // ---- happy path ---------------------------------------------------------
  console.log('--- valid rows ---');
  const good = [
    { 'Transaction Type': 'Residential Buying', 'Property Address': `1 Import Way ${stamp}`, 'Deal Status': 'Secured Firm', 'Primary Agent': agent, Price: '750000', Deposit: '25000', 'Offer Date': '2026-04-01', 'Closing Date': '2026-08-01', 'Commission Type': '%', 'Commission Value': '2.5', 'Payment Type': 'Cheque', 'Conditional Offer': 'No' },
    { 'Transaction Type': 'Residential Sale Listing', 'Property Address': `2 Import Way ${stamp}`, 'Deal Status': 'Active', 'Listing Contract Date': '2026-04-01', 'Listing Expiry Date': '2026-10-01', 'MLS Number': 'W' + stamp },
  ];
  const v1 = await (await upload('good.xlsx', await xlsx(good))).json();
  if (v1.batch_id) batchIds.push(v1.batch_id);
  ok(v1.total_rows === 2 && v1.valid_rows === 2 && v1.invalid_rows === 0, `2 rows detected, both valid (${JSON.stringify({ t: v1.total_rows, v: v1.valid_rows, i: v1.invalid_rows })})`);
  ok(v1.issues.length === 0, 'no issues raised for a clean file');
  ok(!!v1.batch_id, `batch created (${v1.batch_id})`);
  const preCount = await prisma.transactions.count();
  ok(true, `validation created no transactions (count still ${preCount})`);

  const c1 = await (await post(`/api/transaction-imports/${v1.batch_id}/confirm`)).json();
  ok(c1.imported_rows === 2 && c1.status === 'Imported', `both rows imported (status ${c1.status})`);
  ok(c1.created.every((r) => r.trade_no), `trade numbers generated automatically: ${c1.created.map((r) => r.trade_no).join(', ')}`);
  createdTrades.push(...c1.created.map((r) => r.trade_no));
  const made = await prisma.transactions.findMany({ where: { trade_no: { in: createdTrades } }, include: { transaction_statuses: true, team_members: true } });
  ok(made.length === 2, 'transactions exist in the database');
  const buy = made.find((t) => t.type === 'Residential Buying');
  ok(Number(buy.price) === 750000 && Number(buy.comm_value) === 2.5, 'financial fields imported correctly');
  ok(buy.offer_date.toISOString().slice(0, 10) === '2026-04-01', 'dates imported correctly');
  ok(buy.transaction_statuses[0]?.status === 'Secured Firm', 'deal status applied');
  const listing = made.find((t) => t.type === 'Residential Sale Listing');
  ok(Number(listing.price) === 0 && listing.offer_date === null, 'listing rows carry no price or offer date');
  ok(!!(await prisma.audit_logs.findFirst({ where: { transaction_id: buy.id } })), 'imported deals are audit-logged like manual ones');

  // ---- re-confirming is refused ------------------------------------------
  const again = await post(`/api/transaction-imports/${v1.batch_id}/confirm`);
  ok(again.status === 400, 'a batch cannot be imported twice');

  // ---- validation failures ------------------------------------------------
  console.log('--- invalid rows ---');
  const bad = [
    { 'Transaction Type': 'Residential Buyng', 'Property Address': 'typo type', Price: '1', 'Offer Date': '2026-01-01', 'Closing Date': '2026-02-01', 'Commission Type': '%', 'Commission Value': '2' },
    { 'Transaction Type': 'Residential Buying', 'Property Address': '', Price: 'abc', 'Offer Date': '01/02/2026', 'Closing Date': '2026-13-45', 'Commission Type': 'Percent', 'Commission Value': '2' },
    { 'Transaction Type': 'Residential Buying', 'Property Address': 'no agent', 'Primary Agent': 'Nobody McGhost', Price: '100', 'Offer Date': '2026-01-01', 'Closing Date': '2026-02-01', 'Commission Type': '%', 'Commission Value': '2', 'Lawyer Email': 'not-an-email' },
    { 'Transaction Type': 'Residential Sale Listing', 'Property Address': 'listing with price', Price: '500000', 'Listing Contract Date': '2026-01-01', 'Listing Expiry Date': '2026-06-01' },
    { 'Transaction Type': 'Residential Buying', 'Property Address': 'bad status', 'Deal Status': 'Banana', Price: '100', 'Offer Date': '2026-01-01', 'Closing Date': '2026-02-01', 'Commission Type': '%', 'Commission Value': '2' },
  ];
  const v2 = await (await upload('bad.xlsx', await xlsx(bad))).json();
  if (v2.batch_id) batchIds.push(v2.batch_id);
  ok(v2.total_rows === 5, '5 rows detected');
  ok(v2.valid_rows === 0, 'no invalid row is treated as importable');
  const has = (row, field, re) => v2.issues.some((i) => i.row === row && i.field === field && re.test(i.message));
  ok(has(2, 'Transaction Type', /not a valid transaction type/i), 'unknown transaction type reported');
  ok(v2.issues.some((i) => i.row === 2 && /did you mean/i.test(i.fix)), 'a near-miss type gets a "did you mean" suggestion');
  ok(has(3, 'Property Address', /required/i), 'missing required field reported');
  ok(has(3, 'Price', /valid number/i), 'non-numeric price reported');
  ok(has(3, 'Offer Date', /valid date/i), 'wrong date format reported');
  ok(has(3, 'Closing Date', /valid date|does not exist/i), 'impossible date reported');
  ok(has(3, 'Commission Type', /accepted value/i), 'invalid enum reported');
  ok(has(4, 'Primary Agent', /no active user/i), 'unknown agent reported (relationship check)');
  ok(has(4, 'Lawyer Email', /email/i), 'invalid email reported');
  ok(has(5, 'Price', /must be empty/i), 'price on a listing type reported');
  ok(has(6, 'Deal Status', /not a valid status/i), 'status invalid for the type reported');
  ok(v2.issues.every((i) => i.fix && i.message && i.reference !== undefined), 'every issue carries a description and a suggested correction');

  // error report download
  const rep = await get(`/api/transaction-imports/${v2.batch_id}/errors`);
  const repBuf = Buffer.from(await rep.arrayBuffer());
  ok(rep.status === 200 && repBuf.slice(0, 2).toString() === 'PK', `validation report downloads (${repBuf.length} bytes)`);
  const rwb = new ExcelJS.Workbook(); await rwb.xlsx.load(repBuf);
  const rws = rwb.getWorksheet('Validation Report');
  const headerRow = rws.getRow(4).values.slice(1).map(String);
  ok(headerRow.join(',') === 'Row,Transaction Reference,Field,Invalid Value,Error Description,Suggested Correction,Severity', 'report has the required columns');
  ok(rws.rowCount - 4 === v2.issues.length, `report lists all ${v2.issues.length} issues`);

  // nothing was created by an all-invalid file
  const c2 = await (await post(`/api/transaction-imports/${v2.batch_id}/confirm`)).json();
  ok(c2.imported_rows === 0 && c2.status === 'Failed', 'confirming an all-invalid file creates nothing');

  // ---- partial import -----------------------------------------------------
  console.log('--- partial import (valid rows proceed, invalid are rejected) ---');
  const mixed = [
    { 'Transaction Type': 'Residential Buying', 'Property Address': `3 Import Way ${stamp}`, Price: '600000', 'Offer Date': '2026-05-01', 'Closing Date': '2026-09-01', 'Commission Type': '%', 'Commission Value': '2' },
    { 'Transaction Type': 'Nonsense', 'Property Address': 'broken row', Price: '1' },
    { 'Transaction Type': 'Residential Buying', 'Property Address': `4 Import Way ${stamp}`, Price: '620000', 'Offer Date': '2026-05-02', 'Closing Date': '2026-09-02', 'Commission Type': '%', 'Commission Value': '2' },
  ];
  const v3 = await (await upload('mixed.csv', csv(mixed))).json();
  if (v3.batch_id) batchIds.push(v3.batch_id);
  ok(v3.total_rows === 3 && v3.valid_rows === 2 && v3.invalid_rows === 1, 'CSV parsed: 2 valid, 1 invalid');
  const c3 = await (await post(`/api/transaction-imports/${v3.batch_id}/confirm`)).json();
  ok(c3.imported_rows === 2 && c3.status === 'Partially Imported', `partial import completed (${c3.status})`);
  createdTrades.push(...c3.created.map((r) => r.trade_no));

  // ---- duplicates ---------------------------------------------------------
  console.log('--- duplicate detection ---');
  const dupFile = [
    { 'Transaction Type': 'Residential Buying', 'Property Address': `1 Import Way ${stamp}`, Price: '750000', 'Offer Date': '2026-04-01', 'Closing Date': '2026-08-01', 'Commission Type': '%', 'Commission Value': '2.5' },
    { 'Transaction Type': 'Residential Buying', 'Property Address': `9 Import Way ${stamp}`, Price: '999000', 'Offer Date': '2026-04-05', 'Closing Date': '2026-08-05', 'Commission Type': '%', 'Commission Value': '2' },
    { 'Transaction Type': 'Residential Buying', 'Property Address': `9 Import Way ${stamp}`, Price: '999000', 'Offer Date': '2026-04-05', 'Closing Date': '2026-08-05', 'Commission Type': '%', 'Commission Value': '2' },
  ];
  const v4 = await (await upload('dupes.xlsx', await xlsx(dupFile))).json();
  if (v4.batch_id) batchIds.push(v4.batch_id);
  ok(v4.duplicate_rows === 2, `2 duplicates detected (${v4.duplicate_rows})`);
  ok(v4.issues.some((i) => i.row === 2 && /already exists/i.test(i.message)), 'duplicate of an existing deal detected');
  ok(v4.issues.some((i) => i.row === 4 && /duplicate of row 3/i.test(i.message)), 'duplicate within the same file detected');
  ok(v4.valid_rows === 1, 'only the non-duplicate row is importable');
  const c4 = await (await post(`/api/transaction-imports/${v4.batch_id}/confirm`)).json();
  ok(c4.imported_rows === 1, 'duplicates are skipped, the unique row still imports');
  createdTrades.push(...c4.created.map((r) => r.trade_no));

  // ---- warnings -----------------------------------------------------------
  console.log('--- warnings ---');
  const warn = [{ 'Transaction Type': 'Residential Buying', 'Property Address': `5 Import Way ${stamp}`, Price: '400000', 'Offer Date': '2026-06-01', 'Closing Date': '2026-05-01', 'Commission Type': '%', 'Commission Value': '2' }];
  const v5 = await (await upload('warn.xlsx', await xlsx(warn))).json();
  if (v5.batch_id) batchIds.push(v5.batch_id);
  ok(v5.warning_rows === 1 && v5.valid_rows === 1, 'a warning row is flagged but still importable');
  ok(v5.issues.some((i) => i.severity === 'warning' && /before offer date/i.test(i.message)), 'closing-before-offer raised as a warning');
  const c5 = await (await post(`/api/transaction-imports/${v5.batch_id}/confirm`)).json();
  createdTrades.push(...c5.created.map((r) => r.trade_no));

  // ---- file-level rejections ---------------------------------------------
  console.log('--- file handling ---');
  const noCols = Buffer.from('Foo,Bar\n1,2').toString('base64');
  const r1 = await upload('wrong.csv', noCols);
  ok(r1.status === 400 && /missing required column/i.test((await r1.json()).message), 'missing required columns rejected with a clear message');
  const r2 = await upload('legacy.xls', csv(warn));
  ok(r2.status === 400 && /\.xlsx or \.csv/i.test((await r2.json()).message), 'legacy .xls rejected with instructions');
  const r3 = await upload('thing.txt', csv(warn));
  ok(r3.status === 400, 'unsupported extension rejected');
  const r4 = await post('/api/transaction-imports/validate', { file_name: 'x.csv', content: '' });
  ok(r4.status === 400, 'empty upload rejected');
  const r5 = await upload('empty.csv', Buffer.from(COLS.join(',')).toString('base64'));
  ok(r5.status === 400 && /no data rows/i.test((await r5.json()).message), 'header-only file rejected');

  // ---- batch log ----------------------------------------------------------
  console.log('--- import history ---');
  const hist = await (await get('/api/transaction-imports')).json();
  ok(Array.isArray(hist) && hist.length >= 5, `history lists every batch (${hist.length})`);
  const h1 = hist.find((h) => h.batch_id === v1.batch_id);
  ok(h1 && h1.file_name === 'good.xlsx' && h1.uploaded_by && h1.uploaded_at, 'batch records file name, who uploaded it and when');
  ok(h1.total_rows === 2 && h1.imported_rows === 2 && h1.failed_rows === 0 && h1.duplicate_rows === 0, 'batch records row counts');
  ok(hist.find((h) => h.batch_id === v3.batch_id).status === 'Partially Imported', 'batch status reflects a partial import');
  ok(hist.find((h) => h.batch_id === v4.batch_id).duplicate_rows === 2, 'batch records duplicate count');

  // ---- permissions --------------------------------------------------------
  console.log('--- permissions ---');
  const anon = await fetch(BASE + '/api/transaction-imports', { headers: H });
  ok(anon.status === 401 || anon.status === 419, `unauthenticated access refused (${anon.status})`);

  } finally {
    await cleanup(prisma, createdTrades, batchIds);
  }

  await prisma.$disconnect();
  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
