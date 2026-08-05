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
 * `birthday` and `anniversary` are gone. There is no send path for either: `CrmSettingsPanel`'s
 * `actionFor` offers wedding, seasonal, promotional, referral and custom, and
 * `CrmAdvancedEmailService` implements exactly those five. The two extras were switches whose help
 * text ("decides whether that email may be sent from Send a CRM Email below") was false in both
 * positions — switching them on made nothing available and switching them off blocked nothing.
 *
 * Rows that already carry the two keys keep them in their stored JSON; nothing reads them, and the
 * next save drops them. Put them back the day something sends a birthday email.
 */
export const TRIGGER_KEYS = [
  'wedding', 'seasonal', 'promotional', 'referral', 'custom',
] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];

export const DEFAULT_TRIGGERS: Record<string, boolean> = {
  wedding: true, seasonal: true, promotional: true, referral: true, custom: true,
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
