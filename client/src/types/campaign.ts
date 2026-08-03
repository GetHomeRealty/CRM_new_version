/** Campaign types (mirror the server's campaign module). */

export interface CampaignStats {
  total: number; sent: number; failed: number;
  opened: number; unsubscribed: number; bounced: number;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'partial' | 'completed' | 'failed';

export interface CampaignSummary {
  id: number;
  name: string;
  template_id: number | null;
  template_name: string | null;
  category: string | null;
  status: CampaignStatus;
  tags: string[];
  stats: CampaignStats;
  created_by: string | null;
  created_at: string | null;
  /**
   * When this campaign goes out, or null for send-now. An absolute UTC instant — every screen
   * renders it in the reader's own timezone rather than the server's.
   */
  scheduled_for: string | null;
  sent_at: string | null;
}

/**
 * Why a delivery failed.
 *  hard    — the mailbox does not exist. The address has been suppressed.
 *  soft    — a transient refusal (full mailbox, greylisting). Being retried.
 *  unknown — a fault at our end (SMTP credentials, connection). Says nothing about the address.
 */
export type BounceType = 'hard' | 'soft' | 'unknown';

export interface CampaignRecipientRow {
  id: number;
  lead_id: number | null;
  name: string | null;
  email: string;
  status: string;
  error: string | null;
  opened: boolean;
  opened_at: string | null;
  unsubscribed: boolean;
  bounced: boolean;
  bounce_type: BounceType | null;
  /** Delivery attempts made. Only a soft bounce increments it. */
  retry_count?: number;
  /** When a deferred recipient will be attempted again. */
  next_retry_at?: string | null;
}

export interface CampaignDetail extends CampaignSummary {
  subject: string;
  /** Snapshot of the HTML that was actually sent. */
  content: string;
  audience: Record<string, string>;
  recipients: CampaignRecipientRow[];
}

export interface CampaignTemplate {
  id: number;
  name: string;
  subject: string;
  category: string;
  /** Every {{TOKEN}} the template uses. */
  variables: string[];
  /** How many files ride along with each send. */
  attachment_count?: number;
}

export interface CampaignTemplateAttachment {
  id: number;
  filename: string;
  content_type: string;
  size: number;
}

/** A template in the library, including its stored attachments. */
export interface CampaignTemplateDetail extends CampaignTemplate {
  content: string;
  is_active: boolean;
  attachments: CampaignTemplateAttachment[];
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CampaignTemplateInput {
  name: string;
  subject: string;
  content: string;
  category: string;
}

export interface CampaignOptions {
  lead_status: string[];
  lead_type: string[];
  lead_source: string[];
  client_type: string[];
  tag_options: string[];
  categories: { value: string; label: string }[];
  fillable_tokens: string[];
  lead_sourced_tokens: string[];
  max_recipients: number;
  tags: string[];
  templates: CampaignTemplate[];
}

/** The lead segment a campaign targets. */
export interface AudienceFilter {
  leadStatus?: string;
  leadType?: string;
  leadSource?: string;
  clientType?: string;
  tag?: string;
}

export interface AudiencePreview {
  count: number;
  sample: { name: string; email: string }[];
}

/**
 * One address the brokerage may no longer email.
 *
 * `reason` is the difference between a person who asked to stop hearing from us and a mailbox that
 * no longer exists — the first is a compliance record, the second is list hygiene, and removing
 * one is a very different decision from removing the other.
 */
export interface Suppression {
  id: number;
  email: string;
  reason: string | null;
  /** The campaign the suppression came out of, if it came from one. */
  campaign_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SuppressionPage {
  data: Suppression[];
  meta: { page: number; per_page: number; total: number; last_page: number };
}

/** Whether tracking pixels can actually be reached from the internet. */
export interface TrackingHealth {
  ok: boolean;
  url: string | null;
  ephemeral: boolean;
  /** Plain http — some mail clients refuse to load the pixel. */
  insecure?: boolean;
  /** Whether the pixel was actually fetched through `url`, not just whether it is configured. */
  reachable?: boolean;
  status?: number | null;
  checked_at?: string;
  reason: string;
}
