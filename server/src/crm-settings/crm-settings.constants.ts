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

/** CRM `DEFAULT_EMAIL_SETTINGS.templates` — per-trigger copy and scheduling. */
export const DEFAULT_TRIGGER_TEMPLATES = {
  birthdayWishes: { enabled: false, daysBefore: 1, template: 'Happy Birthday!' },
  weddingGreetings: { enabled: false, template: 'Congratulations on your wedding!' },
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
 * Triggers → CRM Triggers when the brokerage wants them.
 */
export const TRIGGER_KEYS = [
  'wedding', 'seasonal', 'promotional', 'referral', 'custom', 'birthday', 'anniversary', 'welcome',
] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];

/**
 * `welcome` defaults to FALSE, with birthday and anniversary and for the same reason.
 *
 * The five that default to true are button-driven: somebody chose a lead, chose a message and
 * pressed send, so the switch is about whether that button works. The three that default to false
 * are timer-driven — nobody is watching when they go — and an upgrade that quietly began emailing
 * every lead who arrives is not a decision this file gets to make on a brokerage's behalf. Turning
 * it on is one switch under Triggers → CRM Triggers.
 */
export const DEFAULT_TRIGGERS: Record<string, boolean> = {
  wedding: true, seasonal: true, promotional: true, referral: true, custom: true,
  birthday: false, anniversary: false, welcome: false,
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
