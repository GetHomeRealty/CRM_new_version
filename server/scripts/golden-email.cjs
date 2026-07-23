// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';

/** Golden parity for Email settings: mail-accounts + email-templates + mail-events + preview,
 *  plus account CRUD and template update round-trips that restore shared config afterward. */
const LARAVEL = 'http://127.0.0.1:8000', NEST = 'http://127.0.0.1:8001';
const USER = ADMIN_LOGIN, PASS = 'Admin@123';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
function jarFrom(res, jar) { const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of cs) { const nv = c.split(';')[0]; const i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } }
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function session(base) { const jar = {}; let r = await fetch(base + '/sanctum/csrf-cookie', { headers: H }); jarFrom(r, jar); const x = decodeURIComponent(jar['XSRF-TOKEN'] || ''); r = await fetch(base + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x, Cookie: cookieHeader(jar) }, body: JSON.stringify({ username: USER, password: PASS }) }); jarFrom(r, jar); return jar; }
const send = (base, jar, method, path, body) => fetch(base + path, { method, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] || ''), Cookie: cookieHeader(jar) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (base, jar, path) => send(base, jar, 'GET', path);

let failures = 0;
const pass = (m) => console.log('  PASS ' + m);
const eq = (m, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) return pass(m); failures++; console.log('  FAIL ' + m); console.log('    laravel:', JSON.stringify(a)?.slice(0, 360)); console.log('    nest   :', JSON.stringify(b)?.slice(0, 360)); };
const noVol = (o) => { if (!o) return o; const { id, created_at, updated_at, ...rest } = o; return rest; };

async function both(method, path, body) { return Promise.all([send(LARAVEL, LJ, method, path, body), send(NEST, NJ, method, path, body)]); }
let LJ, NJ;

async function main() {
  [LJ, NJ] = await Promise.all([session(LARAVEL), session(NEST)]);

  console.log('--- reads ---');
  const [le, ne] = await Promise.all([get(LARAVEL, LJ, '/api/mail-events'), get(NEST, NJ, '/api/mail-events')]);
  eq('mail-events catalog', le.body, ne.body);

  const [lt, nt] = await Promise.all([get(LARAVEL, LJ, '/api/email-templates'), get(NEST, NJ, '/api/email-templates')]);
  // strip updated_at from every template (may drift), compare structure + ordering.
  const stripT = (r) => ({ groups: r.groups.map((g) => ({ module: g.module, templates: g.templates.map((t) => { const { updated_at, ...rest } = t; return rest; }) })), mail_accounts: r.mail_accounts.map((a) => { const { created_at, ...rest } = a; return rest; }) });
  eq('email-templates (groups + mail_accounts, updated_at stripped)', stripT(lt.body), stripT(nt.body));

  const [la, na] = await Promise.all([get(LARAVEL, LJ, '/api/mail-accounts'), get(NEST, NJ, '/api/mail-accounts')]);
  eq('mail-accounts index (created_at stripped)', { data: la.body.data.map(noVol) }, { data: na.body.data.map(noVol) });

  // preview a seeded template (dates are now()-based → identical when both run the same day).
  const tid = lt.body.groups.flatMap((g) => g.templates).find((t) => t.event_key === 'invoice.send')?.id;
  const ntid = nt.body.groups.flatMap((g) => g.templates).find((t) => t.event_key === 'invoice.send')?.id;
  const [lp, np] = await Promise.all([send(LARAVEL, LJ, 'POST', `/api/email-templates/${tid}/preview`), send(NEST, NJ, 'POST', `/api/email-templates/${ntid}/preview`)]);
  eq('preview invoice.send', lp.body, np.body);

  console.log('--- mail-account CRUD round-trip ---');
  const origDefault = la.body.data.find((a) => a.is_default)?.id ?? null;
  const acc = { name: 'Parity SMTP', from_name: 'Parity', from_email: 'parity@example.com', host: 'smtp.example.com', port: 587, username: 'pu', password: 'secret', encryption: 'tls', is_active: true, is_default: false };
  const [lc, nc] = await both('POST', '/api/mail-accounts', acc);
  console.log('  create:', lc.status, 'vs', nc.status);
  eq('created account (id/created_at stripped)', noVol(lc.body.data), noVol(nc.body.data));
  const lid = lc.body.data.id, nid = nc.body.data.id;

  const [lu, nu] = await Promise.all([send(LARAVEL, LJ, 'PUT', '/api/mail-accounts/' + lid, { ...acc, name: 'Parity SMTP Renamed', password: '' }), send(NEST, NJ, 'PUT', '/api/mail-accounts/' + nid, { ...acc, name: 'Parity SMTP Renamed', password: '' })]);
  eq('updated account (blank password keeps has_password true)', noVol(lu.body.data), noVol(nu.body.data));

  const [lsd, nsd] = await Promise.all([send(LARAVEL, LJ, 'POST', `/api/mail-accounts/${lid}/default`), send(NEST, NJ, 'POST', `/api/mail-accounts/${nid}/default`)]);
  eq('setDefault response', noVol(lsd.body.data), noVol(nsd.body.data));

  // restore original default (if any) then delete the test account on both
  if (origDefault) await both('POST', `/api/mail-accounts/${origDefault}/default`);
  const [ld, nd] = await Promise.all([send(LARAVEL, LJ, 'DELETE', '/api/mail-accounts/' + lid), send(NEST, NJ, 'DELETE', '/api/mail-accounts/' + nid)]);
  eq('delete message', ld.body, nd.body);

  console.log('--- template update round-trip (restored after) ---');
  const orig = lt.body.groups.flatMap((g) => g.templates).find((t) => t.event_key === 'invoice.send');
  const upd = { subject: 'Parity {{ invoice_number }}', body_html: '<p>Hi {{ customer_name }}</p>', mail_account_id: null, is_active: true };
  const [ltu, ntu] = await Promise.all([send(LARAVEL, LJ, 'PUT', '/api/email-templates/' + tid, upd), send(NEST, NJ, 'PUT', '/api/email-templates/' + ntid, upd)]);
  const stripU = (r) => { const { updated_at, ...rest } = r; return rest; };
  eq('updated template', stripU(ltu.body.data), stripU(ntu.body.data));
  // restore original subject/body/is_active/mail_account_id
  const restore = { subject: orig.subject, body_html: orig.body_html, mail_account_id: orig.mail_account_id, is_active: orig.is_active };
  await Promise.all([send(LARAVEL, LJ, 'PUT', '/api/email-templates/' + tid, restore), send(NEST, NJ, 'PUT', '/api/email-templates/' + ntid, restore)]);

  console.log('--- test-endpoint validation ---');
  const testId = lid; // deleted, but validation runs after 404... use a live account instead
  const liveId = origDefault ?? (la.body.data[0]?.id);
  if (liveId) {
    const [lv, nv] = await Promise.all([send(LARAVEL, LJ, 'POST', `/api/mail-accounts/${liveId}/test`, { to: '' }), send(NEST, NJ, 'POST', `/api/mail-accounts/${liveId}/test`, { to: '' })]);
    eq('test missing `to` (422 validation)', { s: lv.status, b: lv.body }, { s: nv.status, b: nv.body });
  } else { console.log('  SKIP test validation (no live account)'); void testId; }

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });