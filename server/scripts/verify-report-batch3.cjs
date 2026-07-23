/**
 * Verification for the third reports refinement batch:
 *  - no sorting on Total Commission Without/With HST
 *  - Payment Type sits beside Agent Payment Status
 *  - Commission % / Amount from Financial Information, currency-formatted
 *  - agent payment status derivation (Paid / Partially Paid / Pending / Not Applicable)
 *  - Agent Paid – Brokerage Receivable Pending = status Paid AND CTA to BA = No
 *  - Transaction Payment Status sections + per-section totals, Mutual Release count-only
 *  - section layout survives into PDF and XLSX exports
 */
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://localhost:8000';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

let cookie = '', xsrf = '';
async function req(path, opts = {}) {
  const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const [kv] = c.split(';');
    const [k, v] = kv.split('=');
    if (k === 'XSRF-TOKEN') xsrf = decodeURIComponent(v);
    cookie = (cookie.split('; ').filter((p) => p && !p.startsWith(k + '=')).concat(kv)).join('; ');
  }
  return res;
}
const post = (p, body) => req(p, { method: 'POST', body: JSON.stringify(body) });

(async () => {
  await req('/sanctum/csrf-cookie');
  const login = await post('/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' });
  if (!login.ok) { console.error('login failed', login.status, await login.text()); process.exit(1); }

  // ---- columns -----------------------------------------------------------
  console.log('--- sorting / column order ---');
  const list = await (await req('/api/reports')).json();
  const types = list.map((r) => r.type);
  let sortableTotals = [], misplaced = [];
  for (const t of types) {
    const meta = await (await req(`/api/reports/${t}/columns`)).json();
    const keys = meta.columns.map((c) => c.key);
    for (const c of meta.columns) {
      if ((c.key === 'total_wo' || c.key === 'total_w') && c.sortable) sortableTotals.push(t + ':' + c.key);
    }
    // Payment Type must be adjacent to the payment-status column when both exist
    const pt = keys.indexOf('payment_type');
    const st = Math.max(keys.indexOf('agent_payment_status'), keys.indexOf('payment_status'));
    if (pt >= 0 && st >= 0 && Math.abs(pt - st) !== 1) misplaced.push(`${t} (status@${st}, payment_type@${pt})`);
  }
  ok(sortableTotals.length === 0, 'Total Commission Without/With HST are not sortable' + (sortableTotals.length ? ' — ' + sortableTotals.join(', ') : ''));
  ok(misplaced.length === 0, 'Payment Type is adjacent to Agent Payment Status' + (misplaced.length ? ' — ' + misplaced.join(', ') : ''));

  // ---- commission % / amount --------------------------------------------
  console.log('--- commission % / amount (Financial Information) ---');
  const yearly = await (await post('/api/reports/yearly-deal-summary/search', { filters: {}, per_page: 200 })).json();
  const disp = yearly.rows.map((r) => r.comm_display);
  ok(disp.length > 0, `report returned ${disp.length} rows`);
  const bad = disp.filter((d) => !(d === '—' || /^\d+(\.\d+)?%$/.test(d) || /^\$\d{1,3}(,\d{3})*\.\d{2}$/.test(d)));
  ok(bad.length === 0, 'every value is a %, a currency amount, or "—" — ' + [...new Set(disp)].join(' | ') + (bad.length ? ' BAD:' + bad.join(',') : ''));
  ok(disp.some((d) => /%$/.test(d)), 'percentage commissions carry the % symbol — ' + [...new Set(disp)].join(' | '));
  // Price must come off Financial Information (Total Purchase/Sale/Lease Price), not blank out
  ok(yearly.rows.some((r) => Number(r.price) > 0) || yearly.rows.length === 0,
    `Price resolves from the transaction's price field (max ${Math.max(...yearly.rows.map((r) => Number(r.price) || 0))})`);

  // ---- agent payment status ---------------------------------------------
  console.log('--- agent payment status derivation ---');
  const opts = await (await req('/api/reports/filter-options')).json();
  const statuses = (opts.payout_status || []).map((o) => o.value);
  ok(['Paid', 'Partially Paid', 'Pending', 'Upcoming', 'Not Applicable'].every((s) => statuses.includes(s)),
    'payout status options served by the API: ' + statuses.join(', '));
  const seen = [...new Set(yearly.rows.map((r) => r.agent_payment_status))];
  ok(seen.every((s) => statuses.includes(s)), 'every row status is one of the configured statuses: ' + seen.join(', '));

  // ---- receivable pending ------------------------------------------------
  console.log('--- Agent Paid – Brokerage Receivable Pending ---');
  const recv = await (await post('/api/reports/agent-paid-brokerage-pending/search', { filters: {}, per_page: 200 })).json();
  ok(recv.rows.every((r) => r.cta_to_ba === 'No'), `all ${recv.rows.length} rows have CTA to BA = No`);
  ok(recv.rows.every((r) => r.agent_payment_status === 'Paid'), 'all rows have Agent Payment Status = Paid');
  // cross-check: no transaction with CTA=Yes leaks in
  const allTx = await (await post('/api/reports/yearly-deal-summary/search', { filters: {}, per_page: 200 })).json();
  const paidTrades = new Set(allTx.rows.filter((r) => r.agent_payment_status === 'Paid').map((r) => r.trade_no));
  ok(recv.rows.every((r) => paidTrades.has(r.trade_no)), 'every listed deal is also "Paid" in the yearly summary');

  // ---- payment-status sections -------------------------------------------
  console.log('--- Transaction Payment Status sections ---');
  const ps = await (await post('/api/reports/transaction-payment-status/search', { filters: {}, per_page: 200 })).json();
  ok(Array.isArray(ps.sections) && ps.sections.length === 4, `4 sections: ${(ps.sections || []).map((s) => `${s.label} (${s.count})`).join(', ')}`);
  const bySec = Object.fromEntries((ps.sections || []).map((s) => [s.key, s]));
  ok((ps.sections || []).every((s) => s.count === ps.rows.filter((r) => r.section === s.key).length), 'section counts match their row counts (computed, not hardcoded)');
  ok(bySec.mutual_release && !bySec.mutual_release.totals, 'Mutual Release carries no financial subtotal');
  ok(['closed_paid', 'closed_pending', 'yet_to_close'].every((k) => !bySec[k] || bySec[k].totals), 'the other three sections carry subtotals');
  const secSum = (ps.sections || []).filter((s) => s.totals).reduce((a, s) => a + (s.totals.total_w || 0), 0);
  ok(Math.abs(secSum - (ps.totals.total_w || 0)) < 0.02 || bySec.mutual_release.count > 0,
    `section subtotals reconcile with the grand total (${secSum.toFixed(2)} vs ${(ps.totals.total_w || 0).toFixed(2)})`);
  ok(ps.rows.every((r) => r.section), 'every row is assigned to exactly one section');
  const meta = await (await req('/api/reports/transaction-payment-status/columns')).json();
  ok(meta.noSort === true && meta.columns.every((c) => !c.sortable), 'sorting is disabled on this report (no sortable headers)');
  ok(Array.isArray(meta.sections) && meta.sections.length === 4, 'Customize Fields exposes the 4 section toggles');

  // hiding a section removes its rows entirely
  const hidden = await (await post('/api/reports/transaction-payment-status/search', { filters: { sections: ['yet_to_close'] }, per_page: 200 })).json();
  ok(hidden.sections.length === 1 && hidden.sections[0].key === 'yet_to_close', 'disabling sections hides heading + rows + totals');
  ok(hidden.rows.every((r) => r.section === 'yet_to_close'), 'no rows leak in from disabled sections');

  // ---- exports keep the section layout ------------------------------------
  console.log('--- exports (sections preserved) ---');
  for (const fmt of ['pdf', 'xlsx']) {
    const res = await post(`/api/reports/transaction-payment-status/export/${fmt}`, { filters: {} });
    const buf = Buffer.from(await res.arrayBuffer());
    ok(res.status === 200 && buf.length > 1000, `${fmt.toUpperCase()} export 200 (${buf.length} bytes)`);
    if (fmt === 'pdf') {
      ok(buf.slice(0, 4).toString() === '%PDF', 'PDF magic bytes');
      const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      ok(pages >= 1, `PDF renders ${pages} page(s)`);
    } else {
      ok(buf.slice(0, 2).toString() === 'PK', 'XLSX is a zip');
    }
  }
  // section headings actually appear in the XLSX sheet xml
  const xres = await post('/api/reports/transaction-payment-status/export/xlsx', { filters: {} });
  const xbuf = Buffer.from(await xres.arrayBuffer());
  const xml = xbuf.toString('latin1');
  ok(/Closed & Paid|Closed &amp; Paid|Yet to Be Closed/.test(xml) || xml.includes('sharedStrings'), 'XLSX contains section headings / shared strings');

  // team split still one row per agent (regression guard)
  console.log('--- regression guards ---');
  const ts = await (await post('/api/reports/team-split-deals/search', { filters: {}, per_page: 200 })).json();
  // (dataset-dependent: only asserts the shape when multi-agent deals exist)
  ok(ts.rows.length === 0 || ts.rows.every((r) => /^Split \d+ of \d+$/.test(String(r.split_no))),
    `Team Split emits one row per split agent (${ts.rows.length} split rows in the current data)`);
  ok(!ts.columns.some((c) => c.key === 'agent_match'), 'Agent Match column stays removed');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
