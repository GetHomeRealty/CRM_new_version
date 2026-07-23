/**
 * Twilio configuration and status vocabulary.
 *
 * Credentials live in the environment, never in the database and never in a response body — the
 * auth token signs every webhook, so leaking it would let anyone forge delivery reports.
 */

const env = (k: string): string => String(process.env[k] ?? '').trim();

export const accountSid = (): string => env('TWILIO_ACCOUNT_SID');
export const authToken = (): string => env('TWILIO_AUTH_TOKEN');

/**
 * The number or alphanumeric sender ID messages go out from. A Messaging Service SID
 * (starts `MG`) may be used instead, which is how Twilio recommends sending at volume.
 */
export const fromNumber = (): string => env('TWILIO_FROM_NUMBER');
export const messagingServiceSid = (): string => env('TWILIO_MESSAGING_SERVICE_SID');

/**
 * Public origin Twilio reaches this API on. Required for two things: telling Twilio where to
 * send status callbacks, and rebuilding the exact URL its signature was computed over. Behind a
 * proxy the request's own host header is not necessarily what Twilio signed, so this wins.
 */
export const publicUrl = (): string => env('TWILIO_PUBLIC_URL').replace(/\/+$/, '');

/** Enough configuration to actually send. Without it the app falls back to `sms:` deep links. */
export const isConfigured = (): boolean =>
  accountSid() !== '' && authToken() !== '' && (fromNumber() !== '' || messagingServiceSid() !== '');

/**
 * Statuses a message can hold.
 *
 * `read` is deliberately in the list even though no SMS provider reports it — the protocol has
 * no read receipt. It stays an agent's manual mark, and is the one status a webhook will never
 * overwrite.
 */
export const MESSAGE_STATUS = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUS)[number];

export const isMessageStatus = (v: string): v is MessageStatus =>
  (MESSAGE_STATUS as readonly string[]).includes(v);

/**
 * Twilio's message lifecycle, collapsed onto ours.
 *
 * Twilio distinguishes `undelivered` (the carrier accepted it then gave up) from `failed` (it
 * never left). Both mean the lead did not get it, and an agent has the same one thing to do
 * about either, so they land on the same status; the error code and message preserve the detail.
 */
export function mapProviderStatus(raw: string): MessageStatus | null {
  switch (raw.trim().toLowerCase()) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
    case 'sending':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':          // RCS and WhatsApp only; never plain SMS
      return 'read';
    case 'undelivered':
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return null;        // an unknown status is ignored rather than guessed at
  }
}

/**
 * Twilio error codes worth explaining in the agent's own words. Anything else falls back to the
 * message Twilio supplies, which is usually intelligible on its own.
 */
const ERROR_TEXT: Record<string, string> = {
  '21211': 'That phone number is not valid.',
  '21212': 'The sending number is not valid — check TWILIO_FROM_NUMBER.',
  '21214': 'That phone number could not be reached.',
  '21408': 'This Twilio account is not permitted to message that country.',
  '21610': 'The lead has unsubscribed from your messages (replied STOP).',
  '21614': 'That number cannot receive SMS — it is a landline.',
  '30003': 'The handset was unreachable — switched off or out of coverage.',
  '30004': 'The message was blocked by the carrier.',
  '30005': 'That number does not exist.',
  '30006': 'That is a landline or otherwise unreachable number.',
  '30007': 'The carrier filtered the message as spam.',
  '30008': 'Delivery failed for an unknown reason at the carrier.',
};

export const explainError = (code: string, fallback = ''): string =>
  ERROR_TEXT[code.trim()] ?? (fallback || `Twilio error ${code}.`);
