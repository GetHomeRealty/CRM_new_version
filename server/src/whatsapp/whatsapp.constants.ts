import { webhookSecret, webhookVerifyToken } from '../meta/meta.constants';

/**
 * WhatsApp Cloud API (Meta) configuration and payload reading.
 *
 * Receiving needs no access token: Meta signs every delivery with the APP SECRET, and the
 * subscription handshake echoes a verify token. Both default to the Meta app this CRM already uses
 * for lead ads, and can be overridden when the WhatsApp number lives on a different Meta app.
 * Secrets stay in the environment, never in the database and never in a response.
 */

const env = (k: string): string => String(process.env[k] ?? '').trim();

export const whatsappAppSecret = (): string => env('WHATSAPP_APP_SECRET') || webhookSecret();
export const whatsappVerifyToken = (): string => env('WHATSAPP_WEBHOOK_VERIFY_TOKEN') || webhookVerifyToken();
/**
 * Optional. When set, only messages to this WhatsApp business number are taken in — so another
 * number on the same Meta app (a test number, another office) cannot create CRM leads.
 */
export const whatsappPhoneNumberId = (): string => env('WHATSAPP_PHONE_NUMBER_ID');

export const isWhatsAppConfigured = (): boolean => whatsappAppSecret() !== '' && whatsappVerifyToken() !== '';

/** `leads.lead_source` and `leads.source` for a lead that arrived on WhatsApp. */
export const WHATSAPP_LEAD_SOURCE = 'whatsapp';

/** One incoming message, as the intake needs it. */
export interface InboundWhatsApp {
  /** WhatsApp's message id (`wamid.…`) — what makes a redelivered webhook harmless. */
  id: string;
  /** The sender's number in international form without the plus, e.g. `14165550134`. */
  from: string;
  profileName: string | null;
  type: string;
  text: string;
  receivedAt: Date;
  phoneNumberId: string | null;
}

const str = (v: unknown): string => String(v ?? '').trim();

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The words of a message, whatever kind it is. A photo or document keeps its caption; anything with
 * no words at all is still recorded, as a bracketed note of what it was, so the enquiry is not lost.
 */
export function messageText(m: Obj): string {
  const type = str(m.type);
  const part = obj(m[type]);
  switch (type) {
    case 'text': return str(obj(m.text).body);
    case 'button': return str(obj(m.button).text) || str(obj(m.button).payload);
    case 'interactive': {
      const reply = obj(part.button_reply ?? part.list_reply);
      return [str(reply.title), str(reply.description)].filter(Boolean).join(' — ');
    }
    case 'location': {
      const where = [str(part.name), str(part.address)].filter(Boolean).join(', ');
      return `[Location] ${where || `${str(part.latitude)}, ${str(part.longitude)}`}`;
    }
    case 'image': case 'video': case 'document': case 'audio': case 'sticker': {
      const label = type.charAt(0).toUpperCase() + type.slice(1);
      const words = str(part.caption) || str(part.filename);
      return words ? `[${label}] ${words}` : `[${label}]`;
    }
    case 'contacts': {
      const names = arr(m.contacts).map((c) => str(obj(obj(c).name).formatted_name)).filter(Boolean);
      return `[Contact card] ${names.join(', ')}`.trim();
    }
    default: return type ? `[${type}]` : '';
  }
}

/**
 * Every customer message in one webhook delivery. Delivery receipts for messages WE sent
 * (`statuses`), reactions and system notices carry no enquiry and are left out.
 */
export function inboundMessages(body: unknown): InboundWhatsApp[] {
  const b = obj(body);
  if (str(b.object) !== 'whatsapp_business_account') return [];
  const out: InboundWhatsApp[] = [];
  for (const entry of arr(b.entry)) {
    for (const change of arr(obj(entry).changes)) {
      const c = obj(change);
      if (str(c.field) !== 'messages') continue;
      const value = obj(c.value);
      const phoneNumberId = str(obj(value.metadata).phone_number_id) || null;
      const names = new Map<string, string>();
      for (const contact of arr(value.contacts)) {
        const ct = obj(contact);
        const name = str(obj(ct.profile).name);
        if (name) names.set(str(ct.wa_id), name);
      }
      for (const message of arr(value.messages)) {
        const m = obj(message);
        const type = str(m.type);
        if (type === 'reaction' || type === 'system' || type === 'unsupported') continue;
        const id = str(m.id);
        const from = str(m.from).replace(/\D/g, '');
        if (!id || !from) continue;
        const seconds = Number(str(m.timestamp));
        out.push({
          id,
          from,
          profileName: names.get(from) ?? names.get(str(m.from)) ?? null,
          type: type || 'text',
          text: messageText(m),
          receivedAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(),
          phoneNumberId,
        });
      }
    }
  }
  return out;
}
