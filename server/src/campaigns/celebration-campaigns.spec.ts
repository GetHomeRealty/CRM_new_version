import { PrismaClient, type mail_accounts } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { MailerService } from '../email/mailer.service';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CelebrationAudienceService } from './celebration-audience.service';
import { CelebrationCampaignsService } from './celebration-campaigns.service';
import { CelebrationFlyerService } from './celebration-flyer.service';
import { CelebrationAutomationService } from './celebration-automation.service';
import { zonedDate } from './celebration';

/**
 * Celebration & Wishes against the real database, with the mailer stubbed.
 *
 * Not wrapped in a rolled-back transaction like most campaign specs: sending claims the draft
 * inside `$transaction`, and the duplicate guard relies on a unique-index violation, both of which
 * need a real connection. Everything is tagged and removed in `afterAll`; the role accounts used are
 * the seeded `agent@test.local` and `agent2@test.local`, so no users are created.
 *
 * NO EMAIL LEAVES: `sendFromAccount` is a jest mock, and `MailerService.redirectTarget` is pinned so
 * the "real delivery" branch can be exercised without any transport.
 */

jest.setTimeout(90000);

const prisma = new PrismaClient();
const p = prisma as unknown as PrismaService;
const T = `cel${Date.now()}`;
const DOMAIN = `${T}.test`;
const BASE = 'https://crm.test';
const TZ = 'America/Toronto';
const ACCOUNT = { id: 990001, from_email: 'sender@cel.test', from_name: 'Celebrations' } as unknown as mail_accounts;

const sendFromAccount = jest.fn(async (_a: unknown, _o: { to: string[] }) => ({ messageId: `<m-${Math.random()}@test>` }));
const mailer = { sendFromAccount, resolveSenderInArea: async () => ACCOUNT };
const emailLog = { recordExternalSend: jest.fn(async () => undefined) };
const audit = { record: async () => undefined };
let allow = true;
const permissions = { can: () => allow };

const audience = new CampaignAudienceService(p);
const celAudience = new CelebrationAudienceService(p, audience, permissions as never);
const campaigns = new CampaignsService(
  p, audience, {} as never, { domainCanReceiveMail: async () => true } as never, mailer as never,
  undefined, audit as never, emailLog as never, celAudience,
);
const flyers = new CelebrationFlyerService(p);
const svc = new CelebrationCampaignsService(p, campaigns, audience, celAudience, flyers, mailer as never, audit as never, emailLog as never);
const automation = new CelebrationAutomationService(p, audience, celAudience, svc, audit as never, {} as never, {} as never);

let agent: AuthUserRecord;
let agent2: AuthUserRecord;
let seq = 0;
const email = (n: string) => `${n}-${(seq += 1)}@${DOMAIN}`;
const today = zonedDate(new Date(), TZ);
const flyerIds: number[] = [];

async function lead(loc: string, data: Record<string, unknown>) {
  const now = new Date();
  return prisma.leads.create({
    data: { name: 'Lead', location: `${T}${loc}`, owner_user_id: agent.id, created_at: now, updated_at: now, ...data } as never,
  });
}

const filtered = (loc: string, extra: Record<string, unknown> = {}) => ({
  mode: 'filtered' as const, filters: { location: `${T}${loc}`, ...extra }, lead_ids: [], excluded_lead_ids: [],
});

async function draft(user: AuthUserRecord, body: Record<string, unknown>) {
  return svc.create({
    name: `${T} ${body.occasion}`, subject: 'Happy {{LEAD_FIRST_NAME}}!', message: 'Hi {{LEAD_FIRST_NAME}},\n\nWarm wishes.',
    timezone: TZ, ...body,
  }, user) as Promise<{ id: number }>;
}

async function scheduleAndDispatch(id: number, user: AuthUserRecord) {
  const tomorrow = new Date(Date.now() + 86400000);
  await svc.send(id, { confirm: true, mode: 'schedule', schedule_date: zonedDate(tomorrow, TZ), schedule_time: '09:00', timezone: TZ }, user, BASE);
  await campaigns.dispatchScheduled(id);
  return prisma.campaigns.findUniqueOrThrow({ where: { id }, include: { recipients: { orderBy: { id: 'asc' } } } });
}

async function settled(id: number) {
  for (let i = 0; i < 60; i += 1) {
    const c = await prisma.campaigns.findUniqueOrThrow({ where: { id }, include: { recipients: { orderBy: { id: 'asc' } } } });
    if (c.status !== 'sending') return c;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`campaign ${id} did not settle`);
}

beforeAll(async () => {
  const load = (e: string) => prisma.users.findFirstOrThrow({ where: { email: e }, include: { user_permissions: true, user_modules: true } });
  agent = (await load('agent@test.local')) as unknown as AuthUserRecord;
  agent2 = (await load('agent2@test.local')) as unknown as AuthUserRecord;
  process.env.CAMPAIGN_PUBLIC_URL = BASE;
});

beforeEach(() => {
  allow = true;
  sendFromAccount.mockClear();
  emailLog.recordExternalSend.mockClear();
  jest.spyOn(MailerService, 'redirectTarget').mockReturnValue(null);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await prisma.campaigns.deleteMany({ where: { name: { contains: T } } });
  await prisma.celebration_automations.deleteMany({ where: { name: { contains: T } } });
  await prisma.celebration_sends.deleteMany({ where: { email_key: { endsWith: `@${DOMAIN}` } } });
  await prisma.crm_email_log.deleteMany({ where: { recipient: { endsWith: `@${DOMAIN}` } } });
  await prisma.email_suppressions.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  await prisma.campaign_flyers.deleteMany({ where: { id: { in: flyerIds } } });
  await prisma.leads.deleteMany({ where: { location: { startsWith: T } } });
  await prisma.$disconnect();
});

describe('who receives it — scope and exclusions', () => {
  it('reaches only the sender’s eligible leads, counting every exclusion with its reason', async () => {
    const priya = await lead('a1', { name: 'Priya Sharma', email: email('priya') });
    const noName = await lead('a1', { name: '', email: email('anon') });
    await lead('a1', { email: email('unsub'), unsubscribed: true });
    const supp = await lead('a1', { email: email('supp') });
    const now = new Date();
    await prisma.email_suppressions.create({ data: { email: String(supp.email), reason: 'unsubscribe', created_at: now, updated_at: now } });
    await lead('a1', { email: 'not-an-email' });
    await lead('a1', { email: null });
    // The same address on a second lead (a brokerage lead assigned to this agent — one owner cannot hold it twice).
    await lead('a1', { email: String(priya.email).toUpperCase(), owner_user_id: null, assigned_to: agent.id });
    const others = await lead('a1', { email: email('other'), owner_user_id: agent2.id });

    const r = await celAudience.resolve(filtered('a1'), agent, { occasion: 'diwali', timezone: TZ });
    expect(r.recipients.map((x) => x.email).sort()).toEqual([priya.email, noName.email].sort());
    const counts = Object.fromEntries(r.exclusions.map((e) => [e.reason, e.count]));
    expect(counts).toEqual({ unsubscribed: 1, suppressed: 1, invalid_email: 1, missing_email: 1, duplicate_email: 1 });
    expect(r.recipients.some((x) => x.email === others.email)).toBe(false);
    // Merge fallbacks.
    expect(r.recipients.find((x) => x.leadId === priya.id)?.vars.LEAD_FIRST_NAME).toBe('Priya');
    expect(r.recipients.find((x) => x.leadId === noName.id)?.vars.LEAD_FIRST_NAME).toBe('there');
  });

  it('honours a manual exclusion, and never lets a hand-picked lead outside the sender’s scope through', async () => {
    const a = await lead('a2', { name: 'Ana Silva', email: email('ana') });
    const b = await lead('a2', { name: 'Ben Ode', email: email('ben') });
    const foreign = await lead('a2', { name: 'Not Mine', email: email('notmine'), owner_user_id: agent2.id });

    const excl = await celAudience.resolve({ ...filtered('a2'), excluded_lead_ids: [b.id] }, agent, { occasion: 'christmas', timezone: TZ });
    expect(excl.recipients.map((x) => x.leadId)).toEqual([a.id]);
    expect(excl.exclusions.find((e) => e.reason === 'excluded_by_you')?.count).toBe(1);

    const picked = await celAudience.resolve({ mode: 'selected', filters: {}, lead_ids: [a.id, foreign.id], excluded_lead_ids: [] }, agent, { occasion: 'christmas', timezone: TZ });
    expect(picked.recipients.map((x) => x.leadId)).toEqual([a.id]);
    expect(picked.not_permitted).toBe(1);

    const one = await celAudience.resolve({ mode: 'single', filters: {}, lead_ids: [foreign.id], excluded_lead_ids: [] }, agent, { occasion: 'christmas', timezone: TZ });
    expect(one.recipients).toEqual([]);
  });
});

describe('birthdays — month and day, missing dates, once a year', () => {
  it('matches today’s birthdays, reports missing and implausible dates, and skips anyone already greeted', async () => {
    const [, mm, dd] = today.split('-');
    const bday = await lead('b1', { name: 'Birthday Person', email: email('bday'), date_of_birth: new Date(`1990-${mm}-${dd}T00:00:00Z`) });
    await lead('b1', { name: 'Other Day', email: email('notday'), date_of_birth: new Date(`1990-${mm === '01' ? '02' : '01'}-15T00:00:00Z`) });
    await lead('b1', { name: 'No Date', email: email('nodate') });
    await lead('b1', { name: 'Bad Date', email: email('baddate'), date_of_birth: new Date(`1850-${mm}-${dd}T00:00:00Z`) });

    const spec = filtered('b1', { date_window: 'today' });
    let r = await celAudience.resolve(spec, agent, { occasion: 'birthday', timezone: TZ });
    expect(r.recipients.map((x) => x.leadId)).toEqual([bday.id]);
    const counts = Object.fromEntries(r.exclusions.map((e) => [e.reason, e.count]));
    expect(counts.missing_date).toBe(1);
    expect(counts.invalid_date).toBe(1);

    // Greeted by another celebration this year…
    await prisma.celebration_sends.create({ data: { occasion_key: 'birthday', email_key: String(bday.email), year: Number(today.slice(0, 4)), created_at: new Date() } });
    r = await celAudience.resolve(spec, agent, { occasion: 'birthday', timezone: TZ });
    expect(r.recipients).toEqual([]);
    expect(r.exclusions.find((e) => e.reason === 'already_greeted')?.count).toBe(1);
    await prisma.celebration_sends.deleteMany({ where: { email_key: String(bday.email) } });

    // …or by the Settings greeting sweep (its sends are in the CRM email log).
    await prisma.crm_email_log.create({ data: { kind: 'birthday', recipient: String(bday.email), success: true, created_at: new Date() } as never });
    r = await celAudience.resolve(spec, agent, { occasion: 'birthday', timezone: TZ });
    expect(r.recipients).toEqual([]);
  });
});

describe('nothing sends until the final, confirmed action', () => {
  it('saving, previewing and scheduling never call the mailer; cancelling removes the queue', async () => {
    const one = await lead('c1', { name: 'Priya Sharma', email: email('prev') });
    await lead('c1', { name: 'Dev Patel', email: email('prev2') });
    const flyer = await flyers.renderTemplate({ occasion: 'diwali', headline: 'Happy Diwali', greeting: 'Light and joy', style: 'festive', format: 'square', alt_text: 'Diwali lights' }, agent);
    flyerIds.push(flyer.id);

    const d = await draft(agent, { occasion: 'diwali', recipients: filtered('c1'), flyer_id: flyer.id });
    const pv = await svc.preview({
      name: `${T} p`, occasion: 'diwali', subject: 'Happy Diwali, {{LEAD_FIRST_NAME}}', message: 'Hi {{LEAD_FIRST_NAME}},\n\nWarm wishes.',
      flyer_id: flyer.id, recipients: filtered('c1'), sample_lead_id: one.id, timezone: TZ,
    }, agent, BASE);
    expect(pv.subject).toBe('Happy Diwali, Priya');
    expect(String(pv.html)).toContain('data:image/jpeg;base64,');
    expect(String(pv.html)).toContain('alt="Diwali lights"');

    await expect(svc.send(d.id, { mode: 'now' }, agent, BASE)).rejects.toThrow(/Confirm/);

    const tomorrow = zonedDate(new Date(Date.now() + 86400000), TZ);
    const scheduled = await svc.send(d.id, { confirm: true, mode: 'schedule', schedule_date: tomorrow, schedule_time: '09:00', timezone: TZ }, agent, BASE);
    expect(scheduled.status).toBe('scheduled');
    expect(await prisma.campaign_recipients.count({ where: { campaign_id: d.id, status: 'pending' } })).toBe(2);
    // A second confirmed send of the same draft is refused, not doubled.
    await expect(svc.send(d.id, { confirm: true, mode: 'now' }, agent, BASE)).rejects.toThrow(/already scheduled/);

    const cancelled = await svc.cancel(d.id, agent);
    expect(cancelled.status).toBe('cancelled');
    expect(await prisma.campaign_recipients.count({ where: { campaign_id: d.id } })).toBe(0);
    expect(sendFromAccount).not.toHaveBeenCalled();
  });

  it('refuses merge fields it cannot fill, and someone else’s draft', async () => {
    await expect(draft(agent, { occasion: 'christmas', message: 'Hi {{PROPERTY_PRICE}}' })).rejects.toThrow(/cannot be filled/);
    const d = await draft(agent, { occasion: 'christmas', recipients: filtered('c2') });
    await expect(svc.get(d.id, agent2)).rejects.toThrow(/not found/);
  });
});

describe('delivery', () => {
  it('sends one message per recipient with the flyer inline, records the mail server reference, and logs a birthday as a birthday', async () => {
    const [, mm, dd] = today.split('-');
    const b = await lead('d1', { name: 'Maya Chen', email: email('maya'), date_of_birth: new Date(`1985-${mm}-${dd}T00:00:00Z`) });
    const flyer = await flyers.renderTemplate({ occasion: 'birthday', headline: 'Happy Birthday', greeting: 'Have a great year', style: 'warm', format: 'square', alt_text: 'Balloons' }, agent);
    flyerIds.push(flyer.id);
    const d = await draft(agent, { occasion: 'birthday', recipients: { mode: 'single', filters: {}, lead_ids: [b.id], excluded_lead_ids: [] }, flyer_id: flyer.id, reply_to: 'replies@cel.test' });

    const c = await scheduleAndDispatch(d.id, agent);
    expect(c.status).toBe('completed');
    expect(c.sent).toBe(1);
    expect(sendFromAccount).toHaveBeenCalledTimes(1);
    const opts = sendFromAccount.mock.calls[0][1] as unknown as { to: string[]; subject: string; html: string; text: string; attachments: { cid?: string }[]; headers: Record<string, string>; maxAttempts: number };
    expect(opts.to).toEqual([b.email]);
    expect(opts.subject).toBe('Happy Maya!');
    expect(opts.html).toContain('cid:celebration-flyer');
    expect(opts.html).toContain('/api/campaigns/unsubscribe');
    expect(opts.text).toContain('Unsubscribe:');
    expect(opts.attachments.some((a) => a.cid === 'celebration-flyer')).toBe(true);
    expect(opts.headers['Reply-To']).toBe('replies@cel.test');
    expect(opts.headers['List-Unsubscribe']).toBeDefined();
    expect(opts.maxAttempts).toBe(1);
    expect(c.recipients[0].status).toBe('sent');
    expect(c.recipients[0].provider_message_id).toMatch(/^<m-/);
    expect(await prisma.celebration_sends.count({ where: { email_key: String(b.email), occasion_key: 'birthday' } })).toBe(1);
    expect(emailLog.recordExternalSend).toHaveBeenCalledWith('birthday', b.email, expect.any(String), true, null, expect.anything(), null);

    // The same person cannot be greeted for their birthday again this year.
    const again = await draft(agent, { occasion: 'birthday', recipients: { mode: 'single', filters: {}, lead_ids: [b.id], excluded_lead_ids: [] } });
    await expect(svc.send(again.id, { confirm: true, mode: 'now' }, agent, BASE)).rejects.toThrow(/Nobody is eligible/);
  });

  it('the unique greeting mark stops a duplicate even when the pre-check misses it', async () => {
    const x = await lead('d2', { name: 'Race Case', email: email('race') });
    const d1 = await draft(agent, { occasion: 'eid-al-fitr', recipients: filtered('d2') });
    const d2 = await draft(agent, { occasion: 'eid-al-fitr', recipients: filtered('d2') });
    const tomorrow = zonedDate(new Date(Date.now() + 86400000), TZ);
    for (const d of [d1, d2]) await svc.send(d.id, { confirm: true, mode: 'schedule', schedule_date: tomorrow, schedule_time: '09:00', timezone: TZ }, agent, BASE);
    await campaigns.dispatchScheduled(d1.id);
    // Simulate two passes racing: the second one's read-ahead did not see the first's mark.
    jest.spyOn(celAudience, 'alreadyGreeted').mockResolvedValueOnce(new Set());
    await campaigns.dispatchScheduled(d2.id);
    const second = await prisma.campaign_recipients.findFirstOrThrow({ where: { campaign_id: d2.id } });
    expect(second.status).toBe('skipped');
    expect(sendFromAccount).toHaveBeenCalledTimes(1);
    expect(sendFromAccount.mock.calls[0][1].to).toEqual([x.email]);
  });

  it('re-checks eligibility and permission at send time', async () => {
    const r1 = await lead('e1', { name: 'Opts Out', email: email('later-unsub') });
    const r2 = await lead('e1', { name: 'Moves Away', email: email('reassigned') });
    const r3 = await lead('e1', { name: 'Still Here', email: email('still') });
    const d = await draft(agent, { occasion: 'thanksgiving', recipients: filtered('e1') });
    const tomorrow = zonedDate(new Date(Date.now() + 86400000), TZ);
    await svc.send(d.id, { confirm: true, mode: 'schedule', schedule_date: tomorrow, schedule_time: '09:00', timezone: TZ }, agent, BASE);

    await prisma.leads.update({ where: { id: r1.id }, data: { unsubscribed: true } });
    await prisma.leads.update({ where: { id: r2.id }, data: { owner_user_id: agent2.id } });
    await campaigns.dispatchScheduled(d.id);

    const c = await prisma.campaigns.findUniqueOrThrow({ where: { id: d.id }, include: { recipients: true } });
    const by = Object.fromEntries(c.recipients.map((x) => [x.lead_id, x]));
    expect(by[r1.id].status).toBe('skipped');
    expect(by[r1.id].error).toMatch(/Unsubscribed/);
    expect(by[r2.id].status).toBe('skipped');
    expect(by[r2.id].error).toMatch(/No longer one of the sender/);
    expect(by[r3.id].status).toBe('sent');
    expect(c.skipped).toBe(2);
    expect(sendFromAccount).toHaveBeenCalledTimes(1);

    // A sender who has lost the right to send campaigns sends nothing at all.
    await lead('e2', { name: 'Anyone', email: email('anyone') });
    const d2 = await draft(agent, { occasion: 'thanksgiving', name: `${T} perm`, recipients: filtered('e2') });
    await svc.send(d2.id, { confirm: true, mode: 'schedule', schedule_date: tomorrow, schedule_time: '09:00', timezone: TZ }, agent, BASE);
    allow = false;
    await campaigns.dispatchScheduled(d2.id);
    const c2 = await prisma.campaigns.findUniqueOrThrow({ where: { id: d2.id }, include: { recipients: true } });
    expect(c2.recipients[0].status).toBe('skipped');
    expect(c2.recipients[0].error).toMatch(/may no longer send/);
    expect(sendFromAccount).toHaveBeenCalledTimes(1);
  });

  it('records a diverted send as diverted — never as sent — and gives the greeting mark back', async () => {
    jest.spyOn(MailerService, 'redirectTarget').mockReturnValue('dev-sink@localhost.invalid');
    const x = await lead('f1', { name: 'Div Erted', email: email('diverted') });
    const d = await draft(agent, { occasion: 'new-year', recipients: filtered('f1') });
    const c = await scheduleAndDispatch(d.id, agent);
    expect(c.recipients[0].status).toBe('diverted');
    expect(c.sent).toBe(0);
    expect(c.diverted).toBe(1);
    expect(c.status).toBe('completed');
    expect(await prisma.celebration_sends.count({ where: { email_key: String(x.email) } })).toBe(0);
  });

  it('retries only sends that certainly did not leave, and never resends a successful one', async () => {
    const a = await lead('g1', { name: 'Refused', email: email('refused') });
    const b = await lead('g1', { name: 'Timeout', email: email('timeout') });
    const c0 = await lead('g1', { name: 'Fine', email: email('fine') });
    sendFromAccount.mockImplementation(async (_acct: unknown, o: { to: string[] }) => {
      if (o.to[0] === a.email) throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:587'), { code: 'ECONNREFUSED' });
      if (o.to[0] === b.email) throw Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
      return { messageId: '<ok@test>' };
    });
    const d = await draft(agent, { occasion: 'canada-day', recipients: filtered('g1') });
    const c = await scheduleAndDispatch(d.id, agent);
    const by = Object.fromEntries(c.recipients.map((x) => [x.lead_id, x]));
    expect(by[a.id].failure_kind).toBe('not_sent');
    expect(by[b.id].failure_kind).toBe('unknown_outcome');
    expect(by[c0.id].status).toBe('sent');
    expect(c.status).toBe('partial');
    // The unknown one keeps its mark (it may have arrived); the refused one gives it back.
    expect(await prisma.celebration_sends.count({ where: { email_key: String(b.email) } })).toBe(1);
    expect(await prisma.celebration_sends.count({ where: { email_key: String(a.email) } })).toBe(0);

    sendFromAccount.mockClear();
    sendFromAccount.mockImplementation(async () => ({ messageId: '<retry@test>' }));
    const detail = await svc.get(d.id, agent);
    expect(detail.retryable).toBe(1);
    expect(detail.unknown_outcome).toBe(1);
    await svc.retryFailed(d.id, agent);
    const after = await settled(d.id);
    expect(sendFromAccount).toHaveBeenCalledTimes(1);
    expect(sendFromAccount.mock.calls[0][1].to).toEqual([a.email]);
    expect(after.recipients.find((x) => x.lead_id === a.id)?.status).toBe('sent');
    expect(after.recipients.find((x) => x.lead_id === b.id)?.status).toBe('failed');
    expect(after.status).toBe('partial');
  });
});

describe('annual automation', () => {
  it('is created paused, runs once a day only when switched on, and sends the saved message', async () => {
    const [, mm, dd] = today.split('-');
    const bd = await lead('h1', { name: 'Auto Birthday', email: email('auto'), date_of_birth: new Date(`1979-${mm}-${dd}T00:00:00Z`) });
    await lead('h1', { name: 'No Dob', email: email('auto-nodob') });
    const rule = await automation.create({
      name: `${T} rule`, occasion: 'birthday', subject: 'Happy birthday {{LEAD_FIRST_NAME}}', message: 'Hi {{LEAD_FIRST_NAME}}',
      send_time: '00:00', timezone: TZ, recipients: filtered('h1'),
    }, agent) as { id: number; status: string };
    expect(rule.status).toBe('paused');
    await automation.sweep();
    expect(await prisma.campaigns.count({ where: { automation_id: rule.id } })).toBe(0);

    await expect(automation.setStatus(rule.id, 'active', false, agent)).rejects.toThrow(/Confirm/);
    await automation.setStatus(rule.id, 'active', true, agent);
    const dry = await automation.dryRun(rule.id, today, agent);
    expect(dry.count).toBe(1);

    await automation.sweep();
    const runs = await prisma.campaigns.findMany({ where: { automation_id: rule.id } });
    expect(runs).toHaveLength(1);
    const c = await settled(runs[0].id);
    expect(c.recipients.map((x) => x.lead_id)).toEqual([bd.id]);
    expect(sendFromAccount.mock.calls.some((call) => call[1].to[0] === bd.email)).toBe(true);
    const saved = await prisma.celebration_automations.findUniqueOrThrow({ where: { id: rule.id } });
    expect(JSON.parse(String(saved.last_run_summary)).exclusions.some((e: { reason: string }) => e.reason === 'missing_date')).toBe(true);

    // The same day does not run twice.
    await automation.sweep();
    expect(await prisma.campaigns.count({ where: { automation_id: rule.id } })).toBe(1);
    await automation.setStatus(rule.id, 'paused', false, agent);
  });

  it('greets a Feb 29 birthday on the day the rule says in a non-leap year', async () => {
    const leap = await lead('h2', { name: 'Leap Ling', email: email('leap'), date_of_birth: new Date('1992-02-29T00:00:00Z') });
    const base = { occasion: 'birthday', subject: 'Happy birthday', message: 'Hi {{LEAD_FIRST_NAME}}', send_time: '00:00', timezone: TZ, recipients: filtered('h2') };
    const feb28 = await automation.create({ ...base, name: `${T} feb28`, feb29_rule: 'feb28' }, agent) as { id: number };
    const skip = await automation.create({ ...base, name: `${T} skip`, feb29_rule: 'skip' }, agent) as { id: number };
    const on28 = await automation.dryRun(feb28.id, '2027-02-28', agent) as { recipients: { lead_id: number }[] };
    expect(on28.recipients.map((x) => x.lead_id)).toEqual([leap.id]);
    expect((await automation.dryRun(feb28.id, '2027-03-01', agent)).count).toBe(0);
    expect((await automation.dryRun(skip.id, '2027-02-28', agent)).count).toBe(0);
    expect((await automation.dryRun(skip.id, '2028-02-29', agent)).count).toBe(1);
  });
});
