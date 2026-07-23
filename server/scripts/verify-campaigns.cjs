/**
 * Verifies the Campaigns module: lead import, audience segmentation, suppression,
 * personalisation, send loop, open tracking, unsubscribe, and the public endpoints.
 *
 * All sends are directed at example.invalid, whose domain has no MX record, so the
 * deliverability guard marks them bounced and NO real email is ever dispatched.
 */
const { PrismaClient } = require('@prisma/client');
// The super-admin's sign-in address is editable in the app, so it is not hard-coded here.
const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const jar = {};
const take = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) { const nv = c.split(';')[0], i = nv.indexOf('='); if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1); } return r; };
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } });
const send = (m, p, b) => fetch(BASE + p, { method: m, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: b ? JSON.stringify(b) : undefined });
const TAG = 'CAMPVERIFY';

(async () => {
  const prisma = new PrismaClient();
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() }, body: JSON.stringify({ username: ADMIN_LOGIN, password: 'Admin@123' }) }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exit(1); }

  const cleanup = async () => {
    const leads = await prisma.leads.findMany({ where: { email: { contains: 'example.invalid' } }, select: { id: true } });
    const ids = leads.map((l) => l.id);
    const camps = await prisma.campaigns.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    await prisma.campaign_recipients.deleteMany({ where: { OR: [{ campaign_id: { in: camps.map((c) => c.id) } }, { lead_id: { in: ids } }] } });
    await prisma.campaigns.deleteMany({ where: { id: { in: camps.map((c) => c.id) } } });
    await prisma.leads.deleteMany({ where: { id: { in: ids } } });
    await prisma.email_suppressions.deleteMany({ where: { email: { contains: 'example.invalid' } } });
    const tpls = await prisma.campaign_templates.deleteMany({ where: { name: { startsWith: TAG } } });
    console.log(`(cleaned up ${ids.length} lead(s), ${camps.length} campaign(s), ${tpls.count} template(s))`);
  };

  try {
    await cleanup(); // start from a known state

    // ---- options ---------------------------------------------------------
    console.log('--- builder vocabularies ---');
    const opts = await (await get('/api/campaigns/options')).json();
    ok(opts.lead_status.length === 4, `lead statuses: ${opts.lead_status.join(', ')}`);
    ok(opts.lead_type.length === 7, `lead types: ${opts.lead_type.length}`);
    ok(opts.lead_source.includes('meta'), `lead sources include meta: ${opts.lead_source.join(', ')}`);
    ok(opts.client_type.length === 5, `client types: ${opts.client_type.length}`);
    ok(opts.max_recipients === 300, 'the 300-recipient cap is exposed');
    // The campaign template library starts empty — an install with no templates yet is a valid
    // state, so assert the shape rather than a count this suite hasn't created yet.
    ok(Array.isArray(opts.templates), `the template library is served (${opts.templates.length} template(s))`);
    ok(opts.templates.every((t) => Array.isArray(t.variables)), 'each template reports the tokens it uses');
    ok(opts.fillable_tokens.includes('LEAD_NAME') && opts.fillable_tokens.includes('PROPERTY_PRICE'), 'fillable token list published');

    // ---- lead import -----------------------------------------------------
    console.log('--- lead import ---');
    const csv = [
      'name,email,phone,status,type,source,clienttype',
      'Ada Buyer,ada@example.invalid,4165550001,hot,buyer,meta,Investor',
      'Bob Seller,bob@example.invalid,4165550002,warm,seller,linkedin,first home buyer',
      'Cy Cold,cy@example.invalid,,cold,tenant,youtube,',
      'Dup Again,ADA@example.invalid,,hot,buyer,meta,',
      'No Email,,4165550003,hot,buyer,meta,',
      'Bad Email,not-an-email,,hot,buyer,meta,',
    ].join('\n');
    const imp = await (await send('POST', '/api/campaigns/leads/import', { csv, tag: 'Verify' })).json();
    ok(imp.imported === 3, `3 leads imported (${imp.imported})`);
    ok(imp.invalid === 2, `2 rows skipped for a bad/missing email (${imp.invalid})`);
    ok(imp.tagged === 0, 'the duplicate address was not imported twice');
    const dbLeads = await prisma.leads.count({ where: { email: { contains: 'example.invalid' } } });
    ok(dbLeads === 3, `database holds 3 leads (${dbLeads})`);
    const ada = await prisma.leads.findFirst({ where: { email: 'ada@example.invalid' } });
    ok(ada.lead_status === 'hot' && ada.lead_type === 'buyer' && ada.lead_source === 'meta', 'segmentation fields imported');
    ok(JSON.parse(ada.tags).includes('Verify'), 'the import tag was applied');

    // re-import tags the existing address instead of duplicating it
    const imp2 = await (await send('POST', '/api/campaigns/leads/import', { csv, tag: 'SecondPass' })).json();
    ok(imp2.imported === 0 && imp2.tagged === 3, `re-import tags existing leads rather than duplicating (${imp2.tagged} tagged)`);
    ok((await prisma.leads.count({ where: { email: { contains: 'example.invalid' } } })) === 3, 'still only 3 leads');

    // ---- audience segmentation ------------------------------------------
    console.log('--- audience segmentation ---');
    const preview = (b) => send('POST', '/api/campaigns/preview', b).then((r) => r.json());
    const all = await preview({ tag: 'Verify' });
    ok(all.count === 3, `tag filter matches 3 (${all.count})`);
    ok(all.sample.length === 3 && all.sample[0].email, 'a sample of recipients is returned');
    ok((await preview({ tag: 'Verify', leadStatus: 'hot' })).count === 1, 'status filter narrows to 1');
    ok((await preview({ tag: 'Verify', leadStatus: 'HOT' })).count === 1, 'status matching is case-insensitive');
    ok((await preview({ tag: 'Verify', leadSource: 'meta' })).count === 1, 'source filter works');
    ok((await preview({ tag: 'Verify', clientType: 'Investor' })).count === 1, 'client-type filter works');
    ok((await preview({ tag: 'Verify', leadType: 'seller', leadStatus: 'hot' })).count === 0, 'filters combine (AND)');
    ok((await preview({ tag: 'NoSuchTag' })).count === 0, 'an unmatched tag returns nobody');

    // ---- bulk tagging ----------------------------------------------------
    console.log('--- bulk tagging ---');
    const tagPrev = await (await send('POST', '/api/campaigns/leads/tag', { preview: true, tag: 'Verify', leadStatus: 'hot' })).json();
    ok(tagPrev.count === 1, `tag preview counts without changing anything (${tagPrev.count})`);
    const applied = await (await send('POST', '/api/campaigns/leads/tag', { tag: 'Verify', leadStatus: 'hot', tagToApply: 'Priority', mode: 'add' })).json();
    ok(applied.count === 1, `tag applied to 1 lead: ${applied.message}`);
    ok((await (await get('/api/campaigns/leads/tags')).json()).tags.includes('Priority'), 'the new tag appears in the tag list');
    const removed = await (await send('POST', '/api/campaigns/leads/tag', { tag: 'Priority', tagToApply: 'Priority', mode: 'remove' })).json();
    ok(removed.count === 1, 'a tag can be removed again');

    // ---- validation ------------------------------------------------------
    console.log('--- send validation ---');
    // Campaigns now draw on their own template library rather than Email Settings' transactional
    // templates, so the suite provides its own and removes it in the cleanup below.
    let tpl = opts.templates[0];
    if (!tpl) {
      const made = await (await send('POST', '/api/campaigns/templates', {
        name: `${TAG} verify template`,
        subject: 'Hello {{LEAD_NAME}}',
        content: '<p>Hello {{LEAD_NAME}}, from {{AGENT_NAME}}.</p>',
        category: 'custom',
      })).json();
      ok(!!made?.id, `created a campaign template for the send tests (#${made?.id})`);
      tpl = made;
    }
    const bad = async (body, re, label) => {
      const r = await send('POST', '/api/campaigns', body);
      const j = await r.json();
      ok(r.status >= 400 && re.test(j.message ?? ''), `${label}: "${j.message}"`);
    };
    await bad({ template_id: tpl.id, tag: 'Verify' }, /name is required/i, 'missing name rejected');
    await bad({ name: `${TAG} x`, tag: 'Verify' }, /valid template/i, 'missing template rejected');
    await bad({ name: `${TAG} x`, template_id: 999999, tag: 'Verify' }, /not found/i, 'unknown template rejected');
    await bad({ name: `${TAG} x`, template_id: tpl.id, tag: 'NoSuchTag' }, /no leads match/i, 'empty audience rejected');

    // ---- send ------------------------------------------------------------
    console.log('--- send (example.invalid has no MX, so nothing is delivered) ---');
    const before = await prisma.campaigns.count();
    const res = await send('POST', '/api/campaigns', { name: `${TAG} run`, template_id: tpl.id, tag: 'Verify', tags: ['Verify'] });
    ok(res.status === 201, `campaign created and sent (${res.status})`);
    const camp = await res.json();
    ok(camp.stats.total === 3, `3 recipients (${camp.stats.total})`);
    ok(camp.stats.bounced === 3 && camp.stats.sent === 0, `all 3 bounced on the DNS guard, none delivered (sent=${camp.stats.sent}, bounced=${camp.stats.bounced})`);
    ok(camp.status === 'failed', `status reflects that nothing was delivered ("${camp.status}")`);
    ok((await prisma.campaigns.count()) === before + 1, 'exactly one campaign row created');

    const detail = await (await get(`/api/campaigns/${camp.id}`)).json();
    ok(detail.recipients.length === 3, 'detail returns every recipient');
    ok(detail.recipients.every((r) => r.status === 'failed' && r.bounced), 'each recipient records its own outcome');
    ok(detail.recipients.every((r) => /cannot receive mail/i.test(r.error ?? '')), 'the bounce reason is recorded per recipient');
    ok(!!detail.subject && !!detail.content, 'the sent subject/body are snapshotted on the campaign');
    ok(detail.audience.tag === 'Verify', 'the audience filter is stored with the campaign');

    const rows = await prisma.campaign_recipients.findMany({ where: { campaign_id: camp.id } });
    ok(rows.every((r) => r.token && r.token.length >= 32), 'every recipient has an unguessable tracking token');
    ok(new Set(rows.map((r) => r.token)).size === 3, 'tokens are unique per recipient');

    // ---- open tracking (public) -----------------------------------------
    console.log('--- open tracking (public endpoint) ---');
    const token = rows[0].token;
    const pixelUrl = `/api/campaigns/track/open?c=${camp.id}&t=${token}`;
    const anon = { Accept: 'image/gif', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' };
    const px = await fetch(BASE + pixelUrl, { headers: anon });
    const body = Buffer.from(await px.arrayBuffer());
    ok(px.status === 200 && px.headers.get('content-type') === 'image/gif', 'the pixel is served without authentication');
    ok(body.slice(0, 3).toString() === 'GIF', `a real GIF is returned (${body.length} bytes)`);
    ok(/no-store/.test(px.headers.get('cache-control') ?? ''), 'the pixel is never cached');
    // a bounced recipient can't have read the mail, so it must not count
    let after = await prisma.campaign_recipients.findUnique({ where: { token } });
    ok(!after.opened, 'an open is NOT counted for a bounced recipient');

    // make one recipient look delivered, then re-test
    await prisma.campaign_recipients.update({ where: { token }, data: { status: 'sent', bounced: false } });
    await prisma.campaigns.update({ where: { id: camp.id }, data: { sent_at: new Date(Date.now() - 60_000) } });
    await fetch(BASE + pixelUrl, { headers: anon });
    after = await prisma.campaign_recipients.findUnique({ where: { token } });
    ok(after.opened && !!after.opened_at, 'a delivered recipient records an open');
    let campRow = await prisma.campaigns.findUnique({ where: { id: camp.id } });
    ok(campRow.opened === 1, `the campaign open count incremented once (${campRow.opened})`);
    await fetch(BASE + pixelUrl, { headers: anon });
    campRow = await prisma.campaigns.findUnique({ where: { id: camp.id } });
    ok(campRow.opened === 1, 're-opening does not double-count');

    // scanners and prefetchers are ignored
    await prisma.campaign_recipients.update({ where: { token: rows[1].token }, data: { status: 'sent', bounced: false } });
    await fetch(`${BASE}/api/campaigns/track/open?c=${camp.id}&t=${rows[1].token}`, { headers: { 'User-Agent': 'Barracuda Sentinel' } });
    ok(!(await prisma.campaign_recipients.findUnique({ where: { token: rows[1].token } })).opened, 'a security scanner user-agent is not counted as an open');
    await prisma.campaigns.update({ where: { id: camp.id }, data: { sent_at: new Date() } });
    await fetch(`${BASE}/api/campaigns/track/open?c=${camp.id}&t=${rows[1].token}`, { headers: anon });
    ok(!(await prisma.campaign_recipients.findUnique({ where: { token: rows[1].token } })).opened, 'a hit within the machine-prefetch window is not counted');
    ok((await fetch(`${BASE}/api/campaigns/track/open?c=${camp.id}&t=bogus`, { headers: anon })).status === 200, 'a bogus token still returns the pixel (never an error)');

    // ---- unsubscribe (public) -------------------------------------------
    console.log('--- unsubscribe (public endpoint) ---');
    const un = await fetch(`${BASE}/api/campaigns/unsubscribe?c=${camp.id}&t=${token}`, { headers: { Accept: 'text/html' } });
    const html = await un.text();
    ok(un.status === 200 && /text\/html/.test(un.headers.get('content-type') ?? ''), 'the unsubscribe page renders without authentication');
    ok(/unsubscribed/i.test(html), 'the page confirms the opt-out');
    const rec = await prisma.campaign_recipients.findUnique({ where: { token } });
    ok(rec.unsubscribed && !!rec.unsubscribed_at, 'the recipient is marked unsubscribed');
    campRow = await prisma.campaigns.findUnique({ where: { id: camp.id } });
    ok(campRow.unsubscribed === 1, 'the campaign unsubscribe count incremented');
    const supp = await prisma.email_suppressions.findFirst({ where: { email: rec.email.toLowerCase() } });
    ok(!!supp && supp.reason === 'unsubscribe', 'the address is added to the global suppression list');
    const leadRow = await prisma.leads.findFirst({ where: { email: { equals: rec.email, mode: 'insensitive' } } });
    ok(leadRow.unsubscribed, 'the lead itself is flagged so future audiences skip it');
    ok((await preview({ tag: 'Verify' })).count === 2, 'the unsubscribed lead is excluded from the audience (3 → 2)');
    await fetch(`${BASE}/api/campaigns/unsubscribe?c=${camp.id}&t=${token}`, { headers: { Accept: 'text/html' } });
    campRow = await prisma.campaigns.findUnique({ where: { id: camp.id } });
    ok(campRow.unsubscribed === 1, 'unsubscribing twice does not double-count');
    ok(/not valid/i.test(await (await fetch(`${BASE}/api/campaigns/unsubscribe?c=abc&t=x`)).text()), 'a malformed unsubscribe link is rejected politely');

    // suppression survives even if the lead is re-subscribed
    await prisma.leads.update({ where: { id: leadRow.id }, data: { unsubscribed: false } });
    ok((await preview({ tag: 'Verify' })).count === 2, 'the global suppression list still excludes the address');

    // ---- list / delete ---------------------------------------------------
    console.log('--- list & delete ---');
    const list = await (await get('/api/campaigns')).json();
    ok(list.some((c) => c.id === camp.id), `campaign appears in the list (${list.length})`);
    ok(list.every((c) => c.stats && !('recipients' in c)), 'the list omits the heavy recipient array');
    ok((await get('/api/campaigns/999999')).status === 404, 'unknown campaign 404s');
    ok((await send('DELETE', `/api/campaigns/${camp.id}`)).status === 200, 'campaign deleted');
    ok((await prisma.campaign_recipients.count({ where: { campaign_id: camp.id } })) === 0, 'its recipients are removed with it');

    // ---- tracking health -------------------------------------------------
    console.log('--- tracking health ---');
    const th = await (await get('/api/campaigns/tracking-health')).json();
    ok(typeof th.ok === 'boolean' && typeof th.reason === 'string', `health reported: ok=${th.ok} — ${th.reason}`);
    ok(th.ok === false, 'running on localhost is correctly reported as unreachable for tracking');

    // ---- auth ------------------------------------------------------------
    console.log('--- access control ---');
    ok((await fetch(BASE + '/api/campaigns', { headers: H })).status === 401, 'the campaign list requires authentication');
    ok((await fetch(BASE + '/api/campaigns/track/open?c=1&t=x', { headers: anon })).status === 200, 'the pixel stays public');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
