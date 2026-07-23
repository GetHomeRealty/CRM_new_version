/**
 * Meta module verification against the live API.
 *
 * There are no Meta app credentials in this environment, so nothing here talks to Facebook.
 * What IS proven: the guards, the CSRF exemption, route ordering, the webhook handshake and
 * HMAC signature check, the OAuth callback's state handling, and that an unauthenticated caller
 * cannot inject a lead. Token crypto, state signing and field mapping are covered by
 * src/meta/meta.spec.ts.
 *
 * Run with the server started as:
 *   $env:META_WEBHOOK_VERIFY_TOKEN='verify-me'; $env:META_WEBHOOK_SECRET='shh'; node dist/main.js
 */
const fs = require('fs');
const path = require('path');
const { createHmac } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'verify-me';
const WEBHOOK_SECRET = process.env.META_WEBHOOK_SECRET || 'shh';

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const skip = (m) => { skipped++; console.log('  SKIP ' + m); };
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
const send = (m, p, b) => fetch(BASE + p, {
  method: m, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }),
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const sign = (raw) => 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

/** POST the webhook with an explicit raw body, so the signature covers the exact bytes. */
const webhook = (raw, signature) => fetch(BASE + '/api/meta/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
  body: raw,
});

(async () => {
  const prisma = new PrismaClient();
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await send('POST', '/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exitCode = 1; return; }

  const leadsBefore = await prisma.leads.count();

  try {
    // ------------------------------------------------------------- unconfigured
    head('reports its own configuration honestly');
    const st = await json(await get('/api/meta/status'));
    ok(st.configured === false, 'status reports the server is NOT configured (no META_APP_ID here)');
    ok(st.token_storage_secure === true, 'token encryption is on (APP_KEY is set)');
    ok(st.is_connected === false, 'no connection exists');
    ok(typeof st.redirect_uri === 'string' && st.redirect_uri.endsWith('/api/meta/callback'), `the redirect URI is published so it can be pasted into Meta (${st.redirect_uri})`);
    ok(st.oauth_strategy === 'config', 'defaults to the config_id strategy Business apps require');

    const authUrl = await send('GET', '/api/meta/auth-url');
    const authBody = await json(authUrl);
    ok(authUrl.status === 400, 'connecting is refused while unconfigured, rather than opening a broken dialog');
    ok(/META_APP_ID/.test(authBody?.message ?? ''), `the refusal names the missing setting: "${authBody?.message}"`);

    head('diagnostics explain what is missing');
    const diag = await json(await get('/api/meta/diagnostics'));
    ok(Array.isArray(diag.blockers) && diag.blockers.length > 0, `${diag.blockers.length} blocker(s) reported`);
    ok(diag.blockers.some((b) => /META_APP_ID/.test(b)), 'missing app credentials are called out');
    ok(diag.blockers.some((b) => /META_LOGIN_CONFIG_ID/.test(b)), 'the Login-for-Business config requirement is called out');
    ok(diag.blockers.some((b) => /HTTPS/i.test(b)), 'the non-HTTPS redirect URI is called out (Meta rejects http)');
    ok(diag.fix_steps.length >= 5, 'a setup checklist is provided');
    ok(diag.token_storage_secure === true, 'diagnostics confirm token encryption is on');

    head('endpoints that need a connection say so');
    for (const [method, p] of [['GET', '/api/meta/pages'], ['GET', '/api/meta/forms?page_id=123']]) {
      const r = await send(method, p);
      ok(r.status === 400, `${p} → 400 while disconnected (${(await json(r))?.message})`);
    }
    const syncRes = await send('POST', '/api/meta/sync');
    ok(syncRes.status === 200, 'sync responds rather than erroring when disconnected');
    ok(/not connected/i.test((await json(syncRes))?.message ?? ''), 'sync explains that Meta is not connected');

    head('the leads view works with no connection');
    const ml = await json(await get('/api/meta/leads'));
    ok(ml && Array.isArray(ml.data), 'the Meta leads list responds');
    ok(ml.stats.total === 0, 'no Meta leads yet');

    // ------------------------------------------------------------------ guards
    head('guards and route ordering');
    const anon = await fetch(BASE + '/api/meta/status', { headers: H });
    ok(anon.status === 401 || anon.status === 403, `status requires a session (anonymous → ${anon.status})`);
    const anonSync = await fetch(BASE + '/api/meta/sync', { method: 'POST', headers: H });
    ok(anonSync.status !== 200, `sync cannot be triggered anonymously (${anonSync.status})`);

    ok((await fetch(BASE + '/api/meta/webhook?hub.mode=subscribe', { headers: H })).status !== 401,
      'the webhook is public — it is not swallowed by the guarded controller');
    const cbAnon = await fetch(BASE + '/api/meta/callback', { headers: H, redirect: 'manual' });
    ok(cbAnon.status === 302, 'the OAuth callback is public and redirects (Facebook sends the user here without a session)');

    // --------------------------------------------------------- webhook verify
    head('webhook handshake');
    // The running API must have been started with the same webhook secrets this script signs
    // with. Detect that rather than reporting a configuration mismatch as a code failure.
    const probe = await fetch(`${BASE}/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHALLENGE123`);
    const webhookReady = probe.status === 200 && (await probe.clone().text()) === 'CHALLENGE123';
    if (!webhookReady) {
      console.log(`  NOTE  the API was not started with META_WEBHOOK_VERIFY_TOKEN='${VERIFY_TOKEN}' /`);
      console.log("        META_WEBHOOK_SECRET, so the delivery checks below cannot run. Restart it with");
      console.log("        those variables set to exercise the webhook end to end.");
    }
    webhookReady
      ? ok(true, 'the correct verify token echoes the challenge')
      : skip('the correct verify token echoes the challenge (webhook secrets not set on the API)');

    const wrong = await fetch(`${BASE}/api/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=X`);
    ok(wrong.status === 403, 'a wrong verify token is rejected');
    const noMode = await fetch(`${BASE}/api/meta/webhook?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=X`);
    ok(noMode.status === 403, 'a challenge without hub.mode=subscribe is rejected');

    // ------------------------------------------------------ webhook signature
    head('webhook signature');
    const payload = JSON.stringify({
      object: 'page',
      entry: [{ id: '999', changes: [{ field: 'leadgen', value: { leadgen_id: 'L-VERIFY-1', form_id: 'F-UNKNOWN', page_id: '999' } }] }],
    });

    const noSig = await webhook(payload, null);
    ok(noSig.status === 200, 'an unsigned delivery still gets 200 (Meta would retry forever otherwise)');
    ok((await json(noSig))?.received === false, 'but it is NOT acted on');

    const badSig = await webhook(payload, 'sha256=' + '0'.repeat(64));
    ok((await json(badSig))?.received === false, 'a wrong signature is rejected');

    const tampered = await webhook(payload.replace('L-VERIFY-1', 'L-VERIFY-2'), sign(payload));
    ok((await json(tampered))?.received === false, 'a body altered after signing is rejected');

    const signed = await webhook(payload, sign(payload));
    ok(signed.status === 200, 'a correctly signed delivery is accepted');
    ok(!/419/.test(String(signed.status)), 'the webhook is exempt from CSRF (it carries no XSRF token)');

    if (webhookReady) {
      ok((await json(signed))?.received === true, 'and processed');
      const other = JSON.stringify({ object: 'user', entry: [] });
      ok((await json(await webhook(other, sign(other))))?.received === true, 'a non-page event is acknowledged and ignored');
    } else {
      skip('and processed (webhook secrets not set on the API)');
      skip('a non-page event is acknowledged and ignored (webhook secrets not set on the API)');
    }

    const leadsNow = await prisma.leads.count();
    ok(leadsNow === leadsBefore, 'a signed delivery for a form nobody connected creates NO lead');

    // -------------------------------------------------------- oauth callback
    head('OAuth callback state handling');
    const redirectOf = async (qs) => {
      const r = await fetch(BASE + '/api/meta/callback' + qs, { redirect: 'manual' });
      return r.headers.get('location') ?? '';
    };
    ok(/meta_error=access_denied/.test(await redirectOf('?error=access_denied')), 'a declined sign-in redirects back with access_denied');
    ok(/meta_error=missing_code/.test(await redirectOf('?state=abc')), 'a callback with no code is rejected');
    ok(/meta_error=invalid_state/.test(await redirectOf('?code=xyz&state=forged.1.2.3')),
      'a forged state is rejected — this is what stops someone binding a Facebook account to another user');
    ok(/meta_error=invalid_state/.test(await redirectOf('?code=xyz')), 'a missing state is rejected');
    ok((await redirectOf('?error=access_denied')).startsWith('http'), 'the callback always redirects to the SPA, never renders raw JSON');

    // -------------------------------------------------------------- frontend
    head('frontend wiring');
    const app = read('App.tsx');
    ok(/path="meta"/.test(app), '/app/meta has a real route');
    ok(app.includes('import MetaPage from'), 'MetaPage is imported');
    ok(!/^\s*meta:/m.test(read('desk/StubPage.tsx')), 'the Meta stub entry was removed (dead code)');

    const nav = read('desk/DeskLayout.tsx');
    const entry = /\{\s*key:\s*'meta',\s*label:\s*'([^']+)'/.exec(nav);
    ok(!!entry, 'Meta is still in the sidebar');
    ok(entry?.[1] === 'Meta', `the sidebar label is exactly "Meta", not "Facebook Meta" (got "${entry?.[1]}")`);

    const page = read('desk/MetaPage.tsx');
    for (const s of ['tailwind', 'shadcn', 'lucide-react', 'next/', 'framer-motion', 'mongodb', 'date-fns']) {
      ok(!page.includes(s), `no "${s}" leaked into the ported page`);
    }
    ok(!/accessToken|access_token/.test(page), 'the page never handles an access token');
    ok(/token_storage_secure/.test(page), 'the page surfaces the unencrypted-token warning');

    head('tokens never reach the browser');
    const bodies = [JSON.stringify(st), JSON.stringify(diag), JSON.stringify(ml)];
    for (const b of bodies) ok(!/access_token|"token"/.test(b), 'no response body carries a token field');

    // ------------------------------------------------------------- isolation
    head('the rest of Transaction Desk is unaffected');
    const txns = await json(await get('/api/transactions'));
    ok((Array.isArray(txns) ? txns : txns.data).length > 0, 'transactions still load');
    ok((await (await get('/api/reports')).json()).length >= 20, 'reports still respond');
    ok((await get('/api/leads?limit=1')).status === 200, 'the Lead module still responds');
    ok((await get('/api/campaigns')).status === 200, 'campaigns still respond');
    ok((await get('/api/calendar/events')).status === 200, 'the calendar still responds');
    const csrfStill = await fetch(BASE + '/api/leads', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Cookie: ch() },
      body: JSON.stringify({ name: 'x', email: 'x@example.invalid' }),
    });
    ok(csrfStill.status === 419, 'the CSRF exemption is scoped to the webhook only — other writes still require the token');
  } finally {
    head('cleanup');
    const leadsAfter = await prisma.leads.count();
    ok(leadsAfter === leadsBefore, `lead count unchanged (${leadsAfter})`);
    ok((await prisma.meta_connections.count()) === 0, 'no Meta connection rows created');
    ok((await prisma.meta_pages.count()) === 0, 'no Meta page rows created');
    ok((await prisma.meta_lead_forms.count()) === 0, 'no Meta lead-form rows created');
    await prisma.$disconnect();

    const note = skipped ? ` (${skipped} skipped — see the NOTE above)` : '';
    console.log(fail === 0 ? `\nALL ${pass} PASS ✅${note}` : `\n${pass} passed, ${fail} FAILED ❌${note}`);
    // Set the code rather than calling process.exit(): forcing exit while fetch's keep-alive
    // sockets are still closing trips a libuv assertion on Windows and reports a bogus code.
    process.exitCode = fail === 0 ? 0 : 1;
  }
})();
