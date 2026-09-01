/** CRM Settings types — migrated from the CRM app, kept separate from Transaction Desk's own. */

export interface CrmNotifications {
  emailAlerts: boolean;
  smsAlerts: boolean;
  leadNotifications: boolean;
  showingReminders: boolean;
  marketUpdates: boolean;
  documentAlerts: boolean;
}

export interface CrmUserEmailSettings {
  signature: string;
  replyTemplate: string;
  autoResponder: { enabled: boolean; message: string };
  forwardingAddress: string;
}

export interface CrmPreferences {
  language: string;
  timeZone: string;
  currency: string;
  dateFormat: string;
  theme: string;
}

export interface CrmTriggerTemplate {
  enabled: boolean;
  template: string;
  daysBefore?: number;
}

export interface CrmTriggerTemplates {
  birthdayWishes: CrmTriggerTemplate;
  // `weddingGreetings` was here and is gone with Wedding Congratulations. Nothing read it — see
  // `DEFAULT_TRIGGER_TEMPLATES` on the server for why this whole shape is inert.
  seasonalWishes: CrmTriggerTemplate;
  promotionalOffers: CrmTriggerTemplate;
  referralCodes: CrmTriggerTemplate;
}

export interface CrmSettings {
  scope: 'global' | 'user';
  is_admin: boolean;
  notifications: CrmNotifications;
  emailSettings: CrmUserEmailSettings;
  preferences: CrmPreferences;
  templates: CrmTriggerTemplates;
  updated_by: string | null;
  updated_at: string | null;
  options: {
    languages: { value: string; label: string }[];
    time_zones: string[];
    currencies: string[];
    date_formats: string[];
    themes: string[];
    notification_keys: string[];
  };
}

export interface CrmProfile {
  id: number | null;
  name: string;
  username: string;
  email: string;
  phone: string;
  role: string;
  status: string;
}

export interface CrmEmailSettings {
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  adminEmail: string;
  autoSendEnabled: boolean;
  emailTemplates: Record<string, boolean>;
  updated_by: string | null;
  updated_at: string | null;
  trigger_keys: string[];
}

export interface CrmReferralCode {
  id: number;
  code: string;
  discount: number;
  validUntil: string;
  usageCount: number;
  maxUsage: number;
  expired: boolean;
  created_by: string | null;
  created_at: string | null;
}

export interface CrmEmailLogRow {
  id: number;
  kind: string;
  lead_name: string | null;
  recipient: string;
  subject: string | null;
  success: boolean;
  error: string | null;
  redirected: string | null;
  sent_by: string | null;
  created_at: string | null;
}

export interface CrmBroadcast {
  id: number;
  message: string;
  type: string;
  /** How many staff have actually received it so far. */
  recipients: number;
  /**
   * Delivery runs off the request thread, so the row exists — and says `sending` — before anybody
   * has been emailed. Without these the list cannot tell a send still in flight from one that
   * reached nobody: both read "0 recipients". A run cut short by a restart is closed out at the
   * next boot rather than reading `sending` for ever.
   */
  status: 'sending' | 'completed' | 'partial' | 'failed';
  /** How many addresses the send is working through in total. */
  attempted: number;
  /** Addresses the mail server refused. */
  failed: number;
  /** The first failure, in words the person who sent it can act on. */
  error: string | null;
  completed_at: string | null;
  sent_by: string | null;
  created_at: string | null;
}

export interface CrmIntegrationState {
  connected: boolean;
  detail: string;
  /**
   * Set on `email` when messages are being REFUSED, as against no account being configured.
   *
   * `connected` covers both, because a summary whose green light means "an account row exists"
   * answers a question nobody asks. This distinguishes the two for anything that wants to word them
   * differently. Optional: an older response simply says nothing.
   */
  failing?: boolean;
}

export interface CrmIntegrations {
  email: CrmIntegrationState;
  google_calendar: CrmIntegrationState;
  meta: CrmIntegrationState;
  mail_redirect: { active: boolean; detail: string };
}

export interface CrmSendResult {
  success: boolean;
  message: string;
  redirected?: string | null;
}

/*
 * `CrmMyTriggers` was here — the payload of `GET /api/crm-settings/triggers`, which the CRM
 * Triggers screen rendered. Screen, endpoint and type are gone together; `CrmCommunicationsOverview`
 * in `lib/crmCommunicationsApi.ts` is what describes these controls now.
 */
