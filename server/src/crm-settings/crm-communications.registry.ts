import { MAIL_EVENTS } from '../email/mail-event-registry';

/**
 * Every CRM communication, in one place.
 *
 * WHY THIS EXISTS. What a CRM communication IS was spread across four files that each knew a
 * different part of it: `mail-event-registry` held the subject and body, `notification-preference`
 * held which channels it supports, `crm-settings.constants` held a per-user switch under a
 * different name, and the screens hard-coded their own lists on top. Adding one communication meant
 * editing all four and hoping they agreed; they did not have to, and a disagreement showed up as a
 * control that governed nothing.
 *
 * This is the one description. The template body still lives in `email_templates` — that is content
 * and belongs in a table somebody can edit — and the per-user answer still lives in
 * `notification_preferences`. What lives HERE is the shape: what the communication is called, what
 * it is allowed to do, and which rows in those two tables belong to it.
 *
 * ADDITIVE ONLY, FOR NOW. Nothing reads this yet. It is introduced ahead of the send-path switch so
 * the switch can be a change of caller rather than a change of caller AND a new source of truth in
 * the same commit. Current sending, trigger and delivery behaviour is untouched.
 *
 * ADDING A COMMUNICATION LATER means one entry here, one entry in `MAIL_EVENTS` if it sends email,
 * and one category in the notification-preference catalogue if it is per-user. The UI is driven
 * from this list, so it appears without a screen being edited.
 */

/** How a communication comes to be sent. */
export type CrmCommunicationKind =
  /** A scheduler or an application event sends it with nobody present. */
  | 'automated'
  /** A person presses a button in CRM Settings to send it. */
  | 'manual';

/** Who receives it. This decides which rules apply, not merely who reads it. */
export type CrmAudience =
  /** A client. Suppression, unsubscribe and CASL apply. */
  | 'lead'
  /** A member of staff. Notification preferences and channels apply. */
  | 'staff';

export interface CrmCommunication {
  /** Stable identifier for this communication. Never reused, never renamed. */
  key: string;
  /** What a person sees on the Communications screen. */
  name: string;
  /** One line explaining when it happens, written for the reader of the screen. */
  description: string;
  kind: CrmCommunicationKind;
  audience: CrmAudience;
  /**
   * Which channels this communication can use at all. A channel absent here is not "off" — it is
   * not a thing this communication does, and the UI must not offer a switch for it.
   */
  channels: { email: boolean; in_app: boolean; push: boolean };
  /**
   * The `notification_preferences.category` holding the per-user answer, or null when the
   * communication has no per-user preference.
   *
   * The six staff notifications already use their existing category names — those rows are live and
   * renaming them would discard everybody's settings. The greetings take a `crm_`-prefixed category
   * that the Phase 1 migration creates.
   */
  preferenceCategory: string | null;
  /** The `email_templates.event_key` holding the subject and body, or null when it sends no email. */
  templateEventKey: string | null;
  /**
   * The key this preference lives under in `crm_trigger_settings` TODAY.
   *
   * Present only while both stores exist. It is what the Phase 1 migration reads and what the
   * send path still reads until Phase 3; once the switch is made and verified, these come out.
   */
  legacyTriggerKey?: string;
  /**
   * Registered but on its way out. Kept visible so the code says what is true — a communication
   * that still has a send path is not gone just because it is unwanted — and so nothing silently
   * keeps working after the UI stops mentioning it.
   */
  retired?: boolean;
}

/** Variables a template for this communication may use. Read from the mail registry, never re-listed. */
export function variablesFor(comm: CrmCommunication): string[] {
  if (!comm.templateEventKey) return [];
  return MAIL_EVENTS[comm.templateEventKey]?.variables ?? [];
}

const staff = { email: true, in_app: true, push: true };
const leadEmailOnly = { email: true, in_app: false, push: false };

export const CRM_COMMUNICATIONS: CrmCommunication[] = [
  // ------------------------------------------------------------ automated, to staff
  {
    key: 'lead_new',
    name: 'New Lead',
    description: 'A lead is added to your book, however it arrived.',
    kind: 'automated', audience: 'staff', channels: staff,
    preferenceCategory: 'lead_new',
    templateEventKey: 'crm.lead_new',
  },
  {
    key: 'lead_assigned',
    name: 'Lead Assigned',
    description: 'Somebody assigns or transfers a lead to you.',
    kind: 'automated', audience: 'staff', channels: staff,
    preferenceCategory: 'lead_assigned',
    templateEventKey: 'crm.lead_assigned',
  },
  {
    key: 'lead_task_due',
    name: 'Follow-up / Task Due',
    description: 'A follow-up on one of your leads reaches its due date.',
    kind: 'automated', audience: 'staff', channels: staff,
    preferenceCategory: 'lead_task_due',
    templateEventKey: 'crm.lead_task_due',
  },
  {
    key: 'lead_meta',
    name: 'Meta Lead Received',
    description: 'A new lead arrives from a Facebook lead form.',
    kind: 'automated', audience: 'staff', channels: staff,
    preferenceCategory: 'lead_meta',
    templateEventKey: 'crm.meta_lead_received',
  },
  {
    key: 'campaign_completed',
    name: 'Campaign Completed',
    description: 'A campaign you own finishes sending.',
    kind: 'automated', audience: 'staff', channels: staff,
    preferenceCategory: 'campaign_completed',
    templateEventKey: 'crm.campaign_completed',
  },
  {
    key: 'campaign_failed',
    name: 'Campaign Failed',
    description: 'A campaign you own stops before it could finish.',
    kind: 'automated', audience: 'staff', channels: staff,
    preferenceCategory: 'campaign_failed',
    templateEventKey: 'crm.campaign_failed',
  },

  // ------------------------------------------------------------ automated, to leads
  /*
   * Email only, and that is not an oversight. These go to a CLIENT; there is no in-app inbox or
   * browser subscription for somebody who does not use the product. The per-user switch decides
   * whether THIS AGENT'S leads receive them, which is why they carry a preference at all.
   */
  {
    key: 'welcome',
    name: 'New Lead Welcome Email',
    description: 'Sent once to a new lead shortly after they arrive, however they arrived.',
    kind: 'automated', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: 'crm_welcome',
    templateEventKey: 'crm.lead_welcome',
    legacyTriggerKey: 'welcome',
  },
  {
    key: 'birthday',
    name: 'Birthday Greeting',
    description: "Sent to your lead on their birthday, if a date of birth is on file.",
    kind: 'automated', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: 'crm_birthday',
    templateEventKey: 'crm.birthday_greeting',
    legacyTriggerKey: 'birthday',
  },
  {
    key: 'anniversary',
    name: 'Anniversary Greeting',
    description: 'Sent to your lead on their wedding anniversary, if a date is on file.',
    kind: 'automated', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: 'crm_anniversary',
    templateEventKey: 'crm.anniversary_greeting',
    legacyTriggerKey: 'anniversary',
  },
  {
    key: 'seasonal',
    name: 'Seasonal Wishes',
    description: 'Seasonal greetings sent to your leads.',
    kind: 'automated', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: 'crm_seasonal',
    templateEventKey: 'crm.seasonal_wishes',
    legacyTriggerKey: 'seasonal',
  },

  // ------------------------------------------------------------ manual, to leads
  /*
   * Sent by a person pressing a button in CRM Settings. They need one switch — may I send this
   * kind of email at all — and nothing else: there is no schedule to mute and no in-app or push
   * equivalent of an email somebody chose to write.
   *
   * `promotional` and `referral` build their body from structured input the sender supplies, and
   * `custom` is authored in full at send time, which is why none of the three maps to a stored
   * template. They keep their existing `crm_trigger_settings` switch; only where it is SHOWN moves.
   */
  {
    key: 'promotional',
    name: 'Promotional Offer',
    description: 'An offer you send to a lead by hand from CRM Settings.',
    kind: 'manual', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: null,
    templateEventKey: null,
    legacyTriggerKey: 'promotional',
  },
  {
    key: 'referral',
    name: 'Referral Code',
    description: 'A referral code you send to a lead by hand.',
    kind: 'manual', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: null,
    templateEventKey: null,
    legacyTriggerKey: 'referral',
  },
  {
    key: 'custom',
    name: 'Custom Email',
    description: 'A one-off email you write and send to a lead yourself.',
    kind: 'manual', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: null,
    templateEventKey: null,
    legacyTriggerKey: 'custom',
  },

  // ------------------------------------------------------------ retired
  /*
   * Wedding Congratulations. Still has a template and a live send path from CRM Settings, so it is
   * registered rather than deleted — a communication that can still be sent must be describable.
   * `retired` keeps it out of the Communications list and out of the Phase 1 migration. Removing
   * the send path is a later decision, and this entry is what makes that decision visible.
   */
  {
    key: 'wedding',
    name: 'Wedding Congratulations',
    description: 'Retired. Still sendable by hand; not offered as a managed communication.',
    kind: 'manual', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: null,
    templateEventKey: 'crm.wedding_congratulations',
    legacyTriggerKey: 'wedding',
    retired: true,
  },
];

/** Everything the Communications screen should list — registered, minus anything retired. */
export const ACTIVE_CRM_COMMUNICATIONS = CRM_COMMUNICATIONS.filter((c) => !c.retired);

export const byKey = (key: string): CrmCommunication | undefined =>
  CRM_COMMUNICATIONS.find((c) => c.key === key);

/** The communication a `notification_preferences.category` belongs to, if any. */
export const byPreferenceCategory = (category: string): CrmCommunication | undefined =>
  CRM_COMMUNICATIONS.find((c) => c.preferenceCategory === category);

/** The communication an `email_templates.event_key` belongs to, if any. */
export const byTemplateEventKey = (eventKey: string): CrmCommunication | undefined =>
  CRM_COMMUNICATIONS.find((c) => c.templateEventKey === eventKey);
