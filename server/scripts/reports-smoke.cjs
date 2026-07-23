/** Drive the Reports API on the running NestJS server. */
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const ch = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function main() {
  const jar = {};
  let r = await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar);
  const x = decodeURIComponent(jar['XSRF-TOKEN'] || '');
  r = await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: ch(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar);
  const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch(jar) } }).then(async (x) => ({ s: x.status, b: await x.json() }));
  const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: ch(jar) }, body: JSON.stringify(body) });

  const list = await get('/api/reports');
  console.log('GET /api/reports ->', list.s, '| reports:', list.b.length);
  console.log('  categories:', [...new Set(list.b.map((r) => r.category))].join(' | '));

  const opts = await get('/api/reports/filter-options');
  console.log('GET filter-options ->', opts.s, '| deal_types:', opts.b.deal_type?.length, 'agents:', opts.b.agent?.length, 'split_ratios:', JSON.stringify(opts.b.split_ratio));

  console.log('\n--- search each report (page 1) ---');
  for (const rep of list.b) {
    const res = await post(`/api/reports/${rep.type}/search`, { filters: {}, page: 1, per_page: 5 });
    const b = await res.json();
    const t = b.totals || {};
    console.log(`  ${rep.type}: ${res.status} | rows ${b.rows?.length ?? '?'}/${b.total_count ?? '?'} | cols ${b.columns?.length} | total_w=${t.total_w ?? '-'} agent_w=${t.agent_w ?? '-'} brok_w=${t.brok_w ?? '-'}`);
  }

  console.log('\n--- filters + sort on sales-statement ---');
  const flt = await post('/api/reports/sales-statement/search', { filters: { deal_type: ['Residential Buying'], status: 'Pending' }, sort: 'total_w', dir: 'desc', page: 1, per_page: 5 });
  const fb = await flt.json();
  console.log('  deal_type=Residential Buying,status=Pending:', flt.status, '| rows', fb.total_count, '| Type-of-Deal col hidden?', !fb.columns.some((c) => c.key === 'type'), '| applied:', JSON.stringify(fb.applied_filters));

  console.log('\n--- customize fields (subset columns) ---');
  const cf = await post('/api/reports/sales-statement/search', { filters: {}, columns: ['trade_no', 'property', 'total_w'], page: 1, per_page: 3 });
  const cb = await cf.json();
  console.log('  selected 3 cols ->', cf.status, '| returned cols:', cb.columns.map((c) => c.key).join(','), '(trade_no mandatory kept)');

  console.log('\n--- exports ---');
  const xlsx = await post('/api/reports/sales-statement/export/xlsx', { filters: {} });
  console.log('  XLSX:', xlsx.status, xlsx.headers.get('content-type'), '| bytes', (await xlsx.arrayBuffer()).byteLength, '| name', xlsx.headers.get('content-disposition'));
  const pdf = await post('/api/reports/yearly-deal-summary/export/pdf', { filters: {} });
  console.log('  PDF :', pdf.status, pdf.headers.get('content-type'), '| bytes', (await pdf.arrayBuffer()).byteLength);

  console.log('\n--- payment-status sections ---');
  const ps = await post('/api/reports/transaction-payment-status/search', { filters: {}, page: 1, per_page: 3 });
  const pb = await ps.json();
  console.log('  sections:', JSON.stringify(pb.sections));

  console.log('\nDONE');
}
main().catch((e) => { console.error('SMOKE ERROR', e); process.exit(1); });
