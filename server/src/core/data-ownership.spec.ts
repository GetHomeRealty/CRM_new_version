import { Prisma } from '@prisma/client';

/**
 * The data-ownership map: what every table hangs off, asserted mechanically.
 *
 * WHY THIS SURVIVED THE REMOVAL OF TENANCY. This classification was written as part of the
 * multi-brokerage work and most of that file went with it — the isolation assertions, the
 * two-brokerage seeding, the per-root column check. What is kept here is the part that
 * was never about tenancy at all: a statement of which table is reached through which, verified
 * against the schema.
 *
 * It still earns its place for three reasons, none of them tenant-related:
 *
 *   OWNERSHIP AND PRIVACY. Agent-to-agent isolation is enforced by owner predicates and by
 *     `ResourceAccessService`, and both reason along exactly these edges — a lead note is private
 *     because the LEAD is. A derived table whose stated parent does not exist is a table nobody is
 *     checking the owner of.
 *   CASCADE BEHAVIOUR. Deleting a transaction is expected to take its clients, conditions and
 *     documents with it. That expectation is this graph.
 *   A FAILING BUILD IS THE DEFAULT. A model in no bucket fails the first test, so the next person to
 *     add a table has to say what owns it rather than leaving the question open.
 *
 * Every model is exactly one of:
 *
 *   ROOT     the brokerage owns it directly; nothing above it to inherit from.
 *   DERIVED  it hangs off something else. The value is the relation that gets there.
 *   GLOBAL   belongs to nobody — framework tables and shared vocabularies, each with its reason.
 */

const models = Prisma.dmmf.datamodel.models;

/** The brokerage owns these directly — nothing above them to inherit ownership from. */
const ROOT = [
  'company_settings',
  'users',
  'leads',
  'transactions',
  'customers',
  'campaigns',
  'agents',
  'marketing_inventory',
  'lead_tags',
  'crm_email_settings',
  'crm_referral_codes',
  'crm_email_log',
  'crm_broadcasts',
  'email_suppressions',
  // These three look like they belong to a user — uploaded_by_id, requested_by_id, tokenable_id —
  // but the columns are bare integers with no foreign key, so there is no relation for isolation to
  // travel along. They are owned directly rather than through a link that isn't there.
  // (`personal_access_tokens` is polymorphic besides: tokenable_type/tokenable_id points at whatever
  // it likes, which is not something an ownership rule can follow.)
  'import_batches',
  'export_jobs',
  // Same shape as export_jobs: requested_by_id is a bare integer with no foreign key, so there is
  // no relation for isolation to travel along. It also outlives the request that created it — the
  // work runs on a queue — so ownership has to be recorded on the row rather than inferred from
  // whoever happens to be asking later.
  'lead_import_jobs',
  'personal_access_tokens',
  'roles',
  'subscriptions',
  // Arrives from Meta before anyone knows whose it is, and is resolved to an owner when processed.
  // An unresolved row belongs to nobody rather than to whoever asks first.
  'meta_webhook_events',
  // Whether a ROLE must hold a second factor. The brokerage sets this for its own staff, and it is
  // reached as "the brokerage's policy", never through any one person — so it is owned directly
  // rather than deriving an owner.
  'mfa_policies',
] as const;

/**
 * Reached through a parent. The value is the relation that gets there — verified below, so a wrong
 * entry here fails rather than quietly leaving a table unfiltered.
 */
const DERIVED: Record<string, string> = {
  // via users
  audit_logs: 'users', google_connections: 'users', ical_feeds: 'users', crm_settings: 'users',
  // One row per person, holding which CRM emails that person may send. Derived via `users` for the
  // same reason `crm_settings` is: the brokerage does not own the row, the person does — reached
  // only as "this user's triggers", never as "the brokerage's triggers".
  crm_trigger_settings: 'users',
  todos: 'users', meta_connections: 'users', meta_sync_history: 'users', meta_lead_forms: 'users',
  favorites: 'users', campaign_templates: 'users', calendar_events: 'users', mail_accounts: 'users',
  sessions: 'users', user_permissions: 'users', user_modules: 'users',
  // A browser belongs to the person who subscribed it, and is reached no other way.
  push_subscriptions: 'users',
  notification_preferences: 'users',
  // In-app notifications the dispatcher delivers. One person's, reached no other way.
  notifications: 'users',
  // What the dispatcher has already handled, per recipient, occurrence and channel. Derived from
  // the recipient for the same reason `notifications` is: every row names one person, and nobody
  // else has any business reading it. Cascades with the user, so a deleted account takes its
  // delivery history with it.
  notification_deliveries: 'users',
  /*
   * Two-factor authentication. Every one of these belongs to a person, not to the brokerage: a
   * factor is enrolled by its owner, a recovery code redeemed by its owner, a device trusted by its
   * owner, a challenge answered by its owner. None is ever reached as "the brokerage's".
   *
   * They are also read during the login challenge, BEFORE the caller is signed in, so none of them
   * may depend on an authenticated session — each is bounded by `user_id` instead.
   */
  user_mfa_methods: 'users',
  mfa_recovery_codes: 'users',
  mfa_trusted_devices: 'users',
  mfa_challenges: 'users',

  // via leads
  lead_notes: 'leads', lead_tasks: 'leads', lead_showings: 'leads', lead_calls: 'leads',
  lead_emails: 'leads', lead_messages: 'leads',
  lead_call_recordings: 'lead_calls',
  // via transactions
  clients: 'transactions', documents: 'transactions', conditions: 'transactions',
  brokerages: 'transactions', precon_terms: 'transactions', team_members: 'transactions',
  transaction_statuses: 'transactions', transaction_messages: 'transactions',
  transaction_message_reads: 'transactions', transaction_snapshots: 'transactions',
  transaction_reviews: 'transactions',
  transaction_reminders: 'transactions',
  // Appointment reminders hang off the event they remind you about, which hangs off its user.
  calendar_event_reminders: 'calendar_events',
  transaction_review_messages: 'transaction_reviews',
  transaction_review_attachments: 'transaction_review_messages',
  transaction_edit_requests: 'transactions', transaction_delete_requests: 'transactions',
  client_identifications: 'transactions', document_reminders: 'transactions',
  inter_board_listings: 'transactions', trashed_row_items: 'transactions',
  team_member_terms: 'team_members', brokerage_agents: 'brokerages',
  // via invoices / customers
  invoices: 'transactions', invoice_line_items: 'invoices', invoice_payments: 'invoices',
  // via campaigns / templates / mail
  campaign_recipients: 'campaigns', campaign_template_attachments: 'campaign_templates',
  // Click tracking: the link belongs to the campaign it appeared in, and a click to both the
  // campaign and the recipient. Reached only through the campaign, so isolation travels that way.
  campaign_links: 'campaigns', campaign_clicks: 'campaigns',
  email_templates: 'mail_accounts', email_template_attachments: 'email_templates',
  inbound_emails: 'mail_accounts', meta_pages: 'meta_connections',
  /*
   * The writable mailbox, added with the Transaction Desk Inbox.
   *
   * All three hang off `mail_accounts`, which is the right parent for the same reason
   * `inbound_emails` does: the ACCOUNT is what carries both the owner and the area (`scope`), so a
   * draft, a sent message and an attachment inherit "whose, and which side of the product" from the
   * mailbox they belong to rather than restating it.
   */
  inbound_email_attachments: 'inbound_emails',
  outbound_emails: 'mail_accounts',
  outbound_email_attachments: 'outbound_emails',
  // via roles
  role_permissions: 'roles',
};

/** Owned by nobody, each for a stated reason. */
const GLOBAL: Record<string, string> = {
  migrations: 'schema history for the database, not for anyone in it',
  cache: 'framework cache, keyed by an opaque key',
  cache_locks: 'framework cache, keyed by an opaque key',
  jobs: 'queue infrastructure; the payload carries whatever work it concerns',
  job_batches: 'queue infrastructure',
  failed_jobs: 'queue infrastructure',
  user_sessions: 'the express-session store, keyed by sid with an opaque payload',
  permissions: 'the vocabulary of screen x level. Roles are per-company; the words they are built from are not',
  password_reset_tokens: 'keyed by email, which identifies the account on its own',
  meta_api_budget:
    'Graph calls spent per time window. The thing being rationed is one Meta APP allowance shared by '
    + 'everybody, so the counter has to be shared too — scoping it per user would hand each agent a '
    + 'full budget against a ceiling they collectively share, which is the opposite of what it is '
    + 'for. No personal data: a window and an integer',
  meta_oauth_nonces:
    'redeemed OAuth state nonces, keyed by a random string with no payload. The owner is carried by '
    + 'the signed state itself, which names the user; this table only answers "has this nonce been '
    + 'used before?", and that answer must be the same for everybody — scoping it per user would '
    + 'let the same nonce be redeemed once per account, which is the replay it exists to stop',
};
describe('every table is classified, so a new one cannot arrive unowned', () => {
  it('puts each model in exactly one bucket', () => {
    const unclassified: string[] = [];
    const twice: string[] = [];
    for (const m of models) {
      const n = [ROOT.includes(m.name as never), m.name in DERIVED, m.name in GLOBAL].filter(Boolean).length;
      if (n === 0) unclassified.push(m.name);
      if (n > 1) twice.push(m.name);
    }
    // If this fails for a table you just added: decide whether the brokerage owns it (ROOT), it hangs
    // off something the brokerage owns (DERIVED), or it belongs to nobody (GLOBAL, with a reason).
    expect({ unclassified, twice }).toEqual({ unclassified: [], twice: [] });
  });

  it('names only tables that exist', () => {
    const known = new Set(models.map((m) => m.name));
    const ghosts = [...ROOT, ...Object.keys(DERIVED), ...Object.keys(GLOBAL)].filter((n) => !known.has(n));
    expect(ghosts).toEqual([]);
  });
});

describe('the classification itself holds up', () => {
  /** Does `model` actually link to `parent` — by a declared relation or by a scalar `<parent>_id`? */
  function links(model: string, parent: string): boolean {
    const m = models.find((x) => x.name === model)!;
    if (m.fields.some((f) => f.kind === 'object' && !f.isList && f.type === parent)) return true;
    const singular = parent.replace(/s$/, '');
    return m.fields.some((f) => f.kind === 'scalar' && (f.name === `${singular}_id` || f.name === `${parent}_id`));
  }

  it('gives every derived table a real link to its stated parent', () => {
    const broken = Object.entries(DERIVED).filter(([child, parent]) => !links(child, parent));
    // A stated parent that is not really there means nothing is checking who owns the table.
    expect(broken.map(([c, p]) => `${c} -> ${p}`)).toEqual([]);
  });

  it('lands every derived chain on a root', () => {
    const stranded: string[] = [];
    for (const start of Object.keys(DERIVED)) {
      let at: string | undefined = start;
      const path = new Set<string>();
      while (at && at in DERIVED) {
        if (path.has(at)) break; // a cycle reaches no root
        path.add(at);
        at = DERIVED[at];
      }
      if (!at || !ROOT.includes(at as never)) stranded.push(start);
    }
    expect(stranded).toEqual([]);
  });
});
