import { Controller, ForbiddenException, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { TwilioService } from './twilio.service';
import { SmsInboundService } from './sms-inbound.service';
import { PrismaService } from '../prisma/prisma.service';
import { mapProviderStatus, explainError, accountSid, authToken } from './sms.constants';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * Endpoints Twilio calls, not the SPA.
 *
 * They carry NO AuthGuard and NO CSRF token — there is no session behind a webhook. Every
 * request is authenticated by its `X-Twilio-Signature` instead, and anything that fails that
 * check is dropped before its body is read.
 *
 * Both return 200 for problems they cannot fix, because Twilio retries a non-2xx and there is no
 * point being retried about a message that does not exist. A bad signature is the exception: it
 * gets a 403, so a misconfiguration is loud rather than silently swallowed.
 */
@Controller('sms/twilio')
export class SmsPublicController {
  private readonly log = new Logger(SmsPublicController.name);

  constructor(
    private readonly twilio: TwilioService,
    private readonly inbound: SmsInboundService,
    private readonly prisma: PrismaService,
  ) {}

  /** Throws unless the request really came from Twilio; never returns false-ish silently. */
  private requireTwilio(req: Request): void {
    if (!this.verified(req)) throw new ForbiddenException({ message: 'Invalid Twilio signature.' });
  }

  private verified(req: Request): boolean {
    if (!this.twilio.configured()) {
      this.log.error('Twilio webhook received but no credentials are configured — ignoring.');
      return false;
    }
    const proto = str(req.headers['x-forwarded-proto']) || req.protocol || 'https';
    const host = str(req.headers['x-forwarded-host']) || str(req.headers.host);
    const url = this.twilio.signedUrl(req.originalUrl, proto, host);
    const ok = this.twilio.signatureValid(url, (req.body ?? {}) as Record<string, unknown>, str(req.headers['x-twilio-signature']));
    if (!ok) this.log.warn(`Twilio signature invalid for ${url} — ignoring.`);
    return ok;
  }

  /**
   * Delivery status. Twilio calls this each time a message moves through its lifecycle:
   * queued → sent → delivered, or → failed/undelivered.
   */
  @Post('status')
  @HttpCode(200)
  async status(@Req() req: Request): Promise<{ received: boolean }> {
    this.requireTwilio(req);

    const b = (req.body ?? {}) as Record<string, unknown>;
    const sid = str(b.MessageSid) || str(b.SmsSid);
    const mapped = mapProviderStatus(str(b.MessageStatus) || str(b.SmsStatus));
    if (!sid || !mapped) return { received: true };

    const msg = await this.prisma.lead_messages.findUnique({ where: { provider_sid: sid }, select: { id: true, status: true } });
    if (!msg) {
      // Not ours — a message sent from another app on the same Twilio account, most likely.
      this.log.debug(`Status callback for unknown message ${sid} — ignoring.`);
      return { received: true };
    }

    // A status callback must never undo what a person recorded: plain SMS has no read receipt,
    // so "read" was marked by an agent who knows something Twilio does not.
    if (msg.status === 'read' && mapped !== 'failed') return { received: true };

    const code = str(b.ErrorCode);
    await this.prisma.lead_messages.update({
      where: { id: msg.id },
      data: {
        status: mapped,
        error_code: code || null,
        error_message: code ? explainError(code, str(b.ErrorMessage)).slice(0, 255) : null,
      },
    });
    return { received: true };
  }

  /**
   * Voice call status for click-to-call. Twilio calls this as the call moves through
   * initiated → ringing → in-progress → completed (or busy/no-answer/failed). The `?call=<id>`
   * query names the lead_calls row; the CallSid is a fallback match. Updates status, duration and
   * a human outcome so the Call Log reflects what actually happened.
   */
  @Post('call-status')
  @HttpCode(200)
  async callStatus(@Req() req: Request): Promise<{ received: boolean }> {
    this.requireTwilio(req);

    const b = (req.body ?? {}) as Record<string, unknown>;
    const sid = str(b.CallSid);
    const rawStatus = str(b.CallStatus).toLowerCase();
    const callId = Number(str((req.query as Record<string, unknown>)?.call));

    const row = Number.isInteger(callId) && callId > 0
      ? await this.prisma.lead_calls.findUnique({ where: { id: callId }, select: { id: true } })
      : (sid ? await this.prisma.lead_calls.findFirst({ where: { provider_sid: sid }, select: { id: true } }) : null);
    if (!row) {
      this.log.debug(`Call status for unknown call (id=${callId || '-'}, sid=${sid || '-'}) — ignoring.`);
      return { received: true };
    }

    const durationNum = Number(str(b.CallDuration));
    const duration = Number.isInteger(durationNum) && durationNum > 0 ? durationNum : undefined;
    // Only set a human outcome on a terminal status, and never overwrite one an agent typed.
    const outcome = rawStatus === 'completed' && (duration ?? 0) > 0 ? 'connected'
      : (rawStatus === 'no-answer' || rawStatus === 'busy') ? 'no answer' : undefined;

    await this.prisma.lead_calls.update({
      where: { id: row.id },
      data: {
        status: rawStatus || undefined,
        ...(sid ? { provider_sid: sid } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
      },
    });
    return { received: true };
  }

  /**
   * A finished call recording. Twilio posts the recording's URL once the audio is ready; we fetch
   * the MP3 (authenticated) and store it against the call so it plays/downloads in the Call Log
   * through the same path as a manually-attached recording. `?call=<id>` names the row.
   */
  @Post('recording-status')
  @HttpCode(200)
  async recordingStatus(@Req() req: Request): Promise<{ received: boolean }> {
    this.requireTwilio(req);

    const b = (req.body ?? {}) as Record<string, unknown>;
    const callId = Number(str((req.query as Record<string, unknown>)?.call));
    const recUrl = str(b.RecordingUrl);
    const recSid = str(b.RecordingSid);
    if (!Number.isInteger(callId) || callId <= 0 || !recUrl) return { received: true };

    const row = await this.prisma.lead_calls.findUnique({ where: { id: callId }, select: { id: true } });
    if (!row) return { received: true };
    // One recording per call — a re-posted callback must not create a second row.
    const existing = await this.prisma.lead_call_recordings.findUnique({ where: { call_id: callId }, select: { id: true } });
    if (existing) return { received: true };

    try {
      const auth = Buffer.from(`${accountSid()}:${authToken()}`).toString('base64');
      const res = await fetch(`${recUrl}.mp3`, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) { this.log.warn(`Recording fetch for call ${callId} failed (HTTP ${res.status}).`); return { received: true }; }
      const buf = Buffer.from(await res.arrayBuffer());
      const MAX = 15 * 1024 * 1024;
      if (buf.length === 0 || buf.length > MAX) { this.log.warn(`Recording for call ${callId} is ${buf.length} bytes — skipped.`); return { received: true }; }
      await this.prisma.lead_call_recordings.create({
        data: { call_id: callId, filename: `call-${recSid || callId}.mp3`, content_type: 'audio/mpeg', size: buf.length, data: buf, created_by: 'Twilio', created_at: new Date() },
      });
    } catch (ex) {
      this.log.warn(`Could not store recording for call ${callId}: ${(ex as Error).message}`);
    }
    return { received: true };
  }

  /** An SMS the lead sent back. Logged against whichever lead owns that number. */
  @Post('inbound')
  @HttpCode(200)
  async inboundMessage(@Req() req: Request): Promise<{ received: boolean }> {
    this.requireTwilio(req);

    const b = (req.body ?? {}) as Record<string, unknown>;
    // A 200 with no TwiML is how Twilio is told "logged, send no auto-reply".
    await this.inbound.record(str(b.From), str(b.Body), str(b.MessageSid) || str(b.SmsSid));
    return { received: true };
  }
}
