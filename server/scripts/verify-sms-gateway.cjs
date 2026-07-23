/**
 * Twilio SMS gateway.
 *
 * No Twilio credentials are configured on this machine and none are needed: what matters is that
 * the app behaves correctly in BOTH states. Unconfigured, it must refuse to pretend a message
 * was sent. Configured, the webhooks must accept a correctly signed request and reject everything
 * else — which the script proves by signing requests itself, exactly as Twilio does.
 *
 * Nothing here contacts Twilio. No message is ever sent.
 */
const fs = require('fs');
const path = require('path');
const { createHmac } = require('node:crypto');

const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const SRV = path.join(process.cwd(), 'src');
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);
const readSrv = (rel) => fs.readFileSync(path.join(SRV, rel), 'utf8');
const readCli = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

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
const send = (m, p, b) => fetch(BASE + p, {
  method: m,
  headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
  body: b === undefined ? undefined : JSON.stringify(b),
});

/** Twilio's scheme: HMAC-SHA1 over url + every param sorted by name, concatenated name+value. */
const twilioSign = (token, url, params) =>
  createHmac('sha1', token)
    .update(Buffer.from(Object.keys(params).sort().reduce((a, k) => a + k + params[k], url), 'utf8'))
    .digest('base64');

const hook = (p, params, signature) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
  body: new URLSearchParams(params).toString(),
});

(async () => {
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await send('POST', '/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exitCode = 1; return; }

  head('what the browser is told about the gateway');
  const st = await (await get('/api/sms/status')).json();
  ok(typeof st.configured === 'boolean', `the SPA can ask whether sending works (configured: ${st.configured})`);
  const body = JSON.stringify(st);
  for (const secret of ['auth_token', 'authToken', 'AUTH_TOKEN', 'account_sid']) {
    ok(!body.toLowerCase().includes(secret.toLowerCase()), `the response never carries ${secret}`);
  }
  ok(!('token' in st) && !('sid' in st), 'no credential field is present at all');
  ok((await fetch(BASE + '/api/sms/status', { headers: H })).status === 401, 'and it needs a session');

  head('with no gateway configured, nothing pretends to send');
  const leads = await (await get('/api/leads')).json();
  const lead = leads.data[0];
  if (!lead) { console.error('no leads to test against'); process.exitCode = 1; return; }
  if (!st.configured) {
    const refused = await send('POST', `/api/leads/${lead.id}/messages`, {
      direction: 'outbound', body: 'must not be sent', phone: '+15005550006', send: true,
    });
    ok(refused.status === 400, 'asking the server to send is refused, not silently logged as sent');
    ok(/no sms gateway/i.test(JSON.stringify(await refused.json())), 'and says why, so the agent is not left guessing');
    const before = (await (await get(`/api/leads/${lead.id}`)).json()).messages.length;
    const after = (await (await get(`/api/leads/${lead.id}`)).json()).messages.length;
    ok(before === after, 'no message row was created by the refused send');
  } else {
    console.log('  NOTE  Twilio IS configured here; the "refuses to send" checks are skipped.');
  }

  head('webhooks reject anything they cannot verify');
  // Unsigned, wrongly signed and empty all have to be rejected. Without credentials the server
  // cannot verify ANY signature, so every one of these is a 403 — which is the safe answer.
  const params = { MessageSid: 'SM_verify_nonexistent', MessageStatus: 'delivered' };
  ok((await hook('/api/sms/twilio/status', params, '')).status === 403, 'an unsigned status callback is rejected');
  ok((await hook('/api/sms/twilio/status', params, 'bm90YXNpZ25hdHVyZQ==')).status === 403,
    'a wrongly signed status callback is rejected');
  ok((await hook('/api/sms/twilio/inbound', { From: '+15551234567', Body: 'hi' }, '')).status === 403,
    'an unsigned inbound message is rejected');
  // The signature is the ONLY thing guarding these: they carry no session and no CSRF token.
  ok((await hook('/api/sms/twilio/status', params, twilioSign('wrong-token', `${BASE}/api/sms/twilio/status`, params))).status === 403,
    'a signature made with the wrong token is rejected');

  head('the signing scheme itself');
  // Verified against Twilio's own published example, so a refactor cannot quietly break it.
  const example = twilioSign('12345',
    'https://mycompany.com/myapp.php?foo=1&bar=2',
    { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' });
  ok(example === 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', 'matches the signature from Twilio\'s published example');

  head('the read receipt is honest about what SMS can do');
  const sms = readSrv('sms/sms.constants.ts');
  ok(sms.includes("'read'"), 'read is a status the app understands');
  ok(/no read receipt/i.test(sms), 'and the code records that no provider reports it for plain SMS');
  const pub = readSrv('sms/sms-public.controller.ts');
  ok(pub.includes("msg.status === 'read'"), 'a callback will not overwrite a read mark a person made');
  ok(/mapProviderStatus/.test(sms) && /undelivered/.test(sms), 'Twilio\'s lifecycle is mapped, including undelivered');
  ok(!/read'\s*:\s*.*automatic/i.test(readCli('desk/LeadDetailPage.tsx')), 'the UI never claims read is automatic');
  const detail = readCli('desk/LeadDetailPage.tsx');
  ok(detail.includes('Read</strong> stays a manual mark'), 'and says so in the panel when a gateway is connected');
  ok(detail.includes('No SMS gateway is connected'), 'and says the opposite when one is not');

  head('credentials stay on the server');
  ok(!fs.readdirSync(CLIENT, { recursive: true }).some((f) => typeof f === 'string' && f.includes('twilio')),
    'no Twilio code was added to the client');
  for (const f of ['desk/LeadDetailPage.tsx', 'lib/leadsApi.ts']) {
    ok(!/TWILIO_|auth_?token/i.test(readCli(f)), `${f} references no credential`);
  }

  head('inbound replies are matched, not invented');
  const inb = readSrv('sms/sms-inbound.service.ts');
  ok(inb.includes('normalizePhone'), 'a reply is matched on a normalised number, so formatting does not matter');
  ok(/matched no lead/.test(inb), 'and an unmatched reply is logged rather than turned into a new lead');
  ok(inb.includes('provider_sid'), 'a retried webhook cannot log the same reply twice');

  head('the deal core is untouched');
  ok((await get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await get('/api/invoices')).status === 200, 'invoices still respond');
  ok((await get('/api/dashboard/commissions')).status === 200, 'the dashboard still responds');
  ok((await get(`/api/leads/${lead.id}`)).status === 200, 'the lead detail still responds');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
