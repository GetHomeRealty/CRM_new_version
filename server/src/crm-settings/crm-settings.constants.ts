/**
 * CRM Settings vocabularies and defaults — a faithful copy of the CRM's own shapes so no field
 * or default is lost in the migration.
 */

/** CRM `settings.notifications`. */
export const NOTIFICATION_KEYS = [
  'emailAlerts', 'smsAlerts', 'leadNotifications', 'showingReminders', 'marketUpdates', 'documentAlerts',
] as const;

export const DEFAULT_NOTIFICATIONS: Record<string, boolean> = {
  emailAlerts: true,
  smsAlerts: true,
  leadNotifications: true,
  showingReminders: true,
  marketUpdates: false,
  documentAlerts: true,
};

/** CRM `settings.emailSettings`. */
export const DEFAULT_EMAIL_SETTINGS = {
  signature: '',
  replyTemplate: '',
  autoSync: false,
  autoResponder: { enabled: false, message: '' },
  forwardingAddress: '',
};

/** CRM `settings.preferences`. */
export const DEFAULT_PREFERENCES = {
  language: 'en',
  timeZone: 'America/Toronto',
  currency: 'CAD',
  dateFormat: 'MM/DD/YYYY',
  theme: 'light',
};

/**
 * CRM `DEFAULT_EMAIL_SETTINGS.templates` — per-trigger copy and scheduling.
 *
 * READ BY NOTHING THAT SENDS. This is the CRM's own legacy `settings.templates` blob, carried over
 * verbatim so the migrated payload kept its shape. What actually decides whether an email may go is
 * `TRIGGER_KEYS` below, resolved through `crm_email_settings` and `crm_trigger_settings`. The two
 * never even named the same things — measured during the CRM › Triggers audit, `weddingGreetings.
 * enabled` saved as false and the wedding email went out anyway.
 *
 * `weddingGreetings` is gone from it with the rest of Wedding Congratulations. It is dropped rather
 * than kept for shape: a stored `templates.weddingGreetings` simply stops being echoed back, and
 * nothing read it in either position.
 */
export const DEFAULT_TRIGGER_TEMPLATES = {
  birthdayWishes: { enabled: false, daysBefore: 1, template: 'Happy Birthday!' },
  seasonalWishes: { enabled: false, template: 'Happy Holidays!' },
  promotionalOffers: { enabled: false, template: 'Special offer for you!' },
  referralCodes: { enabled: false, template: 'Here is your referral code!' },
};

/**
 * CRM `emailSettings.emailTemplates` trigger switches — one per email this application can send.
 *
 * `birthday` and `anniversary` were removed once, because nothing sent either and both switches
 * were decorative — the help text ("decides whether that email may be sent") was false in both
 * positions. That note ended "put them back the day something sends a birthday email".
 *
 * THAT DAY IS NOW. `LeadGreetingsService` sweeps daily for leads whose `date_of_birth` or
 * `marriage_day` falls today and sends through `CrmAdvancedEmailService`, which checks these
 * switches like every other send. So they gate something real, in both positions.
 *
 * DEFAULT OFF, unlike the five above, and that asymmetry is deliberate. The others fire only when
 * a person presses a button; these fire on a timer, at whatever the stored dates say, without
 * anybody present. An upgrade that silently began emailing a brokerage's whole book on a schedule
 * nobody chose would be the wrong default whatever the feature. Switch them on under
 * CRM → Communications → Brokerage Controls when the brokerage wants them.
 */
export const TRIGGER_KEYS = [
  'seasonal', 'promotional', 'referral', 'custom', 'birthday', 'anniversary', 'welcome',
] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];

/**
 * The three greetings whose PERSONAL layer has moved to `notification_preferences`.
 *
 * WHAT MOVED AND WHAT DID NOT. Only the per-user answer moved. The brokerage layer for these three
 * is still `crm_email_settings.template_toggles`, read through `brokerageDefaultFor`, because it is
 * a brokerage-wide default and `notification_preferences` has no row that could hold one. So the
 * three levels are unchanged in shape — kill switch, personal choice, brokerage default — and only
 * the middle one changed table.
 *
 * ABSENT IN THE MAP MEANS "STILL OWNED BY `crm_trigger_settings`". `welcome`, `promotional`,
 * `referral` and `custom` are deliberately not here: welcome has no verified migration yet, and the
 * three manual emails are permanent residents of that table — they are a switch on a button, not a
 * notification somebody receives, so there is no per-channel answer for them to hold.
 */
export const GREETING_CATEGORY: Partial<Record<TriggerKey, string>> = {
  birthday: 'crm_birthday',
  anniversary: 'crm_anniversary',
  seasonal: 'crm_seasonal',
};

/**
 * `welcome` defaults to FALSE, with birthday and anniversary and for the same reason.
 *
 * The five that default to true are button-driven: somebody chose a lead, chose a message and
 * pressed send, so the switch is about whether that button works. The three that default to false
 * are timer-driven — nobody is watching when they go — and an upgrade that quietly began emailing
 * every lead who arrives is not a decision this file gets to make on a brokerage's behalf. Turning
 * it on is one switch under CRM → Communications.
 */
/**
 * What a brokerage that has chosen nothing sends.
 *
 * NOTHING REACHES A CLIENT AUTOMATICALLY BY DEFAULT. The four automated lead-facing emails -
 * welcome, birthday, anniversary and seasonal - are off, and the brokerage switches each on
 * deliberately. Three of them already were; `seasonal` was the outlier and is now consistent with
 * the other three.
 *
 * WHY, and it is a business decision rather than a technical one: these are commercial messages
 * sent on the CRM's own initiative, and the only consent this system records is the ABSENCE of an
 * unsubscribe. That is opt-out, where Canadian commercial email is generally expected to be opt-in.
 * Whether the brokerage's leads are covered by implied consent is a question for the brokerage and
 * its advisor - so the application stops answering it on their behalf and asks instead. Reviewed and
 * chosen by the brokerage on 2026-08-29.
 *
 * `promotional`, `referral` and `custom` stay on: they are MANUAL sends, dispatched when somebody
 * presses send, so their toggle governs availability rather than an unattended send.
 *
 * THIS IS THE DEFAULT, NOT THE ANSWER. `crm_email_settings.template_toggles` overrides it, and a
 * brokerage that has switched these on keeps them on - see migration
 * 20260829130000_automated_client_email_off_by_default for why the stored row was cleared once.
 */
export const DEFAULT_TRIGGERS: Record<string, boolean> = {
  promotional: true, referral: true, custom: true,
  welcome: false, birthday: false, anniversary: false, seasonal: false,
};

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'zh', label: 'Mandarin' },
  { value: 'hi', label: 'Hindi' },
  { value: 'pa', label: 'Punjabi' },
];

export const TIME_ZONES = [
  'America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg',
  'America/Halifax', 'America/St_Johns', 'America/New_York', 'UTC',
];

export const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'INR'];
export const DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];
export const THEMES = ['light', 'dark', 'system'];
export const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter', 'Holiday Season', 'New Year'];
export const BROADCAST_TYPES = ['info', 'warning', 'success'];

/** Roles treated as administrators by the CRM's settings scoping. */
export const CRM_ADMIN_ROLES = ['admin', 'administrator', 'manager', 'developer'];

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Guardrail on a single bulk send, so one click cannot fan out unbounded. */
export const MAX_BULK_RECIPIENTS = 200;
