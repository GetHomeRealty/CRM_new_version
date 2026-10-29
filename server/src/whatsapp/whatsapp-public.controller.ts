import { Controller, Get, Header, HttpCode, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SkipThrottle } from '@nestjs/throttler';
import { WhatsAppIntakeService } from './whatsapp-intake.service';
import { inboundMessages, whatsappAppSecret, whatsappVerifyToken } from './whatsapp.constants';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * The WhatsApp Cloud API webhook — called by Meta, not by the SPA.
 *
 * NO AuthGuard and NO CSRF token (it is in the CSRF exempt list): there is no session behind a
 * webhook. Every delivery is authenticated by its `x-hub-signature-256` HMAC over the raw body,
 * and anything that fails that check is dropped before it is read — exactly as the lead-ads
 * webhook in MetaPublicController does.
 *
 * Exempt from rate limiting: a burst of customer messages is real enquiries, not an attacker.
 */
@SkipThrottle()
@Controller('whatsapp')
export class WhatsAppPublicController {
  private readonly log = new Logger(WhatsAppPublicController.name);

  constructor(private readonly intake: WhatsAppIntakeService) {}

  /** Subscription handshake. Meta calls this once, when the webhook URL is saved. */
  @Get('webhook')
  @Header('Content-Type', 'text/plain')
  verify(@Query() q: Record<string, string>, @Res() res: Response): void {
    const expected = whatsappVerifyToken();
    // Refuse rather than echo the challenge when no token is configured — otherwise anyone could
    // complete the handshake and point a subscription at this server.
    if (expected && str(q['hub.mode']) === 'subscribe' && str(q['hub.verify_token']) === expected) {
      res.status(200).send(str(q['hub.challenge']));
      return;
    }
    this.log.warn('WhatsApp webhook verification rejected (token mismatch or no verify token configured).');
    res.status(403).send('Forbidden');
  }

  /**
   * Incoming messages. Meta retries anything that is not a 200, so problems this cannot fix still
   * answer 200 — except a bad signature, which is refused so a misconfiguration is visible.
   */
  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ received: boolean }> {
    const secret = whatsappAppSecret();
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!secret || !raw) {
      this.log.error(`WhatsApp webhook received but ${secret ? 'the raw body is missing' : 'no app secret is configured'} — ignoring.`);
      return { received: false };
    }
    if (!signatureValid(raw, str(req.headers['x-hub-signature-256']), secret)) {
      this.log.warn('WhatsApp webhook signature invalid — ignoring.');
      res.status(403);
      return { received: false };
    }

    for (const message of inboundMessages(req.body)) {
      try {
        await this.intake.ingest(message);
      } catch (err) {
        // Swallowed: a throw would make Meta retry the whole batch, re-running the ones that worked.
        this.log.error(`WhatsApp message ${message.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { received: true };
  }
}

/** HMAC-SHA256 of the exact bytes Meta sent, compared in constant time. */
export function signatureValid(raw: Buffer, header: string, secret: string): boolean {
  if (!header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
