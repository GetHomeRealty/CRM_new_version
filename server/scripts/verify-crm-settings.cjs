/**
 * CRM Settings migration verification.
 *
 * Proves every migrated field, section, validation and action works, AND that Transaction
 * Desk's own Email Settings (mail accounts, transactional templates, company settings) is
 * byte-for-byte unchanged.
 *
 * SAFETY: the advanced-email actions really send. Anything that would dispatch is only
 * exercised when MAIL_REDIRECT_TO is set; otherwise those checks are skipped and the reason is
 * printed. Two real emails have already been sent by accident in this project — do not remove
 * this guard.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');
const REDIRECT = (process.env.MAIL_REDIRECT_TO || '').trim();

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

(async () => {
  const prisma = new PrismaClient();
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  if (take(await send('POST', '/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' })).status !== 200) {
    console.error('login failed'); process.exitCode = 1; return;
  }

  // Snapshot everything Transaction Desk owns, to prove none of it moved.
  const before = {
    accounts: await prisma.mail_accounts.findMany({ orderBy: { id: 'asc' } }),
    templates: await prisma.email_templates.findMany({ orderBy: { id: 'asc' } }),
    company: await prisma.company_settings.findMany(),
    campaignTemplates: await prisma.campaign_templates.count({ where: { deleted_at: null } }),
    me: await prisma.users.findFirst({ where: { email: ADMIN_LOGIN } }),
  };

  try {
    if (!REDIRECT) {
      console.log('\nNOTE  MAIL_REDIRECT_TO is not set, so the checks that would dispatch a real');
      console.log('      email are skipped. Set it and restart the API to exercise them.');
    }

    // ---------------------------------------------------------------- settings
    head('settings: load, defaults and scoping');
    const s = await json(await get('/api/crm-settings'));
    ok(s.scope === 'global' && s.is_admin === true, 'an administrator edits the shared global scope, as in the CRM');
    for (const k of ['emailAlerts', 'smsAlerts', 'leadNotifications', 'showingReminders', 'marketUpdates', 'documentAlerts']) {
      ok(k in s.notifications, `notification "${k}" is present`);
    }
    ok(s.notifications.marketUpdates === false, 'marketUpdates defaults to false, matching the CRM');
    ok(s.notifications.emailAlerts === true, 'emailAlerts defaults to true');
    for (const k of ['signature', 'replyTemplate', 'autoResponder', 'forwardingAddress']) {
      ok(k in s.emailSettings, `email setting "${k}" is present`);
    }
    ok(s.emailSettings.autoResponder.enabled === false, 'the auto-responder is off by default');
    for (const k of ['language', 'timeZone', 'currency', 'dateFormat', 'theme']) ok(k in s.preferences, `preference "${k}" is present`);
    ok(s.preferences.timeZone === 'America/Toronto' && s.preferences.currency === 'CAD', 'CRM preference defaults preserved');
    for (const k of ['birthdayWishes', 'weddingGreetings', 'seasonalWishes', 'promotionalOffers', 'referralCodes']) {
      ok(k in s.templates, `trigger template "${k}" is present`);
    }
    ok(s.templates.birthdayWishes.daysBefore === 1, 'birthdayWishes keeps its daysBefore field');
    ok(s.templates.birthdayWishes.template === 'Happy Birthday!', 'the CRM default copy is preserved');

    head('settings: save and validation');
    const bad = await send('PUT', '/api/crm-settings', {});
    ok(bad.status === 400 && /Invalid settings structure/.test((await json(bad))?.message ?? ''),
      'an empty body is rejected with the CRM\'s own message');

    const saved = await json(await send('PUT', '/api/crm-settings', {
      notifications: { ...s.notifications, smsAlerts: false, marketUpdates: true },
      preferences: { ...s.preferences, currency: 'USD', theme: 'dark' },
    }));
    ok(saved.notifications.smsAlerts === false && saved.notifications.marketUpdates === true, 'notification switches persist');
    ok(saved.preferences.currency === 'USD' && saved.preferences.theme === 'dark', 'preferences persist');
    ok(saved.emailSettings.signature === '', 'a partial save leaves the untouched sections alone');

    const junkPref = await json(await send('PUT', '/api/crm-settings', { preferences: { ...s.preferences, currency: 'DOGE', theme: 'neon' } }));
    ok(junkPref.preferences.currency === 'CAD' && junkPref.preferences.theme === 'light',
      'an unknown preference value falls back to the default rather than being stored');

    const badEmail = await send('PUT', '/api/crm-settings', { emailSettings: { ...s.emailSettings, forwardingAddress: 'not-an-email' } });
    ok(badEmail.status === 400, 'an invalid forwarding address is rejected');

    const sig = await json(await send('PUT', '/api/crm-settings', {
      emailSettings: { signature: 'Jane — Get Home Realty', replyTemplate: 'Thanks for writing.', autoResponder: { enabled: true, message: 'Away until Monday.' }, forwardingAddress: 'desk@example.invalid' },
    }));
    ok(sig.emailSettings.signature.startsWith('Jane'), 'signature saved');
    ok(sig.emailSettings.autoResponder.enabled === true && sig.emailSettings.autoResponder.message.startsWith('Away'), 'the nested auto-responder object round-trips');

    const tpl = await json(await send('PUT', '/api/crm-settings', {
      templates: { ...s.templates, birthdayWishes: { enabled: true, daysBefore: 7, template: 'Many happy returns!' } },
    }));
    ok(tpl.templates.birthdayWishes.daysBefore === 7 && tpl.templates.birthdayWishes.enabled === true, 'a trigger template can be edited');

    ok((await json(await send('POST', '/api/crm-settings', { preferences: sig.preferences })))?.message === 'Settings saved successfully',
      'POST works as an alias of PUT, as it did in the CRM');

    // ----------------------------------------------------------------- profile
    head('profile: the Personal Information form');
    const p = await json(await get('/api/crm-settings/profile'));
    for (const k of ['name', 'username', 'email', 'phone', 'role']) ok(k in p, `profile field "${k}" is served`);

    const noName = await send('PUT', '/api/crm-settings/profile', { name: '', username: 'x' });
    ok(noName.status === 400, 'name is required');
    // Username is required only once an account has one — Transaction Desk's column is nullable
    // and existing accounts have none, so a blanket requirement would lock them out.
    const noUser = await send('PUT', '/api/crm-settings/profile', { name: 'x', username: '' });
    ok(noUser.status === (p.username ? 400 : 200),
      p.username ? 'a username cannot be blanked out once set' : 'an account without a username can still save the form');
    const badMail = await send('PUT', '/api/crm-settings/profile', { name: p.name, username: p.username, email: 'nope' });
    ok(badMail.status === 400 && /valid email/i.test((await json(badMail))?.message ?? ''), 'an invalid email is rejected with the CRM\'s message');

    const savedProfile = await json(await send('PUT', '/api/crm-settings/profile', {
      name: p.name, username: p.username, email: p.email, phone: '416-555-0199',
    }));
    ok(savedProfile.phone === '416-555-0199', 'the phone number persists (a column that did not exist before)');
    ok(savedProfile.role === p.role, 'role is unchanged by this form');

    // Role must not be writable here — that would be privilege escalation.
    await send('PUT', '/api/crm-settings/profile', { name: p.name, username: p.username, email: p.email, role: 'admin', phone: '416-555-0199' });
    const afterRole = await prisma.users.findUnique({ where: { id: p.id }, select: { role: true } });
    ok(afterRole.role === before.me.role, 'role cannot be escalated through the profile form');

    // ---------------------------------------------------------- email settings
    head('email settings and triggers');
    const es = await json(await get('/api/crm-settings/email-settings'));
    for (const k of ['smtpHost', 'smtpPort', 'smtpUser', 'adminEmail', 'autoSendEnabled', 'emailTemplates']) {
      ok(k in es, `email setting "${k}" is served`);
    }
    for (const k of ['birthday', 'anniversary', 'wedding', 'seasonal', 'promotional', 'referral']) {
      ok(k in es.emailTemplates, `trigger switch "${k}" is present`);
    }

    ok((await send('PUT', '/api/crm-settings/email-settings', { adminEmail: 'bad' })).status === 400, 'an invalid admin email is rejected');
    ok((await send('PUT', '/api/crm-settings/email-settings', { smtpPort: 'abc' })).status === 400, 'a non-numeric SMTP port is rejected');

    const savedEs = await json(await send('PUT', '/api/crm-settings/email-settings', {
      smtpHost: 'smtp.example.com', smtpPort: '587', smtpUser: 'crm@example.invalid',
      adminEmail: 'admin@example.invalid', autoSendEnabled: true,
      emailTemplates: { ...es.emailTemplates, wedding: false },
    }));
    ok(savedEs.smtpHost === 'smtp.example.com' && savedEs.smtpPort === '587', 'SMTP fields persist');
    ok(savedEs.emailTemplates.wedding === false, 'a trigger can be switched off');

    // The CRM refused to send when a trigger was off — the behaviour that matters most here.
    const disabled = await json(await send('POST', '/api/crm-settings/email-settings', {
      action: 'sendWeddingEmail', leadName: 'Test', leadEmail: 'nobody@example.invalid', weddingDate: '2026-08-01',
    }));
    ok(disabled.success === false && /disabled/i.test(disabled.message), `a disabled trigger refuses to send: "${disabled.message}"`);
    ok((await prisma.crm_email_log.count({ where: { recipient: 'nobody@example.invalid' } })) === 0, 'and nothing was dispatched or logged');

    await send('PUT', '/api/crm-settings/email-settings', { ...savedEs, emailTemplates: { ...es.emailTemplates, wedding: true } });

    head('the CRM action dispatcher');
    ok((await json(await send('POST', '/api/crm-settings/email-settings', { action: 'nonsense' })))?.error === 'Invalid action',
      'an unknown action returns the CRM\'s "Invalid action"');
    const viaAction = await json(await send('POST', '/api/crm-settings/email-settings', {
      action: 'updateSettings', smtpHost: 'smtp.updated.example', smtpPort: '465', emailTemplates: es.emailTemplates,
    }));
    ok(viaAction.smtpHost === 'smtp.updated.example', 'the updateSettings action still saves, as in the CRM');

    head('referral codes');
    const gen = await json(await send('POST', '/api/crm-settings/email-settings', {
      action: 'generateReferralCode', discount: 15, validDays: 45, maxUsage: 3,
    }));
    ok(gen.success === true && /^GHR-[A-Z2-9]{6}$/.test(gen.data.code), `a code is generated (${gen.data?.code})`);
    ok(gen.data.discount === 15 && gen.data.maxUsage === 3, 'the requested discount and usage cap are stored');
    const codes = await json(await get('/api/crm-settings/referral-codes'));
    ok(codes.some((c) => c.code === gen.data.code), 'it appears in the referral code list');
    const clamped = await json(await send('POST', '/api/crm-settings/email-settings', { action: 'generateReferralCode', discount: 9999 }));
    ok(clamped.data.discount === 100, 'an out-of-range discount is clamped rather than stored');

    head('broadcasts');
    ok((await send('POST', '/api/crm-settings/broadcasts', { message: '  ' })).status === 400, 'an empty broadcast is rejected');
    const bc = await json(await send('POST', '/api/crm-settings/broadcasts', { message: 'CRM migration test broadcast', type: 'info' }));
    ok(bc.recipients > 0, `a broadcast records its audience (${bc.recipients} active user(s))`);
    ok((await json(await get('/api/crm-settings/broadcasts'))).some((b) => b.message.includes('CRM migration test')), 'and is listed back');

    head('integrations');
    const ints = await json(await get('/api/crm-settings/integrations'));
    for (const k of ['email', 'google_calendar', 'meta', 'mail_redirect']) ok(k in ints, `integration "${k}" is reported`);
    ok(ints.email.connected === true, 'email integration reflects the real mail accounts');
    ok(ints.google_calendar.connected === false && /not part of the migrated code/i.test(ints.google_calendar.detail),
      'Google Calendar is honestly reported as unavailable rather than shown as a dead button');
    ok(ints.mail_redirect.active === !!REDIRECT, 'the mail-redirect state is reported accurately');

    head('sending (only with MAIL_REDIRECT_TO set)');
    if (!REDIRECT) {
      skip('a wedding email can be sent and logged');
      skip('a custom email requires a subject and body');
      skip('bulk send reports per-recipient outcomes');
    } else {
      const sent = await json(await send('POST', '/api/crm-settings/email-settings', {
        action: 'sendWeddingEmail', leadName: 'Verify Person', leadEmail: 'verify@example.invalid', weddingDate: '2026-08-01',
      }));
      ok(typeof sent.success === 'boolean', `wedding send returned an outcome: "${sent.message}"`);
      ok((await prisma.crm_email_log.count({ where: { recipient: 'verify@example.invalid' } })) > 0, 'the attempt is recorded in the CRM email log');

      const noSubject = await send('POST', '/api/crm-settings/email-settings', {
        action: 'sendCustomEmail', leadEmail: 'verify@example.invalid', subject: '', content: 'x',
      });
      ok(noSubject.status === 400, 'a custom email without a subject is rejected');

      const bulk = await json(await send('POST', '/api/crm-settings/email-settings', {
        action: 'bulkSend', emailType: 'seasonal',
        emailData: { season: 'Winter', year: '2026' },
        leads: [{ name: 'A', email: 'a@example.invalid' }, { name: 'B', email: 'not-an-email' }],
      }));
      ok(Array.isArray(bulk.results) && bulk.results.length === 2, 'bulk send reports one result per recipient');
      ok(bulk.results[1].success === false, 'an invalid address fails on its own without aborting the batch');
    }

    head('guards');
    ok((await fetch(BASE + '/api/crm-settings', { headers: H })).status === 401, 'CRM settings require a session');
    const noCsrf = await fetch(BASE + '/api/crm-settings/profile', {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json', Cookie: ch() }, body: '{}',
    });
    ok(noCsrf.status === 419, 'a write without the CSRF token is refused');

    head('audit trail');
    const audit = await json(await get('/api/audit-logs?category=Settings'));
    ok((audit.data ?? []).some((r) => String(r.section) === 'CRM Settings'), 'CRM settings changes are written to the global audit trail');

    // ============ the whole point: Transaction Desk must be untouched ============
    head('Transaction Desk Email Settings is unchanged');
    const afterAccounts = await prisma.mail_accounts.findMany({ orderBy: { id: 'asc' } });
    const afterTemplates = await prisma.email_templates.findMany({ orderBy: { id: 'asc' } });
    const afterCompany = await prisma.company_settings.findMany();
    ok(JSON.stringify(afterAccounts) === JSON.stringify(before.accounts), `all ${afterAccounts.length} SMTP accounts are byte-for-byte unchanged`);
    ok(JSON.stringify(afterTemplates) === JSON.stringify(before.templates), `all ${afterTemplates.length} transactional templates are unchanged`);
    ok(JSON.stringify(afterCompany) === JSON.stringify(before.company), 'company settings are unchanged');
    ok((await get('/api/mail-accounts')).status === 200, 'the mail-accounts endpoint still works');
    ok((await get('/api/email-templates')).status === 200, 'the email-templates endpoint still works');
    ok((await get('/api/mail-events')).status === 200, 'the mail-events endpoint still works');
    ok((await get('/api/company-settings')).status === 200, 'company settings still respond');
    ok((await prisma.campaign_templates.count({ where: { deleted_at: null } })) === before.campaignTemplates,
      `the ${before.campaignTemplates} campaign templates are untouched`);

    head('frontend wiring');
    const page = read('desk/EmailSettingsPage.tsx');
    ok(page.includes('import CrmSettingsPanel'), 'the CRM panel is imported by Email Settings');
    ok(/tab === 'crm'/.test(page), 'it has its own tab');
    ok(/tab === 'accounts' && <AccountsTab/.test(page), 'the existing SMTP Accounts tab still renders');
    ok(/tab === 'templates' && <TemplatesTab/.test(page), 'the existing Templates tab still renders');
    const panel = read('desk/CrmSettingsPanel.tsx');
    for (const s2 of ['tailwind', 'shadcn', 'lucide-react', 'next/', 'framer-motion', 'mongodb']) {
      ok(!panel.includes(s2), `no "${s2}" leaked into the migrated panel`);
    }
    for (const section of ['Personal Information', 'Notification Settings', 'Broadcast Message', 'Email Preferences', 'Preferences', 'Email Campaigns', 'Trigger Templates', 'Referral Codes', 'Integrations']) {
      ok(panel.includes(section), `the panel renders the "${section}" section`);
    }

    head('the rest of Transaction Desk is unaffected');
    const txns = await json(await get('/api/transactions'));
    ok((Array.isArray(txns) ? txns : txns.data).length > 0, 'transactions still load');
    ok((await (await get('/api/reports')).json()).length >= 20, 'reports still respond');
    ok((await get('/api/leads?limit=1')).status === 200, 'leads still respond');
    ok((await get('/api/campaigns')).status === 200, 'campaigns still respond');
    ok((await get('/api/calendar/todos')).status === 200, 'calendar todos still respond');
    ok((await get('/api/meta/status')).status === 200, 'meta still responds');
  } finally {
    head('cleanup');
    await prisma.crm_settings.deleteMany({});
    await prisma.crm_email_settings.deleteMany({});
    await prisma.crm_referral_codes.deleteMany({});
    await prisma.crm_email_log.deleteMany({});
    await prisma.crm_broadcasts.deleteMany({});
    if (before.me) {
      await prisma.users.update({ where: { id: before.me.id }, data: { phone: before.me.phone ?? null, name: before.me.name, username: before.me.username, email: before.me.email } });
    }
    ok((await prisma.crm_settings.count()) === 0, 'CRM settings rows removed');
    ok((await prisma.crm_email_log.count()) === 0, 'CRM email log cleared');
    const me = await prisma.users.findUnique({ where: { id: before.me.id } });
    ok(me.phone === (before.me.phone ?? null) && me.name === before.me.name, 'the admin user record is back as it was');
    await prisma.$disconnect();

    const note = skipped ? ` (${skipped} skipped — see the NOTE above)` : '';
    console.log(fail === 0 ? `\nALL ${pass} PASS ✅${note}` : `\n${pass} passed, ${fail} FAILED ❌${note}`);
    // Set the code rather than calling process.exit(): forcing exit while fetch's keep-alive
    // sockets are still closing trips a libuv assertion on Windows and reports a bogus code.
    process.exitCode = fail === 0 ? 0 : 1;
  }
})();
