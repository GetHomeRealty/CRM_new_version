/** Campaigns → Celebrations (festival, birthday, anniversary and general greetings). */

export type RecipientMode = 'all' | 'filtered' | 'selected' | 'single';

export interface RecipientFilters {
  agent_id?: number | null;
  status?: string;
  tags?: string[];
  location?: string;
  source?: string;
  lead_type?: string;
  client_type?: string;
  date_window?: 'today' | 'next7' | 'this_month' | 'on_date';
  date_on?: string;
  feb29_rule?: 'feb28' | 'mar1' | 'skip';
}

export interface RecipientSpec {
  mode: RecipientMode;
  filters: RecipientFilters;
  lead_ids: number[];
  excluded_lead_ids: number[];
}

export interface OccasionOption { value: string; label: string; group: 'festival' | 'birthday' | 'anniversary' | 'general' }

export interface CelebrationOptions {
  occasions: OccasionOption[];
  tones: string[];
  lengths: string[];
  languages: string[];
  feb29_rules: string[];
  tokens: { token: string; label: string; fallback: string }[];
  filters: {
    lead_status: readonly string[]; lead_source: readonly string[]; lead_type: readonly string[]; client_type: readonly string[];
    tags: string[]; agents: { id: number; name: string }[];
  };
  scope: 'brokerage' | 'own';
  scope_note: string;
  sender_accounts: { id: number; name: string | null; from_email: string; from_name: string | null }[];
  default_sender: string | null;
  me: { name: string; email: string };
  ai: { available: boolean; reason: string | null; provider: string | null };
  flyer: {
    formats: { value: string; label: string }[];
    styles: string[];
    brand_colours: { primary: string; accent: string; background: string; text: string };
    logo_available: boolean;
    agent_photo_available: boolean;
    agent_photo_note: string;
    image_generation: boolean;
    image_generation_note: string;
  };
  max_recipients: number;
  default_timezone: string;
  send_problem: string | null;
}

export interface Exclusion { reason: string; label: string; count: number; sample?: { lead_id: number; name: string; email: string | null }[] }

export interface AudiencePreviewResult {
  count: number;
  matched: number;
  not_permitted: number;
  exclusions: Exclusion[];
  excluded_total: number;
  over_cap: boolean;
  scan_capped: boolean;
  max_recipients: number;
  year: number;
  days: string[];
  recipients: { lead_id: number; name: string; email: string; first_name: string }[];
  scope: 'brokerage' | 'own';
}

export interface PickableLead {
  id: number; name: string; email: string | null; lead_status: string | null;
  eligible: boolean; reason: string | null; has_birthday: boolean; has_anniversary: boolean;
}

export interface Flyer {
  id: number; source: 'upload' | 'template'; mime: string; width: number; height: number; size: number;
  alt_text: string; settings: Record<string, unknown> | null; label: string; data_url: string;
}

export interface CelebrationStats {
  total: number; sent: number; diverted: number; failed: number; skipped: number; bounced: number;
  opened: number; clicked: number; unsubscribed: number; pending: number;
}

export interface CelebrationSummary {
  id: number;
  name: string;
  status: 'draft' | 'scheduled' | 'sending' | 'completed' | 'partial' | 'failed' | 'cancelled' | string;
  occasion: string | null;
  occasion_label: string | null;
  occasion_name: string;
  subject: string;
  automation_id: number | null;
  ai_assisted: boolean;
  flyer_id: number | null;
  stats: CelebrationStats;
  sender_email: string | null;
  timezone: string | null;
  scheduled_for: string | null;
  sent_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CelebrationRecipient {
  id: number; lead_id: number | null; name: string | null; email: string; status: string; error: string | null;
  opened: boolean; opened_at: string | null; clicked_at: string | null; unsubscribed: boolean; bounced: boolean;
  bounce_type: string | null; failure_kind: string | null; retry_count: number; next_retry_at: string | null;
  provider_message_id: string | null; sent_at: string | null;
}

export interface CelebrationDetail extends CelebrationSummary {
  preview_text: string | null;
  message: string | null;
  branding: 'brokerage' | 'agent' | null;
  reply_to: string | null;
  sender_account_id: number | null;
  recipients_spec: RecipientSpec;
  audience_snapshot: { exclusions: Exclusion[]; matched: number | null; not_permitted: number; built_at: string | null };
  flyer: Flyer | null;
  by_status: Record<string, number>;
  retryable: number;
  unknown_outcome: number;
  recipients: CelebrationRecipient[];
}

/** What the wizard edits and saves. */
export interface CelebrationDraftInput {
  name: string;
  occasion: string;
  occasion_label: string;
  subject: string;
  preview_text: string;
  message: string;
  branding: 'brokerage' | 'agent';
  sender_account_id: number | null;
  reply_to: string;
  flyer_id: number | null;
  recipients: RecipientSpec;
  timezone: string;
  ai_assisted: boolean;
}

export interface CelebrationPreview {
  subject: string;
  preview_text: string;
  html: string;
  text: string;
  from: { name: string | null; email: string } | null;
  reply_to: string | null;
  sample: { lead_id: number; name: string; email: string | null } | null;
  merge_values: Record<string, string>;
  send_problem: string | null;
}

export interface AiGreetingDraft { subject: string; preview_text: string; message: string; flyer_headline: string; flyer_greeting: string }

export interface CelebrationAutomation {
  id: number;
  name: string;
  occasion: 'birthday' | 'anniversary';
  status: 'active' | 'paused';
  subject: string;
  preview_text: string | null;
  message: string;
  branding: 'brokerage' | 'agent';
  flyer_id: number | null;
  sender_account_id: number | null;
  reply_to: string | null;
  send_time: string;
  timezone: string;
  feb29_rule: 'feb28' | 'mar1' | 'skip';
  recipients: { mode: 'all' | 'filtered'; filters: RecipientFilters; excluded_lead_ids: number[] } | null;
  last_run_on: string | null;
  last_run_at: string | null;
  last_run_summary: { date?: string; campaign_id?: number; recipients?: number; exclusions?: Exclusion[]; note?: string; error?: string } | null;
  next_run: string | null;
  created_at: string;
  updated_at: string;
}
