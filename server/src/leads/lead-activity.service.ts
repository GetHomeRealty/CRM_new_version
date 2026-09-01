import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeadAuditService } from './lead-audit.service';
import type { AuthUserRecord } from '../auth/auth.types';
import {
  AUDIO_EXTENSIONS, MAX_RECORDING_BYTES,
  isAudioType, isCallOutcome, isShowingStatus, isTaskPriority, isTaskStatus,
  TASK_PRIORITY, TASK_STATUS,
} from './lead.constants';
// The message-status vocabulary belongs to the SMS module: it has to match what the gateway
// reports, so keeping a second copy here would let the two drift apart.
import { MESSAGE_STATUS, isMessageStatus, mapProviderStatus, fromNumber, publicUrl } from '../sms/sms.constants';
import { TwilioService } from '../sms/twilio.service';
import { MailerService } from '../email/mailer.service';

import { ResourceAccessService } from '../core/resource-access.service';
import { RecordingStorageService } from './recording-storage.service';
// Extracted to ../common/ai-provider so the Calendar can use the same provider layer rather than
// growing a second copy of it. Behaviour is unchanged.
import { draftEmailWithAi, resolveEmailAi, safeForPrompt } from '../common/ai-provider';
import { assertAiFeatureEnabled } from '../common/ai-consent';
import { AiDisclosureService } from '../common/ai-disclosure.service';
// One-to-one lead mail only. Deliberately not importable from `campaigns/` — see personal-email.ts.
import { FALLBACK_SUBJECT, htmlToText, personalEmailSystem, toPersonalHtml } from './personal-email';
import { CrmEventNotifier } from '../notifications/crm-events.service';
const str = (v: unknown): string => String(v ?? '').trim();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Best-effort E.164 for a dialable number; '' when it can't be trusted (so we refuse rather than misdial). */
function toE164(raw: string | null | undefined): string {
  const s = String(raw ?? '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(s) ? s : '';
  if (s.length === 10) return `+1${s}`;                       // NANP without country code
  if (s.length === 11 && s.startsWith('1')) return `+${s}`;   // NANP with a leading 1
  return /^\d{8,15}$/.test(s) ? `+${s}` : '';
}

/** Twilio call status → the column's allowed vocabulary; null for anything unrecognised. */
function normalizeCallStatus(raw: string): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  return ['queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'canceled', 'failed'].includes(s) ? s : null;
}

/**
 * Notes, tasks, showings and calls that hang off a lead.
 *
 * The source system stored each of these as an embedded array on the lead document; here they
 * are their own tables, so each entry keeps its own author, timestamp and status.
 */
@Injectable()
export class LeadActivityService {
  private readonly log = new Logger(LeadActivityService.name);

  constructor(
    private readonly access: ResourceAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: LeadAuditService,
    private readonly twilio: TwilioService,
    private readonly mailer: MailerService,
    private readonly recordings: RecordingStorageService,
    private readonly disclosures: AiDisclosureService,
    /*
     * OPTIONAL, exactly as it is on `LeadsService`. Every existing test constructs this service
     * with the seven collaborators above and no notifier; making it required would break them all
     * and, worse, would mean a missing provider stopped a task from being SAVED. A notification is
     * not worth failing the write for — hence the optional injection and `?.` at both call sites.
     */
    private readonly crmEvents?: CrmEventNotifier,
  ) {}

  /**
   * The lead, in the shape the notifier expects, plus WHO SHOULD BE TOLD about it.
   *
   * The recipient is resolved HERE, from the lead's own row, and never taken from the request body.
   * The caller can say which lead they are acting on — they cannot nominate who gets emailed about
   * it, which is what stops a crafted request from mailing an arbitrary person or revealing that an
   * address exists. `assigned_to ?? owner_user_id` is the same ordering `LeadsService` already uses
   * to decide whose book a lead is in, so a notification cannot disagree with the Leads screen.
   *
   * `first_name: name` mirrors the existing call sites: `leads` stores one `name` column, and the
   * notifier's `nameOf` joins first and last, so the whole name goes in the first field.
   */
  private async notifyLead(leadId: number): Promise<{
    id: number; first_name: string | null; last_name: null; email: string | null; agentUserId: number | null;
  }> {
    const row = await this.prisma.leads.findFirst({
      where: { id: leadId, deleted_at: null },
      select: { id: true, name: true, email: true, assigned_to: true, owner_user_id: true },
    });
    return {
      id: leadId,
      first_name: row?.name ?? null,
      last_name: null,
      email: row?.email ?? null,
      agentUserId: row?.assigned_to ?? row?.owner_user_id ?? null,
    };
  }

  /** Every write goes through here first, so activity can't be attached to a missing lead. */
  private async requireLead(leadId: number): Promise<{ id: number; name: string }> {
    const lead = await this.prisma.leads.findFirst({ where: { id: leadId, deleted_at: null }, select: { id: true, name: true } });
    if (!lead) throw new NotFoundException({ message: 'Lead not found.' });
    return lead;
  }

  private toDate(v: unknown, field: string): Date {
    const s = str(v).slice(0, 10);
    if (!DATE_RE.test(s)) throw new BadRequestException({ message: `The ${field} must be in YYYY-MM-DD format.` });
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      throw new BadRequestException({ message: `That ${field} does not exist.` });
    }
    return d;
  }

  // ----------------------------------------------------------------- notes
  async addNote(leadId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const lead = await this.requireLead(leadId);
    const content = str(body.content);
    if (!content) throw new BadRequestException({ message: 'The note cannot be empty.' });
    if (content.length > 20000) throw new BadRequestException({ message: 'The note must be 20,000 characters or fewer.' });

    const now = new Date();
    const note = await this.prisma.lead_notes.create({
      data: {
        lead_id: lead.id, content, pinned: body.pinned === true,
        created_by: user.name, user_id: user.id ?? null, created_at: now, updated_at: now,
      },
    });
    await this.audit.record(user, 'Lead note added', lead.name, content.slice(0, 120));
    return this.presentNote(note);
  }

  async updateNote(leadId: number, noteId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_notes.findFirst({ where: { id: noteId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'Note not found.' });
    // Reaching the lead is not the same as owning what somebody else wrote on it. Editing is the
    // author's alone — the note carries their name, and rewriting the words under it is
    // misattribution rather than an edit.
    this.access.assertNoteAuthor(user, existing, 'edit');

    const data: Record<string, unknown> = { updated_at: new Date() };
    if (body.content !== undefined) {
      const content = str(body.content);
      if (!content) throw new BadRequestException({ message: 'The note cannot be empty.' });
      data.content = content;
    }
    if (body.pinned !== undefined) data.pinned = body.pinned === true;

    const note = await this.prisma.lead_notes.update({ where: { id: noteId }, data });
    await this.audit.record(user, 'Lead note updated', `Lead #${leadId}`, note.pinned ? 'Pinned' : '');
    return this.presentNote(note);
  }

  async removeNote(leadId: number, noteId: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_notes.findFirst({ where: { id: noteId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'Note not found.' });
    // The author, or an administrator moderating. Unlike an edit, a deletion leaves the record
    // honest rather than altered, so there is a real case for it above the author.
    this.access.assertNoteAuthor(user, existing, 'delete');
    await this.prisma.lead_notes.delete({ where: { id: noteId } });
    // The CONTENT goes in the trail, not just the fact that something was removed. A deleted note
    // was previously unrecoverable and unreadable after the fact, so "a note was deleted" could not
    // answer the only question anyone would ask afterwards: which one, and what did it say?
    await this.audit.record(
      user, 'Lead note deleted', `Lead #${leadId}`,
      `By ${existing.created_by ?? 'unknown'}: ${existing.content.slice(0, 200)}`,
    );
    return { deleted: true };
  }

  /**
   * Remove one entry from a lead's email history.
   *
   * THE RECORD IS NOT LOST, IT MOVES. `lead_emails` has no `deleted_at`, so this is a hard delete —
   * and an email row is evidence that the brokerage did or did not contact a client, which is the
   * kind of thing somebody asks about months later. So the whole of it goes into the audit trail
   * first: recipient, subject, outcome, when, and who sent it. "An email was deleted" would answer
   * none of the questions that get asked afterwards, and the same reasoning already governs note
   * deletion a few methods above.
   *
   * FAILED SENDS ARE THE COMMON CASE for this. Five of the six entries on the lead that prompted
   * this were `invalid_grant` failures from one broken mailbox, repeated — noise sitting on top of
   * the correspondence that matters. Clearing them is tidying, not concealment, which is exactly
   * why the trail keeps a copy.
   *
   * Scoped by `lead_id` as well as `id`: an email id from another lead resolves to nothing rather
   * than deleting somebody else's record through a lead the caller happens to be allowed to see.
   */
  async removeEmail(leadId: number, emailId: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_emails.findFirst({ where: { id: emailId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'That email is not on this lead.' });

    await this.prisma.lead_emails.delete({ where: { id: emailId } });

    await this.audit.record(
      user, 'Lead email deleted', `Lead #${leadId}`,
      `${existing.status} to ${existing.recipient} on ${existing.sent_at.toISOString().slice(0, 16).replace('T', ' ')}`
      + ` by ${existing.sent_by ?? 'unknown'} — "${existing.subject}"`
      + (existing.error ? ` (${existing.error.slice(0, 200)})` : ''),
    );
    return { deleted: true };
  }

  // ----------------------------------------------------------------- tasks
  async addTask(leadId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const lead = await this.requireLead(leadId);
    const title = str(body.title);
    if (!title) throw new BadRequestException({ message: 'A task title is required.' });
    const due = this.toDate(body.due_date, 'due date');

    const status = str(body.status) || 'pending';
    if (!isTaskStatus(status)) throw new BadRequestException({ message: `The status must be one of: ${TASK_STATUS.join(', ')}.` });
    const priority = str(body.priority) || 'medium';
    if (!isTaskPriority(priority)) throw new BadRequestException({ message: `The priority must be one of: ${TASK_PRIORITY.join(', ')}.` });

    const now = new Date();
    const task = await this.prisma.lead_tasks.create({
      data: {
        lead_id: lead.id, title: title.slice(0, 255), due_date: due,
        description: str(body.description) || null, status, priority,
        assigned_to: await this.resolveAssignee(body.assigned_to, user),
        created_by: user.name, user_id: user.id ?? null, created_at: now, updated_at: now,
      },
    });
    await this.audit.record(user, 'Lead task added', lead.name, `${title} — due ${due.toISOString().slice(0, 10)}`);
    /*
     * Told after the write, and never allowed to fail it.
     *
     * `void` because the caller is a person waiting on a form: a slow mail server must not hold the
     * response open, and a notification failure must not turn a saved task into an error. The
     * dispatcher records its own outcome per channel in `notification_deliveries`, which is where a
     * failure is visible — the `catch` here only stops an unhandled rejection.
     */
    void this.crmEvents
      ?.taskAssigned(task, await this.notifyLead(lead.id), task.assigned_to, user.id ?? null, user.name)
      .catch(() => undefined);
    return this.presentTask(task);
  }

  async updateTask(leadId: number, taskId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_tasks.findFirst({ where: { id: taskId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'Task not found.' });

    const data: Record<string, unknown> = { updated_at: new Date() };
    if (body.title !== undefined) {
      const title = str(body.title);
      if (!title) throw new BadRequestException({ message: 'A task title is required.' });
      data.title = title.slice(0, 255);
    }
    if (body.due_date !== undefined) data.due_date = this.toDate(body.due_date, 'due date');
    if (body.description !== undefined) data.description = str(body.description) || null;
    if (body.status !== undefined) {
      const status = str(body.status);
      if (!isTaskStatus(status)) throw new BadRequestException({ message: `The status must be one of: ${TASK_STATUS.join(', ')}.` });
      data.status = status;
    }
    if (body.priority !== undefined) {
      const priority = str(body.priority);
      if (!isTaskPriority(priority)) throw new BadRequestException({ message: `The priority must be one of: ${TASK_PRIORITY.join(', ')}.` });
      data.priority = priority;
    }
    if (body.assigned_to !== undefined) data.assigned_to = await this.resolveAssignee(body.assigned_to, user);

    const task = await this.prisma.lead_tasks.update({ where: { id: taskId }, data });
    await this.audit.record(user, 'Lead task updated', task.title, `Status: ${task.status}`);
    return this.presentTask(task);
  }

  async removeTask(leadId: number, taskId: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_tasks.findFirst({ where: { id: taskId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'Task not found.' });
    await this.prisma.lead_tasks.delete({ where: { id: taskId } });
    await this.audit.record(user, 'Lead task deleted', existing.title);
    return { deleted: true };
  }

  // -------------------------------------------------------------- showings
  async addShowing(leadId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const lead = await this.requireLead(leadId);
    const date = this.toDate(body.showing_date, 'showing date');
    const time = str(body.time) || '12:00';
    if (!TIME_RE.test(time)) throw new BadRequestException({ message: 'The time must be in 24-hour HH:MM format.' });

    const status = str(body.status) || 'scheduled';
    if (!isShowingStatus(status)) throw new BadRequestException({ message: 'That is not a recognised showing status.' });

    const now = new Date();
    const showing = await this.prisma.lead_showings.create({
      data: {
        lead_id: lead.id, showing_date: date, time,
        property: str(body.property) || null, notes: str(body.notes) || null, status,
        created_by: user.name, user_id: user.id ?? null, created_at: now, updated_at: now,
      },
    });
    await this.audit.record(user, 'Lead showing scheduled', lead.name, `${str(body.property) || 'Property'} — ${date.toISOString().slice(0, 10)} ${time}`);
    // Same shape as `addTask`: after the write, never able to fail it. The recipient is the lead's
    // own agent, resolved server-side — see `notifyLead`.
    const owner = await this.notifyLead(lead.id);
    void this.crmEvents
      ?.showingCreated(showing, owner, owner.agentUserId, user.id ?? null, user.name)
      .catch(() => undefined);
    return this.presentShowing(showing);
  }

  async updateShowing(leadId: number, showingId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_showings.findFirst({ where: { id: showingId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'Showing not found.' });

    const data: Record<string, unknown> = { updated_at: new Date() };
    if (body.showing_date !== undefined) data.showing_date = this.toDate(body.showing_date, 'showing date');
    if (body.time !== undefined) {
      const time = str(body.time);
      if (!TIME_RE.test(time)) throw new BadRequestException({ message: 'The time must be in 24-hour HH:MM format.' });
      data.time = time;
    }
    if (body.property !== undefined) data.property = str(body.property) || null;
    if (body.notes !== undefined) data.notes = str(body.notes) || null;
    if (body.status !== undefined) {
      const status = str(body.status);
      if (!isShowingStatus(status)) throw new BadRequestException({ message: 'That is not a recognised showing status.' });
      data.status = status;
    }

    const showing = await this.prisma.lead_showings.update({ where: { id: showingId }, data });
    /*
     * Say what MOVED, not just where it ended up. A showing that changes day is the substantive
     * edit here - CRM-042 gave Reschedule a date and time to send - and an entry reading only
     * "Status: scheduled" records the half of it nobody needs to look up later. The OLD slot is in
     * the line because the question this record exists to answer is "when was this viewing before
     * somebody moved it".
     *
     * Same `toISOString().slice(0, 10)` the API uses for `showing_date`, so the audit trail and the
     * screen name a date the same way.
     */
    const day = (d: Date): string => d.toISOString().slice(0, 10);
    const moved = day(existing.showing_date) !== day(showing.showing_date) || existing.time !== showing.time;
    const detail = moved
      ? `Moved from ${day(existing.showing_date)} ${existing.time} to ${day(showing.showing_date)} ${showing.time}. Status: ${showing.status}`
      : `Status: ${showing.status}`;
    await this.audit.record(user, 'Lead showing updated', showing.property ?? `Lead #${leadId}`, detail);
    return this.presentShowing(showing);
  }

  async removeShowing(leadId: number, showingId: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_showings.findFirst({ where: { id: showingId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'Showing not found.' });
    await this.prisma.lead_showings.delete({ where: { id: showingId } });
    await this.audit.record(user, 'Lead showing deleted', existing.property ?? `Lead #${leadId}`);
    return { deleted: true };
  }

  // ----------------------------------------------------------------- calls
  /**
   * Log a contact attempt. There is no telephony integration here, so the entry is recorded
   * by the agent after the call rather than captured automatically.
   */
  async addCall(leadId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const lead = await this.requireLead(leadId);

    const raw = str(body.called_at);
    const calledAt = raw ? new Date(raw) : new Date();
    if (Number.isNaN(calledAt.getTime())) throw new BadRequestException({ message: 'That call time is not a valid date.' });

    const outcome = str(body.outcome);
    if (outcome && !isCallOutcome(outcome)) throw new BadRequestException({ message: 'That is not a recognised call outcome.' });

    const durationRaw = body.duration;
    let duration: number | null = null;
    if (durationRaw !== undefined && durationRaw !== null && durationRaw !== '') {
      const n = Number(durationRaw);
      if (!Number.isInteger(n) || n < 0) throw new BadRequestException({ message: 'The duration must be a whole number of seconds.' });
      duration = n;
    }

    const call = await this.prisma.lead_calls.create({
      data: {
        lead_id: lead.id, called_at: calledAt, duration, outcome: outcome || null,
        notes: str(body.notes) || null, created_by: user.name, user_id: user.id ?? null, created_at: new Date(),
      },
    });
    await this.audit.record(user, 'Lead call logged', lead.name, outcome || 'Call logged');
    return this.presentCall(call);
  }

  /**
   * Click-to-call via Twilio. Twilio rings the AGENT's own phone first; when they answer, the
   * TwiML bridges them to the lead (caller-ID'd as the brokerage number) and records the
   * conversation. The row is written up front — status `initiated` — so the status callback has
   * something to update; if Twilio refuses the call the row is marked `failed` so the log is honest.
   */
  async initiateCall(leadId: number, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    if (!this.twilio.voiceConfigured()) {
      throw new BadRequestException({ message: 'Voice calling is not configured on the server. Set the TWILIO_* environment variables to enable click-to-call.' });
    }
    const lead = await this.prisma.leads.findFirst({ where: { id: leadId, deleted_at: null }, select: { id: true, name: true, phone: true } });
    if (!lead) throw new NotFoundException({ message: 'Lead not found.' });

    const leadNumber = toE164(lead.phone);
    if (!leadNumber) throw new BadRequestException({ message: 'This lead has no valid phone number to call.' });
    const agentNumber = toE164(user.phone);
    if (!agentNumber) throw new BadRequestException({ message: 'Add your own phone number in Settings first — click-to-call rings your phone, then connects the lead.' });

    const row = await this.prisma.lead_calls.create({
      data: { lead_id: lead.id, called_at: new Date(), status: 'initiated', created_by: user.name, user_id: user.id ?? null, created_at: new Date() },
    });

    const base = publicUrl();
    const callback = base ? `${base}/api/sms/twilio/call-status?call=${row.id}` : '';
    const recCb = base
      ? ` recordingStatusCallback="${base}/api/sms/twilio/recording-status?call=${row.id}" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"`
      : '';
    const spoken = (lead.name || 'your lead').replace(/[<>&]/g, ' ').slice(0, 80);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting you to ${spoken}. Please hold.</Say><Dial callerId="${fromNumber()}" record="record-from-answer"${recCb}><Number>${leadNumber}</Number></Dial></Response>`;

    try {
      const res = await this.twilio.call(agentNumber, twiml, callback);
      const updated = await this.prisma.lead_calls.update({
        where: { id: row.id }, data: { provider_sid: res.sid, status: normalizeCallStatus(res.status) ?? 'initiated' },
      });
      await this.audit.record(user, 'Lead call placed', lead.name, `Click-to-call to ${leadNumber}`);
      return { ...this.presentCall(updated), sid: res.sid };
    } catch (err) {
      await this.prisma.lead_calls.update({ where: { id: row.id }, data: { status: 'failed', notes: (err instanceof Error ? err.message : 'Call failed').slice(0, 255) } });
      throw err;
    }
  }

  /**
   * Prepare an in-browser (Voice SDK) call: create the log row up front so the child-leg status
   * callback has something to update, and hand the browser the E.164 number to dial. The actual
   * audio happens in the browser via the Voice SDK; this only sets up the record + validates.
   */
  async prepareBrowserCall(leadId: number, user: AuthUserRecord): Promise<{ callId: number; to: string; leadName: string }> {
    await this.access.assertLead(user, leadId);
    const lead = await this.prisma.leads.findFirst({ where: { id: leadId, deleted_at: null }, select: { id: true, name: true, phone: true } });
    if (!lead) throw new NotFoundException({ message: 'Lead not found.' });

    const to = toE164(lead.phone);
    if (!to) throw new BadRequestException({ message: 'This lead has no valid phone number to call.' });

    const row = await this.prisma.lead_calls.create({
      data: { lead_id: lead.id, called_at: new Date(), status: 'initiated', notes: 'In-browser call', created_by: user.name, user_id: user.id ?? null, created_at: new Date() },
    });
    await this.audit.record(user, 'Lead call placed', lead.name, `In-browser call to ${to}`);
    return { callId: row.id, to, leadName: lead.name };
  }

  async removeCall(leadId: number, callId: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_calls.findFirst({ where: { id: callId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'Call not found.' });
    await this.prisma.lead_calls.delete({ where: { id: callId } });
    /*
     * WHAT was deleted, not merely that something was.
     *
     * A call log is the record that somebody spoke to a client — under CASL it is evidence of the
     * contact, and it is the kind of thing a complaint turns on months later. Anyone who can reach
     * the lead may delete one (unlike a note, a call is a shared fact rather than one person's
     * words), so the protection has to be that the deletion cannot be silent. The trail carried
     * only "Lead #12" until now, which cannot answer the one question anyone asks afterwards.
     *
     * This became urgent when the screen grew a Delete button for calls; before that the endpoint
     * existed and nothing in the interface reached it.
     */
    await this.audit.record(
      user, 'Lead call deleted', `Lead #${leadId}`,
      `Logged by ${existing.created_by ?? 'unknown'} at ${existing.called_at.toISOString()}`
      + `${existing.outcome ? ` — ${existing.outcome}` : ''}`
      + `${existing.duration != null ? `, ${existing.duration}s` : ''}`
      + `${existing.notes ? `: ${existing.notes.slice(0, 200)}` : ''}`,
    );
    return { deleted: true };
  }

  // ------------------------------------------------------------------ email
  /**
   * Email one lead, from their own page.
   *
   * Deliberately not a Campaign: no tracking pixel, no unsubscribe footer, no audience. It is
   * one person writing to another, and it goes out through the same SMTP account Email Settings
   * already manages.
   *
   * An unsubscribed lead is refused. They opted out of hearing from the brokerage, and honouring
   * that only for bulk sends while letting individual mail through would defeat the point — and
   * in Canada, CASL does not distinguish.
   *
   * The row is written after the send either way: `sent` when SMTP accepted it, `failed` with
   * the reason when it did not. A history that only records successes is worse than none.
   */
  async sendEmail(leadId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const lead = await this.prisma.leads.findFirst({
      where: { id: leadId, deleted_at: null },
      select: { id: true, name: true, email: true, unsubscribed: true },
    });
    if (!lead) throw new NotFoundException({ message: 'Lead not found.' });
    if (!lead.email) throw new BadRequestException({ message: 'This lead has no email address.' });
    if (lead.unsubscribed) {
      throw new BadRequestException({ message: `${lead.name} has unsubscribed, so they cannot be emailed.` });
    }

    const subject = str(body.subject);
    if (!subject) throw new BadRequestException({ message: 'A subject is required.' });
    if (subject.length > 255) throw new BadRequestException({ message: 'That subject is too long.' });
    const html = str(body.body);
    if (!html) throw new BadRequestException({ message: 'The message cannot be empty.' });

    const accountId = body.account_id == null || body.account_id === '' ? null : Number(body.account_id);
    if (accountId !== null && (!Number.isInteger(accountId) || accountId <= 0)) {
      throw new BadRequestException({ message: 'That is not a valid mail account.' });
    }
    /*
     * THE CHOSEN SENDER HAS TO BE ONE OF THEIRS.
     *
     * A well-formed id was the whole of the check, and the id then went to the mailer unexamined —
     * so naming a colleague's mailbox sent the message from THEIR address with THEIR OAuth token,
     * and logged it against them. `resolveSender` now refuses that too, but it refuses by falling
     * back to this user's own default, which would send the message from a different address than
     * the one the sender picked and say nothing. Refusing here instead keeps the two answers the
     * same and makes the reason visible.
     *
     * `user_id: null` is the brokerage mailbox, which everybody may legitimately send through.
     */
    if (accountId !== null) {
      const allowed = await this.prisma.mail_accounts.findFirst({
        where: { id: accountId, is_active: true, OR: [{ user_id: user.id ?? -1 }, { user_id: null }] },
        select: { id: true },
      });
      if (!allowed) {
        throw new BadRequestException({
          message: 'That mailbox is not one you can send from. Choose one of your own connected accounts.',
        });
      }
    }

    let status = 'sent';
    let error: string | null = null;
    try {
      // The sender's own connected account is preferred, so an agent's email leaves from their
      // own address; it falls back to the brokerage account when they have not added one.
      //
      // No `headers` argument, which is what keeps List-Unsubscribe off this message: that header
      // is correct for campaigns and wrong here, and the difference is the absent argument rather
      // than a flag anybody has to remember to set.
      //
      // The last argument adds the `text/plain` alternative. Personal mail is normally multipart;
      // sending HTML-only is one of the things that makes typed correspondence look generated.
      await this.mailer.sendDirect(lead.email, subject, html, accountId, [], user.id ?? null, undefined, htmlToText(html));
    } catch (ex) {
      status = 'failed';
      error = String((ex as Error).message ?? ex).slice(0, 500);
    }

    const row = await this.prisma.lead_emails.create({
      data: {
        lead_id: lead.id, recipient: lead.email, subject, body: html,
        status, error, account_id: accountId,
        sent_by: user.name, user_id: user.id ?? null, sent_at: new Date(),
      },
    });
    await this.audit.record(user, status === 'sent' ? 'Lead emailed' : 'Lead email failed', lead.name, subject);

    // Surfaced as a failure so the agent sees it went wrong, with the row already recorded.
    if (status === 'failed') throw new BadRequestException({ message: `The email could not be sent: ${error}` });
    return this.presentEmail(row);
  }

  private presentEmail(e: {
    id: number; recipient: string; subject: string; body: string; status: string;
    error: string | null; sent_by: string | null; sent_at: Date;
  }): Record<string, unknown> {
    return {
      id: e.id, recipient: e.recipient, subject: e.subject, body: e.body, status: e.status,
      error: e.error, sent_by: e.sent_by, sent_at: e.sent_at.toISOString(),
    };
  }

  // ------------------------------------------------------- call recordings
  /**
   * Attach the audio recording of a call.
   *
   * Nothing captures this automatically — there is no telephony integration — so the agent
   * uploads whatever file their phone or dialler produced. The type is checked against an audio
   * allowlist rather than trusted, because the download endpoint serves it inline so the browser
   * can play it: an HTML or SVG file served inline from our own origin would be a script-injection
   * hole. Anything not on the list is refused rather than silently relabelled.
   */
  async addRecording(leadId: number, callId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const call = await this.prisma.lead_calls.findFirst({ where: { id: callId, lead_id: leadId } });
    if (!call) throw new NotFoundException({ message: 'Call not found.' });

    const contentType = str(body.content_type).toLowerCase().split(';')[0];
    if (!isAudioType(contentType)) {
      throw new BadRequestException({
        message: `That is not an audio file. Accepted formats: ${AUDIO_EXTENSIONS.join(', ')}.`,
      });
    }

    // Accept either a bare base64 string or a full data: URI from a file input.
    const base64 = str(body.data).replace(/^data:[^;]+;base64,/, '');
    if (!base64) throw new BadRequestException({ message: 'The recording is empty.' });
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) throw new BadRequestException({ message: 'The recording is empty.' });
    if (buffer.length > MAX_RECORDING_BYTES) {
      const mb = (MAX_RECORDING_BYTES / 1024 / 1024).toFixed(0);
      throw new BadRequestException({
        message: `That recording is ${(buffer.length / 1024 / 1024).toFixed(1)} MB, above the ${mb} MB limit.`,
      });
    }

    const filename = (str(body.filename) || 'recording').slice(0, 255);
    // Prisma's Bytes rejects a Node Buffer (it is backed by a SharedArrayBuffer under Jest).
    const bytes = new Uint8Array(buffer);

    /*
     * Disk first, database as the fallback.
     *
     * `write` returns null when the storage directory is unusable — a read-only mount, a container
     * with no volume, a full disk — and in that case the bytes go into the column exactly as they
     * always did. An upload must not fail because of where the file was going to live; the recording
     * of a conversation with a client is the thing worth keeping, and the storage location is an
     * operational detail it should not depend on.
     */
    const storagePath = await this.recordings.write(bytes, contentType);
    const data = {
      filename, content_type: contentType, size: buffer.length,
      // Exactly one of these is set — the database CHECK constraint enforces it, so a row can never
      // end up describing a recording that lives nowhere.
      data: storagePath ? null : bytes,
      storage_path: storagePath,
      created_by: user.name, created_at: new Date(),
    };

    // One per call: re-uploading replaces the previous file rather than stacking up copies — so the
    // one it replaces has to be removed from disk, or every re-upload leaks a file.
    const previous = await this.prisma.lead_call_recordings.findUnique({
      where: { call_id: callId }, select: { storage_path: true },
    });
    const saved = await this.prisma.lead_call_recordings.upsert({
      where: { call_id: callId },
      create: { call_id: callId, ...data },
      update: data,
    });
    if (previous?.storage_path && previous.storage_path !== storagePath) {
      await this.recordings.remove(previous.storage_path);
    }

    await this.audit.record(user, 'Lead call recording attached', `Lead #${leadId}`, filename);
    return this.presentRecording(saved);
  }

  /**
   * The stored bytes, for the download/playback endpoint.
   *
   * Reads from wherever this particular recording lives: `storage_path` for anything written since
   * the move to disk, `data` for everything before it. Both are supported indefinitely rather than
   * on a deadline — a row whose file cannot be read is a missing recording, and the honest answer
   * to that is a 404 with a reason, not a zero-byte download that plays silence.
   */
  async getRecording(leadId: number, callId: number, user: AuthUserRecord): Promise<{ filename: string; content_type: string; data: Uint8Array }> {
    await this.access.assertLead(user, leadId);
    const call = await this.prisma.lead_calls.findFirst({ where: { id: callId, lead_id: leadId }, select: { id: true } });
    if (!call) throw new NotFoundException({ message: 'Call not found.' });
    const rec = await this.prisma.lead_call_recordings.findUnique({ where: { call_id: callId } });
    if (!rec) throw new NotFoundException({ message: 'No recording is attached to that call.' });

    if (rec.storage_path) {
      const bytes = await this.recordings.read(rec.storage_path);
      if (!bytes) {
        throw new NotFoundException({
          message: 'That recording is recorded against the call but its file is missing from storage. '
            + 'It may not have survived a restart on a server without persistent storage — check RECORDING_STORAGE_DIR.',
        });
      }
      return { filename: rec.filename, content_type: rec.content_type, data: bytes };
    }
    // Written before the move to disk; still served from the column it has always been in.
    return { filename: rec.filename, content_type: rec.content_type, data: rec.data ?? new Uint8Array() };
  }

  async removeRecording(leadId: number, callId: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    await this.access.assertLead(user, leadId);
    const call = await this.prisma.lead_calls.findFirst({ where: { id: callId, lead_id: leadId }, select: { id: true } });
    if (!call) throw new NotFoundException({ message: 'Call not found.' });
    const rec = await this.prisma.lead_call_recordings.findUnique({ where: { call_id: callId }, select: { id: true, storage_path: true } });
    if (!rec) throw new NotFoundException({ message: 'No recording is attached to that call.' });
    await this.prisma.lead_call_recordings.delete({ where: { call_id: callId } });
    // The row goes first: if the unlink fails, the result is an orphaned file rather than a row
    // pointing at a file that is no longer there.
    if (rec.storage_path) await this.recordings.remove(rec.storage_path);
    await this.audit.record(user, 'Lead call recording deleted', `Lead #${leadId}`);
    return { deleted: true };
  }

  // -------------------------------------------------------------- messages
  /**
   * Record a message in the SMS conversation.
   *
   * Nothing is transmitted here — the app has no SMS gateway. The browser hands the text to the
   * device's messaging app via an `sms:` link and this call keeps the record, so the conversation
   * survives on the lead rather than only in the agent's phone. Inbound replies are logged the
   * same way.
   */
  async addMessage(leadId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const lead = await this.prisma.leads.findFirst({
      where: { id: leadId, deleted_at: null },
      select: { id: true, name: true, phone: true },
    });
    if (!lead) throw new NotFoundException({ message: 'Lead not found.' });

    const text = str(body.body);
    if (!text) throw new BadRequestException({ message: 'The message cannot be empty.' });
    if (text.length > 2000) throw new BadRequestException({ message: 'The message is too long — keep it under 2000 characters.' });

    const direction = str(body.direction) || 'outbound';
    if (direction !== 'outbound' && direction !== 'inbound') {
      throw new BadRequestException({ message: 'A message must be inbound or outbound.' });
    }

    const raw = str(body.sent_at);
    const sentAt = raw ? new Date(raw) : new Date();
    if (Number.isNaN(sentAt.getTime())) throw new BadRequestException({ message: 'That message time is not a valid date.' });

    // An inbound message has no delivery status — it already arrived.
    let status: string | null = null;
    if (direction === 'outbound') {
      status = str(body.status) || 'sent';
      if (!isMessageStatus(status)) {
        throw new BadRequestException({ message: `The status must be one of: ${MESSAGE_STATUS.join(', ')}.` });
      }
    }

    /*
     * `send` asks the gateway to deliver it for real. Without one the caller falls back to an
     * `sms:` link and only logs what it handed over, so the flag is refused rather than silently
     * ignored — a message the agent believes was sent but never was is the worst outcome here.
     *
     * The send happens BEFORE the row is written. If Twilio rejects the number there is nothing
     * worth recording as "sent", and the agent gets Twilio's own reason back.
     */
    /*
     * THE DESTINATION COMES FROM THE LEAD, NOT FROM THE REQUEST.
     *
     * It used to be `str(body.phone)`, handed straight to the gateway without ever being compared
     * to the lead. Any user with `lead` edit — which is every agent — could therefore send two
     * thousand characters of arbitrary text to any number in the world on the brokerage's Twilio
     * account: toll fraud, harassment, and unsolicited commercial SMS under CASL, all billed to the
     * brokerage and logged against a lead who had nothing to do with it.
     *
     * The lead's own number is the only number this endpoint will dial. A caller who wants to text
     * somebody else can put that person on the lead record first, which is the point at which the
     * usual rules — ownership, opt-out, the audit trail — actually apply to them.
     */
    let sid: string | null = null;
    let destination = str(body.phone) || null;
    if (body.send === true) {
      if (direction !== 'outbound') throw new BadRequestException({ message: 'Only an outbound message can be sent.' });
      const to = toE164(lead.phone);
      if (!to) {
        throw new BadRequestException({
          message: lead.phone
            ? `${lead.name}'s phone number (${lead.phone}) is not a number this can dial. Correct it on the lead first.`
            : `${lead.name} has no phone number on file, so there is nothing to text.`,
        });
      }
      destination = to;
      const result = await this.twilio.send(to, text);
      sid = result.sid;
      status = mapProviderStatus(result.status) ?? 'queued';
    }

    const msg = await this.prisma.lead_messages.create({
      data: {
        lead_id: lead.id, direction, status, body: text, phone: destination,
        provider_sid: sid,
        sent_at: sentAt, created_by: user.name, user_id: user.id ?? null, created_at: new Date(),
      },
    });
    await this.audit.record(user, direction === 'inbound' ? 'Lead SMS reply logged' : 'Lead SMS logged', lead.name);
    return this.presentMessage(msg);
  }

  /**
   * Change the recorded delivery status of an outbound message.
   *
   * Nothing here is automatic: the agent marks a message read when the lead replies or says they
   * saw it, and failed when the number bounced. An inbound message has no status to change.
   */
  async updateMessage(leadId: number, messageId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_messages.findFirst({ where: { id: messageId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'Message not found.' });
    if (existing.direction !== 'outbound') {
      throw new BadRequestException({ message: 'A received message has no delivery status.' });
    }

    const status = str(body.status);
    if (!isMessageStatus(status)) {
      throw new BadRequestException({ message: `The status must be one of: ${MESSAGE_STATUS.join(', ')}.` });
    }

    const updated = await this.prisma.lead_messages.update({ where: { id: messageId }, data: { status } });
    await this.audit.record(user, 'Lead SMS status changed', `Lead #${leadId}`, status);
    return this.presentMessage(updated);
  }

  async removeMessage(leadId: number, messageId: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    await this.access.assertLead(user, leadId);
    const existing = await this.prisma.lead_messages.findFirst({ where: { id: messageId, lead_id: leadId } });
    if (!existing) throw new NotFoundException({ message: 'Message not found.' });
    await this.prisma.lead_messages.delete({ where: { id: messageId } });
    // The text goes in the trail for the same reason a deleted call's notes do: an SMS thread is a
    // record of what was said to a client, and "a message was deleted" is not a record of anything.
    await this.audit.record(
      user, 'Lead SMS deleted', `Lead #${leadId}`,
      `${existing.direction === 'inbound' ? 'From' : 'To'} ${existing.phone ?? 'unknown'}`
      + `, logged by ${existing.created_by ?? 'unknown'}: ${existing.body.slice(0, 200)}`,
    );
    return { deleted: true };
  }

  // ---------------------------------------------------------------- shared
  /** An unspecified assignee falls back to whoever is creating the item. */
  private async resolveAssignee(raw: unknown, user: AuthUserRecord): Promise<number | null> {
    if (raw === null || raw === '' || raw === 'unassigned') return null;
    if (raw === undefined) return user.id ?? null;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException({ message: 'Not a valid user.' });
    const found = await this.prisma.users.findFirst({ where: { id }, select: { id: true } });
    if (!found) throw new BadRequestException({ message: 'That user does not exist.' });
    return id;
  }

  private presentNote(n: { id: number; content: string; pinned: boolean; created_by: string | null; created_at: Date | null }): Record<string, unknown> {
    return { id: n.id, content: n.content, pinned: n.pinned, created_by: n.created_by, created_at: n.created_at?.toISOString() ?? null };
  }

  private presentTask(t: {
    id: number; title: string; due_date: Date; description: string | null; status: string;
    priority: string; assigned_to: number | null; created_by: string | null; created_at: Date | null;
  }): Record<string, unknown> {
    return {
      id: t.id, title: t.title, due_date: t.due_date.toISOString().slice(0, 10),
      description: t.description, status: t.status, priority: t.priority,
      assigned_to: t.assigned_to, created_by: t.created_by, created_at: t.created_at?.toISOString() ?? null,
    };
  }

  private presentShowing(s: {
    id: number; showing_date: Date; time: string; property: string | null;
    notes: string | null; status: string; created_by: string | null; created_at: Date | null;
  }): Record<string, unknown> {
    return {
      id: s.id, showing_date: s.showing_date.toISOString().slice(0, 10), time: s.time,
      property: s.property, notes: s.notes, status: s.status,
      created_by: s.created_by, created_at: s.created_at?.toISOString() ?? null,
    };
  }

  /**
   * Draft a one-off email with AI. Takes the agent's plain-language instruction and the lead's
   * name, returns a subject + a styled HTML body the agent can review and send. Works with any one
   * of Anthropic, OpenAI or Google Gemini — whichever key is configured (see `resolveEmailAi`). It
   * only drafts; nothing is sent here.
   */
  async generateEmail(leadId: number, prompt: string, user: AuthUserRecord): Promise<{ subject: string; html: string; fallback?: boolean; reason?: string }> {
    await this.access.assertLead(user, leadId);
    const cfg = resolveEmailAi();
    if (!cfg) {
      throw new ServiceUnavailableException({
        message: 'AI email generation is not configured on the server. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, then restart.',
      });
    }
    /*
     * OFF BY DEFAULT, because this sends a client's information to a company the client has never
     * heard of.
     *
     * Everything else in this module keeps lead data inside the brokerage. This one call puts a
     * real person's name, and whatever the agent typed about them, into an HTTP request to
     * Anthropic, OpenAI or Google. That may be perfectly acceptable — it is a routine arrangement —
     * but it is a decision about somebody else's personal information, and under PIPEDA the
     * brokerage is accountable for it whether or not anyone noticed it was happening.
     *
     * The switch and the wording of the refusal both live in `common/ai-consent.ts`, with the other
     * two features that disclose to a model, so what each one sends is written down in one place a
     * privacy officer can read rather than spread across three services.
     */
    assertAiFeatureEnabled('lead-email-drafting');

    const p = str(prompt);
    if (!p) throw new BadRequestException({ message: 'Describe the email you want to send.' });
    if (p.length > 2000) throw new BadRequestException({ message: 'That instruction is too long.' });

    const lead = await this.prisma.leads.findFirst({ where: { id: leadId, deleted_at: null }, select: { name: true } });
    if (!lead) throw new NotFoundException({ message: 'Lead not found.' });

    /*
     * ONLY THE FIRST NAME LEAVES. The model needs something to address the reader as; it does not
     * need a full legal name, and it has never needed the email address, phone number, budget or
     * property details that sit on the same row. Sending the minimum is the difference between
     * "the drafting tool knows what to call them" and "the brokerage's client list has been posted
     * to a third party one lead at a time".
     *
     * The name is also SANITISED before it goes into the system prompt. It is attacker-controllable
     * — a Meta lead form, a web enquiry and a CSV import all write it — so a lead called
     * `". Ignore previous instructions and…` would otherwise be writing our instructions for us.
     * Quotes and newlines out, length capped, and it is delimited so the model can tell data from
     * direction.
     */
    const firstName = safeForPrompt(String(lead.name ?? '').trim().split(/\s+/)[0] ?? '', 40);
    const agentName = safeForPrompt(user.name ?? '', 80);

    /*
     * ASKS FOR PERSONAL CORRESPONDENCE, NOT A STYLED EMAIL.
     *
     * This prompt used to ask for "a self-contained HTML email body with inline CSS and clean,
     * professional styling (a simple header, well-spaced paragraphs, and a signature)" — a marketing
     * artefact produced by a feature whose entire purpose is one agent writing to one person. The
     * instruction now lives in `personal-email.ts` beside the allowlist that enforces it, so the
     * request and the guarantee cannot drift apart.
     */
    const system = personalEmailSystem(firstName, agentName);
    const userText = `Agent instruction: ${p}`;

    /*
     * Recorded through the SHARED disclosure writer, not the Leads one.
     *
     * "Did any client information go to an AI provider, and whose?" is asked from outside a module —
     * by a privacy officer, or by anyone answering an access request — and it is only answerable if
     * every such disclosure lands in one place under one name. Filing this one under `Lead` and the
     * Calendar's under `Calendar` would scatter the answer across two trails.
     */
    await this.disclosures.record(
      user, 'lead-email-drafting', lead.name,
      "the lead's first name, the agent's name and email, and the agent's instruction",
      cfg,
    );

    /*
     * A DRAFT TO EDIT, RATHER THAN NOTHING, WHEN THE PROVIDER IS UNAVAILABLE.
     *
     * The agent came here to write to a client. When the model cannot answer — a used-up daily
     * allowance being the case that prompted this, and the one that does not clear in a moment —
     * the useful outcome is a plain opening they can rewrite, not an empty form and an apology.
     *
     * FLAGGED, never passed off as the model's work. `fallback` and `reason` travel with it so the
     * screen can say where it came from; silently substituting a template for AI output would be
     * the one thing worse than failing, because the agent would send it believing it had been
     * drafted for this lead.
     *
     * A misconfigured request is NOT caught here. A wrong model name or a rejected key is a server
     * problem somebody has to fix, and quietly papering over it with a template would hide it for
     * as long as the feature appeared to work.
     */
    let raw: string;
    try {
      raw = await draftEmailWithAi(cfg, system, userText);
    } catch (ex) {
      if (ex instanceof ServiceUnavailableException) {
        const reason = String((ex.getResponse() as { message?: string })?.message ?? 'The AI service is unavailable.');
        this.log.warn(`AI draft unavailable for lead #${leadId}; returning an editable starter instead — ${reason}`);
        return {
          subject: FALLBACK_SUBJECT,
          html: toPersonalHtml(`Hi ${firstName || 'there'},



${user.name ?? ''}`),
          fallback: true,
          reason,
        };
      }
      throw ex;
    }
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '');
    const m = /\{[\s\S]*\}/.exec(cleaned);
    let parsed: { subject?: string; html?: string } | null = null;
    try { parsed = JSON.parse(m ? m[0] : cleaned); } catch { parsed = null; }
    if (!parsed || !str(parsed.html)) {
      throw new BadRequestException({ message: 'The AI did not return a usable email. Try rephrasing your instruction.' });
    }
    /*
     * The prompt is a request; this is the guarantee.
     *
     * `toPersonalHtml` is applied to every draft rather than trusted away, because the provider is
     * configurable (Anthropic, OpenAI or Gemini) and models change underneath a prompt. If one of
     * them returns a banner, a button or a table anyway, the agent gets the words without the
     * marketing furniture instead of a campaign-looking message they have to notice and undo.
     */
    const html = toPersonalHtml(String(parsed.html));
    if (!html) {
      throw new BadRequestException({ message: 'The AI did not return a usable email. Try rephrasing your instruction.' });
    }
    // Falls back to a natural subject rather than "A note from <agent>", which reads like a
    // notification from a system and is exactly the register section 5 asks us to avoid.
    return { subject: str(parsed.subject) || FALLBACK_SUBJECT, html };
  }

  private presentCall(c: {
    id: number; called_at: Date; duration: number | null; outcome: string | null;
    notes: string | null; created_by: string | null; provider_sid?: string | null; status?: string | null;
  }): Record<string, unknown> {
    return {
      id: c.id, called_at: c.called_at.toISOString(), duration: c.duration,
      outcome: c.outcome, notes: c.notes, created_by: c.created_by,
      provider_sid: c.provider_sid ?? null, status: c.status ?? null,
    };
  }

  /** Metadata only — the audio itself is never part of a lead payload. */
  private presentRecording(r: {
    id: number; filename: string; content_type: string; size: number; created_by: string | null; created_at: Date | null;
  }): Record<string, unknown> {
    return {
      id: r.id, filename: r.filename, content_type: r.content_type, size: r.size,
      created_by: r.created_by, created_at: r.created_at?.toISOString() ?? null,
    };
  }

  private presentMessage(m: {
    id: number; direction: string; status: string | null; body: string; phone: string | null;
    error_code: string | null; error_message: string | null;
    sent_at: Date; created_by: string | null;
  }): Record<string, unknown> {
    return {
      id: m.id, direction: m.direction, status: m.status, body: m.body, phone: m.phone,
      // Why a message failed, in words the agent can act on. The provider SID is not exposed:
      // it identifies the message inside our Twilio account and the UI has no use for it.
      error_code: m.error_code, error_message: m.error_message,
      sent_at: m.sent_at.toISOString(), created_by: m.created_by,
    };
  }
}
