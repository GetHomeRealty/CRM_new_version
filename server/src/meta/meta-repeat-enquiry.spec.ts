import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MetaApiBudgetService } from './meta-api-budget.service';
import { MetaConnectionService } from './meta-connection.service';
import { MetaSyncService } from './meta-sync.service';
import type { GraphLead } from './meta-graph.service';
import { LeadAuditService } from '../leads/lead-audit.service';

/**
 * A PERSON ALREADY ON THE BOOKS ENQUIRES AGAIN.
 *
 * WHAT WAS REPORTED. Someone assigned to an agent submitted a second Meta enquiry about a different
 * property. It appeared as a NEW, unassigned lead, and the agent holding the first was told nothing.
 *
 * TWO INDEPENDENT CAUSES, which is why the fix has two halves:
 *
 *   THE MATCH MISSED. `findExisting` compares a phone only against `leads.phone_normalized`, a
 *   DERIVED column. The CSV importer creates leads without it — `lead-import.engine.ts` has four
 *   `create` calls and no `normalizePhone` — so an IMPORTED lead carries a phone and a null
 *   normalised form, and a phone-only repeat enquiry matched nothing at all.
 *
 *   THE NOTICE WAS SUPPRESSED BY DESIGN. Deduplication returned before `metaArrived` on the
 *   documented reasoning that "an existing lead being updated is not a new lead arriving". True of
 *   the same submission arriving twice; false of a different submission from the same person.
 *
 * WHAT IS DELIBERATELY NOT CHANGED, and asserted below: matching inside the importer's own book,
 * agent-owned connections' book restrictions, and every protected field on a matched lead.
 *
 * Against the test database, each case in a transaction that is rolled back.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

type U = { id: number; name: string; role: string };

async function makeUser(db: PrismaService, role: string, label: string): Promise<U> {
  const now = new Date();
  const t = tag();
  return db.users.create({
    data: { name: `ZZ Rep ${label} ${t}`, email: `zz-rep-${label}-${t}@probe.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
    select: { id: true, name: true, role: true },
  }) as Promise<U>;
}

/** Every notification this sync would raise, instead of sending one. */
interface Sent { event: string; leadId: number; recipient: number | null | undefined; metaId: string }

function syncService(db: PrismaService, sent: Sent[]) {
  return new MetaSyncService(
    db,
    new MetaConnectionService(db, { fetchPages: async () => [] } as never),
    {} as never,
    new LeadAuditService(db),
    { notifyNewLead: async () => {} } as never,
    new MetaApiBudgetService(db),
    { reconnectRequired: async () => {} } as never,
    {
      /*
       * MIRRORS THE REAL DISPATCHER'S CLAIM, which matters to what these tests prove.
       * `NotificationDispatcherService` writes a `notification_deliveries` row per
       * (recipient, category, occurrence, channel) BEFORE it does anything, and that row is the
       * dedupe. `MetaSyncService` reads it to decide whether anybody has been told yet, so a mock
       * that only records the call would make every retry look like a lost notification and
       * recovery would fire for ever. Writing the claim here is what makes the harness faithful.
       */
      metaRepeatEnquiry: async (lead: { id: number }, recipient: number | null | undefined, metaId: string) => {
        sent.push({ event: 'repeat', leadId: lead.id, recipient, metaId });
        if (!recipient) return;
        const now = new Date();
        await db.notification_deliveries.createMany({
          data: [{
            user_id: recipient,
            category: 'lead_meta',
            dedupe_key: `meta-repeat:${metaId}:${recipient}`,
            channel: 'in_app',
            status: 'sent',
            created_at: now,
            updated_at: now,
          }],
          skipDuplicates: true,
        });
      },
      metaLeadArrived: async (lead: { id: number }, recipient: number | null | undefined, metaId: string) => {
        sent.push({ event: 'arrived', leadId: lead.id, recipient, metaId });
      },
    } as never,
  );
}

/** A submission carrying a phone and, optionally, an email. */
function submission(id: string, opts: { email?: string; phone?: string; property?: string }, at: Date): GraphLead {
  return {
    id,
    created_time: at.toISOString(),
    field_data: [
      { name: 'full_name', values: ['Priya Raman'] },
      ...(opts.email ? [{ name: 'email', values: [opts.email] }] : []),
      ...(opts.phone ? [{ name: 'phone_number', values: [opts.phone] }] : []),
      ...(opts.property ? [{ name: 'property', values: [opts.property] }] : []),
    ],
  } as GraphLead;
}

const ctxFor = (user: U, ownerId: number | null, form = 'Brampton Homes') => ({
  userId: user.id, userName: user.name, pageId: 'page-ghr', pageName: 'Get Home Realty',
  formId: `form-${form.replace(/\W+/g, '-').toLowerCase()}`, formName: form, ownerId,
});

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 15, 0, 0));
const inquiriesOf = (db: PrismaService, leadId: number) =>
  db.meta_lead_inquiries.findMany({ where: { lead_id: leadId }, orderBy: { id: 'asc' } });

/**
 * A lead created the way the CSV importer creates one: a phone, and NO `phone_normalized`.
 *
 * Written through the client rather than through `LeadsService`, deliberately — that service
 * normalises the phone, which is exactly the step the importer skips and this test is about.
 */
async function importedLead(db: PrismaService, over: Record<string, unknown> = {}) {
  const now = new Date();
  const t = tag();
  return db.leads.create({
    data: {
      name: 'Priya Raman',
      email: `priya-${t}@probe.test`,
      phone: '(416) 555-0199',
      phone_normalized: null,          // the importer's omission, which is the defect
      source: 'csv_import',
      lead_source: 'import',
      lead_status: 'New',
      owner_user_id: null,             // a BROKERAGE lead
      created_at: now,
      updated_at: now,
      ...over,
    },
  });
}

// =====================================================================================
describe('a brokerage lead from another source is found by a repeat enquiry', () => {
  it('FINDS AN IMPORTED LEAD BY PHONE, where the normalised column is null', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const agent = await makeUser(tx, 'agent', 'ag');
      const lead = await importedLead(tx, { assigned_to: agent.id });
      const sent: Sent[] = [];

      // The same number as the lead, written the way a Meta form would deliver it.
      const r = await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { phone: '+1 416-555-0199', property: '77 Queen St, Brampton' }, day(3)),
        ctxFor(admin, null),
      );

      // Attached to the EXISTING lead; no second lead created.
      expect(r.leadId).toBe(lead.id);
      expect(r.outcome).toBe('duplicate');
      const qs = await inquiriesOf(tx, lead.id);
      expect(qs).toHaveLength(1);
      expect(qs[0].property_address).toBe('77 Queen St, Brampton');
    });
  }, 60000);

  it('NOTIFIES THE ASSIGNED AGENT, not the administrator whose connection delivered it', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const agent = await makeUser(tx, 'agent', 'ag');
      const lead = await importedLead(tx, { assigned_to: agent.id });
      const sent: Sent[] = [];

      await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { phone: '416 555 0199' }, day(3)),
        ctxFor(admin, null),
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].event).toBe('repeat');
      expect(sent[0].leadId).toBe(lead.id);
      expect(sent[0].recipient).toBe(agent.id);
    });
  }, 60000);

  it('PRESERVES EVERY PROTECTED FIELD — assignee, owner, status, source and contact details', async () => {
    /*
     * The fallback attaches and writes NOTHING to the lead. A phone-shaped match across books is a
     * weaker claim than an email match inside one, and the lead's details may have been typed by a
     * person. The enquiry row is the record of what arrived.
     */
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const agent = await makeUser(tx, 'agent', 'ag');
      const lead = await importedLead(tx, { assigned_to: agent.id });
      const before = await tx.leads.findUniqueOrThrow({ where: { id: lead.id } });

      await syncService(tx, []).upsertLead(
        submission(`m-${tag()}`, { phone: '4165550199', property: 'Somewhere else' }, day(4)),
        ctxFor(admin, null),
      );

      const after = await tx.leads.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.assigned_to).toBe(agent.id);
      expect(after.owner_user_id).toBe(before.owner_user_id);
      expect(after.team_id).toBe(before.team_id);
      expect(after.lead_status).toBe(before.lead_status);
      expect(after.source).toBe('csv_import');
      expect(after.lead_source).toBe('import');
      expect(after.email).toBe(before.email);
      expect(after.phone).toBe(before.phone);
      // Not even the Meta columns, which the in-book branch does write.
      expect(after.facebook_lead_id).toBe(before.facebook_lead_id);
      expect(after.meta_form_name).toBe(before.meta_form_name);
    });
  }, 60000);
});

// =====================================================================================
describe('retries never produce a second enquiry or a second notice', () => {
  it('THE SAME SUBMISSION TWICE: one enquiry, one notification', async () => {
    /*
     * `facebook_lead_id` is UNIQUE on `meta_lead_inquiries` and the insert is `skipDuplicates`, so
     * `count === 1` identifies the writer that actually inserted. That is what the notice is keyed
     * on — the database, not a timestamp or which path arrived first.
     */
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const agent = await makeUser(tx, 'agent', 'ag');
      const lead = await importedLead(tx, { assigned_to: agent.id });
      const sent: Sent[] = [];
      const sync = syncService(tx, sent);
      const s = submission(`m-${tag()}`, { phone: '4165550199', property: '1 King St' }, day(5));

      await sync.upsertLead(s, ctxFor(admin, null));
      await sync.upsertLead(s, ctxFor(admin, null));
      await sync.upsertLead(s, ctxFor(admin, null));

      expect(await inquiriesOf(tx, lead.id)).toHaveLength(1);
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(1);
    });
  }, 60000);

  it('A DIFFERENT SUBMISSION FROM THE SAME PERSON: a second enquiry and a second notification', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const agent = await makeUser(tx, 'agent', 'ag');
      const lead = await importedLead(tx, { assigned_to: agent.id });
      const sent: Sent[] = [];
      const sync = syncService(tx, sent);

      await sync.upsertLead(submission(`m-${tag()}`, { phone: '4165550199', property: '1 King St' }, day(5)), ctxFor(admin, null));
      await sync.upsertLead(submission(`m-${tag()}`, { phone: '4165550199', property: '2 Queen St' }, day(6)), ctxFor(admin, null));

      const qs = await inquiriesOf(tx, lead.id);
      expect(qs).toHaveLength(2);
      expect(qs.map((q) => q.property_address)).toEqual(['1 King St', '2 Queen St']);
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(2);
    });
  }, 60000);

  it('an in-book match notifies too, once per submission however many passes run', async () => {
    // The same rule on the pre-existing branch: a Meta lead matched by email inside the importer's
    // own book was also silent before this change.
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'ag');
      const sent: Sent[] = [];
      const sync = syncService(tx, sent);
      const email = `priya-${tag()}@probe.test`;

      const first = await sync.upsertLead(submission(`m-${tag()}`, { email, property: 'A' }, day(2)), ctxFor(agent, agent.id));
      expect(first.outcome).toBe('imported');

      await sync.upsertLead(submission(`m-${tag()}`, { email, property: 'B' }, day(3)), ctxFor(agent, agent.id));
      await sync.upsertLead(submission(`m-${tag()}`, { email, property: 'B2' }, day(3)), ctxFor(agent, agent.id));

      expect(await inquiriesOf(tx, first.leadId!)).toHaveLength(3);
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(2);
    });
  }, 60000);
});

// =====================================================================================
describe('the fallback refuses to cross the boundaries it was given', () => {
  it('NEVER TOUCHES AN AGENT-PRIVATE LEAD, even on an exact phone match', async () => {
    /*
     * `ownership_type` is a generated column: once `owner_user_id` is set the lead is PRIVATE, and
     * it is another agent's relationship with the same person. `ownBook` exists to protect that and
     * the fallback searches `owner_user_id IS NULL` only.
     */
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const other = await makeUser(tx, 'agent', 'other');
      const priv = await importedLead(tx, { owner_user_id: other.id, assigned_to: other.id });
      const sent: Sent[] = [];

      const r = await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { phone: '4165550199' }, day(7)),
        ctxFor(admin, null),
      );

      // A new lead, exactly as before this change.
      expect(r.outcome).toBe('imported');
      expect(r.leadId).not.toBe(priv.id);
      expect(await inquiriesOf(tx, priv.id)).toHaveLength(0);
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(0);
    });
  }, 60000);

  it('AN AGENT-OWNED CONNECTION KEEPS ITS BOOK RESTRICTION — no fallback for it', async () => {
    // An agent who connected their own ad account matches their own book and nothing else. The
    // brokerage lead below is not theirs, and the documented rule is that they get a lead of
    // their own: they paid for the click.
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'ag');
      const brokerageLead = await importedLead(tx, { assigned_to: null });
      const sent: Sent[] = [];

      const r = await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { phone: '4165550199' }, day(8)),
        ctxFor(agent, agent.id),            // ownerId = the agent → agent intake
      );

      expect(r.outcome).toBe('imported');
      expect(r.leadId).not.toBe(brokerageLead.id);
      expect(await inquiriesOf(tx, brokerageLead.id)).toHaveLength(0);
    });
  }, 60000);

  it('TWO BROKERAGE LEADS ON ONE NUMBER ARE NOT COMBINED', async () => {
    /*
     * Ambiguity is not resolved by guessing. Picking one would file somebody's enquiry against the
     * wrong person; the existing behaviour — create a lead — stands, and the conflict is recorded
     * as a warning on the sync log, which is where this service already reports a submission it
     * could not place.
     */
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const a = await importedLead(tx);
      const b = await importedLead(tx);     // same phone, a different brokerage lead
      const sent: Sent[] = [];

      const r = await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { phone: '4165550199' }, day(9)),
        ctxFor(admin, null),
      );

      expect(r.outcome).toBe('imported');
      expect([a.id, b.id]).not.toContain(r.leadId);
      expect(await inquiriesOf(tx, a.id)).toHaveLength(0);
      expect(await inquiriesOf(tx, b.id)).toHaveLength(0);
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(0);
    });
  }, 60000);

  it('A PHONE THAT MATCHES NOTHING STILL CREATES A LEAD, exactly as before', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const sent: Sent[] = [];

      const r = await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { email: `nobody-${tag()}@probe.test`, phone: '4169990000' }, day(10)),
        ctxFor(admin, null),
      );

      expect(r.outcome).toBe('imported');
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(0);
    });
  }, 60000);

  it('a near-miss number is not a match — the real rule decides, not the SQL prefilter', async () => {
    /*
     * The prefilter is a suffix test on digits, which is deliberately looser than `normalizePhone`.
     * This is the case that proves the TypeScript confirmation is doing work: a stored number whose
     * digits END with the target but which does not normalise to it.
     */
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      // 12 digits: `normalizePhone` keeps all of them, so it cannot equal the 10-digit target.
      const lead = await importedLead(tx, { phone: '99 4165550199' });
      const sent: Sent[] = [];

      const r = await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { phone: '4165550199' }, day(11)),
        ctxFor(admin, null),
      );

      expect(r.leadId).not.toBe(lead.id);
      expect(await inquiriesOf(tx, lead.id)).toHaveLength(0);
    });
  }, 60000);
});

// =====================================================================================
describe('an ambiguous identity is never resolved by guessing', () => {
  it('EMAIL POINTS AT ONE LEAD AND PHONE AT ANOTHER: the exact email wins, and the clash is logged', async () => {
    /*
     * THE POLICY, NOT AN ACCIDENT: exact email takes precedence; a conflicting phone match is
     * logged. A phone is routinely shared and an email usually is not, so the email is the stronger
     * signal — and refusing here would mean falling through to a create that the email uniqueness
     * constraint rejects, i.e. dropping the enquiry rather than filing it safely.
     *
     * Uniqueness of an address within a book is a storage constraint, not proof of identity, which
     * is why the disagreement is recorded with both lead ids rather than silently resolved.
     */
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'ag');
      const t = tag();
      const sharedEmail = `shared-${t}@probe.test`;

      const a = await importedLead(tx, { email: sharedEmail, phone: '(905) 555-1111', phone_normalized: '9055551111', owner_user_id: agent.id, assigned_to: agent.id });
      const b = await importedLead(tx, { email: `other-${t}@probe.test`, phone: '(416) 555-0199', phone_normalized: '4165550199', owner_user_id: agent.id });

      const warnings: string[] = [];
      const sent: Sent[] = [];
      const sync = syncService(tx, sent);
      (sync as unknown as { log: { warn: (m: string) => void } }).log = { warn: (m: string) => warnings.push(m) };

      const r = await sync.upsertLead(
        submission(`m-${tag()}`, { email: sharedEmail, phone: '416 555 0199', property: '3 Yonge St' }, day(13)),
        ctxFor(agent, agent.id),
      );

      // Attached to the email's lead; the phone's lead is untouched.
      expect(r.leadId).toBe(a.id);
      expect(await inquiriesOf(tx, a.id)).toHaveLength(1);
      expect(await inquiriesOf(tx, b.id)).toHaveLength(0);
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(1);

      // And the clash is on the record, naming both leads and neither identifier.
      const clash = warnings.find((w) => /also matches lead/i.test(w));
      expect(clash).toBeDefined();
      expect(clash).toContain(String(a.id));
      expect(clash).toContain(String(b.id));
      expect(clash).not.toContain(sharedEmail);
      expect(clash).not.toContain('4165550199');
    });
  }, 60000);

  it('TWO LEADS SHARE THE PHONE INSIDE ONE BOOK: neither is attached to', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'ag');
      const a = await importedLead(tx, { phone_normalized: '4165550199', owner_user_id: agent.id });
      const b = await importedLead(tx, { phone_normalized: '4165550199', owner_user_id: agent.id });
      const sent: Sent[] = [];

      const r = await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { phone: '4165550199' }, day(14)),
        ctxFor(agent, agent.id),
      );

      expect([a.id, b.id]).not.toContain(r.leadId);
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(0);
    });
  }, 60000);

  it('THE SAME LEAD ON BOTH IDENTIFIERS IS AGREEMENT, NOT CONFLICT', async () => {
    // The guard against over-reach: one lead carrying both the email and the phone must still be
    // matched, or the conflict check would have broken ordinary repeat enquiries.
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'ag');
      const t = tag();
      const email = `both-${t}@probe.test`;
      const lead = await importedLead(tx, { email, phone_normalized: '4165550199', owner_user_id: agent.id, assigned_to: agent.id });
      const sent: Sent[] = [];

      const r = await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { email, phone: '4165550199', property: '9 Bay St' }, day(15)),
        ctxFor(agent, agent.id),
      );

      expect(r.leadId).toBe(lead.id);
      expect(await inquiriesOf(tx, lead.id)).toHaveLength(1);
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(1);
    });
  }, 60000);

  it('the warning names lead ids and the submission, and quotes neither email nor phone', async () => {
    /*
     * Logs are read by more people than the CRM is, leave the machine, and outlive the lead. The
     * ids resolve the conflict — they open in the CRM — without identifying anybody to a reader who
     * could not already see them.
     */
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'ag');
      const t = tag();
      const email = `pii-${t}@probe.test`;
      // Two leads on ONE phone number and no email match — the conflict that is genuinely refused.
      await importedLead(tx, { email: `pii1-${t}@probe.test`, phone_normalized: '4165550199', owner_user_id: agent.id });
      await importedLead(tx, { email: `pii2-${t}@probe.test`, phone_normalized: '4165550199', owner_user_id: agent.id });

      const warnings: string[] = [];
      const sync = syncService(tx, []);
      (sync as unknown as { log: { warn: (m: string) => void } }).log = { warn: (m: string) => warnings.push(m) };

      await sync.upsertLead(
        submission(`m-${tag()}`, { email, phone: '4165550199' }, day(16)),
        ctxFor(agent, agent.id),
      );
      void email;

      const conflict = warnings.find((w) => /ambiguous/i.test(w));
      expect(conflict).toBeDefined();
      expect(conflict).toMatch(/ids: \d+/);
      expect(conflict).toMatch(/Merge or correct/);
      // The person is not in the message.
      expect(conflict).not.toContain(email);
      expect(conflict).not.toContain('4165550199');
      expect(conflict).not.toContain('9055551111');
    });
  }, 60000);
});

// =====================================================================================
describe('a notification lost after the enquiry was recorded is recovered', () => {
  it('RECOVERS ON THE NEXT PASS, with no second enquiry and no second notice', async () => {
    /*
     * THE DURABILITY CASE. The enquiry row commits, then the notice fails — the dispatcher is
     * unreachable, or the process dies. `count` is 0 for ever after, so a gate on the insert would
     * mean nobody is ever told. The gate is the DELIVERY LEDGER instead: no claim row means the
     * dispatcher was never reached, and the next sync pass tries again.
     *
     * The first pass throws from inside the notifier, which is what a dispatcher failure looks like
     * from here. `repeatEnquiryNotice` swallows it — the enquiry must survive — so the sync itself
     * reports success, exactly as it would in production.
     */
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const agent = await makeUser(tx, 'agent', 'ag');
      const lead = await importedLead(tx, { assigned_to: agent.id });
      const s = submission(`m-${tag()}`, { phone: '4165550199', property: '5 Front St' }, day(17));

      // --- pass one: the enquiry lands, the notification does not.
      const attempted: string[] = [];
      const failing = new MetaSyncService(
        tx,
        new MetaConnectionService(tx, { fetchPages: async () => [] } as never),
        {} as never,
        new LeadAuditService(tx),
        { notifyNewLead: async () => {} } as never,
        new MetaApiBudgetService(tx),
        { reconnectRequired: async () => {} } as never,
        {
          metaRepeatEnquiry: async (_l: unknown, _r: unknown, metaId: string) => {
            attempted.push(metaId);
            throw new Error('dispatcher unavailable');
          },
        } as never,
      );
      await failing.upsertLead(s, ctxFor(admin, null));

      expect(attempted).toHaveLength(1);
      expect(await inquiriesOf(tx, lead.id)).toHaveLength(1);
      // Nothing was claimed, because the dispatcher was never reached.
      expect(await tx.notification_deliveries.count({
        where: { user_id: agent.id, dedupe_key: { startsWith: 'meta-repeat:' } },
      })).toBe(0);

      // --- pass two: the same submission again. The notice recovers; the enquiry does not duplicate.
      const sent: Sent[] = [];
      await syncService(tx, sent).upsertLead(s, ctxFor(admin, null));

      expect(await inquiriesOf(tx, lead.id)).toHaveLength(1);
      const repeats = sent.filter((x) => x.event === 'repeat');
      expect(repeats).toHaveLength(1);
      expect(repeats[0].recipient).toBe(agent.id);
    });
  }, 60000);

  it('DOES NOT RE-ANNOUNCE ONCE THE DISPATCHER HAS A CLAIM, whatever it decided', async () => {
    /*
     * The other half. A claim exists — `pending`, `sent`, `muted`, `failed` — so the dispatcher ran
     * and owns the outcome. Re-announcing on every sync would turn a recovery into a loop, and
     * `muted` in particular is somebody's preference rather than a failure.
     */
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const agent = await makeUser(tx, 'agent', 'ag');
      const lead = await importedLead(tx, { assigned_to: agent.id });
      const metaId = `m-${tag()}`;
      const s = submission(metaId, { phone: '4165550199' }, day(18));
      const now = new Date();

      // The dispatcher decided this one was muted, before any sync pass runs.
      await tx.notification_deliveries.create({
        data: {
          user_id: agent.id, category: 'lead_meta',
          dedupe_key: `meta-repeat:${metaId}:${agent.id}`,
          channel: 'in_app', status: 'muted', created_at: now, updated_at: now,
        },
      });

      const sent: Sent[] = [];
      await syncService(tx, sent).upsertLead(s, ctxFor(admin, null));

      expect(await inquiriesOf(tx, lead.id)).toHaveLength(1);
      expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(0);
    });
  }, 60000);
});

// =====================================================================================
describe('recovery is bounded by the notification retention window', () => {
  /*
   * WHY A BOUND IS NEEDED. The ledger check reads "no claim row" as "the dispatcher was never
   * reached". `NotificationRetentionService` purges `notification_deliveries` by age and `lead_meta`
   * has no `STILL_LIVE` guard, so an old claim is eventually deleted — at which point an old
   * submission re-synced would look un-notified and the notice would be raised again. The bound is
   * the ENQUIRY ROW's persisted `created_at`, because the row is the thing whose notification may
   * have been purged.
   */
  const withRetentionMonths = async (months: string | undefined, fn: () => Promise<void>) => {
    const before = process.env.NOTIFICATION_RETENTION_MONTHS;
    if (months === undefined) delete process.env.NOTIFICATION_RETENTION_MONTHS;
    else process.env.NOTIFICATION_RETENTION_MONTHS = months;
    try { await fn(); } finally {
      if (before === undefined) delete process.env.NOTIFICATION_RETENTION_MONTHS;
      else process.env.NOTIFICATION_RETENTION_MONTHS = before;
    }
  };

  it('A RECENT ENQUIRY STILL RECOVERS — the bound does not break the common case', async () => {
    await inRollback(async (tx) => {
      await withRetentionMonths('12', async () => {
        const admin = await makeUser(tx, 'admin', 'adm');
        const agent = await makeUser(tx, 'agent', 'ag');
        const lead = await importedLead(tx, { assigned_to: agent.id });
        const metaId = `m-${tag()}`;
        const s2 = submission(metaId, { phone: '4165550199', property: '5 Front St' }, day(19));

        // The enquiry is recorded with no claim — the state a lost notification leaves behind.
        await tx.meta_lead_inquiries.create({
          data: {
            lead_id: lead.id, facebook_lead_id: metaId, property_address: '5 Front St',
            meta_form_name: 'ZZ Form', submitted_at: day(19),
            created_at: new Date(),                       // recorded just now
          },
        });

        const sent: Sent[] = [];
        await syncService(tx, sent).upsertLead(s2, ctxFor(admin, null));

        expect(await inquiriesOf(tx, lead.id)).toHaveLength(1);
        const repeats = sent.filter((x) => x.event === 'repeat');
        expect(repeats).toHaveLength(1);
        expect(repeats[0].recipient).toBe(agent.id);
      });
    });
  }, 60000);

  it('AN OLD REPLAY AFTER A PURGE DOES NOT RE-NOTIFY', async () => {
    /*
     * The enquiry was recorded fourteen months ago and its claim has since been purged. Re-syncing
     * that submission must not resurrect a notification the brokerage already saw and aged out.
     */
    await inRollback(async (tx) => {
      await withRetentionMonths('12', async () => {
        const admin = await makeUser(tx, 'admin', 'adm');
        const agent = await makeUser(tx, 'agent', 'ag');
        const lead = await importedLead(tx, { assigned_to: agent.id });
        const metaId = `m-${tag()}`;
        const old = new Date();
        old.setMonth(old.getMonth() - 14);

        await tx.meta_lead_inquiries.create({
          data: {
            lead_id: lead.id, facebook_lead_id: metaId, property_address: '5 Front St',
            meta_form_name: 'ZZ Form', submitted_at: old,
            created_at: old,                              // older than the window
          },
        });
        // No claim row: exactly what a purge leaves behind.
        expect(await tx.notification_deliveries.count({
          where: { user_id: agent.id, dedupe_key: { startsWith: 'meta-repeat:' } },
        })).toBe(0);

        const sent: Sent[] = [];
        await syncService(tx, sent).upsertLead(
          submission(metaId, { phone: '4165550199', property: '5 Front St' }, old),
          ctxFor(admin, null),
        );

        expect(await inquiriesOf(tx, lead.id)).toHaveLength(1);   // no duplicate enquiry either
        expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(0);
      });
    });
  }, 60000);

  it('WITH RETENTION OFF, an old enquiry still recovers — nothing is ever purged', async () => {
    // `months() === 0` disables the sweep, so no claim can have been purged and the absence of one
    // means what it says. Reading a disabled policy as "unbounded" rather than special-casing it.
    await inRollback(async (tx) => {
      await withRetentionMonths('0', async () => {
        const admin = await makeUser(tx, 'admin', 'adm');
        const agent = await makeUser(tx, 'agent', 'ag');
        const lead = await importedLead(tx, { assigned_to: agent.id });
        const metaId = `m-${tag()}`;
        const old = new Date();
        old.setMonth(old.getMonth() - 30);

        await tx.meta_lead_inquiries.create({
          data: {
            lead_id: lead.id, facebook_lead_id: metaId, property_address: '5 Front St',
            meta_form_name: 'ZZ Form', submitted_at: old, created_at: old,
          },
        });

        const sent: Sent[] = [];
        await syncService(tx, sent).upsertLead(
          submission(metaId, { phone: '4165550199' }, old),
          ctxFor(admin, null),
        );

        expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(1);
      });
    });
  }, 60000);

  it('A NEWLY INSERTED ENQUIRY IS NEVER TREATED AS OLD, whatever the submission date says', async () => {
    /*
     * The trap this bound could have introduced. Meta's `created_time` can be well in the past — a
     * form re-read, a backfill — and bounding on THAT would silence the notice for an enquiry being
     * recorded for the first time right now. The bound reads the ROW's `created_at`, which for a
     * fresh insert is now.
     */
    await inRollback(async (tx) => {
      await withRetentionMonths('12', async () => {
        const admin = await makeUser(tx, 'admin', 'adm');
        const agent = await makeUser(tx, 'agent', 'ag');
        const lead = await importedLead(tx, { assigned_to: agent.id });
        const long = new Date();
        long.setMonth(long.getMonth() - 20);              // the SUBMISSION is old

        const sent: Sent[] = [];
        await syncService(tx, sent).upsertLead(
          submission(`m-${tag()}`, { phone: '4165550199', property: 'Backfilled' }, long),
          ctxFor(admin, null),
        );

        expect(await inquiriesOf(tx, lead.id)).toHaveLength(1);
        expect(sent.filter((x) => x.event === 'repeat')).toHaveLength(1);
      });
    });
  }, 60000);
});

// =====================================================================================
describe('an unassigned brokerage lead uses the existing routing', () => {
  it('FALLS BACK TO THE IMPORTING USER, with no wider recipient list invented', async () => {
    /*
     * Requirement: "use existing authorized brokerage notification routing. Do not invent a broad
     * recipient list." The order is the lead's assignee, then its owner, then the user whose
     * connection delivered the enquiry — who already sees this intake. Nobody else is added.
     */
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'adm');
      const lead = await importedLead(tx, { assigned_to: null });   // brokerage, unassigned
      const sent: Sent[] = [];

      await syncService(tx, sent).upsertLead(
        submission(`m-${tag()}`, { phone: '4165550199' }, day(12)),
        ctxFor(admin, null),
      );

      const repeats = sent.filter((x) => x.event === 'repeat');
      expect(repeats).toHaveLength(1);
      expect(repeats[0].leadId).toBe(lead.id);
      expect(repeats[0].recipient).toBe(admin.id);
    });
  }, 60000);
});
