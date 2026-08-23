import { classifyBounce, type BounceType } from './bounce-classifier';

/**
 * Reading a bounce that arrives as an EMAIL rather than as an SMTP error.
 *
 * WHY THIS EXISTS. `classifyBounce` reads the exception thrown when the relay refuses a message
 * during the SMTP conversation. That covers a refusal the sending server makes on the spot — but it
 * is not how most real bounces arrive. A relay that accepts responsibility answers `250 OK`,
 * discovers the mailbox is missing when it tries to deliver, and reports the failure minutes later
 * as a Non-Delivery Report addressed back to the sender.
 *
 * Nothing read those. A campaign sent to an address whose DOMAIN resolves — `karishma@gmail.co` is
 * the reported case, `.co` being a real TLD — was accepted by Gmail, recorded `sent`, and the NDR
 * that came back was just another message in the sender's inbox. The recipient stayed "sent" for
 * ever, and because it was never marked bounced, nothing stopped a later pixel fetch from marking
 * it "opened" too.
 *
 * THERE IS NO WEBHOOK TO WAIT FOR. This application sends over SMTP with Gmail OAuth; SMTP has no
 * delivery callback and no event stream. The NDR IS the provider's delivery response, and reading
 * the sender's own mailbox is the only place it can be observed.
 */

/** Who a non-delivery report comes from. */
const NDR_SENDER = /(mailer-daemon|postmaster|mail delivery (subsystem|system)|no-?reply@.*(mail|smtp))/i;

/** What one is titled, across the common providers. */
const NDR_SUBJECT = new RegExp([
  'delivery status notification',
  'undelivered mail returned to sender',
  'undeliverable',
  'returned mail',
  'delivery failure',
  'mail delivery failed',
  'failure notice',
  'delivery has failed',
].join('|'), 'i');

/** Addresses that are never the failed recipient, so a report cannot bounce its own sender. */
const NEVER_A_RECIPIENT = /(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i;

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface NdrVerdict {
  /** Whether this message looks like a non-delivery report at all. */
  isNdr: boolean;
  /** Addresses the report says could not be reached, lower-cased and de-duplicated. */
  addresses: string[];
  /** `hard` when the mailbox is gone, `soft` when the refusal was temporary. */
  type: BounceType;
  /** The line the verdict was taken from, for the recipient's error column. */
  reason: string;
}

const EMPTY: NdrVerdict = { isNdr: false, addresses: [], type: 'unknown', reason: '' };

/**
 * Decide whether an inbound message is a bounce, and for whom.
 *
 * DELIBERATELY CONSERVATIVE ABOUT WHAT COUNTS AS A BOUNCE. Marking a live recipient as bounced
 * suppresses their address and stops the brokerage mailing a real client, so a false positive is
 * worse here than a miss: an unread bounce leaves a wrong status, a wrongly-read one silently
 * removes somebody from every future campaign. Hence both a sender check AND a body that actually
 * contains a delivery failure, rather than either alone — a forwarded complaint with "undeliverable"
 * in the subject is not a bounce.
 *
 * THE FAILED ADDRESS IS TAKEN FROM `Final-Recipient` WHERE THE REPORT PROVIDES IT, because that is
 * the machine-readable field RFC 3464 defines for exactly this. Scanning the prose is the fallback
 * for providers that send a human-readable report only.
 */
export function parseNdr(msg: {
  from?: string | null; subject?: string | null; text?: string | null; html?: string | null;
}): NdrVerdict {
  const from = String(msg.from ?? '');
  const subject = String(msg.subject ?? '');
  const body = `${String(msg.text ?? '')}\n${String(msg.html ?? '').replace(/<[^>]+>/g, ' ')}`;

  const looksLikeNdr = NDR_SENDER.test(from) || NDR_SUBJECT.test(subject);
  if (!looksLikeNdr) return EMPTY;

  /*
   * `classifyBounce` is reused rather than reimplemented: it already knows how to read an SMTP
   * status out of text — `550 5.1.1`, `Enhanced Status Code`, "user unknown" — and an NDR quotes
   * exactly that. One definition of what "hard" means, shared with the send path, so the two cannot
   * disagree about the same code.
   */
  const verdict = classifyBounce(`${subject}\n${body}`);

  // A report we cannot read a failure out of is not treated as one. `unknown` from the classifier
  // means "this says nothing about the address", and acting on it would be guessing.
  if (verdict.type === 'unknown') return EMPTY;

  const addresses = failedRecipients(body).filter((a) => !NEVER_A_RECIPIENT.test(a));
  if (!addresses.length) return EMPTY;

  return { isNdr: true, addresses, type: verdict.type, reason: verdict.reason };
}

/**
 * The addresses a report names as undeliverable.
 *
 * `Final-Recipient:` / `Original-Recipient:` first — RFC 3464's delivery-status part, which every
 * major provider emits and which names ONLY the failed address. Falling straight to a scan of the
 * whole body would also collect the sender, the support address in the footer and anything quoted
 * from the original message, and suppressing those would be worse than reading no bounce at all.
 */
function failedRecipients(body: string): string[] {
  const found = new Set<string>();

  const structured = body.match(/^(?:final|original)-recipient:\s*rfc822;\s*(.+)$/gim) ?? [];
  for (const line of structured) {
    const addr = line.split(';').slice(1).join(';').trim().replace(/^<|>$/g, '').toLowerCase();
    if (addr.includes('@')) found.add(addr);
  }
  if (found.size) return [...found];

  /*
   * No structured part — a human-readable report only. Take addresses that appear on a line the
   * provider used to say something failed, rather than every address in the message. Gmail's
   * wording is "Your message wasn't delivered to X because…"; others say "X: host … said: 550".
   */
  for (const line of body.split(/\r?\n/)) {
    if (!/(wasn't delivered|was not delivered|could ?n[o']t be (found|delivered)|does not exist|user unknown|recipient (address )?rejected|failed permanently|delivery to the following recipient)/i.test(line)) continue;
    for (const m of line.match(EMAIL_IN_TEXT) ?? []) found.add(m.toLowerCase());
  }
  return [...found];
}
