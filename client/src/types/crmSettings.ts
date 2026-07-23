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
  weddingGreetings: CrmTriggerTemplate;
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
  recipients: number;
  sent_by: string | null;
  created_at: string | null;
}

export interface CrmIntegrationState {
  connected: boolean;
  detail: string;
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
