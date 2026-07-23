/** Campaign types (mirror the server's campaign module). */

export interface CampaignStats {
  total: number; sent: number; failed: number;
  opened: number; unsubscribed: number; bounced: number;
}

export interface CampaignSummary {
  id: number;
  name: string;
  template_id: number | null;
  template_name: string | null;
  category: string | null;
  status: 'draft' | 'sending' | 'completed' | 'failed';
  tags: string[];
  stats: CampaignStats;
  created_by: string | null;
  created_at: string | null;
  sent_at: string | null;
}

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
