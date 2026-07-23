/** Reports API integration tests against the running server (filters, exports, customize,
 *  single-deal-type behaviour, footer-total integrity, sorting, pagination, edge cases). */
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const ch = (j) => Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };

async function main() {
  const jar = {};
  let r = await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar);
  const x = decodeURIComponent(jar['XSRF-TOKEN'] || '');
  r = await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: ch(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar);
  const search = (type, body) => fetch(`${BASE}/api/reports/${type}/search`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: ch(jar) }, body: JSON.stringify(body) });
  const exportReq = (type, fmt, body) => fetch(`${BASE}/api/reports/${type}/export/${fmt}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: ch(jar) }, body: JSON.stringify(body) });

  console.log('--- every registered report returns a well-formed result ---');
  const list = await (await fetch(BASE + '/api/reports', { headers: { ...H, Cookie: ch(jar) } })).json();
  // the registry grows as reports are added — assert its shape, not a frozen count
  ok('reports registered with type/name/description/category', list.length >= 14
    && list.every((r) => r.type && r.name && r.description && r.category), `got ${list.length}`);
  ok('report types are unique', new Set(list.map((r) => r.type)).size === list.length);
  for (const rep of list) {
    const b = await (await search(rep.type, { filters: {}, page: 1, per_page: 5 })).json();
    ok(`${rep.type} shape`, Array.isArray(b.rows) && Array.isArray(b.columns) && typeof b.total_count === 'number' && b.totals && typeof b.last_page === 'number');
  }

  console.log('\n--- single deal type hides "Type of Deal" col + shows in applied filters ---');
  const one = await (await search('sales-statement', { filters: { deal_type: ['Residential Buying'] } })).json();
  ok('single deal type hides Type-of-Deal column', !one.columns.some((c) => c.key === 'type'));
  ok('single deal type in applied_filters', one.applied_filters.some((f) => f.label === 'Deal Type' && f.value === 'Residential Buying'));
  const multi = await (await search('sales-statement', { filters: { deal_type: ['Residential Buying', 'Residential Lease'] } })).json();
  ok('multiple deal types keep Type-of-Deal column', multi.columns.some((c) => c.key === 'type'));

  console.log('\n--- customize fields: subset + mandatory kept ---');
  const cz = await (await search('sales-statement', { filters: {}, columns: ['property', 'total_w'] })).json();
  ok('selected columns respected', cz.columns.map((c) => c.key).includes('property') && cz.columns.map((c) => c.key).includes('total_w'));
  ok('mandatory trade_no kept even if unchecked', cz.columns.some((c) => c.key === 'trade_no'));

  console.log('\n--- footer totals == decimal-safe sum over the COMPLETE filtered set ---');
  const full = await (await search('yearly-deal-summary', { filters: {}, per_page: 200 })).json();
  const manual = Math.round(full.rows.reduce((a, row) => a + Number(row.total_w || 0), 0) * 100) / 100;
  ok('total_w footer equals sum of all rows', Math.abs(full.totals.total_w - manual) < 0.01, `footer ${full.totals.total_w} vs manual ${manual}`);
  ok('footer count equals total_count', full.totals.count === full.total_count);

  console.log('\n--- filters combine + sorting + pagination ---');
  const combo = await (await search('sales-statement', { filters: { deal_type: ['Residential Buying'], status: 'Pending' } })).json();
  ok('combined filters return a subset', combo.total_count <= one.total_count);
  const asc = await (await search('yearly-deal-summary', { filters: {}, sort: 'total_w', dir: 'asc', per_page: 50 })).json();
  const sortedAsc = asc.rows.map((r) => Number(r.total_w)).every((v, i, a) => i === 0 || a[i - 1] <= v);
  ok('server-side sort asc by total_w', sortedAsc);
  const p1 = await (await search('yearly-deal-summary', { filters: {}, page: 1, per_page: 2 })).json();
  ok('pagination metadata', p1.page === 1 && p1.per_page === 2 && p1.last_page >= 1);

  console.log('\n--- exports produce valid files (magic bytes) over full dataset ---');
  const xlsx = await exportReq('sales-statement', 'xlsx', { filters: {} });
  const xbuf = Buffer.from(await xlsx.arrayBuffer());
  ok('XLSX is a zip (PK magic)', xlsx.status === 200 && xbuf[0] === 0x50 && xbuf[1] === 0x4b, `status ${xlsx.status}`);
  ok('XLSX filename has report + timestamp', /Sales_Statement_Report_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.xlsx/.test(xlsx.headers.get('content-disposition') || ''));
  const pdf = await exportReq('yearly-deal-summary', 'pdf', { filters: {} });
  const pbuf = Buffer.from(await pdf.arrayBuffer());
  ok('PDF has %PDF magic', pdf.status === 200 && pbuf.slice(0, 4).toString() === '%PDF', `status ${pdf.status}`);

  console.log('\n--- security / edge cases ---');
  const bad = await search('does-not-exist', { filters: {} });
  ok('unknown report type → 404', bad.status === 404, `status ${bad.status}`);
  const empty = await (await search('brokerage-lead-conversion', { filters: {} })).json();
  ok('report with no source data → empty (0 rows), not an error', empty.total_count === 0 && Array.isArray(empty.rows));
  const opts = await (await fetch(BASE + '/api/reports/filter-options', { headers: { ...H, Cookie: ch(jar) } })).json();
  ok('admin filter-options expose multiple agents (brokerage-wide)', opts.agent.length > 1);
  ok('split ratios discovered dynamically from data', opts.split_ratio.length > 0 && opts.split_ratio.every((r) => /^\d+\/\d+$/.test(r.value)));

  console.log(`\n${fail === 0 ? `ALL ${pass} PASS ✅` : `${fail} FAILED, ${pass} passed ❌`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
