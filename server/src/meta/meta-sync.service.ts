import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeadAuditService } from '../leads/lead-audit.service';
import { LeadNotificationService } from '../leads/lead-notification.service';
import { CrmEventNotifier } from '../notifications/crm-events.service';
import { MetaConnectionService } from './meta-connection.service';
import { MetaGraphService, GraphError, isAuthFailure, type GraphLead } from './meta-graph.service';
import { MetaApiBudgetService } from './meta-api-budget.service';
import { MetaAlertService } from './meta-alert.service';
import { mapMetaInquiry, mapMetaLead, normalizePhone, type MappedMetaLead } from './meta-lead-mapper';
import { ownerAtIntake } from '../common/lead-scope';
/*
 * The notification retention window, read from the service that owns it rather than restated here.
 * `months()` is static and consults `NOTIFICATION_RETENTION_MONTHS`; 0 means the sweep is off and
 * nothing is ever purged. See `repeatEnquiryNotice` for why this file needs to know.
 */
import { NotificationRetentionService } from '../notifications/notification-retention.service';
import { MAX_LEADS_PER_FORM, META_RAW_MAX_CHARS, META_RAW_RETENTION_DAYS, WEBHOOK_QUIET_ALERT_MS } from './meta.constants';
import { isSuperAdmin } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

const str = (v: unknown): string => String(v ?? '').trim();
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SyncResult {
  imported: number;
  updated: number;
  duplicates: number;
  skipped: number;
  forms: number;
  errors: string[];
}

/** How a lead was matched to an existing record, so the reason can be reported. */
export type UpsertOutcome = 'imported' | 'updated' | 'duplicate' | 'skipped';

interface LeadContext {
  userId: number;
  userName: string;
  pageId: string;
  pageName?: string;
  formId: string;
  formName?: string;
  /**
   * Who will OWN what this form brings in: the connecting agent, or `null` for the brokerage.
   *
   * WHAT DECIDES IT, since Meta reports nothing about whose budget paid for a click. A connection
   * belongs to the person who made it (`meta_lead_forms.user_id`), so the question becomes "whose
   * ads are these?" — and the answer follows the same one-line rule as every other intake: an
   * AGENT connecting their own ad account keeps their leads; anybody else connecting a Page is the
   * brokerage advertising for itself. Computed by `ownerAtIntake`, never re-derived here.
   */
  ownerId?: number | null;
}

@Injectable()
export class MetaSyncService {
  private readonly log = new Logger(MetaSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: MetaConnectionService,
    private readonly graph: MetaGraphService,
    private readonly audit: LeadAuditService,
    private readonly notifications: LeadNotificationService,
    private readonly budget: MetaApiBudgetService,
    private readonly alerts: MetaAlertService,
    /** Optional so existing constructions — including this service's specs — keep working. */
    private readonly crmEvents?: CrmEventNotifier,
  ) {}

  /** Exposed for tests and for re-mapping a stored payload. */
  mapLead(fieldData: GraphLead['field_data']): MappedMetaLead {
    return mapMetaLead(fieldData);
  }

  /**
   * The raw Graph payload as it is stored, capped.
   *
   * It was stored whole and unbounded. `meta_raw` is kept so an import can be re-examined or
   * re-mapped when a form's questions change — that needs the answers, not every byte Meta sent —
   * and it duplicates data already in the mapped columns, so one pathological submission was able
   * to carry an unbounded row for no diagnostic gain.
   *
   * Truncation is MARKED rather than silent. A clipped payload that still looks like JSON is worse
   * than no payload: somebody re-mapping from it would read partial answers as complete ones.
   */
  private rawForStorage(lead: GraphLead): string {
    const full = JSON.stringify(lead);
    if (full.length <= META_RAW_MAX_CHARS) return full;
    return JSON.stringify({
      _truncated: true,
      _original_length: full.length,
      _note: `Stored payload capped at ${META_RAW_MAX_CHARS} characters. The mapped columns hold the answers.`,
      _payload: full.slice(0, META_RAW_MAX_CHARS),
    });
  }

  /**
   * Forget raw payloads past the retention window.
   *
   * The mapped columns are the record; `meta_raw` is a working copy of what arrived, and it holds
   * everything a person typed into somebody's ad — the fullest personal-data footprint this module
   * keeps. Holding it for ever with no policy is the part that would be hard to defend. Clearing
   * the column leaves the lead itself untouched.
   *
   * Returns how many rows were cleared. Runs from the sync scheduler rather than its own timer,
   * because it is housekeeping and does not need to be prompt.
   */
  async pruneRawPayloads(): Promise<number> {
    if (META_RAW_RETENTION_DAYS <= 0) return 0;
    const cutoff = new Date(Date.now() - META_RAW_RETENTION_DAYS * 86_400_000);
    const r = await this.prisma.leads.updateMany({
      where: { meta_raw: { not: null }, meta_imported_at: { lt: cutoff } },
      data: { meta_raw: null },
    });
    if (r.count) {
      this.log.log(`Cleared the stored Meta payload on ${r.count} lead(s) older than ${META_RAW_RETENTION_DAYS} days.`);
    }
    return r.count;
  }

  /**
   * Who WORKS an imported lead. Unchanged: whoever's Meta connection produced it.
   *
   * The Leads module scopes an agent to leads assigned to them, so an unassigned Meta lead
   * would be invisible to the very person meant to work it. It therefore goes to the user whose
   * Meta connection produced it — the same rule the Leads module applies to agent-created leads.
   *
   * This stays true for a brokerage connection too: the administrator or CRM staffer who connected
   * the Page is the person triaging what comes in, and they can reassign it. What changes for a
   * brokerage connection is the OWNER, not the assignee — see `ownerFor`.
   */
  private assignee(ctx: LeadContext): number {
    return ctx.userId;
  }

  /**
   * Who OWNS an imported lead — the brokerage, or the agent whose ad it was.
   *
   * `null` is not "nobody": in this database it is how a BROKERAGE-owned lead is recorded, and it
   * is what puts the lead in front of every `leads.brokerage-scope` holder rather than one person.
   * See `common/lead-scope.ts`.
   *
   * WHY THE CONNECTION DECIDES. Meta reports nothing about whose budget paid for a click, so the
   * only honest signal is who connected the Page. An `agent` connecting their own ad account keeps
   * their leads — that is the long-standing meaning of `source = 'facebook_meta'`, and it is why a
   * personal Meta lead is never transferable and stays with a departing agent. Anybody else
   * connecting a Page is the brokerage advertising for itself, and those leads are the brokerage's.
   *
   * A BROKERAGE META LEAD IS STILL `source = 'facebook_meta'`, and that is deliberate. The source
   * records HOW it arrived; ownership records WHOSE it is. Keeping them separate means the
   * departure rule — "a personal Meta lead stays with its agent" — keeps working unchanged, because
   * that rule is about leads an agent OWNS, and these are not owned by anyone.
   *
   * Falls back to the connecting user when the caller did not resolve an owner, which is the
   * pre-existing behaviour and the safe direction: a lead nobody owns is visible to brokerage staff,
   * and getting there by accident should need a decision rather than a missing field.
   */
  private ownerFor(ctx: LeadContext): number | null {
    return ctx.ownerId === undefined ? ctx.userId : ctx.ownerId;
  }

  /**
   * Leads this importing agent already works — the only records a Meta submission may match.
   *
   * THE SCOPE IS THE WHOLE POINT. These lookups used to span the entire brokerage, and the update
   * that follows wrote into whatever they found. So a submission on AGENT A's ad that happened to
   * share an email with AGENT B's lead enriched B's record — rewriting its `source`, its
   * `lead_source`, its `message` and its Meta identifiers with data from a campaign B had nothing to
   * do with — while agent A, who paid for the click, received no lead at all and saw it counted as a
   * "duplicate".
   *
   * That is a cross-book write into a record the writer cannot read, and it contradicts the
   * uniqueness rule this application settled on: the same person MAY be a lead of two different
   * agents, precisely because they can arrive through anybody's ad. Meta ads are that scenario.
   *
   * Matching is therefore confined to the importer's own book — owned by them, or assigned to them,
   * which is the same set the Leads module treats as theirs. Anything outside it is a different
   * agent's relationship with the same person, and the correct outcome is a new lead of their own.
   */
  private ownBook(userId: number): Prisma.leadsWhereInput {
    return { OR: [{ owner_user_id: userId }, { assigned_to: userId }] };
  }

  /**
   * The leads a submission may match: the importer's own book, plus — when this intake is the
   * brokerage's — every brokerage-owned lead.
   *
   * WHY BROKERAGE INTAKE NEEDS IT. A brokerage lead is handed down Admin → Team Lead → Agent and
   * `assigned_to` moves with it, so it leaves `ownBook` for the administrator whose connection
   * imports it. The customer's next submission then matched nothing, tried to create a second
   * brokerage lead, hit `leads_owner_email_key` (one brokerage lead per address) and was lost as
   * skipped. This is exactly the set that index already treats as one book, so nothing new becomes
   * writable; agent intake keeps `ownBook` unchanged.
   */
  private matchBook(ctx: LeadContext): Prisma.leadsWhereInput {
    const own = this.ownBook(ctx.userId);
    return this.ownerFor(ctx) === null ? { OR: [own, { owner_user_id: null }] } : own;
  }

  /**
   * Find an existing lead for this submission, in the order the brief requires:
   * Meta lead id → email → normalized phone. Returns the row and which rule matched.
   *
   * `facebook_lead_id` is deliberately NOT scoped: it is globally unique, so a match is the same
   * submission arriving twice rather than a different person, and the row it finds is by definition
   * the one this delivery already created. Scoping it would let a retry create a second copy.
   */
  private async findExisting(facebookLeadId: string, mapped: MappedMetaLead, ctx: LeadContext): Promise<{ id: number; rule: string } | null> {
    const byMetaId = await this.prisma.leads.findFirst({
      where: { facebook_lead_id: facebookLeadId },
      select: { id: true },
    });
    // Globally unique, and therefore not an identity question: this is the same submission arriving
    // again, and the row it finds is by definition the one that delivery already created.
    if (byMetaId) return { id: byMetaId.id, rule: 'meta lead id' };

    const mine = this.matchBook(ctx);

    /*
     * EVERY CANDIDATE, NOT THE FIRST ONE.
     *
     * This used to take `findFirst` on email and, failing that, `findFirst` on phone — so email
     * silently outranked phone, and "two leads share this address" silently resolved to whichever
     * row the database yielded first. Both are identity questions the sync is not entitled to
     * answer on its own: attaching an enquiry to the wrong person files a stranger's conversation
     * in somebody's record, and nothing on screen would ever say so.
     *
     * Still inside `matchBook`, so the private-book restriction is untouched — this changes how
     * ambiguity is handled, not which records are visible.
     */
    const emailIds = mapped.email && EMAIL_SHAPE.test(mapped.email)
      ? (await this.prisma.leads.findMany({
        where: { AND: [{ email: { equals: mapped.email, mode: 'insensitive' }, deleted_at: null }, mine] },
        select: { id: true },
        take: 10,
      })).map((r) => r.id)
      : [];

    const phoneIds = mapped.phone_normalized
      ? (await this.prisma.leads.findMany({
        where: { AND: [{ phone_normalized: mapped.phone_normalized, deleted_at: null }, mine] },
        select: { id: true },
        take: 10,
      })).map((r) => r.id)
      : [];

    /*
     * THE MATCHING POLICY: EXACT EMAIL TAKES PRECEDENCE; CONFLICTING PHONE MATCHES ARE LOGGED.
     *
     * This is a deliberate choice about which identifier the brokerage trusts, not a claim that any
     * other choice is impossible. Two reasons it was made this way:
     *
     *   A PHONE IS ROUTINELY SHARED — a household, a couple, an office line — whereas an email
     *   address is usually one person's. So an exact email is the stronger signal, and a phone
     *   pointing elsewhere is weak evidence against it. Treating the disagreement as a blocker
     *   would turn ordinary shared numbers into lost enquiries.
     *
     *   AND THE ALTERNATIVE COSTS MORE THAN IT LOOKS. Refusing here means falling through to
     *   creating a lead, which collides with `UNIQUE (COALESCE(owner_user_id, 0), LOWER(email))`
     *   when the email is the shared identifier — so "refuse" would in practice mean "drop the
     *   enquiry", not "file it safely". Choosing to drop it is available; it is simply a worse
     *   outcome than attaching to the email's lead and saying so.
     *
     * An email being unique within a book does NOT prove two records are the same person — it is a
     * storage constraint, not an identity proof. The disagreement is therefore logged with both
     * lead ids so somebody can confirm or merge them.
     */
    if (emailIds.length === 1) {
      const other = phoneIds.filter((id) => id !== emailIds[0]);
      if (other.length) {
        this.log.warn(
          `Meta submission ${facebookLeadId}: attached by email address to lead ${emailIds[0]}, `
          + `whose phone number also matches lead(s) ${other.join(', ')}. The email is exact and one `
          + 'address belongs to one lead per book, so it decides; check whether those leads are the '
          + 'same person.',
        );
      }
      return { id: emailIds[0], rule: 'email address' };
    }

    /*
     * MORE THAN ONE LEAD ON THE SAME ADDRESS inside one book is what the unique index is there to
     * prevent, so reaching here means the index is absent, disabled, or the rows pre-date it.
     * Which of those cannot be told from here, and neither lead is a safer guess than the other,
     * so this refuses and names both.
     */
    if (emailIds.length > 1) {
      this.logIdentityConflict(facebookLeadId, emailIds, 'on the same email address in the importing book');
      return null;
    }

    if (phoneIds.length === 1) return { id: phoneIds[0], rule: 'phone number' };

    if (phoneIds.length > 1) {
      /*
       * SEVERAL LEADS ON ONE NUMBER, and no email to break the tie. This is the conflict worth
       * refusing: picking one files a stranger's enquiry in somebody's record. Creating a lead is
       * possible here — the address is free — so the existing behaviour stands and the ids are
       * logged for somebody to merge.
       */
      this.logIdentityConflict(facebookLeadId, phoneIds, 'on the same phone number in the importing book');
      return null;
    }

    return null;
  }

  /**
   * Say that a submission could not be placed, in terms somebody can act on and without quoting
   * the person.
   *
   * NO EMAIL ADDRESS AND NO PHONE NUMBER IN THE MESSAGE. Logs are read by more people than the CRM
   * is, are shipped off the machine, and are kept longer than a lead is. The lead ids are enough to
   * resolve the conflict — they open directly in the CRM — and the Meta submission id is enough to
   * find the enquiry itself. Neither identifies anybody to a reader who cannot already see them.
   */
  private logIdentityConflict(facebookLeadId: string, leadIds: number[], where: string): void {
    this.log.warn(
      `Meta submission ${facebookLeadId} matches ${leadIds.length} leads ${where} `
      + `(ids: ${leadIds.join(', ')}) — identity is ambiguous, so a new lead was created rather than `
      + 'attaching the enquiry to one of them. Merge or correct those leads to resolve it.',
    );
  }

  /**
   * A BROKERAGE LEAD THIS PERSON ALREADY IS, found when `findExisting` matched nothing.
   *
   * WHAT THIS FIXES. `findExisting` matches a phone only against `leads.phone_normalized`, which is
   * a DERIVED column written by the Meta mapper and by `LeadsService`. The CSV importer
   * (`lead-import.engine.ts`) creates leads without it — four `create` calls, no `normalizePhone` —
   * so an IMPORTED lead carries a phone number and a null normalised form. A person on such a lead
   * who enquires again by phone matched nothing at all, and the sync created a second, unassigned
   * lead while the agent holding the first was told nothing. That is the reported defect.
   *
   * ONE IMPLEMENTATION OF THE RULE, NOT TWO. `normalizePhone` has branches — strip a leading
   * country 1, keep anything longer than eleven digits, otherwise take the last ten — and writing
   * that again in SQL would be a second copy free to drift from the first. So SQL does a cheap
   * prefilter (stripped digits ENDING with the target, which every branch of the rule satisfies)
   * and the real function confirms each candidate in TypeScript.
   *
   * BROKERAGE-OWNED ONLY, AND NEVER AN AGENT'S PRIVATE BOOK. `ownership_type` is a generated column
   * — 'PRIVATE' once `owner_user_id` is set — so `owner_user_id IS NULL` is exactly the brokerage's
   * own book and is the whole search space here. An agent's lead is a different agent's
   * relationship with the same person, which is the rule `ownBook` exists to protect and this does
   * not weaken.
   *
   * BROKERAGE INTAKE ONLY. An agent who connected their own ad account keeps the existing
   * restriction untouched: their submissions match their book and nothing else.
   *
   * AMBIGUITY IS NOT RESOLVED HERE. Two brokerage leads whose phones normalise the same way are two
   * relationships, and picking one would silently merge somebody's enquiry into the wrong file. The
   * caller is told `ambiguous` and falls back to creating a lead, which is the behaviour that
   * exists today.
   */
  private async findBrokerageFallback(
    mapped: MappedMetaLead,
    ctx: LeadContext,
  ): Promise<{ id: number; rule: string } | { ambiguous: true; ids: number[] } | null> {
    // Agent-owned advertising connections keep their current book restriction.
    if (this.ownerFor(ctx) !== null) return null;

    const target = mapped.phone_normalized;
    if (!target) return null;

    /*
     * The prefilter. `regexp_replace(phone, '[^0-9]', '', 'g')` is the same "digits only" step the
     * rule starts with. A CHARACTER CLASS RATHER THAN `\D`, and not for style: inside a template
     * literal TypeScript collapses the unrecognised escape `\D` to a bare `D`, so the first draft
     * of this query asked Postgres to strip the letter D and matched nothing at all.
     * starts with, and every branch of it returns a suffix of those digits — so a candidate whose
     * stripped phone does not END with the target cannot normalise to it. Narrowed to the
     * brokerage's own live leads first, so the scan is over that book rather than the table.
     */
    const candidates = await this.prisma.$queryRaw<{ id: number; phone: string | null }[]>`
      SELECT id, phone
      FROM leads
      WHERE owner_user_id IS NULL
        AND deleted_at IS NULL
        AND phone IS NOT NULL
        AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${'%' + target}
      LIMIT 25
    `;

    // The single existing rule decides. A prefilter hit that does not normalise to the same value
    // is not a match.
    const matched = [...new Set(
      candidates.filter((c) => normalizePhone(c.phone) === target).map((c) => c.id),
    )];

    if (matched.length === 0) return null;
    if (matched.length > 1) return { ambiguous: true, ids: matched };
    return { id: matched[0], rule: 'phone number (brokerage)' };
  }

  /**
   * A lead of this agent's that was soft-deleted and holds the address this submission needs.
   *
   * `findExisting` filters out deleted rows on purpose — a deleted lead is not one to enrich — but
   * the `lower(email)` unique index still holds the address, so creating the new row raises P2002
   * and the submission was lost outright. A person who enquires again after their lead was tidied
   * away is exactly the enquiry a brokerage most wants, and it was the one guaranteed to fail.
   */
  private async deletedHolder(email: string, ctx: LeadContext): Promise<{ id: number } | null> {
    if (!email) return null;
    return this.prisma.leads.findFirst({
      where: { AND: [{ email: { equals: email, mode: 'insensitive' }, deleted_at: { not: null } }, this.matchBook(ctx)] },
      select: { id: true },
    });
  }

  /**
   * Turn one Graph lead into a CRM lead plus a Meta inquiry.
   *
   * ONE PERSON = ONE LEAD, ONE SUBMISSION = ONE INQUIRY:
   *   imported   a new person — a new lead, with this submission as inquiry #1.
   *   duplicate  a person already here, by a NEW submission — the lead is kept exactly as it is
   *              (owner, assignee, Team Lead, team, status) and one inquiry is added under it.
   *   updated    a submission already recorded — nothing is created and the count does not move.
   *
   * Idempotent at the database: `meta_lead_inquiries.facebook_lead_id` is unique and every inquiry
   * insert is `ON CONFLICT DO NOTHING`. Two syncs racing on a NEW person both try to create the
   * lead; the loser gets a unique violation on `leads`, which is not a failure — it resolves the
   * submission once more and finds the lead the winner created.
   */
  async upsertLead(lead: GraphLead, ctx: LeadContext): Promise<{ outcome: UpsertOutcome; leadId: number | null; rule?: string }> {
    try {
      return await this.upsertOnce(lead, ctx);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return this.upsertOnce(lead, ctx);
      throw err;
    }
  }

  private async upsertOnce(lead: GraphLead, ctx: LeadContext): Promise<{ outcome: UpsertOutcome; leadId: number | null; rule?: string }> {
    const facebookLeadId = str(lead.id);
    if (!facebookLeadId) return { outcome: 'skipped', leadId: null };

    /*
     * THIS SUBMISSION, ALREADY RECORDED: skip, and write nothing. Re-writing the lead here is what
     * let whichever submission the scheduler read last become "the" enquiry for a returning person.
     *
     * AND IT IS WHERE A LOST NOTIFICATION IS RECOVERED. This early return is the path every retry
     * of an already-recorded submission takes — so if the notice failed the first time, or the
     * process died between the insert and the dispatcher, this is the only place that will ever
     * see it again. `repeatEnquiryNotice` reads the delivery ledger and does nothing when the
     * dispatcher was already reached, so the common case costs one indexed lookup.
     */
    const seen = await this.prisma.meta_lead_inquiries.findUnique({
      where: { facebook_lead_id: facebookLeadId },
      select: {
        lead_id: true, property_address: true, project_name: true, meta_form_name: true,
        // The PERSISTED time, which is what bounds recovery — see `repeatEnquiryNotice`.
        created_at: true,
      },
    });
    if (seen) {
      await this.repeatEnquiryNotice(seen.lead_id, facebookLeadId, seen, ctx);
      return { outcome: 'updated', leadId: seen.lead_id, rule: 'meta lead id' };
    }

    const mapped = this.mapLead(lead.field_data);
    const attribution = this.attribution(lead);
    const createdAt = lead.created_time ? new Date(lead.created_time) : new Date();
    const now = new Date();
    const details = mapMetaInquiry(lead.field_data, mapped);
    const inquiry = {
      facebook_lead_id: facebookLeadId,
      facebook_page_id: ctx.pageId || null,
      facebook_form_id: ctx.formId || null,
      meta_page_name: ctx.pageName ?? null,
      meta_form_name: ctx.formName ?? null,
      property_address: details.property_address,
      project_name: details.project_name,
      answers: details.answers,
      submitted_at: createdAt,
      created_at: now,
    };

    const existing = await this.findExisting(facebookLeadId, mapped, ctx);

    const metaFields = {
      facebook_lead_id: facebookLeadId,
      facebook_form_id: ctx.formId || null,
      facebook_page_id: ctx.pageId || null,
      meta_page_name: ctx.pageName ?? null,
      meta_form_name: ctx.formName ?? null,
      ...attribution,
      meta_created_at: createdAt,
      meta_imported_at: now,
      meta_raw: this.rawForStorage(lead),
      message: mapped.message,
      budget: mapped.budget,
      timeline: mapped.timeline,
      property_type: mapped.property_type,
      custom_fields: Object.keys(mapped.custom_fields).length ? JSON.stringify(mapped.custom_fields) : null,
      updated_at: now,
    };

    if (existing) {
      /*
       * A PERSON ALREADY HERE: attach the submission as one more inquiry. `count` is 1 only for the
       * writer that actually added the row, so a concurrent sync that lost the race counts nothing.
       */
      const { count } = await this.prisma.meta_lead_inquiries.createMany({
        data: [{ ...inquiry, lead_id: existing.id }],
        skipDuplicates: true,
      });

      /*
       * THE ENQUIRY IS RECORDED, SO SOMEBODY SHOULD HEAR ABOUT IT — now or on a later pass.
       *
       * NOT GATED ON `count`, and that is the durability fix. `count === 1` identifies the pass
       * that inserted, which is the right answer to "is this a new enquiry"; it is the wrong answer
       * to "has anybody been told". If the notice failed, or the process died between the insert
       * and the dispatcher, the row is committed, `count` is 0 for ever after, and nobody would
       * ever be told. `repeatEnquiryNotice` therefore decides from the DELIVERY LEDGER instead.
       *
       * Deliberately BEFORE the `meta lead id` early return below.
       */
      await this.repeatEnquiryNotice(existing.id, facebookLeadId, inquiry, ctx);

      // The lead's own Meta id was this submission (imported before inquiries existed): now recorded.
      if (existing.rule === 'meta lead id' || count === 0) return { outcome: 'updated', leadId: existing.id, rule: 'meta lead id' };

      /*
       * The lead's Meta columns describe its LATEST submission, so only a newer one moves them on;
       * an older submission recovered later must not drag them back. Either way the inquiry row is
       * the record. Owner, assignee, Team Lead, team and status are never written here.
       */
      const current = await this.prisma.leads.findUnique({ where: { id: existing.id }, select: { meta_created_at: true } });
      if (!current?.meta_created_at || current.meta_created_at.getTime() <= createdAt.getTime()) {
        await this.prisma.leads.update({
          where: { id: existing.id },
          data: {
            ...metaFields,
            source: 'facebook_meta',
            lead_source: 'meta',
            // Only fill blanks — never overwrite something a person typed.
            first_name: mapped.first_name ?? undefined,
            last_name: mapped.last_name ?? undefined,
            phone_normalized: mapped.phone_normalized ?? undefined,
          },
        });
      }
      return { outcome: 'duplicate', leadId: existing.id, rule: existing.rule };
    }

    /*
     * NOTHING IN THE IMPORTER'S BOOK — TRY THE BROKERAGE'S OWN.
     *
     * Reached only when `findExisting` matched nothing, so email has already failed and this can
     * only be a phone match. `findBrokerageFallback` says why it exists and what it refuses to do.
     *
     * ATTACH ONLY. Unlike the branch above, this writes NOTHING to the lead — not the Meta columns,
     * not the blanks, not `source`. The lead was created somewhere else, by somebody who may have
     * typed its contact details, and a phone-shaped match across books is a weaker claim than an
     * email match inside one. The enquiry row carries the submission whole, which is the record
     * that was missing; the lead keeps its assignee, owner, Team Lead, team, status and source.
     */
    const fallback = await this.findBrokerageFallback(mapped, ctx);
    if (fallback && 'ambiguous' in fallback) {
      /*
       * TWO BROKERAGE LEADS NORMALISE TO THE SAME NUMBER. Picking one would file somebody's enquiry
       * against the wrong person, so the existing behaviour stands — a lead is created below — and
       * the conflict is recorded as a warning on the sync log, which is the internal channel this
       * service already uses for a submission it could not place. No lead-review mechanism exists
       * to raise it on, and inventing a notification recipient for it is outside this change.
       */
      this.logIdentityConflict(facebookLeadId, fallback.ids, 'in the brokerage book');
    } else if (fallback) {
      // The insert result is deliberately not consulted: `repeatEnquiryNotice` decides from the
      // delivery ledger, so a notice lost on an earlier pass is recovered on a later one.
      await this.prisma.meta_lead_inquiries.createMany({
        data: [{ ...inquiry, lead_id: fallback.id }],
        skipDuplicates: true,
      });
      await this.repeatEnquiryNotice(fallback.id, facebookLeadId, inquiry, ctx);
      return { outcome: 'duplicate', leadId: fallback.id, rule: fallback.rule };
    }

    // A Meta form can omit email entirely. `leads.email` is required, so a placeholder keyed to
    // the Meta id keeps the enquiry visible and fixable instead of dropping it.
    const email = mapped.email && EMAIL_SHAPE.test(mapped.email)
      ? mapped.email
      : `no-email-${facebookLeadId}@meta.invalid`;

    /*
     * The person may be returning to a lead this agent deleted. Restore it and attach the new
     * submission, rather than raising a unique-constraint error and losing the enquiry.
     *
     * Restoring is the right answer rather than "create a second one": the address is the same
     * person, the row still holds whatever history was recorded before, and the deletion was a
     * filing decision that a fresh enquiry supersedes. The outcome is reported as `imported`,
     * because from the brokerage's point of view a lead has arrived.
     */
    const buried = await this.deletedHolder(email, ctx);
    if (buried) {
      const restored = await this.prisma.leads.update({
        where: { id: buried.id },
        data: {
          ...metaFields,
          deleted_at: null,
          deleted_by: null,
          source: 'facebook_meta',
          lead_source: 'meta',
          name: mapped.name,
          first_name: mapped.first_name ?? undefined,
          last_name: mapped.last_name ?? undefined,
          phone: mapped.phone ?? undefined,
          phone_normalized: mapped.phone_normalized ?? undefined,
          location: mapped.location ?? undefined,
          property: mapped.property ?? undefined,
        },
      });
      await this.prisma.meta_lead_inquiries.createMany({ data: [{ ...inquiry, lead_id: restored.id }], skipDuplicates: true });
      this.log.log(`Meta lead ${facebookLeadId} restored lead #${buried.id}, which had been deleted.`);
      void this.notifications.notifyNewLead(restored);
      void this.metaArrived(restored, ctx, facebookLeadId);
      return { outcome: 'imported', leadId: restored.id, rule: 'restored a deleted lead with the same address' };
    }

    const row = await this.prisma.leads.create({
      data: {
        ...metaFields,
        name: mapped.name,
        first_name: mapped.first_name,
        last_name: mapped.last_name,
        email,
        phone: mapped.phone,
        phone_normalized: mapped.phone_normalized,
        location: mapped.location,
        property: mapped.property,
        lead_status: 'cold',
        lead_response: 'inactive',
        lead_source: 'meta',
        source: 'facebook_meta',
        tags: JSON.stringify([]),
        assigned_to: this.assignee(ctx),
        owner_user_id: this.ownerFor(ctx),
        created_by: `Meta${ctx.pageName ? ` · ${ctx.pageName}` : ''}`,
        created_at: createdAt,
        updated_at: createdAt,
        // The lead and its inquiry #1 in one statement, so neither exists without the other.
        meta_lead_inquiries: { create: inquiry },
      },
    });
    // Best-effort "new lead from Meta" email to the assigned agent; never blocks the sync.
    void this.notifications.notifyNewLead(row);
    void this.metaArrived(row, ctx, facebookLeadId);
    return { outcome: 'imported', leadId: row.id };
  }

  /**
   * Tell whoever holds this lead that the same person has enquired again.
   *
   * THE RECIPIENT IS THE LEAD'S, NOT THE CONNECTION'S. `metaArrived` notifies the importing user,
   * which is right for an arrival — they are the one whose ad produced it. A repeat enquiry belongs
   * to whoever is working the relationship, so the assignee comes first, then the owner for an
   * agent-owned lead, and only then the importing user. That last step is the existing authorised
   * routing for a brokerage lead nobody has been given yet: the person whose connection delivered
   * the enquiry already sees this intake. No wider list is invented.
   *
   * NEVER THROWS. Reached from the middle of a sync that has already written the enquiry row; a
   * notification failure must not lose that or abort the rest of the run.
   */
  private async repeatEnquiryNotice(
    leadId: number,
    facebookLeadId: string,
    inquiry: {
      property_address: string | null; project_name: string | null; meta_form_name: string | null;
      /** When the enquiry row was written. Absent on the paths that are inserting it right now. */
      created_at?: Date | null;
    },
    ctx: LeadContext,
  ): Promise<void> {
    try {
      const lead = await this.prisma.leads.findUnique({
        where: { id: leadId },
        select: { id: true, name: true, email: true, assigned_to: true, owner_user_id: true, facebook_lead_id: true },
      });
      if (!lead) return;

      /*
       * THIS SUBMISSION IS THE LEAD'S OWN ARRIVAL, NOT A REPEAT.
       *
       * A submission that CREATED a lead stamps its id on the row, and it was announced by
       * `notifyNewLead` and `metaArrived` at the time. Without this check the recovery above would
       * find no `meta-repeat:` claim for it — there is none, and never should be — and announce a
       * brand-new lead as "a new enquiry from an existing lead" on the next sync pass, for ever.
       */
      if (lead.facebook_lead_id && lead.facebook_lead_id === facebookLeadId) return;

      const recipient = lead.assigned_to ?? lead.owner_user_id ?? ctx.userId;
      if (!recipient) return;

      /*
       * HAS THE DISPATCHER ALREADY BEEN REACHED FOR THIS SUBMISSION AND THIS PERSON?
       *
       * `notification_deliveries` is this repository's delivery ledger: the dispatcher CLAIMS a row
       * per (recipient, category, occurrence, channel) with status `pending` before it does
       * anything, then settles it. So the absence of any row means the dispatcher was never
       * reached — the notice threw, or the process died — and this pass should try again. The
       * presence of one, whatever its status, means it ran and owns the outcome from there:
       * `muted` is a preference, `failed` is its own business, and re-announcing either on every
       * sync would be a loop rather than a recovery.
       *
       * The key is built exactly as `metaRepeatEnquiry` builds it, so this reads the same row the
       * dispatcher will write. Both are keyed on META'S OWN SUBMISSION ID, which is what keeps
       * submission-and-recipient deduplication intact across the poll, the webhook and a retry.
       */
      /*
       * OLDER THAN THE RETENTION WINDOW: LEAVE IT ALONE.
       *
       * The ledger check below reads "no claim row" as "the dispatcher was never reached". That is
       * true for a recent enquiry and FALSE for an old one, because `NotificationRetentionService`
       * purges `notification_deliveries` by age — and `lead_meta` carries no `STILL_LIVE` guard, so
       * its rows are purgeable. Without this bound, a submission re-synced after its claim had been
       * purged would look un-notified and the notice would be raised again: a notification the
       * brokerage had already seen, read and aged out, arriving a year later.
       *
       * BOUNDED BY THE ENQUIRY'S OWN PERSISTED `created_at`, not by the submission's Meta timestamp
       * and not by now. The row is the thing whose notification may have been purged, so the row's
       * age is the question. A freshly inserted enquiry has no stored time to consult here and is
       * never old, so normal delivery is untouched.
       *
       * `months() === 0` means the sweep is off and nothing is ever purged, so recovery is
       * unbounded — the correct reading of a disabled retention policy rather than a special case.
       */
      const months = NotificationRetentionService.months();
      if (months > 0 && inquiry.created_at) {
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - months);
        if (inquiry.created_at.getTime() < cutoff.getTime()) {
          this.log.debug?.(
            `Meta submission ${facebookLeadId}: enquiry recorded ${inquiry.created_at.toISOString()} is `
            + `older than the ${months}-month notification retention window; not re-notifying.`,
          );
          return;
        }
      }

      const alreadyDispatched = await this.prisma.notification_deliveries.findFirst({
        where: {
          user_id: recipient,
          category: 'lead_meta',
          dedupe_key: `meta-repeat:${facebookLeadId}:${recipient}`.slice(0, 190),
        },
        select: { id: true },
      });
      if (alreadyDispatched) return;

      await this.crmEvents?.metaRepeatEnquiry(
        { id: lead.id, first_name: lead.name, last_name: null, email: lead.email },
        recipient,
        facebookLeadId,
        {
          formName: inquiry.meta_form_name ?? ctx.formName ?? ctx.pageName ?? null,
          propertyAddress: inquiry.property_address,
          projectName: inquiry.project_name,
        },
      );
    } catch (err) {
      this.log.warn(
        `Meta submission ${facebookLeadId}: the enquiry was recorded but its notification failed — `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Tell the owning agent that a Meta lead arrived.
   *
   * REACHED ONLY FROM THE TWO `imported` PATHS — a fresh lead, or a deleted one restored by a new
   * enquiry. A submission that matched an existing lead returns `duplicate` or `updated` well before
   * here, so deduplication produces no notification, which is the required behaviour: an existing
   * lead being updated is not a new lead arriving.
   *
   * IDEMPOTENT ACROSS INTAKE MECHANISMS. `facebookLeadId` is Meta's own identifier for the
   * submission, and both the scheduled poll and the webhook carry it. Keying on it — rather than on
   * our row id, a timestamp, or which path got here first — means whichever arrives second is
   * dropped deterministically by the dispatcher, with no dependence on ordering.
   *
   * In-app and push only. The templated Meta email is `notifyNewLead` on the line above, and asking
   * the dispatcher for email as well would deliver two.
   */
  private async metaArrived(
    lead: { id: number; name: string | null; email: string | null },
    ctx: { userId: number | null; assignedTo?: number | null; formName?: string | null; pageName?: string | null },
    facebookLeadId: string,
  ): Promise<void> {
    const recipient = this.assignee(ctx as never) ?? ctx.userId;
    if (!recipient || !facebookLeadId) return;
    await this.crmEvents?.metaLeadArrived(
      { id: lead.id, first_name: lead.name, last_name: null, email: lead.email },
      recipient,
      facebookLeadId,
      ctx.formName ?? ctx.pageName ?? null,
    );
  }

  /**
   * Campaign / ad-set / ad attribution, when the request was allowed to ask for it.
   *
   * Graph returns these as flat `campaign_id` / `campaign_name` fields on the lead, not as
   * nested objects — reading them as objects silently yields null on every lead.
   */
  private attribution(lead: GraphLead): Record<string, string | null> {
    const l = lead as unknown as Record<string, unknown>;
    const pick = (key: string): string | null => str(l[key]) || null;
    return {
      meta_campaign_id: pick('campaign_id'),
      meta_campaign_name: pick('campaign_name'),
      meta_adset_id: pick('adset_id'),
      meta_adset_name: pick('adset_name'),
      meta_ad_id: pick('ad_id'),
      meta_ad_name: pick('ad_name'),
    };
  }

  /**
   * Pull leads for every form the user opted into. Only opted-in forms are read — connecting a
   * Page must not silently ingest every campaign running on it.
   */
  async syncUser(user: AuthUserRecord, trigger: 'manual' | 'webhook' | 'scheduled' = 'manual'): Promise<SyncResult> {
    const result: SyncResult = { imported: 0, updated: 0, duplicates: 0, skipped: 0, forms: 0, errors: [] };
    const userId = user.id ?? 0;
    if (!userId) return result;

    const startedAt = new Date();
    const conn = await this.connections.find(userId);
    if (!conn) { result.errors.push('Meta is not connected.'); return result; }

    const forms = await this.prisma.meta_lead_forms.findMany({ where: { user_id: userId, is_active: true } });
    if (!forms.length) { result.errors.push('No lead forms are connected yet.'); return result; }

    /*
     * Spend from the budget everybody shares, before fanning out.
     *
     * `META_SYNC_LIMIT` bounds how often ONE person may press Sync; this bounds what the whole
     * brokerage may spend, because Meta's limits are per app. Charged per form about to be read,
     * up front, so a refusal costs nothing rather than stopping half way through a run.
     *
     * The scheduled pass is charged too. Exempting it would mean the automatic traffic — the larger
     * and more predictable half — was invisible to the ceiling meant to bound total usage.
     */
    const budget = await this.budget.consume(forms.length);
    if (!budget.allowed) {
      const minutes = Math.ceil(budget.resetInSeconds / 60);
      result.errors.push(
        `The brokerage has used its Meta API allowance for now (${budget.spent} of ${budget.limit} calls). `
        + `Lead collection resumes automatically in about ${minutes} minute(s) — no leads are lost, `
        + 'Meta holds them until they are collected.',
      );
      this.log.warn(`Meta sync for ${user.name} deferred: shared budget spent (${budget.spent}/${budget.limit}).`);
      await this.recordHistory(userId, trigger, startedAt, result);
      return result;
    }

    for (const form of forms) {
      const page = conn.pages.find((p) => p.page_id === form.page_id);
      if (!page) { result.errors.push(`Page ${form.page_id} is no longer available on this connection.`); continue; }

      try {
        const { leads, truncated } = await this.graph.formLeads(form.form_id, page.token, MAX_LEADS_PER_FORM);
        result.forms++;
        /*
         * Say so when the ceiling stopped us mid-form.
         *
         * Reported as an error line rather than a log entry, because it is the one outcome an
         * operator has to act on: the remaining submissions are not coming on the next run either,
         * since every run reads the same newest-first window. Raising META_MAX_LEADS_PER_FORM and
         * syncing again is the fix, and the message has to say that.
         */
        if (truncated) {
          result.errors.push(
            `${form.form_name ?? form.form_id}: stopped after ${MAX_LEADS_PER_FORM} lead(s) — this form has more. `
            + 'Raise META_MAX_LEADS_PER_FORM and sync again to bring in the rest.',
          );
        }
        for (const lead of leads) {
          try {
            const { outcome } = await this.upsertLead(lead, {
              userId, userName: user.name, pageId: form.page_id, pageName: page.name,
              formId: form.form_id, formName: form.form_name ?? undefined,
              // The signed-in person running the sync IS the connection's owner here.
              ownerId: ownerAtIntake(user),
            });
            // `duplicate` is counted under `duplicates` — the plural key on SyncResult.
            if (outcome === 'duplicate') result.duplicates++;
            else result[outcome]++;
          } catch (err) {
            result.skipped++;
            this.log.warn(`Meta lead ${lead.id} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        await this.prisma.meta_lead_forms.update({ where: { id: form.id }, data: { last_sync: new Date(), updated_at: new Date() } });
      } catch (err) {
        // One broken form must not abort the rest of the run.
        const message = err instanceof GraphError ? this.explain(err) : (err instanceof Error ? err.message : String(err));
        result.errors.push(`${form.form_name ?? form.form_id}: ${message}`);
        await this.connections.recordError(userId, message);

        /*
         * A dead token is not a per-form problem, and retrying the remaining forms is pointless —
         * every one of them will fail the same way, each costing another Graph call against the
         * shared budget and another identical error line.
         *
         * More importantly this is terminal until a human acts. Marking it here is what turns
         * "lead sync quietly stopped" into "your Meta connection needs reconnecting", which is the
         * whole difference between the two for a brokerage paying for the clicks.
         */
        if (err instanceof GraphError && isAuthFailure(err)) {
          await this.tokenDied(userId, user.name, message);
          result.errors.push('Lead collection is paused for this account until Meta is reconnected.');
          break;
        }
      }
    }

    await this.connections.touchSync(userId);
    await this.recordHistory(userId, trigger, startedAt, result);

    if (result.imported > 0) {
      await this.audit.record(user, 'Meta leads synced', `${result.imported} new lead(s)`,
        `${result.imported} imported, ${result.updated} updated, ${result.duplicates} merged into existing leads, ${result.forms} form(s) read`);
    }
    return result;
  }

  /**
   * The token is gone. Record it, and tell the person once.
   *
   * `token_expires_at` is set to now rather than a new flag being invented, because that is
   * factually what Meta just told us and every existing consumer already reads it — `status()`
   * derives `needs_reconnect` from it, so the screen becomes correct with no other change. A
   * REVOKED token is the case that made this necessary: somebody removes the app from their
   * Facebook account and the stored expiry is still weeks away, so nothing looked wrong while
   * nothing worked.
   *
   * The email goes out at most once per `META_RECONNECT_NOTICE_HOURS`. Without that guard the
   * scheduler would send one every fifteen minutes for ever, which is how a real alert becomes
   * something people filter.
   */
  private async tokenDied(userId: number, userName: string, message: string): Promise<void> {
    const due = await this.connections.markTokenDead(userId);
    this.log.warn(`Meta token for ${userName} (#${userId}) is no longer valid: ${message}`);
    if (!due) return;
    try {
      await this.alerts.reconnectRequired(userId, message);
    } catch (e) {
      // A failed email must not lose the fact that the token is dead — that is already recorded.
      this.log.error(`Could not send the Meta reconnect notice to user #${userId}: ${(e as Error).message}`);
    }
  }

  /** Turn a Graph failure into something an agent can act on. */
  private explain(err: GraphError): string {
    if (err.code === 190) return 'The Facebook access token has expired or been revoked — reconnect Meta.';
    if (err.code === 4 || err.code === 17 || err.code === 32) return 'Facebook is rate-limiting these requests. Try again shortly.';
    if (err.code === 10 || err.code === 200) return 'The connected account is missing a required permission (leads_retrieval). Reconnect and grant it.';
    if (err.code === 100) return `Facebook rejected the request: ${err.message}`;
    return err.message;
  }

  private async recordHistory(userId: number, trigger: string, startedAt: Date, r: SyncResult): Promise<void> {
    try {
      await this.prisma.meta_sync_history.create({
        data: {
          user_id: userId, trigger, forms_read: r.forms,
          imported: r.imported, updated: r.updated, skipped: r.skipped, duplicates: r.duplicates,
          errors: r.errors.length ? JSON.stringify(r.errors) : null,
          started_at: startedAt, finished_at: new Date(),
        },
      });
    } catch (err) {
      this.log.warn(`Could not record Meta sync history: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async syncHistory(userId: number, limit = 20): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.meta_sync_history.findMany({
      where: { user_id: userId }, orderBy: { id: 'desc' }, take: Math.min(100, limit),
    });
    return rows.map((h) => ({
      id: h.id, trigger: h.trigger, forms_read: h.forms_read,
      imported: h.imported, updated: h.updated, duplicates: h.duplicates, skipped: h.skipped,
      errors: h.errors ? (JSON.parse(h.errors) as string[]) : [],
      started_at: h.started_at.toISOString(),
      finished_at: h.finished_at?.toISOString() ?? null,
    }));
  }

  // ------------------------------------------------------------- webhooks
  /**
   * Handle one `leadgen` change, exactly once.
   *
   * The event row is claimed first via a unique key. If the insert conflicts the delivery is a
   * retry, so it is acknowledged without touching the database again — which is what makes
   * repeated delivery safe.
   */
  async ingestWebhookLead(leadgenId: string, formId: string, pageId: string, payload?: unknown): Promise<{ status: string; leadId: number | null }> {
    const eventKey = `${pageId}:${formId}:${leadgenId}`.slice(0, 200);
    const now = new Date();

    const claimed = await this.claim(eventKey, leadgenId, formId, pageId, payload, now);
    if (!claimed.fresh) {
      this.log.log(`Meta webhook ${eventKey} already handled (${claimed.status}) — ignoring the retry.`);
      return { status: 'duplicate', leadId: claimed.leadId };
    }

    const finish = (status: string, leadId: number | null, error?: string) =>
      this.prisma.meta_webhook_events.update({
        where: { event_key: eventKey },
        data: { status, lead_id: leadId, error: error ?? null, processed_at: new Date() },
      }).then(() => ({ status, leadId }));

    /*
     * ONE FORM BELONGS TO ONE AGENT, so this resolves to exactly one owner.
     *
     * Each agent connects their own Meta account, their own Page and their own lead forms, and
     * receives their own leads. Nothing is shared. `meta_lead_forms_page_form_key` enforces that at
     * the database — a form already connected by somebody else is refused at the point of
     * connecting, with a message naming who holds it, rather than being allowed and then routed
     * ambiguously.
     *
     * That constraint is why this is now a safe lookup. It used to be `findFirst` over a set that
     * could genuinely hold several rows, which meant one agent silently received every lead from a
     * shared form and the other received none while their screen showed it connected.
     *
     * The `> 1` branch below cannot be reached through the API; it exists because rows predating the
     * constraint could still be in an older database, and answering that with an arbitrary pick
     * would recreate the original defect. Refusing loudly is the honest failure.
     */
    const forms = await this.prisma.meta_lead_forms.findMany({
      where: { form_id: formId, page_id: pageId, is_active: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    if (!forms.length) return finish('ignored', null, 'That lead form is not connected here.');
    if (forms.length > 1) {
      const owners = forms.map((f) => f.user_id).join(', ');
      this.log.error(`Meta form ${formId} on page ${pageId} is connected by more than one user (${owners}) — refusing to guess whose lead this is.`);
      return finish('failed', null,
        `This lead form is connected by more than one agent (users ${owners}), so there is no single owner for the lead. `
        + 'Each agent must connect their own form: disconnect it from all but one account and sync again.');
    }

    const form = forms[0];
    const conn = await this.connections.find(form.user_id);
    const page = conn?.pages.find((p) => p.page_id === pageId);
    if (!conn || !page) return finish('failed', null, `No active Meta connection for page ${pageId}.`);

    const owner = await this.prisma.users.findUnique({
      where: { id: form.user_id },
      // `role` decides whether this connection is the brokerage's advertising or an agent's own,
      // which decides who owns the lead. The webhook runs with no request in context, so the
      // connecting user's role has to be read here.
      select: { id: true, name: true, status: true, role: true },
    });

    /*
     * A LEAD IS NOT DELIVERED TO AN ACCOUNT THAT HAS BEEN SWITCHED OFF.
     *
     * The form still belongs to this agent — that is the rule, and a form is never reassigned
     * behind anybody's back — but their account is inactive, so a lead written against them would
     * be visible to nobody: they cannot sign in, and a book belongs to one person. It would sit in
     * the database looking imported while no screen in the application could reach it.
     *
     * Recorded as `failed` with a reason rather than `ignored`, because this is a state somebody
     * has to resolve: it surfaces on the webhook health view instead of passing silently. The
     * submission itself is not lost — Meta keeps it retrievable, and reconnecting the form to
     * whoever is running it now collects it.
     *
     * This is why disconnecting Meta comes FIRST when an agent leaves, ahead of deactivating them
     * (see `OffboardingService`): done in that order, the form is already free and the successor
     * receives this lead instead of it landing here.
     */
    if (owner && (owner.status ?? 'Active') !== 'Active') {
      this.log.warn(`Meta webhook lead for form ${formId} refused: ${owner.name}'s account is ${owner.status}.`);
      return finish('failed', null,
        `This lead form belongs to ${owner.name}, whose account is ${owner.status}, so the lead has `
        + 'no owner who could see it. Disconnect Meta on that account and connect the form to '
        + 'whoever is running it now — this submission can then be collected from Meta.');
    }

    try {
      const lead = await this.graph.lead(leadgenId, page.token);
      const { outcome, leadId, rule } = await this.upsertLead(lead, {
        userId: form.user_id, userName: owner?.name ?? 'Meta', pageId, pageName: page.name,
        formId, formName: form.form_name ?? undefined,
        ownerId: ownerAtIntake(owner),
      });

      await this.connections.touchWebhook(form.user_id);
      if (outcome === 'imported' && owner) {
        await this.audit.record({ id: owner.id, name: owner.name } as AuthUserRecord,
          'Meta lead received', this.mapLead(lead.field_data).name, `Webhook · ${page.name}`);
      }
      return finish(outcome === 'duplicate' ? 'duplicate' : 'processed', leadId,
        rule ? `Matched an existing lead by ${rule}.` : undefined);
    } catch (err) {
      const message = err instanceof GraphError ? this.explain(err) : (err instanceof Error ? err.message : String(err));
      await this.connections.recordError(form.user_id, message);
      return finish('failed', null, message);
    }
  }

  /** Insert the event row, or report that this delivery was already seen. */
  private async claim(eventKey: string, leadgenId: string, formId: string, pageId: string, payload: unknown, now: Date):
  Promise<{ fresh: boolean; status: string; leadId: number | null }> {
    try {
      await this.prisma.meta_webhook_events.create({
        data: {
          event_key: eventKey, leadgen_id: leadgenId || null, form_id: formId || null, page_id: pageId || null,
          status: 'received', payload: payload ? JSON.stringify(payload).slice(0, 20000) : null,
          received_at: now,
        },
      });
      return { fresh: true, status: 'received', leadId: null };
    } catch {
      // Unique violation — Meta re-delivered. Count the attempt and report the first outcome.
      const existing = await this.prisma.meta_webhook_events.findUnique({ where: { event_key: eventKey } });
      if (existing) {
        await this.prisma.meta_webhook_events.update({
          where: { event_key: eventKey }, data: { attempts: { increment: 1 } },
        });
        return { fresh: false, status: existing.status, leadId: existing.lead_id };
      }
      return { fresh: true, status: 'received', leadId: null };
    }
  }

  /** Recent deliveries plus a health summary for the settings panel. */
  /**
   * Recent webhook deliveries for the caller's own forms, and whether Meta is still reaching us.
   *
   * SCOPED, WHICH IT WAS NOT. This took no user id and returned every row to anybody with
   * `meta:view` — `leadgen_id`, `form_id`, `page_id` and the resulting `lead_id` for every agent in
   * the brokerage. It was the only unscoped read in the module, in a module whose entire premise is
   * that an agent sees their own leads and nobody else's.
   *
   * Scoping is by `form_id`, which is the right key rather than a convenient one: a Meta form id is
   * globally unique, so "events for my forms" is exactly "events that were or would have been
   * mine". Forms the agent has since disconnected are included deliberately — their delivery
   * history is still theirs, and losing it the moment a form is switched off would hide the very
   * period somebody is trying to diagnose.
   *
   * A Super Admin sees everything, including deliveries for forms nobody has connected. That is the
   * one view where an unroutable delivery is visible at all, and diagnosing "Meta says it sent it,
   * where did it go?" is impossible without it.
   */
  async webhookHealth(user: AuthUserRecord, limit = 20): Promise<Record<string, unknown>> {
    const take = Math.min(100, Math.max(1, limit));
    const everything = isSuperAdmin(user);

    let where: Prisma.meta_webhook_eventsWhereInput = {};
    if (!everything) {
      const forms = await this.prisma.meta_lead_forms.findMany({
        where: { user_id: user.id ?? 0 },
        select: { form_id: true },
      });
      const ids = [...new Set(forms.map((f) => f.form_id))];
      // No forms, no deliveries — and `in: []` matches nothing, which is the answer we want.
      where = { form_id: { in: ids } };
    }

    const [rows, total, failed, lastRow, connectedForms] = await Promise.all([
      this.prisma.meta_webhook_events.findMany({ where, orderBy: { id: 'desc' }, take }),
      this.prisma.meta_webhook_events.count({ where }),
      this.prisma.meta_webhook_events.count({ where: { ...where, status: 'failed' } }),
      this.prisma.meta_webhook_events.findFirst({ where, orderBy: { id: 'desc' } }),
      this.prisma.meta_lead_forms.count({
        where: { is_active: true, ...(everything ? {} : { user_id: user.id ?? 0 }) },
      }),
    ]);

    /*
     * The signal worth having: forms are connected but nothing has arrived for a long time.
     *
     * A webhook stops silently — a lapsed subscription, a redeployed host, an expired tunnel — and
     * the only symptom is leads that never appear, which looks identical to a quiet week. Polling
     * covers the gap, so this is a warning rather than an alarm, but "connected and silent" is the
     * shape of the failure and nothing was reporting it.
     */
    const lastAt = lastRow?.received_at ?? null;
    const quietFor = lastAt ? Date.now() - lastAt.getTime() : null;
    const stalled = connectedForms > 0 && (quietFor === null || quietFor > WEBHOOK_QUIET_ALERT_MS);

    return {
      total,
      failed,
      connected_forms: connectedForms,
      last_received_at: lastAt?.toISOString() ?? null,
      quiet_for_hours: quietFor === null ? null : Math.floor(quietFor / 3_600_000),
      stalled,
      stalled_reason: stalled
        ? (lastAt
          ? `No webhook delivery for ${Math.floor((quietFor ?? 0) / 3_600_000)} hours while ${connectedForms} form(s) are connected. `
            + 'Scheduled polling is still collecting leads, but check the Meta subscription and that '
            + 'META_PUBLIC_URL still points at this deployment.'
          : `${connectedForms} form(s) are connected but no webhook delivery has ever been received. `
            + 'Check the subscription and that META_PUBLIC_URL is reachable from Meta.')
        : null,
      events: rows.map((e) => ({
        id: e.id, leadgen_id: e.leadgen_id, form_id: e.form_id, page_id: e.page_id,
        status: e.status, error: e.error, lead_id: e.lead_id, attempts: e.attempts,
        received_at: e.received_at.toISOString(),
        processed_at: e.processed_at?.toISOString() ?? null,
      })),
    };
  }

  /** Re-derive the normalized phone for a lead saved through the Leads module. */
  static normalizePhone = normalizePhone;
}
