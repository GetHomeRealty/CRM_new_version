/** Meta (Facebook / Instagram) lead-ads integration types. */

export interface MetaStatus {
  /** Whether the server has META_APP_ID / META_APP_SECRET. Nothing works without it. */
  configured: boolean;
  /** False when APP_KEY is missing, which would mean access tokens sit unencrypted. */
  token_storage_secure: boolean;
  redirect_uri: string;
  oauth_strategy: string;
  has_login_config_id: boolean;
  is_connected: boolean;
  facebook_user_name: string | null;
  pages_count: number;
  page_name: string | null;
  connected_at: string | null;
  last_sync: string | null;
  leads_count: number;
  /** Lead forms currently opted in. */
  connected_forms: number;
  token_expires_at: string | null;
  token_days_left: number | null;
  token_expired: boolean;
  needs_reconnect: boolean;
  granted_scopes: string[];
  missing_permissions: string[];
  ad_account_id: string | null;
  ad_account_name: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_webhook_at: string | null;
}

export interface MetaSyncRun {
  id: number;
  trigger: string;
  forms_read: number;
  imported: number;
  updated: number;
  duplicates: number;
  skipped: number;
  errors: string[];
  started_at: string;
  finished_at: string | null;
}

export interface MetaWebhookEvent {
  id: number;
  leadgen_id: string | null;
  form_id: string | null;
  page_id: string | null;
  status: string;
  error: string | null;
  lead_id: number | null;
  attempts: number;
  received_at: string;
  processed_at: string | null;
}

export interface MetaWebhookHealth {
  total: number;
  failed: number;
  last_received_at: string | null;
  events: MetaWebhookEvent[];
}

export interface MetaAdAccount {
  id: string;
  name: string;
  active: boolean;
}

export interface MetaPage {
  id: string;
  name: string;
}

export interface MetaForm {
  id: string;
  name: string;
  status: string | null;
  leads_count: number;
  created_at: string | null;
  is_connected: boolean;
}

export interface MetaLeadRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  message: string | null;
  property: string | null;
  lead_status: string | null;
  facebook_lead_id: string | null;
  created_at: string | null;
}

export interface MetaLeadsResponse {
  stats: { total: number; today: number; week: number };
  data: MetaLeadRow[];
}

export interface MetaSyncResult {
  imported: number;
  updated: number;
  skipped: number;
  forms: number;
  errors: string[];
  message: string;
}

export interface MetaDiagnostics {
  configured: boolean;
  app_id: string | null;
  app_name: string | null;
  app_link: string | null;
  live_permissions: string[];
  required_permissions: string[];
  missing_permissions: string[];
  redirect_uri: string;
  oauth_strategy: string;
  login_config_id: string | null;
  token_storage_secure: boolean;
  blockers: string[];
  fix_steps: string[];
}
