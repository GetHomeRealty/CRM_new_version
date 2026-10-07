import { BadRequestException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import type { mail_accounts, recruitment_emails } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { MailerService } from '../email/mailer.service';
import { MailAccountService } from '../email/mail-account.service';
import { RecruitmentService } from './recruitment.service';
import { interviewWhen } from './recruitment-interview-notify.service';

/** The email shape the rest of Recruitment already checks a candidate's address against. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBJECT_MAX = 255;
const MESSAGE_MAX = 20_000;
const ERROR_MAX = 500;

/** The reminder goes this far ahead of the interview. */
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
/** A failed reminder is tried this many times in all, one sweep apart, while it is still useful. */
export const REMINDER_MAX_ATTEMPTS = 3;
/**
 * A reminder left `sending` this long was interrupted mid-send — a crash or a restart. Whether it
 * reached the candidate is unknown, so it is closed as failed and NOT tried again: a second copy is
 * worse than none.
 */
const STALE_SENDING_MS = 30 * 60 * 1000;

const reminderKey = (interviewId: number, at: Date): string => `interview-reminder-24h:${interviewId}:${at.toISOString()}`;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A plain-text message as the HTML that is sent: escaped, paragraphs on blank lines, breaks kept. */
export function messageHtml(message: string): string {
  return message
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

const isUrl = (s: string): boolean => /^https?:\/\/\S+$/i.test(s.trim());

/**
 * The 24-hour reminder's content: the candidate's name, the date and time with its time zone, and
 * where to go — the saved location, or the meeting link when that is what was saved.
 */
export function reminderContent(
  candidate: { name: string },
  interview: { scheduled_at: Date; mode: string | null; location: string | null },
  senderName: string | null,
): { subject: string; html: string } {
  const when = interviewWhen(interview.scheduled_at);
  const place = (interview.location ?? '').trim();
  const firstName = candidate.name.trim().split(/\s+/)[0] || candidate.name;
  const where = place
    ? (isUrl(place)
      ? `<p><strong>Meeting link:</strong> <a href="${escapeHtml(place)}">${escapeHtml(place)}</a></p>`
      : `<p><strong>Location:</strong> ${escapeHtml(place)}</p>`)
    : '';
  const how = interview.mode ? `<p><strong>Format:</strong> ${escapeHtml(interview.mode.replace(/_/g, ' '))}</p>` : '';
  return {
    subject: `Reminder: your interview on ${when}`,
    html: [
      `<p>Hi ${escapeHtml(firstName)},</p>`,
      `<p>This is a reminder that your interview is scheduled for <strong>${escapeHtml(when)}</strong>.</p>`,
      where,
      how,
      '<p>If you need to change the time, please reply to this email.</p>',
      `<p>Thank you${senderName ? `,<br>${escapeHtml(senderName)}` : '.'}</p>`,
    ].filter(Boolean).join('\n'),
  };
}

const short = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, ERROR_MAX);

/**
 * WHAT A SEND FAILURE TELLS US ABOUT WHETHER THE MESSAGE WENT.
 *
 *   retry    certainly NOT accepted, and worth another try: the server answered with a temporary
 *            4xx code, or no connection was ever made (refused, DNS, no greeting).
 *   final    certainly NOT accepted, and trying again will not help: the server answered 5xx.
 *   unknown  anything else — above all a connection that closed or timed out with no reply. The
 *            server may already have the whole message; sending again risks a second copy.
 *
 * UNKNOWN IS THE DEFAULT, on purpose. Nodemailer reports `command: "CONN"` both before anything was
 * sent and after the server received the entire message and the reply was lost (measured
 * 2026-10-07), so the SMTP stage cannot be trusted to say which. Only an explicit reply from the
 * server, or a connection that never opened, proves the message did not arrive.
 */
export type SendFailure = 'retry' | 'final' | 'unknown';

export function classifySendFailure(err: unknown): SendFailure {
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown; message?: unknown };
  if (typeof e.responseCode === 'number') {
    if (e.responseCode >= 400 && e.responseCode < 500) return 'retry';
    if (e.responseCode >= 500 && e.responseCode < 600) return 'final';
  }
  const code = String(e.code ?? '');
  const msg = String(e.message ?? '');
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EDNS', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'retry';
  if (/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|Greeting never received/i.test(msg)) return 'retry';
  return 'unknown';
}

const UNKNOWN_OUTCOME = 'Outcome unknown: the mail server did not confirm, and may have received it. Not sent again automatically.';

/**
 * EMAIL TO A CANDIDATE — hand-sent from the candidate's page, and the automatic 24-hour interview
 * reminder sent by crm-worker.
 *
 * Both leave through the brokerage's CRM mail account (`MailAccountService.defaultSender('crm')`)
 * via `MailerService`, the same path every other CRM email takes, so `MAIL_REDIRECT_TO` and the
 * local-mail safety rules apply here exactly as they do everywhere else. SMS consent plays no part:
 * agreeing to texts is about texts.
 */
@Injectable()
export class RecruitmentEmailService {
  private readonly log = new Logger(RecruitmentEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly accounts: MailAccountService,
    private readonly recruitment: RecruitmentService,
  ) {}

  // ------------------------------------------------------------------ hand-sent

  /** What the composer opens with: who it goes to, from where, and whether it can be sent. */
  async composer(user: AuthUserRecord, candidateId: number): Promise<Record<string, unknown>> {
    const c = await this.recruitment.candidateFor(user, candidateId);
    const sender = await this.accounts.defaultSender('crm');
    const email = (c.email ?? '').trim();
    const blocked = !EMAIL_SHAPE.test(email)
      ? `${c.name} has no valid email address on file. Correct it in Overview first.`
      : !sender ? 'No CRM mail account is connected, so nothing can be sent from here.' : null;
    return {
      candidate: { id: c.id, name: c.name, email: email || null },
      from: sender ? { name: sender.from_name ?? sender.name, email: sender.from_email } : null,
      can_send: !blocked,
      blocked_reason: blocked,
    };
  }

  /** Exactly what Send would send, without sending it. */
  async preview(user: AuthUserRecord, candidateId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const c = await this.recruitment.candidateFor(user, candidateId);
    const { subject, message } = this.validated(body);
    const sender = await this.accounts.defaultSender('crm');
    return {
      to: c.email,
      from: sender ? { name: sender.from_name ?? sender.name, email: sender.from_email } : null,
      subject,
      html: messageHtml(message),
    };
  }

  async send(user: AuthUserRecord, candidateId: number, body: Record<string, unknown>): Promise<{ data: recruitment_emails; contacted: boolean }> {
    const c = await this.recruitment.candidateFor(user, candidateId);
    const { subject, message } = this.validated(body);
    const to = (c.email ?? '').trim();
    if (!EMAIL_SHAPE.test(to)) {
      throw new BadRequestException({ message: `${c.name} has no valid email address on file. Correct it in Overview first.` });
    }
    const sender = await this.accounts.defaultSender('crm');
    if (!sender) throw new UnprocessableEntityException({ message: 'No CRM mail account is connected, so nothing can be sent from here.' });

    const html = messageHtml(message);
    const now = new Date();
    const row = await this.prisma.recruitment_emails.create({
      data: {
        candidate_id: c.id, kind: 'manual', status: 'sending', to_email: to, from_email: sender.from_email,
        subject, body: html, attempts: 1, last_attempt_at: now,
        created_by: user.name ?? null, user_id: user.id ?? null, created_at: now, updated_at: now,
      },
    });

    try {
      // ONE transport attempt: retrying is decided here, from what the failure proves (see
      // `classifySendFailure`), never inside the mailer where a lost reply looks transient.
      await this.mailer.sendFromAccount(sender, { to: [to], subject, html, maxAttempts: 1 });
    } catch (ex) {
      /*
       * Recorded, then reported. When the server never confirmed, the recruiter is told it MAY have
       * arrived, so sending again is their informed choice rather than a silent second copy.
       */
      const unknown = classifySendFailure(ex) === 'unknown';
      const why = unknown ? `${UNKNOWN_OUTCOME} (${short(ex)})` : short(ex);
      await this.prisma.recruitment_emails.update({
        where: { id: row.id }, data: { status: 'failed', error_message: why.slice(0, ERROR_MAX), updated_at: new Date() },
      });
      await this.recruitment.event(this.prisma, c.id, 'email_failed', `Email "${subject}" could not be confirmed as sent: ${short(ex)}`, user);
      throw new UnprocessableEntityException({
        message: unknown
          ? `The mail server did not confirm this email (${short(ex)}). It may still have been delivered — check before sending it again.`
          : `The email could not be sent: ${short(ex)}`,
      });
    }

    const sent = await this.prisma.recruitment_emails.update({
      where: { id: row.id }, data: { status: 'sent', sent_at: new Date(), updated_at: new Date() },
    });
    await this.recruitment.event(this.prisma, c.id, 'email_sent', `Email sent to ${to}: "${subject}".`, user);

    /*
     * A NEW CANDIDATE WHO HAS JUST BEEN EMAILED HAS BEEN CONTACTED. Only after the transport confirmed
     * the send — a failed or unconfirmed send threw above and never gets here, and composing or
     * previewing never calls this at all.
     *
     * One conditional write, `status = 'new'` in the WHERE, so the database decides atomically: of two
     * sends racing for the same candidate exactly one moves them, and a candidate at any other status
     * — Contacted already, Interview, Hold, Approved — is left exactly where they are. Recorded in the
     * candidate's history the way a hand status change is, with the sender's name.
     */
    const moved = await this.prisma.recruitment_candidates.updateMany({
      where: { id: c.id, status: 'new', deleted_at: null },
      data: { status: 'contacted', updated_at: new Date() },
    });
    const contacted = moved.count === 1;
    if (contacted) {
      await this.recruitment.event(this.prisma, c.id, 'status', 'New → Contacted, after an email was sent.', user);
    }
    return { data: sent, contacted };
  }

  /** Every email to this candidate, newest first — hand-sent and reminders, with what became of each. */
  async history(user: AuthUserRecord, candidateId: number): Promise<{ data: recruitment_emails[] }> {
    await this.recruitment.candidateFor(user, candidateId);
    const data = await this.prisma.recruitment_emails.findMany({
      where: { candidate_id: candidateId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return { data };
  }

  private validated(body: Record<string, unknown>): { subject: string; message: string } {
    const subject = String(body.subject ?? '').trim();
    const message = String(body.message ?? '').trim();
    if (!subject) throw new BadRequestException({ message: 'The email needs a subject.' });
    if (subject.length > SUBJECT_MAX) throw new BadRequestException({ message: `The subject can be at most ${SUBJECT_MAX} characters.` });
    if (!message) throw new BadRequestException({ message: 'The email needs a message.' });
    if (message.length > MESSAGE_MAX) throw new BadRequestException({ message: `The message can be at most ${MESSAGE_MAX} characters.` });
    return { subject, message };
  }

  // ------------------------------------------------------------------ the 24-hour reminder

  /**
   * One sweep: every interview whose 24-hour reminder has fallen due and not yet been handled.
   *
   * DUE means: still `scheduled`, the candidate not removed, the interview still ahead, at most 24
   * hours away — and its current time set at least 24 hours before it (`scheduled_set_at`), so an
   * interview booked or moved for tomorrow morning gets no late "24-hour" reminder. With the
   * 10-minute sweep a reminder goes out on the first check after it falls due.
   *
   * Each one is claimed by inserting its unique `dedupe_key` (interview id + scheduled time) BEFORE
   * anything is sent. A second sweep running at the same moment, or the same sweep after a restart,
   * meets the key and stops. Moving the interview changes the key, so the old reminder can no longer
   * fire and the new time earns its own.
   */
  async runReminders(now: Date = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
    const tally = { sent: 0, skipped: 0, failed: 0 };
    await this.closeInterrupted(now);

    const due = await this.prisma.recruitment_interviews.findMany({
      where: {
        status: 'scheduled',
        scheduled_at: { gt: now, lte: new Date(now.getTime() + REMINDER_LEAD_MS) },
        candidate: { deleted_at: null },
      },
      select: { id: true },
      orderBy: { scheduled_at: 'asc' },
    });

    let sender: mail_accounts | null | undefined;
    for (const { id } of due) {
      try {
        sender ??= await this.accounts.defaultSender('crm');
        const outcome = await this.remindOne(id, now, sender);
        if (outcome) tally[outcome] += 1;
      } catch (ex) {
        // One interview must not stop the rest of the sweep.
        this.log.warn(`Candidate reminder for interview ${id} failed: ${short(ex)}`);
        tally.failed += 1;
      }
    }
    if (tally.sent || tally.failed || tally.skipped) {
      this.log.log(`Candidate interview reminders: ${tally.sent} sent, ${tally.skipped} skipped, ${tally.failed} failed.`);
    }
    return tally;
  }

  /** Re-reads the interview and candidate, claims the reminder, sends it, records the result. */
  private async remindOne(interviewId: number, now: Date, sender: mail_accounts | null): Promise<'sent' | 'skipped' | 'failed' | null> {
    const fresh = await this.eligible(interviewId, now);
    if (!fresh) return null;
    const { interview, candidate } = fresh;
    const key = reminderKey(interview.id, interview.scheduled_at);

    const email = (candidate.email ?? '').trim();
    const validEmail = EMAIL_SHAPE.test(email);
    const { subject, html } = reminderContent(candidate, interview, sender ? (sender.from_name ?? sender.name) : null);

    // ---- claim
    const existing = await this.prisma.recruitment_emails.findUnique({ where: { dedupe_key: key } });
    let row: recruitment_emails;
    if (!existing) {
      const t = new Date();
      try {
        row = await this.prisma.recruitment_emails.create({
          data: {
            candidate_id: candidate.id, interview_id: interview.id, kind: 'interview_reminder', dedupe_key: key,
            status: validEmail ? 'sending' : 'skipped',
            to_email: email || null, from_email: sender?.from_email ?? null, subject, body: html,
            error_message: validEmail ? null : (email ? `Not a valid email address: ${email}` : 'No email address on file.'),
            attempts: validEmail ? 1 : 0, last_attempt_at: validEmail ? t : null,
            created_by: 'Automatic reminder', created_at: t, updated_at: t,
          },
        });
      } catch (ex) {
        // Somebody else inserted the same key between our read and our write: theirs to send.
        if ((ex as { code?: string }).code === 'P2002') return null;
        throw ex;
      }
      if (!validEmail) {
        await this.recruitment.event(this.prisma, candidate.id, 'email_skipped', `24-hour interview reminder not sent: ${row.error_message}`, null);
        return 'skipped';
      }
    } else {
      // Already sent, or being sent right now by another sweep: nothing to do.
      if (existing.status === 'sent' || existing.status === 'sending') return null;
      // A retry is only worth making with an address that will take it.
      if (!validEmail) return null;
      if (existing.status === 'failed' && existing.attempts >= REMINDER_MAX_ATTEMPTS) return null;
      // Claimed atomically: only one sweep can move this row from where it was to `sending`.
      const t = new Date();
      const claimed = await this.prisma.recruitment_emails.updateMany({
        where: { id: existing.id, status: existing.status, attempts: existing.attempts },
        data: {
          status: 'sending', attempts: existing.attempts + 1, last_attempt_at: t, error_message: null,
          to_email: email, from_email: sender?.from_email ?? null, subject, body: html, updated_at: t,
        },
      });
      if (claimed.count !== 1) return null;
      row = (await this.prisma.recruitment_emails.findUnique({ where: { id: existing.id } }))!;
    }

    // ---- last look: the interview may have been cancelled or moved while this was being claimed
    const still = await this.eligible(interview.id, now);
    if (!still || still.interview.scheduled_at.getTime() !== interview.scheduled_at.getTime()) {
      await this.prisma.recruitment_emails.update({
        where: { id: row.id },
        data: { status: 'skipped', error_message: 'The interview was changed or cancelled before the reminder went out.', updated_at: new Date() },
      });
      return 'skipped';
    }

    // ---- send
    if (!sender) {
      await this.fail(row.id, 'No CRM mail account is connected.');
      return 'failed';
    }
    try {
      await this.mailer.sendFromAccount(sender, { to: [email], subject, html, maxAttempts: 1 });
    } catch (ex) {
      /*
       * ONLY A CERTAIN NON-DELIVERY IS RETRIED. A claim in this table stops two sweeps sending at
       * once; it cannot know whether a message the server never confirmed actually arrived. So an
       * `unknown` or `final` failure closes the reminder (attempts set to the limit) and later
       * sweeps leave it alone. A `retry` failure keeps its attempt count and is tried again.
       */
      const kind = classifySendFailure(ex);
      const closed = kind !== 'retry';
      await this.fail(row.id, kind === 'unknown' ? `${UNKNOWN_OUTCOME} (${short(ex)})` : short(ex), closed);
      if (closed || row.attempts >= REMINDER_MAX_ATTEMPTS) {
        await this.recruitment.event(
          this.prisma, candidate.id, 'email_failed',
          kind === 'unknown'
            ? `24-hour interview reminder not confirmed by the mail server and not resent: ${short(ex)}`
            : `24-hour interview reminder could not be sent after ${row.attempts} attempt${row.attempts === 1 ? '' : 's'}: ${short(ex)}`,
          null,
        );
      }
      return 'failed';
    }
    await this.prisma.recruitment_emails.update({
      where: { id: row.id }, data: { status: 'sent', sent_at: new Date(), updated_at: new Date() },
    });
    await this.recruitment.event(this.prisma, candidate.id, 'email_sent', `24-hour interview reminder sent to ${email}.`, null);
    return 'sent';
  }

  /**
   * The interview and candidate as they are NOW, or null when the reminder no longer applies:
   * not scheduled (cancelled, completed or decided), candidate removed, no time, already passed,
   * more than 24 hours away, or a time set less than 24 hours before it.
   */
  private async eligible(interviewId: number, now: Date) {
    const interview = await this.prisma.recruitment_interviews.findFirst({
      where: { id: interviewId, status: 'scheduled', candidate: { deleted_at: null } },
      select: { id: true, scheduled_at: true, scheduled_set_at: true, created_at: true, mode: true, location: true, candidate_id: true },
    });
    if (!interview?.scheduled_at) return null;
    const at = interview.scheduled_at;
    const dueAt = at.getTime() - REMINDER_LEAD_MS;
    if (now.getTime() < dueAt || now.getTime() >= at.getTime()) return null;
    const setAt = interview.scheduled_set_at ?? interview.created_at;
    if (!setAt || setAt.getTime() > dueAt) return null;

    const candidate = await this.prisma.recruitment_candidates.findFirst({
      where: { id: interview.candidate_id, deleted_at: null },
      select: { id: true, name: true, email: true },
    });
    if (!candidate) return null;
    return { interview: { ...interview, scheduled_at: at }, candidate };
  }

  /** Records a failure; `closed` also spends every remaining attempt, so no sweep retries it. */
  private async fail(id: number, message: string, closed = false): Promise<void> {
    await this.prisma.recruitment_emails.update({
      where: { id },
      data: {
        status: 'failed', error_message: message.slice(0, ERROR_MAX), updated_at: new Date(),
        ...(closed ? { attempts: REMINDER_MAX_ATTEMPTS } : {}),
      },
    });
  }

  /** Reminders a crash left `sending`: closed as failed and never retried, in case they did arrive. */
  private async closeInterrupted(now: Date): Promise<void> {
    await this.prisma.recruitment_emails.updateMany({
      where: { kind: 'interview_reminder', status: 'sending', last_attempt_at: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
      data: {
        status: 'failed',
        attempts: REMINDER_MAX_ATTEMPTS,
        error_message: 'Interrupted while sending. Not retried automatically, in case it was delivered.',
        updated_at: now,
      },
    });
  }
}
