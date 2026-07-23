/**
 * Verifies the sidebar contains every module and satisfies the requested ordering:
 *   Inbox → Lead → Campaigns,  Transactions → Invoice → Reports,  Triggers → Email Settings.
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
const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

const jar = {};
const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } });

(async () => {
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }) }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exit(1); }

  const nav = read('desk/DeskLayout.tsx');
  const keys = [...nav.matchAll(/\{\s*key:\s*'([^']+)'/g)].map((m) => m[1]);
  const at = (k) => keys.indexOf(k);
  console.log(`sidebar (${keys.length}): ${keys.join(' · ')}\n`);

  // ---- presence ------------------------------------------------------------
  console.log('--- every module present ---');
  // 'account' is the personal "My Settings" item — always visible, not a permission screen, so it
  // sits in the sidebar between the admin Settings and Triggers but is absent from the catalog.
  const EXPECTED = ['dashboard', 'analytics', 'calendar', 'reviews', 'favorites', 'inventory',
    'inbox', 'lead', 'campaigns', 'meta', 'mls', 'transactions', 'invoice', 'reports',
    'audit', 'users', 'settings', 'account', 'triggers', 'email-settings', 'recycle-bin'];
  for (const k of EXPECTED) ok(at(k) >= 0, `"${k}" in the sidebar`);
  ok(keys.length === EXPECTED.length, `sidebar has ${keys.length} items (expected ${EXPECTED.length})`);
  ok(new Set(keys).size === keys.length, 'no duplicates');

  // ---- the requested ordering ---------------------------------------------
  console.log('\n--- requested ordering ---');
  const below = (a, b) => ok(at(a) === at(b) + 1, `"${a}" sits directly below "${b}" (${at(b)} → ${at(a)})`);
  below('campaigns', 'lead');       // Campaigns below Lead
  below('lead', 'inbox');           // Inbox above Lead
  below('invoice', 'transactions'); // Invoice below Transactions
  below('reports', 'invoice');      // Reports below Invoice
  ok(at('triggers') < at('email-settings'), `"triggers" is above "email-settings" (${at('triggers')} < ${at('email-settings')})`);

  // ---- each module resolves to a page (real component or the shared stub) --
  console.log('\n--- routes & pages ---');
  const app = read('App.tsx');
  const REAL_PAGES = { calendar: 'CalendarPage', campaigns: 'CampaignsPage', inventory: 'InventoryPage', mls: 'MlsPage', invoice: 'InvoicePage', reports: 'ReportsPage', transactions: 'TransactionsPage', lead: 'LeadsPage', meta: 'MetaPage' };
  for (const [key, page] of Object.entries(REAL_PAGES)) {
    ok(new RegExp(`path="${key}"`).test(app), `/app/${key} has its own route`);
    ok(app.includes(`import ${page} from`), `${page} is imported`);
    ok(fs.existsSync(path.join(CLIENT, 'desk', `${page}.tsx`)), `${page}.tsx exists on disk`);
  }
  // 'inbox' is now a real page (the per-user IMAP mailbox), no longer a stub.
  ok(/path="inbox"/.test(app), '/app/inbox has its own route (personal mailbox)');
  ok(app.includes('import InboxPage from'), 'InboxPage is imported');
  const STUBBED = ['favorites', 'reviews', 'triggers'];
  const stubText = read('desk/StubPage.tsx');
  for (const key of STUBBED) {
    ok(!new RegExp(`path="${key}"`).test(app), `/app/${key} falls through to the :page stub (no page yet)`);
    ok(new RegExp(`^\\s*${key}:`, 'm').test(stubText), `the stub page describes "${key}"`);
  }
  ok(/path=":page"/.test(app), 'the catch-all stub route is present');

  // ---- stub + landing ------------------------------------------------------
  console.log('\n--- campaigns wiring ---');
  ok(/'campaigns'/.test(read('desk/guards.tsx')), 'Campaigns is in the landing-redirect order');
  ok(/path="campaigns"/.test(read('App.tsx')), 'Campaigns has its own route');

  // ---- server catalog mirrors the sidebar ---------------------------------
  console.log('\n--- permission catalog ---');
  const cat = await (await get('/api/users/catalog')).json();
  const screens = cat.screens.map((s) => s.key);
  ok(screens.includes('campaigns'), 'Campaigns is grantable in Users → Permissions');
  ok(screens.includes('triggers'), 'Triggers survived the reorder (was nearly dropped)');
  ok(screens.length === 18, `catalog exposes ${screens.length} screens`);
  // the catalog's own comment promises it mirrors the sidebar — hold it to that. 'account' is a
  // personal, always-visible item with no screen permission, so it is not in the catalog either.
  const navNoSuper = keys.filter((k) => k !== 'email-settings' && k !== 'recycle-bin' && k !== 'account');
  ok(screens.join(',') === navNoSuper.join(','),
    `catalog order matches the sidebar\n      catalog: ${screens.join(', ')}\n      sidebar: ${navNoSuper.join(', ')}`);
  for (const [role, map] of Object.entries(cat.role_defaults)) {
    ok('campaigns' in map, `role "${role}" has a default level for Campaigns (${map.campaigns})`);
  }

  // ---- regression ----------------------------------------------------------
  console.log('\n--- regression ---');
  const txns = await (await get('/api/transactions')).json();
  ok((Array.isArray(txns) ? txns : txns.data).length > 0, 'transactions still load');
  ok((await (await get('/api/reports')).json()).length >= 20, 'reports module unaffected');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  // Set the code rather than calling process.exit(): forcing exit while fetch's keep-alive
  // sockets are still closing trips a libuv assertion on Windows and reports a bogus code.
  process.exitCode = fail === 0 ? 0 : 1;
})();
