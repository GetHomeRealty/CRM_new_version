/** Leads module types. Mirrors the shapes returned by `server/src/leads`. */

export interface LeadPropertyPreferences {
  budget?: { min?: number | null; max?: number | null };
  /**
   * Several may be chosen at once. Values outside the standard vocabulary are the ones typed in
   * under "Custom" — they are stored verbatim, so a preference the brokerage has no word for
   * still survives.
   */
  propertyType?: string[];
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
  yearBuilt?: number | null;
  lotSize?: string;
  parking?: number | null;
  locations?: string[];
  features?: string[];
}

/** Where an imported Meta lead came from. Null on every manually created lead. */
export interface LeadMetaAttribution {
  page_id: string | null;
  page_name: string | null;
  form_id: string | null;
  form_name: string | null;
  lead_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  submitted_at: string | null;
  imported_at: string | null;
  message: string | null;
  budget: string | null;
  timeline: string | null;
  property_type: string | null;
}

export interface Lead {
  id: number;
  name: string;
  /** manual | import | facebook_meta */
  source: string | null;
  first_name: string | null;
  last_name: string | null;
  facebook_lead_id: string | null;
  meta: LeadMetaAttribution | null;
  email: string;
  phone: string | null;
  location: string | null;
  property: string | null;
  lead_status: string | null;
  lead_type: string | null;
  lead_source: string | null;
  lead_response: string | null;
  client_type: string | null;
  lead_conversion: string | null;
  tags: string[];
  gender: string | null;
  language: string | null;
  religion: string | null;
  age: number | null;
  date_of_birth: string | null;
  marriage_day: string | null;
  notes: string | null;
  /**
   * A lead may keep several sets — a home to live in and a property to let, say. Always a list
   * from the API; a legacy single object is wrapped server-side. Null when none were recorded.
   */
  property_preferences: LeadPropertyPreferences[] | null;
  property_address: string | null;
  property_price: string | null;
  bedrooms: string | null;
  bathrooms: string | null;
  square_footage: string | null;
  key_features: string | null;
  unsubscribed: boolean;
  assigned_to: number | null;
  assigned_to_name: string | null;
  /**
   * The user who created the lead. When an agent is working a lead they did not create, the
   * brokerage owns its identity — email, phone, source and assignment are locked, and it cannot
   * be deleted. Compare to the signed-in user id to decide. The server enforces this regardless.
   */
  owner_user_id: number | null;
  /**
   * Whether THIS user may delete THIS lead, decided by the server rule that will refuse it.
   *
   * Sent because the screen kept getting it wrong on its own: it hid Delete only when a lead had an
   * owner who was somebody else, while `remove()` refuses whenever the agent is not the owner - and
   * with every lead here owned by nobody, the two never agreed. Optional so an older response, or a
   * surface that does not send it, keeps the button rather than silently losing it.
   */
  can_delete?: boolean;
  call_count: number;
  task_count: number;
  pending_task_count: number;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface LeadNote {
  id: number;
  content: string;
  pinned: boolean;
  created_by: string | null;
  created_at: string | null;
}

export interface LeadTask {
  id: number;
  title: string;
  due_date: string;
  description: string | null;
  status: string;
  priority: string;
  assigned_to: number | null;
  assigned_to_name?: string | null;
  created_by: string | null;
  created_at: string | null;
}

/** A lead task with the lead it belongs to, as the Dashboard lists them across all leads. */
export interface LeadTaskRow extends LeadTask {
  lead_id: number;
  lead_name: string;
}

export interface LeadShowing {
  id: number;
  showing_date: string;
  time: string;
  property: string | null;
  notes: string | null;
  status: string;
  created_by: string | null;
  created_at: string | null;
}

/** A showing with its owning lead, for the cross-lead Dashboard panel. */
export interface LeadShowingRow extends LeadShowing {
  lead_id: number;
  lead_name: string;
}

/**
 * Metadata for an audio recording attached to a call. The audio itself is never in a lead
 * payload — it is streamed from `/api/leads/:id/calls/:callId/recording`.
 */
export interface LeadCallRecording {
  id: number;
  filename: string;
  content_type: string;
  size: number;
}

export interface LeadCall {
  id: number;
  called_at: string;
  duration: number | null;
  outcome: string | null;
  notes: string | null;
  created_by: string | null;
  /** Twilio Call SID + live status when placed via click-to-call; null for manually logged calls. */
  provider_sid?: string | null;
  status?: string | null;
  recording?: LeadCallRecording | null;
}

/**
 * One SMS in the conversation with a lead. The app has no SMS gateway, so `outbound` means the
 * agent handed the text to their own phone and logged it here; `inbound` is a reply they typed in.
 */
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/** Whether the server can send SMS for real, and from what. Never carries credentials. */
export interface SmsGatewayStatus {
  configured: boolean;
  /** Whether outbound voice calling (click-to-call) is possible — needs a real From number. */
  voice: boolean;
  from: string | null;
  callback_url: string | null;
}

export interface LeadMessage {
  id: number;
  direction: 'outbound' | 'inbound';
  /**
   * Outbound only; null on a received message. Filled from the gateway's delivery callback when
   * one is connected, otherwise recorded by the agent. `read` is always manual — plain SMS has
   * no read receipt from any provider.
   */
  status: MessageStatus | null;
  /** Why a send failed, in words. Only ever set on a `failed` message. */
  error_code: string | null;
  error_message: string | null;
  body: string;
  phone: string | null;
  sent_at: string;
  created_by: string | null;
}

/** A one-off email sent to this lead from their own page — not a campaign send. */
export interface LeadEmail {
  id: number;
  recipient: string;
  subject: string;
  body: string;
  status: 'sent' | 'failed';
  error: string | null;
  sent_by: string | null;
  sent_at: string;
}

/** A single lead with its full activity history. */
export interface LeadDetail extends Lead {
  emails: LeadEmail[];
  notes_history: LeadNote[];
  tasks: LeadTask[];
  showings: LeadShowing[];
  calls: LeadCall[];
  messages: LeadMessage[];
}

export interface LeadStats {
  total: number;
  noCalls: number;
  recent: number;
  byStatus: { hot: number; warm: number; cold: number; mild: number; closed: number };
  /** Lead counts by source for the Dashboard. `other` absorbs everything not broken out. */
  bySource: { google: number; meta: number; website: number; referral: number; other: number };
}

export interface LeadListResponse {
  data: Lead[];
  meta: { current_page: number; per_page: number; last_page: number; total: number };
  stats: LeadStats;
}

/** Every filter the list endpoint understands. Empty strings mean "no filter". */
export interface LeadFilters {
  search: string;
  leadStatus: string;
  leadType: string;
  leadSource: string;
  leadResponse: string;
  clientType: string;
  leadConversion: string;
  tag: string;
  gender: string;
  language: string;
  religion: string;
  minAge: string;
  maxAge: string;
  assignedTo: string;
  recent: string;
  /**
   * 'true' narrows to leads with no logged call.
   *
   * The No Calls tile counted these and then filtered nothing - it cleared the Recent filter and
   * raised a toast, so the list showed everybody while the message named a smaller number.
   */
  noCalls: string;
}

export interface LeadOptions {
  lead_status: string[];
  lead_type: string[];
  lead_source: string[];
  lead_response: string[];
  client_type: string[];
  lead_conversion: string[];
  genders: string[];
  languages: string[];
  religions: string[];
  property_types: string[];
  task_status: string[];
  task_priority: string[];
  showing_status: string[];
  call_outcome: string[];
  none_filter_value: string;
  recent_days: number;
  users: { id: number; name: string; role: string }[];
}

export interface DeletedLead {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  location: string | null;
  lead_status: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface LeadTagCounts {
  tags: string[];
  counts: { name: string; count: number }[];
}

export interface LeadImportResult {
  imported: number;
  tagged: number;
  duplicate: number;
  invalid: number;
  tag: string | null;
  message: string;
}
