import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  accountSid, authToken, fromNumber, messagingServiceSid, publicUrl, isConfigured, explainError,
} from './sms.constants';

export interface SendResult {
  sid: string;
  status: string;
}

export interface CallResult {
  sid: string;
  status: string;
}

/**
 * Talks to Twilio's REST API directly over `fetch`.
 *
 * No SDK: sending a message is one form POST and verifying a webhook is one HMAC, so a
 * dependency would buy nothing and add a supply-chain surface to a package that holds the
 * credentials able to spend money.
 */
@Injectable()
export class TwilioService {
  private readonly log = new Logger(TwilioService.name);

  configured(): boolean {
    return isConfigured();
  }

  /**
   * Whether outbound voice calling is possible. Voice needs a real From number to place the call
   * and to caller-ID the bridged leg — a Messaging Service (which is enough for SMS) is not.
   */
  voiceConfigured(): boolean {
    return accountSid() !== '' && authToken() !== '' && fromNumber() !== '';
  }

  /** What the SPA is allowed to know: whether sending/calling works, and from what. Never the token. */
  status(): { configured: boolean; voice: boolean; from: string | null; callback_url: string | null } {
    return {
      configured: isConfigured(),
      voice: this.voiceConfigured(),
      from: messagingServiceSid() || fromNumber() || null,
      callback_url: publicUrl() ? `${publicUrl()}/api/sms/twilio/status` : null,
    };
  }

  /**
   * Place an outbound voice call. `to` is dialled first (the agent's own phone); when they answer,
   * `twiml` runs — which bridges them to the lead. Returns Twilio's Call SID so the status
   * callback can find the row. Errors from Twilio surface rather than being swallowed.
   */
  async call(to: string, twiml: string, statusCallback: string): Promise<CallResult> {
    if (!this.voiceConfigured()) {
      throw new BadRequestException({ message: 'Voice calling is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.' });
    }
    const form = new URLSearchParams({ To: to, From: fromNumber(), Twiml: twiml });
    if (statusCallback) {
      form.set('StatusCallback', statusCallback);
      form.set('StatusCallbackMethod', 'POST');
      for (const e of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', e);
    }
    const auth = Buffer.from(`${accountSid()}:${authToken()}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid()}/Calls.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch (ex) {
      throw new BadRequestException({ message: `Could not reach Twilio: ${(ex as Error).message}` });
    }
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number; message?: string };
    if (!res.ok || !json.sid) {
      const code = String(json.code ?? '');
      throw new BadRequestException({ message: json.message || `Twilio refused the call (HTTP ${res.status}).`, code: code || undefined });
    }
    return { sid: json.sid, status: String(json.status ?? 'queued') };
  }

  /**
   * Send an SMS. Returns Twilio's SID and initial status, which the caller stores so the status
   * callback can find the row later.
   *
   * Twilio's own errors are surfaced verbatim-ish rather than swallowed: "that number is a
   * landline" is something the agent can act on, and hiding it behind a generic failure would
   * leave them retrying forever.
   */
  async send(to: string, body: string): Promise<SendResult> {
    if (!isConfigured()) {
      throw new BadRequestException({ message: 'No SMS gateway is connected. Set the TWILIO_* environment variables to send from here.' });
    }

    const form = new URLSearchParams({ To: to, Body: body });
    // A Messaging Service handles sender selection and opt-outs; a bare number is the simpler
    // setup. Whichever is configured, only one may be sent.
    if (messagingServiceSid()) form.set('MessagingServiceSid', messagingServiceSid());
    else form.set('From', fromNumber());

    // Without a public URL Twilio has nowhere to report back to, so the message still sends but
    // its status stays at whatever the API returned. Better than refusing to send at all.
    const callback = publicUrl() ? `${publicUrl()}/api/sms/twilio/status` : '';
    if (callback) form.set('StatusCallback', callback);
    else this.log.warn('TWILIO_PUBLIC_URL is not set — messages will send but delivery status will never update.');

    const auth = Buffer.from(`${accountSid()}:${authToken()}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid()}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch (ex) {
      throw new BadRequestException({ message: `Could not reach Twilio: ${(ex as Error).message}` });
    }

    const json = await res.json().catch(() => ({})) as { sid?: string; status?: string; code?: number; message?: string };
    if (!res.ok || !json.sid) {
      const code = String(json.code ?? '');
      throw new BadRequestException({
        message: code ? explainError(code, json.message) : (json.message || `Twilio refused the message (HTTP ${res.status}).`),
        code: code || undefined,
      });
    }
    return { sid: json.sid, status: String(json.status ?? 'queued') };
  }

  /**
   * Verify Twilio's `X-Twilio-Signature`.
   *
   * The signature is HMAC-SHA1, keyed by the auth token, over the exact request URL followed by
   * every POST parameter sorted by name and concatenated as name+value. It must be checked
   * before anything in the body is trusted: these endpoints carry no session and no CSRF token,
   * so the signature is the only thing standing between a stranger and forged delivery reports
   * or fabricated inbound messages.
   */
  signatureValid(url: string, params: Record<string, unknown>, header: string): boolean {
    const token = authToken();
    if (!token || !header) return false;

    const data = Object.keys(params).sort().reduce((acc, k) => acc + k + String(params[k] ?? ''), url);
    const expected = createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * The URL Twilio signed. `TWILIO_PUBLIC_URL` wins, because behind a proxy the host this
   * process sees is not necessarily the host Twilio requested — and a mismatch there fails
   * every signature check with no obvious cause.
   */
  signedUrl(originalUrl: string, proto: string, host: string): string {
    const base = publicUrl() || `${proto || 'https'}://${host}`;
    return `${base.replace(/\/+$/, '')}${originalUrl}`;
  }
}
