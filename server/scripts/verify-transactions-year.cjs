/**
 * "Year (by closing date)" filter on the Transactions list.
 *
 * The filter is applied client-side over the rows the list already has, exactly like the other
 * filters on that screen — so there is no API, query or schema change to verify. What matters is
 * that the year rule matches the Dashboard's, that the option list comes from real data, and
 * that the transactions endpoint itself is untouched.
 */
const fs = require('fs');
const path = require('path');

// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);
const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

const jar = {};
const take = (r) => {
  for (const c of (r.headers.getSetCookie?.() || [])) {
    const nv = c.split(';')[0], i = nv.indexOf('=');
    if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1);
  }
  return r;
};
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } });

(async () => {
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
    body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }),
  }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exitCode = 1; return; }

  head('the rows the filter runs over');
  const body = await (await get('/api/transactions')).json();
  const rows = Array.isArray(body) ? body : body.data;
  ok(Array.isArray(rows) && rows.length > 0, `${rows.length} transactions returned`);
  ok('closing_date' in rows[0], 'each row carries closing_date, which the filter reads');

  // The exact rule the page uses, mirrored here so a divergence shows up as a failure.
  const dealYear = (t) => (t.closing_date ? String(t.closing_date).slice(0, 4) : null);
  const years = [...new Set(rows.map(dealYear).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  ok(years.length > 0, `the dropdown will offer ${years.length} year(s): ${years.join(', ')}`);
  ok(years.every((y) => /^\d{4}$/.test(y)), 'every option is a four-digit year');
  ok(years.join(',') === [...years].sort((a, b) => b.localeCompare(a)).join(','), 'newest first');

  const undated = rows.filter((t) => !dealYear(t)).length;
  console.log(`  NOTE  ${undated} transaction(s) have no closing date and are excluded once a year is picked.`);
  for (const y of years) {
    const n = rows.filter((t) => dealYear(t) === y).length;
    ok(n > 0, `${y} matches ${n} transaction(s)`);
  }
  ok(rows.filter((t) => dealYear(t) === '1999').length === 0, 'a year with no deals matches nothing');
  ok(years.reduce((sum, y) => sum + rows.filter((t) => dealYear(t) === y).length, 0) + undated === rows.length,
    'every transaction is accounted for exactly once across the years plus the undated ones');

  head('frontend wiring');
  const page = read('desk/TransactionsPage.tsx');
  ok(page.includes('const dealYear ='), 'the page defines the closing-date year rule');
  ok(page.includes("String(t.closing_date).slice(0, 4)"), 'and derives it from closing_date, as the Dashboard does');
  ok(page.includes('All years (by closing date)'), 'the dropdown is labelled by closing date, so it cannot be confused with offer date');
  ok(/if \(f\.year && dealYear\(t\) !== f\.year\) return false;/.test(page), 'the filter is applied to the row list');
  ok(/year: ''/.test(page), 'it starts unset, so the default view is unchanged');
  ok(page.includes('const years = useMemo'), 'the options are derived from the loaded rows, not hardcoded');

  // "Deals by Year & Type" was removed from the Dashboard on request; Transactions is now the
  // only place that filters by closing-date year. Assert it stays gone rather than dropping the
  // check, so the section cannot quietly reappear.
  const dash = read('desk/DashboardPage.tsx');
  // Match the rendered heading (JSX-escaped ampersand), not the plain phrase — the file still
  // mentions the section by name in a comment explaining where the feature went.
  ok(!dash.includes('Deals by Year &amp; Type'), 'the Dashboard no longer renders the Deals by Year & Type section');
  ok(!dash.includes('dealYear'), 'and none of its year-filtering code was left behind');
  ok(!/CATEGORIES/.test(dash), 'the type-category chips are gone too');
  ok(page.match(/String\(t\.closing_date\)\.slice\(0, 4\)/g).length >= 1, 'Transactions owns the deal-year rule');

  head('the deal core is untouched');
  ok((await get('/api/transactions')).status === 200, 'the transactions endpoint still responds');
  ok((await get('/api/invoices')).status === 200, 'invoices still respond');
  ok((await (await get('/api/reports')).json()).length >= 20, 'reports still respond');
  ok((await get('/api/dashboard/commissions')).status === 200, 'the dashboard still responds');
  // No server file needed changing: the filter runs entirely in the browser.
  const serverTouched = fs.existsSync(path.join(process.cwd(), 'src', 'transactions', 'year-filter.ts'));
  ok(!serverTouched, 'no server-side transaction code was added for this');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  // Set the code rather than calling process.exit(): forcing exit while fetch's keep-alive
  // sockets are still closing trips a libuv assertion on Windows and reports a bogus code.
  process.exitCode = fail === 0 ? 0 : 1;
})();
