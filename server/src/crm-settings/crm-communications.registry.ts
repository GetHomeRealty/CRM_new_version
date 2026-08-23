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
    key: 'task_assigned',
    name: 'Task Assigned',
    description: 'Somebody assigns you a follow-up task on a lead.',
    kind: 'automated', audience: 'staff', channels: staff,
    preferenceCategory: 'task_assigned',
    templateEventKey: 'crm.task_assigned',
  },
  {
    key: 'showing_created',
    name: 'Showing Scheduled',
    description: 'A showing is booked on a lead in your book.',
    kind: 'automated', audience: 'staff', channels: staff,
    preferenceCategory: 'showing_created',
    templateEventKey: 'crm.showing_created',
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
  /*
   * WELCOME IS NOT MIGRATED, AND ITS REGISTRY ENTRY SAYS SO RATHER THAN IMPLYING OTHERWISE.
   *
   * It carried `preferenceCategory: 'crm_welcome'` while no such category existed in the
   * notification catalogue and the Phase 1 migration deliberately did not create one — so the field
   * named a destination nothing had moved to. Now that `preferenceCategory` is what decides which
   * store a row is read from, leaving it would have silently switched Welcome to a table holding no
   * answer for it, and every agent who had switched it off would have started sending again.
   *
   * `legacyTriggerKey` alone, therefore: `crm_trigger_settings` is where Welcome's per-user answer
   * genuinely lives. Migrating it is a separate decision with its own dry run; the category name is
   * recorded in the comment rather than in a field that would act on it.
   */
  {
    key: 'welcome',
    name: 'New Lead Welcome Email',
    description: 'Sent once to a new lead shortly after they arrive, however they arrived.',
    kind: 'automated', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: null,
    templateEventKey: 'crm.lead_welcome',
    legacyTriggerKey: 'welcome',
  },
  /*
   * The three migrated greetings. `legacyTriggerKey` is GONE from all three, and its absence is the
   * statement: the per-user answer is `notification_preferences` now, in the category named below,
   * and there is no longer a second store for these that could disagree. The brokerage DEFAULT they
   * inherit is still `crm_email_settings.template_toggles` — a brokerage-wide value that
   * `notification_preferences` has no row shape to hold. See `GREETING_CATEGORY`.
   */
  {
    key: 'birthday',
    name: 'Birthday Greeting',
    description: "Sent to your lead on their birthday, if a date of birth is on file.",
    kind: 'automated', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: 'crm_birthday',
    templateEventKey: 'crm.birthday_greeting',
  },
  {
    key: 'anniversary',
    name: 'Anniversary Greeting',
    description: 'Sent to your lead on their wedding anniversary, if a date is on file.',
    kind: 'automated', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: 'crm_anniversary',
    templateEventKey: 'crm.anniversary_greeting',
  },
  {
    key: 'seasonal',
    name: 'Seasonal Wishes',
    description: 'Seasonal greetings sent to your leads.',
    kind: 'automated', audience: 'lead', channels: leadEmailOnly,
    preferenceCategory: 'crm_seasonal',
    templateEventKey: 'crm.seasonal_wishes',
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

  /*
   * ------------------------------------------------------------ retired
   *
   * WEDDING CONGRATULATIONS IS GONE, and this note is what is left of it.
   *
   * It was registered here with `retired: true` while it still had a live send path, because a
   * communication that can be sent must be describable even when it is unwanted. That is no longer
   * true of it: the brokerage's decision is that Anniversary Greeting covers the need, so the
   * button, the `sendWeddingEmail` action, the service method, the trigger key and this entry have
   * all gone. Nothing in the application can send it.
   *
   * WHAT DELIBERATELY REMAINS. `crm.wedding_congratulations` stays registered in `MAIL_EVENTS` and
   * any `email_templates` row keyed to it is left alone — as are the `crm_email_log` and
   * `audit_logs` rows recording weddings that really were sent. Those are history, and the record
   * of an email a brokerage sent to a client is not ours to delete because the feature was retired.
   * Keeping the mail-registry entry is also what stops that orphaned template row surfacing on the
   * Communications screen as an "unmapped" template somebody should do something about.
   */
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
