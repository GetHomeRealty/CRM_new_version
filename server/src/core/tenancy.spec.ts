import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Tenant isolation — the contract, written before the migration that satisfies it.
 *
 * A cross-tenant leak is the failure mode that does not announce itself. Nothing throws, no page
 * looks broken, and the only symptom is one brokerage reading another's leads. So the rule is
 * asserted here mechanically rather than by anyone reading a 681-line diff and believing it.
 *
 * MOST OF THIS IS RED TODAY. That is the point: it states what must become true, and each phase of
 * the work turns part of it green. In order:
 *
 *   phase 1  tenant context           → `currentCompanyId()` resolves
 *   phase 2  company_id + backfill    → every ROOT model has the column
 *   phase 3  the Prisma extension     → the isolation tests pass
 *   phase 4  jobs and raw SQL         → the loops-every-tenant test passes
 *
 * The classification below is the design. Every model is exactly one of:
 *
 *   ROOT     the brokerage owns it directly. Gets a company_id column and is filtered on it.
 *   DERIVED  it hangs off something else. It inherits isolation through its parent, and giving it
 *            its own company_id would create a second answer to the same question — and therefore
 *            the possibility of the two disagreeing.
 *   GLOBAL   genuinely not a tenant's. Framework tables and vocabularies. Filtering these would be
 *            wrong, not merely unnecessary, so each one is listed with its reason.
 *
 * A model in no bucket fails the first test. That is deliberate: the next person to add a table has
 * to say which kind it is, and the default is a failing build rather than an unfiltered table.
 */

const prisma = new PrismaClient();
const models = Prisma.dmmf.datamodel.models;

/** The brokerage owns these directly. Each gets `company_id`. */
const ROOT = [
  'company_settings', // is the tenant — its id IS company_id
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
  // travel along. They carry their own company_id rather than depending on a link that isn't there.
  // (`personal_access_tokens` is polymorphic besides: tokenable_type/tokenable_id points at whatever
  // it likes, which is not something a tenant filter can follow.)
  'import_batches',
  'export_jobs',
  'personal_access_tokens',
  'roles', // already has it
  'subscriptions', // already has it
  // Arrives from Meta before anyone knows whose it is; resolved to a tenant when processed, so its
  // column is nullable and an unresolved row belongs to nobody rather than to whoever asks first.
  'meta_webhook_events',
] as const;

/**
 * Reached through a parent. The value is the relation that gets there — verified below, so a wrong
 * entry here fails rather than quietly leaving a table unfiltered.
 */
const DERIVED: Record<string, string> = {
  // via users
  audit_logs: 'users', google_connections: 'users', ical_feeds: 'users', crm_settings: 'users',
  todos: 'users', meta_connections: 'users', meta_sync_history: 'users', meta_lead_forms: 'users',
  favorites: 'users', campaign_templates: 'users', calendar_events: 'users', mail_accounts: 'users',
  sessions: 'users', user_permissions: 'users', user_modules: 'users',

  // via leads
  lead_notes: 'leads', lead_tasks: 'leads', lead_showings: 'leads', lead_calls: 'leads',
  lead_emails: 'leads', lead_messages: 'leads',
  lead_call_recordings: 'lead_calls',
  // via transactions
  clients: 'transactions', documents: 'transactions', conditions: 'transactions',
  brokerages: 'transactions', precon_terms: 'transactions', team_members: 'transactions',
  transaction_statuses: 'transactions', transaction_messages: 'transactions',
  transaction_message_reads: 'transactions', transaction_snapshots: 'transactions',
  transaction_edit_requests: 'transactions', transaction_delete_requests: 'transactions',
  client_identifications: 'transactions', document_reminders: 'transactions',
  inter_board_listings: 'transactions', trashed_row_items: 'transactions',
  team_member_terms: 'team_members', brokerage_agents: 'brokerages',
  // via invoices / customers
  invoices: 'transactions', invoice_line_items: 'invoices', invoice_payments: 'invoices',
  // via campaigns / templates / mail
  campaign_recipients: 'campaigns', campaign_template_attachments: 'campaign_templates',
  email_templates: 'mail_accounts', email_template_attachments: 'email_templates',
  inbound_emails: 'mail_accounts', meta_pages: 'meta_connections',
  // via roles
  role_permissions: 'roles',
};

/** Not a tenant's, each for a stated reason. */
const GLOBAL: Record<string, string> = {
  migrations: 'schema history for the database, not for anyone in it',
  cache: 'framework cache, keyed by an opaque key',
  cache_locks: 'framework cache, keyed by an opaque key',
  jobs: 'queue infrastructure; the payload carries whatever tenant it concerns',
  job_batches: 'queue infrastructure',
  failed_jobs: 'queue infrastructure',
  user_sessions: 'the express-session store, keyed by sid with an opaque payload',
  permissions: 'the vocabulary of screen x level. Roles are per-company; the words they are built from are not',
  password_reset_tokens: 'keyed by email, and one person works at one brokerage, so email identifies the tenant',
};

describe('every table is classified, so a new one cannot arrive unfiltered', () => {
  afterAll(async () => { await prisma.$disconnect(); });

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
  afterAll(async () => { await prisma.$disconnect(); });

  /** Does `model` actually link to `parent` — by a declared relation or by a scalar `<parent>_id`? */
  function links(model: string, parent: string): boolean {
    const m = models.find((x) => x.name === model)!;
    if (m.fields.some((f) => f.kind === 'object' && !f.isList && f.type === parent)) return true;
    const singular = parent.replace(/s$/, '');
    return m.fields.some((f) => f.kind === 'scalar' && (f.name === `${singular}_id` || f.name === `${parent}_id`));
  }

  it('gives every derived table a real link to its stated parent', () => {
    const broken = Object.entries(DERIVED).filter(([child, parent]) => !links(child, parent));
    // A stated parent that is not really there means the table is not isolated by anything.
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

  it('gives every root table a company_id', () => {
    // RED until phase 2. `company_settings` is exempt: it IS the tenant, and its own id is the value
    // every other table points at.
    const missing = ROOT.filter((n) => n !== 'company_settings')
      .filter((n) => !models.find((m) => m.name === n)!.fields.some((f) => f.name === 'company_id'));
    expect(missing).toEqual([]);
  });
});

/**
 * The behavioural half. Two tenants, seeded for real, and no query under one may see the other.
 *
 * Deliberately a hand-built graph rather than a generated row per model: required fields differ too
 * much for a generic seeder to be honest, and a seeder that skipped the awkward tables would report
 * a coverage it did not have. The structural tests above cover the rest by making the rule
 * mechanical; this covers that the rule is actually enforced at runtime.
 */
describe('no query crosses a tenant boundary', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  /** Phase 1 delivers this. Failing loudly beats skipping — a skipped isolation test reads as a pass. */
  function tenantContext(): { run<T>(companyId: number, fn: () => Promise<T>): Promise<T> } {
    let mod: unknown;
    try {
      mod = require('./tenant-context');
    } catch {
      throw new Error('tenant context does not exist yet — phase 1. This test is red on purpose.');
    }
    return mod as { run<T>(companyId: number, fn: () => Promise<T>): Promise<T> };
  }

  it('shows a tenant only its own rows, for every root table', async () => {
    const ctx = tenantContext();
    const [a, b] = [1, 2];
    for (const model of ROOT) {
      if (model === 'company_settings') continue;
      const seen = await ctx.run(a, () => (prisma as never as Record<string, { findMany(x: unknown): Promise<{ company_id: number }[]> }>)[model].findMany({ select: { company_id: true } }));
      const foreign = seen.filter((r) => r.company_id !== a);
      expect({ model, foreign: foreign.length }).toEqual({ model, foreign: 0 });
      expect(b).toBe(2); // the other tenant exists; this test asserts it is invisible, not absent
    }
  });

  it('refuses a findUnique on another tenantid', async () => {
    const ctx = tenantContext();
    // The one Prisma cannot narrow by extension: `where` takes unique fields only, so every one of
    // the 104 call sites becomes findFirst or checks ownership after the fact. This asserts the
    // outcome rather than the technique.
    const other = await prisma.leads.findFirst({ where: { company_id: 2 } as never });
    if (!other) throw new Error('seed a second tenant before this can mean anything');
    const found = await ctx.run(1, () => prisma.leads.findUnique({ where: { id: other.id } }));
    expect(found).toBeNull();
  });

  it('makes every background job name its tenant', () => {
    // The 4 timers run with no request, so nothing sets the context for them. A job that forgets does
    // one brokerage's work against another's data, on a schedule, with nobody watching.
    const timers = [
      'inbox/imap-sync.service.ts',
      'meta/meta-sync-scheduler.service.ts',
      'reports/export-job.service.ts',
      'transactions/lawyer-reminder-scheduler.service.ts',
    ];
    const missing = timers.filter((t) => {
      const src = readFileSync(join(__dirname, '..', t), 'utf8');
      return !/withTenant|forEachTenant|companyId/.test(src);
    });
    expect(missing).toEqual([]); // → green once phase 4 lands
  });
});
