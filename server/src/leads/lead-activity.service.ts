import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
// Extracted to ../common/ai-provider so the Calendar can use the same provider layer rather than
// growing a second copy of it. Behaviour is unchanged.
import { draftEmailWithAi, resolveEmailAi } from '../common/ai-provider';
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
  constructor(
    private readonly access: ResourceAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: LeadAuditService,
    private readonly twilio: TwilioService,
    private readonly mailer: MailerService,
  ) {}

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
    await this.prisma.lead_notes.delete({ where: { id: noteId } });
    await this.audit.record(user, 'Lead note deleted', `Lead #${leadId}`);
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
    await this.audit.record(user, 'Lead showing updated', showing.property ?? `Lead #${leadId}`, `Status: ${showing.status}`);
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
    await this.audit.record(user, 'Lead call deleted', `Lead #${leadId}`);
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

    let status = 'sent';
    let error: string | null = null;
    try {
      // The sender's own connected account is preferred, so an agent's email leaves from their
      // own address; it falls back to the brokerage account when they have not added one.
      await this.mailer.sendDirect(lead.email, subject, html, accountId, [], user.id ?? null);
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
    const data = {
      filename, content_type: contentType, size: buffer.length,
      // Prisma's Bytes rejects a Node Buffer (it is backed by a SharedArrayBuffer under Jest).
      data: new Uint8Array(buffer),
      created_by: user.name, created_at: new Date(),
    };
    // One per call: re-uploading replaces the previous file rather than stacking up copies.
    const saved = await this.prisma.lead_call_recordings.upsert({
      where: { call_id: callId },
      create: { call_id: callId, ...data },
      update: data,
    });
    await this.audit.record(user, 'Lead call recording attached', `Lead #${leadId}`, filename);
    return this.presentRecording(saved);
  }

  /** The stored bytes, for the download/playback endpoint. */
  async getRecording(leadId: number, callId: number, user: AuthUserRecord): Promise<{ filename: string; content_type: string; data: Uint8Array }> {
    await this.access.assertLead(user, leadId);
    const call = await this.prisma.lead_calls.findFirst({ where: { id: callId, lead_id: leadId }, select: { id: true } });
    if (!call) throw new NotFoundException({ message: 'Call not found.' });
    const rec = await this.prisma.lead_call_recordings.findUnique({ where: { call_id: callId } });
    if (!rec) throw new NotFoundException({ message: 'No recording is attached to that call.' });
    return { filename: rec.filename, content_type: rec.content_type, data: rec.data };
  }

  async removeRecording(leadId: number, callId: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    await this.access.assertLead(user, leadId);
    const call = await this.prisma.lead_calls.findFirst({ where: { id: callId, lead_id: leadId }, select: { id: true } });
    if (!call) throw new NotFoundException({ message: 'Call not found.' });
    const rec = await this.prisma.lead_call_recordings.findUnique({ where: { call_id: callId }, select: { id: true } });
    if (!rec) throw new NotFoundException({ message: 'No recording is attached to that call.' });
    await this.prisma.lead_call_recordings.delete({ where: { call_id: callId } });
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
    const lead = await this.requireLead(leadId);

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
    let sid: string | null = null;
    if (body.send === true) {
      if (direction !== 'outbound') throw new BadRequestException({ message: 'Only an outbound message can be sent.' });
      const to = str(body.phone);
      if (!to) throw new BadRequestException({ message: 'There is no phone number to send to.' });
      const result = await this.twilio.send(to, text);
      sid = result.sid;
      status = mapProviderStatus(result.status) ?? 'queued';
    }

    const msg = await this.prisma.lead_messages.create({
      data: {
        lead_id: lead.id, direction, status, body: text, phone: str(body.phone) || null,
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
    await this.audit.record(user, 'Lead SMS deleted', `Lead #${leadId}`);
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
  async generateEmail(leadId: number, prompt: string, user: AuthUserRecord): Promise<{ subject: string; html: string }> {
    await this.access.assertLead(user, leadId);
    const cfg = resolveEmailAi();
    if (!cfg) {
      throw new ServiceUnavailableException({
        message: 'AI email generation is not configured on the server. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, then restart.',
      });
    }
    const p = str(prompt);
    if (!p) throw new BadRequestException({ message: 'Describe the email you want to send.' });
    if (p.length > 2000) throw new BadRequestException({ message: 'That instruction is too long.' });

    const lead = await this.prisma.leads.findFirst({ where: { id: leadId, deleted_at: null }, select: { name: true } });
    if (!lead) throw new NotFoundException({ message: 'Lead not found.' });

    const system =
      'You write professional real-estate emails for Get Home Realty, a Canadian brokerage. ' +
      'From the agent\'s instruction, produce a complete, ready-to-send email. ' +
      'Return ONLY a compact JSON object: {"subject": string, "html": string}. Rules: ' +
      '"html" is a self-contained HTML email body with inline CSS and clean, professional styling ' +
      '(a simple header, well-spaced paragraphs, and a signature) — no <html>/<head>/<body> wrapper, just the content. ' +
      `Address the recipient by first name where natural; recipient full name is "${lead.name}". ` +
      `Sign off as the agent "${user.name}"${user.email ? ` (${user.email})` : ''} at Get Home Realty. ` +
      'Canadian English, warm and concise. Never use bracketed placeholders like [Name]. ' +
      'Do not invent specific facts (prices, addresses, dates) unless the instruction supplies them.';
    const userText = `Agent instruction: ${p}`;

    const raw = await draftEmailWithAi(cfg, system, userText);
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '');
    const m = /\{[\s\S]*\}/.exec(cleaned);
    let parsed: { subject?: string; html?: string } | null = null;
    try { parsed = JSON.parse(m ? m[0] : cleaned); } catch { parsed = null; }
    if (!parsed || !str(parsed.html)) {
      throw new BadRequestException({ message: 'The AI did not return a usable email. Try rephrasing your instruction.' });
    }
    return { subject: str(parsed.subject) || `A note from ${user.name}`, html: String(parsed.html) };
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
