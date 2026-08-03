/**
 * Telling a dead address apart from a bad afternoon.
 *
 * Every failed send used to be recorded the same way: recipient marked `failed` and `bounced`,
 * error text stored, nothing else. That conflates two situations a sender has to treat as
 * opposites. "550 no such user" means the mailbox does not exist and never will — sending to it
 * again is what runs a domain's reputation down, because mailbox providers score a sender on
 * repeat attempts at addresses they have already rejected. "451 greylisted, try again later" or
 * "452 mailbox full" means the message is fine and the moment was not; giving up on it loses a
 * real recipient for no reason.
 *
 * So: HARD → suppress the address permanently. SOFT → leave it queued and try again later.
 *
 * The classification is deliberately conservative. Anything that is not recognisably permanent is
 * treated as soft, because the cost of the two mistakes is asymmetric — a soft address wrongly
 * suppressed is a client the brokerage silently stops talking to, while a hard address wrongly
 * retried costs a handful of retries and then gives up anyway.
 */

/** hard — the address is dead. soft — try again later. unknown — a local/transport fault. */
export type BounceType = 'hard' | 'soft' | 'unknown';

export interface BounceVerdict {
  type: BounceType;
  /** The SMTP status this was read from, when the server gave one — e.g. "550" or "5.1.1". */
  code: string | null;
  /** Short plain-English reason, stored on the recipient row for the results screen. */
  reason: string;
}

/**
 * Failures that never reached a mail server at all — no credentials, no connection, our own
 * misconfiguration. These are OUR problem, not the recipient's, and must not count against the
 * address: suppressing somebody because the brokerage's SMTP password expired would be the worst
 * possible outcome of a bad afternoon.
 */
const LOCAL_FAULTS = [
  /no active smtp account/i,
  /invalid login|authentication (failed|unsuccessful)|535|534|530/i,
  /econnrefused|enotfound|etimedout|econnreset|ehostunreach|enetunreach|socket close|connection timeout/i,
  /self.signed certificate|unable to verify the first certificate|cert(ificate)? has expired/i,
];

/**
 * Permanent rejections, by wording. Checked alongside the numeric code because plenty of servers
 * answer 5xx with the detail only in the text, and a few answer with the right words behind an
 * enhanced status the parser below would otherwise not reach.
 */
const HARD_PHRASES = [
  /user (unknown|not found)|unknown user/i,
  /no such (user|mailbox|recipient|address|person)/i,
  /recipient (address )?rejected/i,
  /(mailbox|address|account|email address) (is )?(unavailable|not found|does not exist|doesn't exist|disabled|deactivated|suspended|inactive)/i,
  /does not exist|doesn.t exist/i,
  /invalid (recipient|mailbox|address)/i,
  /address (is )?(not valid|unknown)/i,
  /domain (not found|does not exist|is not hosted)/i,
  /host or domain name not found/i,
  /relay access denied|not our customer|no mailbox here by that name/i,
  /account (has been )?(closed|terminated)/i,
  /email domain cannot receive mail/i,
];

/**
 * Temporary rejections, by wording. A mailbox that is full today may be emptied tomorrow, and
 * greylisting is *designed* to reject the first attempt — treating either as permanent throws away
 * a deliverable address.
 */
const SOFT_PHRASES = [
  /mailbox (is )?full|over ?quota|quota exceeded|insufficient (system )?storage/i,
  /greylist|grey ?listed|try again later|please retry|deferred|temporarily (unavailable|deferred|rejected)/i,
  /rate limit|too many (messages|connections|recipients)|throttl|slow down/i,
  /service (not available|unavailable)|server busy|resources temporarily unavailable/i,
  /timed? out/i,
];

/**
 * Read an SMTP status out of an error message.
 *
 * Two forms travel together in real replies — the three-digit basic code and the RFC 3463 enhanced
 * code ("5.1.1"). The enhanced one is preferred where present because it is the more precise of
 * the two, and its first digit carries the same permanent/transient meaning.
 *
 * The three-digit match is anchored to a word boundary and a following space or dash so it does
 * not pick a number out of the middle of a message id or a timestamp.
 */
export function smtpCode(message: string): { basic: number | null; enhanced: string | null } {
  const text = String(message ?? '');
  const enhanced = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(text);
  const basic = /\b([245]\d{2})(?=[\s\-:]|$)/.exec(text);
  return {
    basic: basic ? Number(basic[1]) : null,
    enhanced: enhanced ? enhanced[0] : null,
  };
}

/**
 * Classify one failed delivery.
 *
 * Order matters. Our own faults are ruled out first, because "535 BadCredentials" is a 5xx and
 * would otherwise be read as a permanent rejection of every address in the campaign — turning one
 * expired password into a suppression list with the whole audience on it. Wording is then read
 * before the numeric code, since a server that says "mailbox full" behind a 5xx is describing a
 * transient condition whatever code it chose.
 */
export function classifyBounce(message: unknown): BounceVerdict {
  const text = String(message ?? '').trim();
  const { basic, enhanced } = smtpCode(text);
  const code = enhanced ?? (basic !== null ? String(basic) : null);

  if (!text) return { type: 'unknown', code: null, reason: 'Delivery failed with no reason given.' };

  for (const rx of LOCAL_FAULTS) {
    if (rx.test(text)) {
      return { type: 'unknown', code, reason: 'Could not be sent because of a mail-server or connection problem at our end, not a problem with the address.' };
    }
  }

  for (const rx of SOFT_PHRASES) {
    if (rx.test(text)) return { type: 'soft', code, reason: softReason(text) };
  }

  for (const rx of HARD_PHRASES) {
    if (rx.test(text)) return { type: 'hard', code, reason: 'The mailbox does not exist or is permanently closed.' };
  }

  // No recognisable wording — fall back to the code. 5xx is permanent by definition, 4xx is
  // transient by definition, and RFC 3463's leading digit says the same thing more precisely.
  const lead = enhanced ? Number(enhanced[0]) : basic !== null ? Math.floor(basic / 100) : null;
  if (lead === 5) return { type: 'hard', code, reason: `The receiving server permanently rejected this address${code ? ` (${code})` : ''}.` };
  if (lead === 4) return { type: 'soft', code, reason: `The receiving server temporarily refused this message${code ? ` (${code})` : ''} — it will be retried.` };

  return { type: 'unknown', code, reason: text.slice(0, 300) };
}

/** Wording for the common transient cases, so the results screen says something useful. */
function softReason(text: string): string {
  if (/mailbox (is )?full|over ?quota|quota exceeded|insufficient/i.test(text)) return 'The recipient\'s mailbox is full — it will be retried.';
  if (/greylist|grey ?listed/i.test(text)) return 'Greylisted by the receiving server — it will be retried shortly.';
  if (/rate limit|too many|throttl|slow down/i.test(text)) return 'The receiving server is rate-limiting us — it will be retried.';
  return 'The receiving server temporarily refused this message — it will be retried.';
}

/**
 * How long to wait before attempt number `attempt` (1 = the first retry).
 *
 * Exponential, from 15 minutes out to 8 hours, which is the shape every mail transfer agent uses
 * for the same reason: a mailbox that is full or a server that is greylisting needs time, and
 * retrying every minute is indistinguishable from an attack. Capped so a campaign cannot drag on
 * for days.
 */
export const RETRY_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 8 * 60 * 60_000];

/** Attempts a soft-bounced recipient gets before it is written off. */
export const MAX_SOFT_RETRIES = RETRY_BACKOFF_MS.length;

/** When to next attempt a recipient that has already been tried `attempt` times. */
export function nextRetryAt(attempt: number, from: Date = new Date()): Date {
  const idx = Math.min(Math.max(1, attempt), RETRY_BACKOFF_MS.length) - 1;
  return new Date(from.getTime() + RETRY_BACKOFF_MS[idx]);
}
