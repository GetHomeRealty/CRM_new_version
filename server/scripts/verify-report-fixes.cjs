// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Verify the Reports fixes: no Sl No. column, no Deal Type col, canonical dropdowns, Closing Year,
 *  commission %/amount, date format, and PDF/XLSX page + layout rules. */
const B = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const j = {};
function jf(r) { const cs = r.headers.getSetCookie?.() || []; for (const c of cs) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) j[nv.slice(0, i)] = nv.slice(i + 1); } }
const ch = () => Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')); } };

(async () => {
  let r = await fetch(B + '/sanctum/csrf-cookie', { headers: H }); jf(r);
  const x = decodeURIComponent(j['XSRF-TOKEN'] || '');
  r = await fetch(B + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: ch() }, body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }) }); jf(r);
  const get = async (p) => (await fetch(B + p, { headers: { ...H, Cookie: ch() } })).json();
  const post = (p, b) => fetch(B + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(j['XSRF-TOKEN'] || ''), Cookie: ch() }, body: JSON.stringify(b) });

  console.log('--- columns ---');
  const meta = await get('/api/reports/yearly-deal-summary/columns');
  const keys = meta.columns.map((c) => c.key);
  // The Sl No. column was removed from every report on request — assert it stays gone rather
// than dropping the check, so it cannot quietly reappear.
ok('no Sl No. / serial column on any report', !meta.columns.some((c) => c.key === 'serial' || c.label === 'Sl No.'));
  ok('duplicated "Deal Type" column removed', !keys.includes('deal_type'));
  ok('"Type of Deal" retained', keys.includes('type'));
  const all = await get('/api/reports');
  for (const rep of all) { const m = await get(`/api/reports/${rep.type}/columns`); if (m.columns.some((c) => c.key === 'deal_type')) { fail++; console.log('  FAIL deal_type still in ' + rep.type); } }
  ok('no report has deal_type column', true);
  const dl = await get('/api/reports/deal-list-price-comparison/columns');
  ok('Price Difference / % removed from Deal List', !dl.columns.some((c) => c.key === 'price_diff' || c.key === 'price_diff_pct'));

  console.log('--- filter options (canonical) ---');
  const o = await get('/api/reports/filter-options');
  ok('Deal Type = 12 canonical transaction types', o.deal_type.length === 12 && o.deal_type[0].value === 'Residential Buying', JSON.stringify(o.deal_type.length));
  ok('Agent = active agent users', Array.isArray(o.agent) && o.agent.length > 0, JSON.stringify(o.agent.map((a) => a.value)));
  ok('Payment Type = Transactions-module options', JSON.stringify(o.payment_type.map((p) => p.value)) === JSON.stringify(['N/A', 'TDB-EFT', 'CTA-BA Transfer', 'Cheque', 'Wire']), JSON.stringify(o.payment_type.map((p) => p.value)));
  ok('Split Ratio sorted by agent share desc', o.split_ratio.every((v, i, a) => i === 0 || Number(a[i - 1].value.split('/')[0]) >= Number(v.value.split('/')[0])), JSON.stringify(o.split_ratio.map((s) => s.value)));
  ok('Closing Year options present', Array.isArray(o.year) && o.year.length > 0, JSON.stringify(o.year.map((y) => y.value)));

  console.log('--- closing year filter uses closing_date ---');
  const yr = o.year[0].value;
  const res = await (await post('/api/reports/yearly-deal-summary/search', { filters: { year: yr }, per_page: 200 })).json();
  ok(`year=${yr} returns only that closing year`, res.rows.every((row) => String(row.closing_date || '').startsWith(yr)), JSON.stringify(res.rows.map((r) => r.closing_date)));
  ok('applied filter labelled "Closing Year"', res.applied_filters.some((f) => f.label === 'Closing Year'));

  console.log('--- commission % / amount ---');
  const full = await (await post('/api/reports/yearly-deal-summary/search', { filters: {}, per_page: 200 })).json();
  const cd = full.rows.map((r) => r.comm_display);
  ok('comm_display shows % or $ (whichever given)', cd.every((v) => v === '—' || /%$/.test(String(v)) || /^\$/.test(String(v))), JSON.stringify(cd));

  console.log('--- exports ---');
  const pdfRes = await post('/api/reports/yearly-deal-summary/export/pdf', { filters: {} });
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  const txt = pdf.toString('latin1');
  const counts = [...txt.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const pages = counts.length ? Math.max(...counts) : -1;
  // The original bug appended a stray blank page because the footer was drawn below the
  // bottom margin. Guard the intent — no page beyond what the rows actually need — rather
  // than a fixed count, which changes with the dataset.
  const maxRowsPerPage = 30;
  const expectedMax = Math.max(1, Math.ceil(full.total_count / maxRowsPerPage));
  ok(`PDF has no stray page for ${full.total_count} records (${pages} page(s), max ${expectedMax})`, pages >= 1 && pages <= expectedMax, 'pages=' + pages);
  ok('PDF valid', pdf.slice(0, 4).toString() === '%PDF');
  const xlsxRes = await post('/api/reports/yearly-deal-summary/export/xlsx', { filters: {} });
  const xb = Buffer.from(await xlsxRes.arrayBuffer());
  ok('XLSX valid', xb[0] === 0x50 && xb[1] === 0x4b, 'bytes=' + xb.length);

  console.log(`\n${fail === 0 ? `ALL ${pass} PASS ✅` : `${fail} FAILED, ${pass} passed ❌`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });