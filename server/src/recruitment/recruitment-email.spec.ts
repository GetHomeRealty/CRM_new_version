import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as net from 'net';
import * as nodemailer from 'nodemailer';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentController } from './recruitment.controller';
import { RecruitmentEmailService, REMINDER_MAX_ATTEMPTS, classifySendFailure, messageHtml, reminderContent } from './recruitment-email.service';
import { PermissionService } from '../auth/permission.service';
import { SCREEN_META } from '../auth/decorators';

/**
 * EMAIL TO A CANDIDATE — Send Mail, and the automatic 24-hour interview reminder.
 *
 * Real tables in the test database; the MAILER IS A MOCK, so nothing is sent anywhere. Every
 * reminder test runs on a clock in 2031, so the sweep can only ever find the interviews these
 * tests create — never a real one, never another suite's leftovers.
 */

const prisma = new PrismaClient();
const db = prisma as unknown as PrismaService;
const recruitment = new RecruitmentService(db);
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

const ADMIN = { id: 1, name: 'ZZ Admin', role: 'admin' } as unknown as AuthUserRecord;
/** An error as nodemailer reports an SMTP reply code — a CERTAIN non-delivery. */
const smtpError = (responseCode: number, message: string) => Object.assign(new Error(message), { responseCode, code: 'EENVELOPE' });

const SENDER = { id: 999, name: 'Brokerage CRM', from_name: 'Get Home Realty', from_email: 'crm@brokerage.test', is_active: true } as never;

type Sent = { to: string[]; subject: string; html: string };
function harness(opts: { sender?: unknown; fail?: (n: number) => Error | null } = {}) {
  const sent: Sent[] = [];
  let calls = 0;
  const mailer = {
    sendFromAccount: async (_account: unknown, msg: Sent) => {
      calls += 1;
      const err = opts.fail?.(calls) ?? null;
      if (err) throw err;
      sent.push(msg);
      return { messageId: `m${calls}` };
    },
  } as never;
  const accounts = { defaultSender: async () => ('sender' in opts ? opts.sender : SENDER) } as never;
  return { svc: new RecruitmentEmailService(db, mailer, accounts, recruitment), sent };
}

const made: number[] = [];
async function candidate(over: Record<string, unknown> = {}) {
  const t = tag();
  const row = await prisma.recruitment_candidates.create({
    data: {
      name: `ZZ Mail Candidate ${t}`, email: `zz-mail-${t}@probe.test`, status: 'interview',
      assigned_recruiter_id: 1,
      created_at: new Date(), updated_at: new Date(), ...over,
    },
  });
  made.push(row.id);
  return row;
}

const H = 3_600_000;
const NOW = new Date('2031-03-10T15:00:00Z');
const at = (msFromNow: number) => new Date(NOW.getTime() + msFromNow);

async function interview(candidateId: number, scheduledAt: Date, over: Record<string, unknown> = {}) {
  return prisma.recruitment_interviews.create({
    data: {
      candidate_id: candidateId, scheduled_at: scheduledAt, status: 'scheduled',
      scheduled_set_at: at(-72 * H), mode: 'in_person', location: '123 Main St, Brampton',
      created_at: at(-72 * H), updated_at: at(-72 * H), ...over,
    },
  });
}

const reminders = (candidateId: number) =>
  prisma.recruitment_emails.findMany({ where: { candidate_id: candidateId, kind: 'interview_reminder' }, orderBy: { id: 'asc' } });

// Each test's candidates are archived when it ends, so a later sweep cannot find an earlier test's
// interview still due on the shared 2031 clock.
afterEach(async () => {
  await prisma.recruitment_candidates.updateMany({ where: { id: { in: made }, deleted_at: null }, data: { deleted_at: new Date() } });
});

afterAll(async () => {
  await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

// ===================================================================== Send Mail

describe('Send Mail', () => {
  it('sends to the saved address from the CRM mail account and records it', async () => {
    const c = await candidate();
    const { svc, sent } = harness();
    const r = await svc.send(ADMIN, c.id, { subject: 'Hello', message: 'Line one\nline two\n\nNew <para>' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([c.email]);
    expect(sent[0].html).toBe('<p>Line one<br>line two</p>\n<p>New &lt;para&gt;</p>');
    expect(r.data).toMatchObject({ status: 'sent', kind: 'manual', to_email: c.email, from_email: 'crm@brokerage.test', created_by: 'ZZ Admin' });
    expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id, action: 'email_sent' } })).toBe(1);
  });

  it('preview shows exactly what would be sent, and sends nothing', async () => {
    const c = await candidate();
    const { svc, sent } = harness();
    const p = await svc.preview(ADMIN, c.id, { subject: 'S', message: 'Hi <b>x</b>' });
    expect(p).toMatchObject({ to: c.email, subject: 'S', html: messageHtml('Hi <b>x</b>') });
    expect(sent).toHaveLength(0);
    expect(await prisma.recruitment_emails.count({ where: { candidate_id: c.id } })).toBe(0);
  });

  it('refuses a missing subject or message, and a candidate without a valid address', async () => {
    const c = await candidate();
    const { svc, sent } = harness();
    await expect(svc.send(ADMIN, c.id, { subject: '', message: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.send(ADMIN, c.id, { subject: 'x', message: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    const bad = await candidate({ email: 'not-an-address' });
    await expect(svc.send(ADMIN, bad.id, { subject: 'x', message: 'y' })).rejects.toBeInstanceOf(BadRequestException);
    expect(sent).toHaveLength(0);
  });

  it('records a failed send and reports it, so it can be sent again', async () => {
    const c = await candidate();
    const { svc } = harness({ fail: () => smtpError(550, 'SMTP 550 mailbox unavailable') });
    await expect(svc.send(ADMIN, c.id, { subject: 'x', message: 'y' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    const rows = await prisma.recruitment_emails.findMany({ where: { candidate_id: c.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', error_message: 'SMTP 550 mailbox unavailable' });
  });

  it('says so when no CRM mail account is connected', async () => {
    const c = await candidate();
    const { svc } = harness({ sender: null });
    await expect(svc.send(ADMIN, c.id, { subject: 'x', message: 'y' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect((await svc.composer(ADMIN, c.id)).can_send).toBe(false);
  });

  it('SMS consent plays no part: a candidate who declined texts can still be emailed', async () => {
    const c = await candidate({ sms_consent: false, sms_consent_by: 'ZZ Admin', sms_consent_at: new Date() });
    const { svc, sent } = harness();
    await svc.send(ADMIN, c.id, { subject: 'x', message: 'y' });
    expect(sent).toHaveLength(1);
  });
});

describe('a confirmed email moves a New candidate to Contacted', () => {
  const statusOf = async (id: number) => (await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id } })).status;
  const statusEvents = (id: number) => prisma.recruitment_events.findMany({ where: { candidate_id: id, action: 'status' } });

  it('New → Contacted after a successful send, recorded with the sender', async () => {
    const c = await candidate({ status: 'new' });
    const { svc } = harness();
    const r = await svc.send(ADMIN, c.id, { subject: 'Hello', message: 'Hi' });
    expect(r.contacted).toBe(true);
    expect(await statusOf(c.id)).toBe('contacted');
    const events = await statusEvents(c.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_name: 'ZZ Admin', detail: 'New → Contacted, after an email was sent.' });
  });

  it('a repeated send changes nothing further', async () => {
    const c = await candidate({ status: 'new' });
    const { svc, sent } = harness();
    expect((await svc.send(ADMIN, c.id, { subject: 'One', message: 'x' })).contacted).toBe(true);
    expect((await svc.send(ADMIN, c.id, { subject: 'Two', message: 'y' })).contacted).toBe(false);
    expect(sent).toHaveLength(2);
    expect(await statusOf(c.id)).toBe('contacted');
    expect(await statusEvents(c.id)).toHaveLength(1);
  });

  it('concurrent sends move the candidate exactly once', async () => {
    const c = await candidate({ status: 'new' });
    const { svc } = harness();
    const results = await Promise.all([1, 2, 3].map((n) => svc.send(ADMIN, c.id, { subject: `S${n}`, message: 'm' })));
    expect(results.filter((r) => r.contacted)).toHaveLength(1);
    expect(await statusOf(c.id)).toBe('contacted');
    expect(await statusEvents(c.id)).toHaveLength(1);
  });

  it('a failed send leaves the candidate New — refused or unconfirmed alike', async () => {
    const refused = await candidate({ status: 'new' });
    await expect(harness({ fail: () => smtpError(550, 'no such user') }).svc.send(ADMIN, refused.id, { subject: 's', message: 'm' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await statusOf(refused.id)).toBe('new');

    const unconfirmed = await candidate({ status: 'new' });
    const lost = Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' });
    await expect(harness({ fail: () => lost }).svc.send(ADMIN, unconfirmed.id, { subject: 's', message: 'm' })).rejects.toThrow(/may still have been delivered/);
    expect(await statusOf(unconfirmed.id)).toBe('new');

    expect(await statusEvents(refused.id)).toHaveLength(0);
    expect(await statusEvents(unconfirmed.id)).toHaveLength(0);
  });

  it('opening the composer and previewing change nothing', async () => {
    const c = await candidate({ status: 'new' });
    const { svc, sent } = harness();
    await svc.composer(ADMIN, c.id);
    await svc.preview(ADMIN, c.id, { subject: 's', message: 'm' });
    expect(sent).toHaveLength(0);
    expect(await statusOf(c.id)).toBe('new');
  });

  it('a send that never reaches the transport (no CRM account) leaves the candidate New', async () => {
    const c = await candidate({ status: 'new' });
    await expect(harness({ sender: null }).svc.send(ADMIN, c.id, { subject: 's', message: 'm' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await statusOf(c.id)).toBe('new');
  });

  it.each(['contacted', 'interview', 'approved', 'onboarding', 'active', 'hold', 'not_selected'])('a %s candidate keeps their status', async (status) => {
    const c = await candidate({ status });
    const { svc, sent } = harness();
    const r = await svc.send(ADMIN, c.id, { subject: 's', message: 'm' });
    expect(sent).toHaveLength(1);
    expect(r.contacted).toBe(false);
    expect(await statusOf(c.id)).toBe(status);
    expect(await statusEvents(c.id)).toHaveLength(0);
  });
});

describe('who may send mail', () => {
  it('a recruiter cannot reach a candidate assigned to somebody else', async () => {
    const c = await candidate({ assigned_recruiter_id: 1 });
    const other = { id: 999_998, name: 'ZZ Other', role: 'recruiter' } as unknown as AuthUserRecord;
    const { svc, sent } = harness();
    await expect(svc.send(other, c.id, { subject: 'x', message: 'y' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.history(other, c.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(sent).toHaveLength(0);
  });

  it('compose, preview and send need Recruitment: edit; history needs view — an Agent has neither edit', () => {
    const p = RecruitmentController.prototype as unknown as Record<string, object>;
    const level = (h: string) => (Reflect.getMetadata(SCREEN_META, p[h]) as { screen: string; level: string });
    for (const h of ['emailComposer', 'emailPreview', 'sendEmail']) expect(level(h)).toEqual({ screen: 'recruitment', level: 'edit', area: undefined });
    expect(level('emailHistory')).toEqual({ screen: 'recruitment', level: 'view', area: undefined });
    const perms = new PermissionService();
    expect(perms.can('agent', [], 'recruitment', 'edit')).toBe(false);
    expect(perms.can('recruiter', [], 'recruitment', 'edit')).toBe(true);
  });
});

// ===================================================================== the 24-hour reminder

describe('24-hour reminder: timing', () => {
  it('sends on the first sweep after it falls due, and only once', async () => {
    const c = await candidate();
    await interview(c.id, at(24 * H + 5 * 60_000)); // due in 5 minutes
    const { svc, sent } = harness();

    await svc.runReminders(NOW);
    expect(sent).toHaveLength(0); // not yet due

    await svc.runReminders(at(10 * 60_000)); // the next 10-minute check
    expect(sent.filter((m) => m.to[0] === c.email)).toHaveLength(1);

    await svc.runReminders(at(20 * 60_000));
    await svc.runReminders(at(30 * 60_000));
    expect(sent.filter((m) => m.to[0] === c.email)).toHaveLength(1);
    expect(await reminders(c.id)).toHaveLength(1);
  });

  it('overlapping sweeps send it once', async () => {
    const c = await candidate();
    await interview(c.id, at(23 * H));
    const { svc, sent } = harness();
    await Promise.all([svc.runReminders(NOW), svc.runReminders(NOW), svc.runReminders(NOW)]);
    expect(sent.filter((m) => m.to[0] === c.email)).toHaveLength(1);
    const rows = await reminders(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
  });

  it('a restart (a fresh service, same database) does not send it again', async () => {
    const c = await candidate();
    await interview(c.id, at(23 * H));
    await harness().svc.runReminders(NOW);
    const second = harness();
    await second.svc.runReminders(at(10 * 60_000));
    expect(second.sent).toHaveLength(0);
  });

  it('an interview booked less than 24 hours ahead gets no late "24-hour" reminder', async () => {
    const c = await candidate();
    await interview(c.id, at(20 * H), { scheduled_set_at: at(-1 * H), created_at: at(-1 * H) });
    const { svc, sent } = harness();
    await svc.runReminders(NOW);
    await svc.runReminders(at(10 * H));
    expect(sent).toHaveLength(0);
    expect(await reminders(c.id)).toHaveLength(0);
  });
});

describe('24-hour reminder: only scheduled interviews', () => {
  it.each(['cancelled', 'completed', 'approved'])('a %s interview sends nothing', async (status) => {
    const c = await candidate();
    await interview(c.id, at(23 * H), { status });
    const { svc, sent } = harness();
    await svc.runReminders(NOW);
    expect(sent).toHaveLength(0);
  });

  it('an archived candidate gets nothing', async () => {
    const c = await candidate({ deleted_at: new Date() });
    await interview(c.id, at(23 * H));
    const { svc, sent } = harness();
    await svc.runReminders(NOW);
    expect(sent).toHaveLength(0);
  });
});

describe('24-hour reminder: rescheduling', () => {
  it('moving the interview retires the old reminder and earns the new time its own', async () => {
    const c = await candidate();
    const iv = await interview(c.id, at(23 * H));
    const { svc, sent } = harness();
    await svc.runReminders(NOW);
    expect(sent).toHaveLength(1);

    // Moved three days on, through the real update path, which restamps when the time was set.
    await recruitment.updateInterview(ADMIN, c.id, iv.id, { scheduled_at: at(72 * H).toISOString() });
    const moved = await prisma.recruitment_interviews.findUniqueOrThrow({ where: { id: iv.id } });
    // Backdate the restamp onto the 2031 clock, as if moved at NOW.
    await prisma.recruitment_interviews.update({ where: { id: iv.id }, data: { scheduled_set_at: NOW } });
    expect(moved.scheduled_set_at).not.toBeNull();

    await svc.runReminders(at(10 * 60_000));
    expect(sent).toHaveLength(1); // the new time is not due yet
    await svc.runReminders(at(48 * H + 5 * 60_000));
    expect(sent).toHaveLength(2);
    const keys = (await reminders(c.id)).map((r) => r.dedupe_key);
    expect(new Set(keys).size).toBe(2);
  });

  it('a move into the final 24 hours earns no reminder for the new time', async () => {
    const c = await candidate();
    const iv = await interview(c.id, at(40 * H));
    await prisma.recruitment_interviews.update({ where: { id: iv.id }, data: { scheduled_at: at(10 * H), scheduled_set_at: NOW } });
    const { svc, sent } = harness();
    await svc.runReminders(at(5 * 60_000));
    expect(sent).toHaveLength(0);
  });

  it('re-saving the same time does not restart the clock', async () => {
    const c = await candidate();
    const iv = await interview(c.id, at(23 * H));
    await recruitment.updateInterview(ADMIN, c.id, iv.id, { scheduled_at: at(23 * H).toISOString(), feedback: 'prep notes' });
    const after = await prisma.recruitment_interviews.findUniqueOrThrow({ where: { id: iv.id } });
    expect(after.scheduled_set_at?.toISOString()).toBe(at(-72 * H).toISOString());
  });
});

describe('24-hour reminder: no address, failures and retries', () => {
  it('a missing or invalid email is recorded as skipped, and sent once the address is fixed', async () => {
    const none = await candidate({ email: '' });
    const bad = await candidate({ email: 'nope' });
    await interview(none.id, at(23 * H));
    await interview(bad.id, at(23 * H));
    const { svc, sent } = harness();
    await svc.runReminders(NOW);
    expect(sent).toHaveLength(0);
    expect((await reminders(none.id))[0]).toMatchObject({ status: 'skipped', error_message: 'No email address on file.' });
    expect((await reminders(bad.id))[0]).toMatchObject({ status: 'skipped', error_message: 'Not a valid email address: nope' });

    await prisma.recruitment_candidates.update({ where: { id: bad.id }, data: { email: `fixed-${tag()}@probe.test` } });
    await svc.runReminders(at(10 * 60_000));
    expect(sent).toHaveLength(1);
    expect((await reminders(bad.id))[0].status).toBe('sent');
  });

  it('a temporary (4xx) refusal is recorded and retried on the next sweep, at most three times in all', async () => {
    const c = await candidate();
    await interview(c.id, at(23 * H));
    const { svc, sent } = harness({ fail: () => smtpError(451, 'SMTP timeout') });
    for (let i = 0; i < 5; i += 1) await svc.runReminders(at(i * 10 * 60_000));
    const [row] = await reminders(c.id);
    expect(row).toMatchObject({ status: 'failed', attempts: REMINDER_MAX_ATTEMPTS, error_message: 'SMTP timeout' });
    expect(sent).toHaveLength(0);
  });

  it('a failure followed by success sends it exactly once', async () => {
    const c = await candidate();
    await interview(c.id, at(23 * H));
    const { svc, sent } = harness({ fail: (n) => (n === 1 ? smtpError(421, 'temporary') : null) });
    await svc.runReminders(NOW);
    await svc.runReminders(at(10 * 60_000));
    await svc.runReminders(at(20 * 60_000));
    expect(sent).toHaveLength(1);
    expect((await reminders(c.id))[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a send interrupted mid-way is closed as failed and never retried, in case it arrived', async () => {
    const c = await candidate();
    const iv = await interview(c.id, at(23 * H));
    await prisma.recruitment_emails.create({
      data: {
        candidate_id: c.id, interview_id: iv.id, kind: 'interview_reminder', status: 'sending',
        dedupe_key: `interview-reminder-24h:${iv.id}:${at(23 * H).toISOString()}`,
        subject: 's', body: 'b', attempts: 1, last_attempt_at: at(-60 * 60_000), created_at: NOW, updated_at: NOW,
      },
    });
    const { svc, sent } = harness();
    await svc.runReminders(NOW);
    await svc.runReminders(at(10 * 60_000));
    expect(sent).toHaveLength(0);
    expect((await reminders(c.id))[0]).toMatchObject({ status: 'failed', attempts: REMINDER_MAX_ATTEMPTS });
  });
});

/**
 * AMBIGUOUS FAILURES — the server took the whole message and the reply was lost.
 *
 * A local SMTP server receives the full message, then drops the connection (or goes silent) instead
 * of answering the final "." — exactly "accepted, but the response never arrived". The error is the
 * one real nodemailer raises for it, not a hand-made imitation.
 */
function lostReplyServer(mode: 'close' | 'silent') {
  let received = 0;
  const srv = net.createServer((sock) => {
    let data = false; let buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { received += 1; data = false; if (mode === 'close') sock.destroy(); }
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250 test\r\n');
        else if (up === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return { srv, received: () => received };
}

/** Sends one message through a real nodemailer transport to the lost-reply server; returns the error. */
async function realLostReplyError(mode: 'close' | 'silent'): Promise<{ err: unknown; received: number }> {
  const s = lostReplyServer(mode);
  await new Promise<void>((r) => s.srv.listen(0, '127.0.0.1', () => r()));
  const port = (s.srv.address() as net.AddressInfo).port;
  const t = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, socketTimeout: 800, greetingTimeout: 800, connectionTimeout: 800 });
  let err: unknown = null;
  try { await t.sendMail({ from: 'a@x.test', to: 'b@x.test', subject: 's', html: '<p>x</p>' }); } catch (e) { err = e; }
  await new Promise<void>((r) => s.srv.close(() => r()));
  return { err, received: s.received() };
}

describe('ambiguous failures: accepted, but the reply was lost', () => {
  it.each(['close', 'silent'] as const)('real nodemailer after a lost reply (%s): the server HAS the message, and it is classed unknown', async (mode) => {
    const { err, received } = await realLostReplyError(mode);
    expect(err).toBeTruthy();
    expect(received).toBe(1);
    expect(classifySendFailure(err)).toBe('unknown');
  });

  it('a later sweep never sends it again', async () => {
    const { err } = await realLostReplyError('close');
    const c = await candidate();
    await interview(c.id, at(23 * H));

    let calls = 0;
    const mailer = { sendFromAccount: async () => { calls += 1; throw err; } } as never;
    const accounts = { defaultSender: async () => SENDER } as never;
    const svc = new RecruitmentEmailService(db, mailer, accounts, recruitment);

    await svc.runReminders(NOW);
    expect(calls).toBe(1);
    const [row] = await reminders(c.id);
    expect(row).toMatchObject({ status: 'failed', attempts: REMINDER_MAX_ATTEMPTS });
    expect(row.error_message).toMatch(/^Outcome unknown/);

    // Every later sweep in the reminder window, and a fresh service as after a restart.
    for (let i = 1; i <= 6; i += 1) await svc.runReminders(at(i * 10 * 60_000));
    await new RecruitmentEmailService(db, mailer, accounts, recruitment).runReminders(at(70 * 60_000));
    expect(calls).toBe(1);
    expect(await reminders(c.id)).toHaveLength(1);
  });

  it('a permanent (5xx) refusal is not retried either — certain, but hopeless', async () => {
    const c = await candidate();
    await interview(c.id, at(23 * H));
    let calls = 0;
    const mailer = { sendFromAccount: async () => { calls += 1; throw smtpError(550, '550 no such user'); } } as never;
    const svc = new RecruitmentEmailService(db, mailer, { defaultSender: async () => SENDER } as never, recruitment);
    for (let i = 0; i < 4; i += 1) await svc.runReminders(at(i * 10 * 60_000));
    expect(calls).toBe(1);
    expect((await reminders(c.id))[0]).toMatchObject({ status: 'failed', attempts: REMINDER_MAX_ATTEMPTS, error_message: '550 no such user' });
  });

  it('a hand-sent email the server never confirmed says it may have arrived', async () => {
    const { err } = await realLostReplyError('close');
    const c = await candidate();
    const mailer = { sendFromAccount: async () => { throw err; } } as never;
    const svc = new RecruitmentEmailService(db, mailer, { defaultSender: async () => SENDER } as never, recruitment);
    await expect(svc.send(ADMIN, c.id, { subject: 'x', message: 'y' })).rejects.toThrow(/may still have been delivered/);
    const [row] = await prisma.recruitment_emails.findMany({ where: { candidate_id: c.id } });
    expect(row.error_message).toMatch(/^Outcome unknown/);
  });

  it('classifies what it can be sure of', () => {
    expect(classifySendFailure(smtpError(451, 'greylisted'))).toBe('retry');
    expect(classifySendFailure(smtpError(550, 'no such user'))).toBe('final');
    expect(classifySendFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25'), { code: 'ESOCKET' }))).toBe('retry');
    expect(classifySendFailure(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.x'), { code: 'EDNS' }))).toBe('retry');
    expect(classifySendFailure(Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT', command: 'CONN' }))).toBe('retry');
    expect(classifySendFailure(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' }))).toBe('unknown');
    expect(classifySendFailure(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'CONN' }))).toBe('unknown');
    expect(classifySendFailure(new Error('anything else'))).toBe('unknown');
  });
});

describe('24-hour reminder: what it says', () => {
  it('carries the name, date and time in Toronto time with its zone, and the saved location', () => {
    // 18:00 UTC on 20 Oct 2031 is 2:00 p.m. EDT in Toronto.
    const c = reminderContent({ name: 'Sandeep Yadav' }, { scheduled_at: new Date('2031-10-20T18:00:00Z'), mode: 'in_person', location: '123 Main St' }, 'Get Home Realty');
    expect(c.html).toContain('Hi Sandeep,');
    expect(c.subject).toMatch(/Oct 20, 2031/);
    expect(c.subject).toMatch(/2:00\s?p\.?m\.?/i);
    expect(c.subject).toMatch(/EDT/);
    expect(c.html).toContain('<strong>Location:</strong> 123 Main St');
  });

  it('winter times carry EST, and a saved meeting link is offered as a link', () => {
    const c = reminderContent({ name: 'A B' }, { scheduled_at: new Date('2031-01-15T15:30:00Z'), mode: 'video', location: 'https://meet.example.com/abc' }, null);
    expect(c.subject).toMatch(/10:30\s?a\.?m\.?/i);
    expect(c.subject).toMatch(/EST/);
    expect(c.html).toContain('<strong>Meeting link:</strong> <a href="https://meet.example.com/abc">');
  });

  it('says nothing about a place when none is saved', () => {
    const c = reminderContent({ name: 'A' }, { scheduled_at: new Date('2031-01-15T15:30:00Z'), mode: null, location: null }, null);
    expect(c.html).not.toContain('Location');
    expect(c.html).not.toContain('Meeting link');
  });
});
