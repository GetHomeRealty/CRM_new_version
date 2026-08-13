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
import { mapMetaLead, normalizePhone, type MappedMetaLead } from './meta-lead-mapper';
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
   * Decide who owns an imported lead.
   *
   * The Leads module scopes an agent to leads assigned to them, so an unassigned Meta lead
   * would be invisible to the very person meant to work it. It therefore goes to the user whose
   * Meta connection produced it — the same rule the Leads module applies to agent-created leads.
   */
  private assignee(ctx: LeadContext): number {
    return ctx.userId;
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
   * Find an existing lead for this submission, in the order the brief requires:
   * Meta lead id → email → normalized phone. Returns the row and which rule matched.
   *
   * `facebook_lead_id` is deliberately NOT scoped: it is globally unique, so a match is the same
   * submission arriving twice rather than a different person, and the row it finds is by definition
   * the one this delivery already created. Scoping it would let a retry create a second copy.
   */
  private async findExisting(facebookLeadId: string, mapped: MappedMetaLead, userId: number): Promise<{ id: number; rule: string } | null> {
    const byMetaId = await this.prisma.leads.findFirst({
      where: { facebook_lead_id: facebookLeadId },
      select: { id: true },
    });
    if (byMetaId) return { id: byMetaId.id, rule: 'meta lead id' };

    const mine = this.ownBook(userId);

    if (mapped.email && EMAIL_SHAPE.test(mapped.email)) {
      const byEmail = await this.prisma.leads.findFirst({
        where: { email: { equals: mapped.email, mode: 'insensitive' }, deleted_at: null, ...mine },
        select: { id: true },
      });
      if (byEmail) return { id: byEmail.id, rule: 'email address' };
    }

    if (mapped.phone_normalized) {
      const byPhone = await this.prisma.leads.findFirst({
        where: { phone_normalized: mapped.phone_normalized, deleted_at: null, ...mine },
        select: { id: true },
      });
      if (byPhone) return { id: byPhone.id, rule: 'phone number' };
    }
    return null;
  }

  /**
   * A lead of this agent's that was soft-deleted and holds the address this submission needs.
   *
   * `findExisting` filters out deleted rows on purpose — a deleted lead is not one to enrich — but
   * the `lower(email)` unique index still holds the address, so creating the new row raises P2002
   * and the submission was lost outright. A person who enquires again after their lead was tidied
   * away is exactly the enquiry a brokerage most wants, and it was the one guaranteed to fail.
   */
  private async deletedHolder(email: string, userId: number): Promise<{ id: number } | null> {
    if (!email) return null;
    return this.prisma.leads.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, deleted_at: { not: null }, ...this.ownBook(userId) },
      select: { id: true },
    });
  }

  /**
   * Turn one Graph lead into a row in `leads`, or enrich the record it duplicates.
   *
   * Idempotent by construction: the same `facebook_lead_id` always resolves to the same row, so
   * a webhook retry and a manual sync racing on one submission cannot both insert.
   */
  async upsertLead(lead: GraphLead, ctx: LeadContext): Promise<{ outcome: UpsertOutcome; leadId: number | null; rule?: string }> {
    const facebookLeadId = str(lead.id);
    if (!facebookLeadId) return { outcome: 'skipped', leadId: null };

    const mapped = this.mapLead(lead.field_data);
    const attribution = this.attribution(lead);
    const createdAt = lead.created_time ? new Date(lead.created_time) : new Date();
    const now = new Date();

    const existing = await this.findExisting(facebookLeadId, mapped, ctx.userId);

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
      // Enrich rather than duplicate: the Meta identifiers and answers are attached to the
      // record that already represents this person, and their existing details are left alone.
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
      return { outcome: existing.rule === 'meta lead id' ? 'updated' : 'duplicate', leadId: existing.id, rule: existing.rule };
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
    const buried = await this.deletedHolder(email, ctx.userId);
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
        owner_user_id: ctx.userId,
        created_by: `Meta${ctx.pageName ? ` · ${ctx.pageName}` : ''}`,
        created_at: createdAt,
      },
    });
    // Best-effort "new lead from Meta" email to the assigned agent; never blocks the sync.
    void this.notifications.notifyNewLead(row);
    void this.metaArrived(row, ctx, facebookLeadId);
    return { outcome: 'imported', leadId: row.id };
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
      select: { id: true, name: true, status: true },
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
