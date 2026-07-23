/**
 * Campaign template library verification — CRUD, categories, token extraction, attachments
 * (including the size cap), the send path, and the hard separation from Email Settings'
 * transactional templates. Everything it creates is removed in the `finally` block.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

// SAFETY: this suite must never POST /api/campaigns. That endpoint creates AND SENDS to the
// live audience, and the mail accounts in this database are real. An earlier version of this
// file called it once to prove a template id could not be crossed between libraries, and
// emailed an actual lead. Test the separation by reading, never by sending.
const FORBIDDEN_SEND = '/api/campaigns';

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
const send = (m, p, b) => {
  // Hard stop rather than a comment: a POST to /api/campaigns dispatches real mail.
  if (m === 'POST' && p === FORBIDDEN_SEND) {
    throw new Error('Refusing to POST /api/campaigns from a verification script — it sends real email.');
  }
  return fetch(BASE + p, {
    method: m, headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
    ...(b === undefined ? {} : { body: JSON.stringify(b) }),
  });
};
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const MARK = `zztpl-${process.pid}`;
const created = [];

(async () => {
  const prisma = new PrismaClient();
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  if (take(await send('POST', '/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' })).status !== 200) {
    console.error('login failed'); process.exitCode = 1; return;
  }

  const settingsBefore = await prisma.email_templates.findMany({ select: { id: true, name: true, subject: true, body_html: true } });
  const templatesBefore = await prisma.campaign_templates.count({ where: { deleted_at: null } });

  try {
    head('categories');
    const cats = await json(await get('/api/campaigns/templates/categories'));
    const values = cats.categories.map((c) => c.value);
    ok(values.join(',') === 'welcome,follow-up,showing,property-update,thank-you,custom',
      `the six campaign categories are served in order (${values.join(', ')})`);

    head('validation');
    const bad = async (body, what) => {
      const r = await send('POST', '/api/campaigns/templates', body);
      ok(r.status === 400, `${what} → 400 (${(await json(r))?.message})`);
    };
    await bad({}, 'no name, subject or body');
    await bad({ name: 'x', subject: 's' }, 'no body');
    await bad({ name: 'x', subject: 's', content: '<p>c</p>', category: 'newsletter' }, 'unknown category');
    await bad({ name: 'x'.repeat(256), subject: 's', content: 'c' }, 'over-long name');

    head('create and read');
    const mk = async (body) => {
      const r = await send('POST', '/api/campaigns/templates', body);
      const b = await json(r);
      if (r.status === 201) created.push(b.id);
      return { status: r.status, body: b };
    };

    const a = await mk({
      name: `${MARK} Welcome`,
      subject: 'Hi {{LEAD_NAME}}, welcome',
      content: '<p>Hi {{LEAD_NAME}},</p><p>{{PROPERTY_ADDRESS}} at {{PROPERTY_PRICE}}.</p><p>{{AGENT_NAME}}</p>',
      category: 'welcome',
    });
    ok(a.status === 201, 'template created');
    ok(a.body.category === 'welcome', 'category stored');
    ok(a.body.attachment_count === 0, 'a new template has no attachments');

    // Tokens are derived from the current text, not stored, so they can never go stale.
    const vars = a.body.variables;
    ok(vars.includes('LEAD_NAME') && vars.includes('AGENT_NAME') && vars.includes('PROPERTY_ADDRESS') && vars.includes('PROPERTY_PRICE'),
      `tokens are extracted from the subject and body (${vars.join(', ')})`);
    ok(new Set(vars).size === vars.length, 'a token used twice is only listed once');

    const b = await mk({ name: `${MARK} Follow up`, subject: 'Following up', content: '<p>Any thoughts?</p>', category: 'follow-up' });
    ok(b.status === 201, 'a second template created');

    const list = await json(await get('/api/campaigns/templates'));
    ok(list.filter((t) => t.name.startsWith(MARK)).length === 2, 'both appear in the library');
    ok(!('content' in list[0]) || list[0].content === undefined, 'the list omits the body so it stays small');

    const one = await json(await get(`/api/campaigns/templates/${a.body.id}`));
    ok(typeof one.content === 'string' && one.content.includes('{{LEAD_NAME}}'), 'fetching one template returns the body');

    const byCat = await json(await get('/api/campaigns/templates?category=welcome'));
    ok(byCat.every((t) => t.category === 'welcome'), 'the category filter works');
    ok(byCat.some((t) => t.id === a.body.id), 'and includes the matching template');

    head('update');
    const upd = await json(await send('PUT', `/api/campaigns/templates/${b.body.id}`, { subject: 'Still thinking, {{LEAD_NAME}}?' }));
    ok(upd.subject.includes('{{LEAD_NAME}}'), 'template updated');
    ok(upd.variables.includes('LEAD_NAME'), 'tokens are recomputed after an edit, not left stale');
    ok(upd.name === `${MARK} Follow up`, 'a partial update leaves other fields alone');

    head('attachments');
    const pdf = Buffer.from('%PDF-1.4 fake test file').toString('base64');
    const att = await json(await send('POST', `/api/campaigns/templates/${a.body.id}/attachments`,
      { filename: 'brochure.pdf', content_type: 'application/pdf', data: `data:application/pdf;base64,${pdf}` }));
    ok(att.id > 0, 'a file can be attached');
    ok(att.size > 0, `its size is recorded (${att.size} bytes)`);
    ok(!('data' in att), 'the upload response does not echo the file contents back');

    const withAtt = await json(await get(`/api/campaigns/templates/${a.body.id}`));
    ok(withAtt.attachments.length === 1 && withAtt.attachments[0].filename === 'brochure.pdf', 'it is listed on the template');

    const dl = await get(`/api/campaigns/templates/${a.body.id}/attachments/${att.id}`);
    ok(dl.status === 200, 'the file can be downloaded');
    ok(dl.headers.get('content-type') === 'application/pdf', 'with its stored content type');
    // `attachment` matters: a stored .html or .svg must download, never render in our origin.
    ok(/^attachment;/.test(dl.headers.get('content-disposition') ?? ''), 'and as a download rather than inline');
    ok(Buffer.from(await dl.arrayBuffer()).toString().startsWith('%PDF'), 'the bytes round-trip unchanged');

    const empty = await send('POST', `/api/campaigns/templates/${a.body.id}/attachments`, { filename: 'x', data: '' });
    ok(empty.status === 400, 'an empty file is rejected');

    const huge = Buffer.alloc(6 * 1024 * 1024, 1).toString('base64');
    const tooBig = await send('POST', `/api/campaigns/templates/${a.body.id}/attachments`,
      { filename: 'huge.bin', content_type: 'application/octet-stream', data: huge });
    ok(tooBig.status === 400, 'an oversized attachment is rejected before it can break a send');
    ok(/limit/i.test((await json(tooBig))?.message ?? ''), 'and the message explains the limit');

    const wrongTemplate = await get(`/api/campaigns/templates/${b.body.id}/attachments/${att.id}`);
    ok(wrongTemplate.status === 404, "one template's attachment cannot be fetched through another's id");

    ok((await send('DELETE', `/api/campaigns/templates/${a.body.id}/attachments/${att.id}`)).status === 200, 'an attachment can be removed');
    ok((await json(await get(`/api/campaigns/templates/${a.body.id}`))).attachments.length === 0, 'and is gone from the template');

    head('the campaign builder uses this library');
    const opts = await json(await get('/api/campaigns/options'));
    const inOptions = opts.templates.filter((t) => String(t.name).startsWith(MARK));
    ok(inOptions.length === 2, 'campaign templates are offered when building a campaign');
    ok(inOptions[0].variables !== undefined, 'each carries its token list for the unfillable-token warning');
    ok(opts.categories.map((c) => c.value).includes('property-update'), 'the builder gets the same category list');

    head('Email Settings templates are a separate library');
    const settingsNames = settingsBefore.map((t) => t.name);
    ok(opts.templates.length === (await prisma.campaign_templates.count({ where: { deleted_at: null, is_active: true } })),
      `the builder lists exactly the campaign templates (${opts.templates.length}), not the ${settingsBefore.length} Email Settings ones`);

    const settingsAfter = await prisma.email_templates.findMany({ select: { id: true, name: true, subject: true, body_html: true } });
    ok(JSON.stringify(settingsAfter) === JSON.stringify(settingsBefore), 'not one Email Settings template was altered');
    ok((await get('/api/email-templates')).status === 200, 'the Email Settings template screen still works');

    // The two libraries are separate tables with independent id sequences, so an id can exist in
    // both. Prove the separation by reading: an Email Settings template id that has no campaign
    // template must not resolve in the campaign library.
    const campaignIds = new Set((await prisma.campaign_templates.findMany({ select: { id: true } })).map((t) => t.id));
    const settingsOnlyId = settingsBefore.map((t) => t.id).find((id) => !campaignIds.has(id));
    if (settingsOnlyId) {
      ok((await get(`/api/campaigns/templates/${settingsOnlyId}`)).status === 404,
        `Email Settings template #${settingsOnlyId} does not exist in the campaign library`);
    } else {
      ok(true, 'every Email Settings id happens to collide with a campaign id — nothing to check');
    }
    ok(!opts.templates.some((t) => settingsNames.includes(String(t.name))),
      'no Email Settings template name appears in the campaign builder');

    head('deleting keeps campaign history intact');
    const del = await json(await send('DELETE', `/api/campaigns/templates/${b.body.id}`));
    ok(del.deleted === true, 'a template can be deleted');
    ok(typeof del.used_by === 'number', `the response reports how many campaigns used it (${del.used_by})`);
    const soft = await prisma.campaign_templates.findUnique({ where: { id: b.body.id }, select: { deleted_at: true } });
    ok(soft?.deleted_at !== null, 'the delete is soft');
    ok(!(await json(await get('/api/campaigns/templates'))).some((t) => t.id === b.body.id), 'and it leaves the library');
    ok((await get(`/api/campaigns/templates/${b.body.id}`)).status === 404, 'a deleted template cannot be fetched');
    ok(!(await json(await get('/api/campaigns/options'))).templates.some((t) => t.id === b.body.id),
      'and can no longer be selected for a new campaign');

    head('routes and guards');
    ok((await get('/api/campaigns/templates')).status === 200, '/campaigns/templates is not swallowed by /campaigns/:id');
    ok((await get('/api/campaigns/templates/categories')).status === 200, '/templates/categories resolves ahead of /templates/:id');
    ok((await fetch(BASE + '/api/campaigns/templates', { headers: H })).status === 401, 'templates require a session');
    const noCsrf = await fetch(BASE + '/api/campaigns/templates', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Cookie: ch() }, body: '{}',
    });
    ok(noCsrf.status === 419, 'a write without the CSRF token is refused');
    ok((await get('/api/campaigns/track/open?c=1&t=x')).status === 200, 'the public tracking pixel still resolves ahead of :id');

    head('frontend wiring');
    const page = read('desk/CampaignsPage.tsx');
    ok(page.includes('import CampaignTemplates from'), 'the templates panel is imported');
    ok(page.includes('<CampaignTemplates'), 'and rendered on the Campaigns page');

    // Two views, one at a time: All Campaigns and Email Templates must not both render.
    ok(page.includes('All Campaigns') && page.includes('Email Templates'), 'both tabs are offered');
    ok(/tab === 'templates' && <CampaignTemplates/.test(page), 'templates render only on the Email Templates tab');
    ok(/tab === 'campaigns' && \(campaigns\.length === 0/.test(page), 'the campaign list renders only on the All Campaigns tab');
    ok(/tab === 'campaigns' && tracking/.test(page), 'the tracking banner belongs to the campaigns tab');
    ok((page.match(/<CampaignTemplates/g) ?? []).length === 1, 'the template library is rendered exactly once');
    ok(/useState<'campaigns' \| 'templates'>\('campaigns'\)/.test(page), 'All Campaigns is the default view');
    const tpl = read('desk/CampaignTemplates.tsx');
    ok(/sandbox=""/.test(tpl), 'stored template HTML is previewed in a sandboxed iframe');
    for (const s of ['tailwind', 'shadcn', 'lucide-react', 'next/', 'mongodb']) {
      ok(!tpl.includes(s), `no "${s}" in the templates component`);
    }
    ok(/Email Settings/.test(tpl), 'the UI states these are separate from Email Settings templates');

    head('the rest of Transaction Desk is unaffected');
    const txns = await json(await get('/api/transactions'));
    ok((Array.isArray(txns) ? txns : txns.data).length > 0, 'transactions still load');
    ok((await (await get('/api/reports')).json()).length >= 20, 'reports still respond');
    ok((await get('/api/leads?limit=1')).status === 200, 'the Lead module still responds');
    ok((await get('/api/calendar/todos')).status === 200, 'the calendar todos still respond');
  } finally {
    head('cleanup');
    for (const id of created) {
      await prisma.campaign_template_attachments.deleteMany({ where: { template_id: id } });
      await prisma.campaign_templates.deleteMany({ where: { id } });
    }
    // Count only this run's rows — the library legitimately holds the starter templates.
    const mine = await prisma.campaign_templates.count({ where: { name: { startsWith: MARK } } });
    ok(mine === 0, `no test templates remain (${mine})`);
    const total = await prisma.campaign_templates.count({ where: { deleted_at: null } });
    ok(total === templatesBefore, `the real template library is intact (${total})`);
    ok((await prisma.campaign_template_attachments.count({ where: { template: { name: { startsWith: MARK } } } })) === 0,
      'no orphaned test attachments remain');
    const settingsFinal = await prisma.email_templates.count();
    ok(settingsFinal === settingsBefore.length, `Email Settings still has its ${settingsFinal} templates`);
    await prisma.$disconnect();

    console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
    // Set the code rather than calling process.exit(): forcing exit while fetch's keep-alive
    // sockets are still closing trips a libuv assertion on Windows and reports a bogus code.
    process.exitCode = fail === 0 ? 0 : 1;
  }
})();
