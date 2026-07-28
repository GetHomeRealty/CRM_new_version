import { Controller, ForbiddenException, Header, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { TwilioService } from '../sms/twilio.service';
import { TwilioVoiceService } from './twilio-voice.service';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * The Voice URL Twilio fetches when a browser call connects — NOT the SPA. No session, no CSRF;
 * authenticated by the `X-Twilio-Signature` HMAC, exactly like the SMS webhooks. Returns TwiML
 * that dials the lead and records the call.
 */
@Controller('twilio/voice')
export class TwilioVoicePublicController {
  private readonly log = new Logger(TwilioVoicePublicController.name);

  constructor(
    private readonly voice: TwilioVoiceService,
    private readonly twilio: TwilioService,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  twiml(@Req() req: Request): string {
    if (!this.verified(req)) throw new ForbiddenException({ message: 'Invalid Twilio signature.' });

    const b = (req.body ?? {}) as Record<string, unknown>;
    const to = str(b.To);
    const callId = str(b.CallId);
    if (!to) {
      return '<?xml version="1.0" encoding="UTF-8"?><Response><Say>No number was provided to dial.</Say></Response>';
    }
    return this.voice.dialTwiml(to, callId);
  }

  private verified(req: Request): boolean {
    if (!this.twilio.configured()) {
      this.log.error('Voice TwiML requested but Twilio is not configured — ignoring.');
      return false;
    }
    const proto = str(req.headers['x-forwarded-proto']) || req.protocol || 'https';
    const host = str(req.headers['x-forwarded-host']) || str(req.headers.host);
    const url = this.twilio.signedUrl(req.originalUrl, proto, host);
    const ok = this.twilio.signatureValid(url, (req.body ?? {}) as Record<string, unknown>, str(req.headers['x-twilio-signature']));
    if (!ok) this.log.warn(`Twilio signature invalid for ${url} — ignoring.`);
    return ok;
  }
}
