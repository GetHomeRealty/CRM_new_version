/** Post-start smoke test: log in and hit the screens a user would actually open. */
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
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

const count = (d) => Array.isArray(d) ? d.length
  : Array.isArray(d?.data) ? d.data.length
  : typeof d?.meta?.total === 'number' ? d.meta.total
  : d && typeof d === 'object' ? Object.keys(d).length : 0;

(async () => {
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const login = take(await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
    body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }),
  }));
  console.log(`login                 ${login.status === 200 ? 'OK' : 'FAILED ' + login.status}`);
  if (login.status !== 200) { process.exitCode = 1; return; }

  const screens = [
    ['Dashboard', '/api/dashboard/commissions'],
    ['Transactions', '/api/transactions'],
    ['Invoice', '/api/invoices'],
    ['Reports', '/api/reports'],
    // Analytics has no endpoint of its own — the page derives everything from transactions.
    ['Calendar', '/api/calendar/events'],
    ['Lead', '/api/leads?limit=5'],
    ['Lead options', '/api/leads/options'],
    ['Campaigns', '/api/campaigns'],
    ['Meta', '/api/meta/status'],
    ['Meta leads', '/api/meta/leads'],
    ['Users', '/api/users'],
    ['Audit Trail', '/api/audit-logs'],
    ['Email Settings', '/api/mail-accounts'],
    ['Email templates', '/api/email-templates'],
    ['Recycle Bin', '/api/trash/transactions'],
  ];

  let bad = 0;
  for (const [name, path] of screens) {
    const r = await get(path);
    const body = r.ok ? await r.json().catch(() => null) : null;
    const note = r.ok ? `${count(body)} item(s)` : '';
    if (!r.ok) bad++;
    console.log(`${name.padEnd(21)} ${String(r.status).padEnd(4)} ${note}`);
  }
  console.log(bad === 0 ? '\nEvery screen responded.' : `\n${bad} screen(s) failed.`);
  process.exitCode = bad === 0 ? 0 : 1;
})();
