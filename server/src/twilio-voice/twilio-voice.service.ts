import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { accountSid, fromNumber, publicUrl } from '../sms/sms.constants';
import { voiceApiKey, voiceApiSecret, twimlAppSid } from './twilio-voice.constants';

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * In-browser voice calling. Mints the short-lived Twilio Voice **Access Token** the browser SDK
 * needs, and builds the TwiML Twilio fetches when that browser call connects — which bridges the
 * agent's browser to the lead's phone and records it.
 *
 * The Access Token is a plain HS256 JWT with Twilio's specific `cty` header and grant shape; it is
 * hand-built here rather than pulling in the Twilio SDK, the same call the SMS module makes.
 */
@Injectable()
export class TwilioVoiceService {
  /** Enough config to hand the browser a working token. Needs the API Key/Secret + a TwiML App. */
  configured(): boolean {
    return accountSid() !== '' && voiceApiKey() !== '' && voiceApiSecret() !== '' && twimlAppSid() !== '';
  }

  /** A capability token for one agent's browser. Expires in an hour; the client refetches. */
  mintToken(identity: string): { token: string; identity: string; ttl: number } {
    if (!this.configured()) {
      throw new ServiceUnavailableException({
        error: 'In-browser calling is not configured. Set TWILIO_API_KEY, TWILIO_API_SECRET and TWILIO_TWIML_APP_SID (plus a TwiML App whose Voice URL points at this API), then restart.',
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const ttl = 3600;
    const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
    const payload = {
      jti: `${voiceApiKey()}-${now}`,
      iss: voiceApiKey(),
      sub: accountSid(),
      iat: now,
      nbf: now,
      exp: now + ttl,
      grants: {
        identity,
        voice: {
          incoming: { allow: false },
          outgoing: { application_sid: twimlAppSid() },
        },
      },
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = b64url(createHmac('sha256', voiceApiSecret()).update(signingInput).digest());
    return { token: `${signingInput}.${sig}`, identity, ttl };
  }

  /**
   * TwiML for a connecting browser call. `to` is the lead's E.164 number, `callId` the lead_calls
   * row to report status against. `answerOnBridge` gives the agent real ringback; the child leg's
   * status callback reuses the SMS module's `call-status` webhook so the Call Log updates itself.
   */
  dialTwiml(to: string, callId: string): string {
    const from = fromNumber();
    const base = publicUrl();
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const statusAttrs = base
      ? ` statusCallback="${esc(`${base}/api/sms/twilio/call-status?call=${encodeURIComponent(callId)}`)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST"`
      : '';
    // Recording is captured on the Dial; Twilio posts the audio URL to recording-status when ready,
    // which the server fetches and stores against this call so it shows in the Call Log.
    const recAttrs = base
      ? ` recordingStatusCallback="${esc(`${base}/api/sms/twilio/recording-status?call=${encodeURIComponent(callId)}`)}" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"`
      : '';
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${esc(from)}" record="record-from-answer" answerOnBridge="true"${recAttrs}><Number${statusAttrs}>${esc(to)}</Number></Dial></Response>`;
  }
}
