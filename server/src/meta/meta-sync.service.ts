import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeadAuditService } from '../leads/lead-audit.service';
import { LeadNotificationService } from '../leads/lead-notification.service';
import { MetaConnectionService } from './meta-connection.service';
import { MetaGraphService, GraphError, type GraphLead } from './meta-graph.service';
import { mapMetaLead, normalizePhone, type MappedMetaLead } from './meta-lead-mapper';
import { MAX_LEADS_PER_FORM } from './meta.constants';
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
  ) {}

  /** Exposed for tests and for re-mapping a stored payload. */
  mapLead(fieldData: GraphLead['field_data']): MappedMetaLead {
    return mapMetaLead(fieldData);
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
   * Find an existing lead for this submission, in the order the brief requires:
   * Meta lead id → email → normalized phone. Returns the row and which rule matched.
   */
  private async findExisting(facebookLeadId: string, mapped: MappedMetaLead): Promise<{ id: number; rule: string } | null> {
    const byMetaId = await this.prisma.leads.findFirst({
      where: { facebook_lead_id: facebookLeadId },
      select: { id: true },
    });
    if (byMetaId) return { id: byMetaId.id, rule: 'meta lead id' };

    if (mapped.email && EMAIL_SHAPE.test(mapped.email)) {
      const byEmail = await this.prisma.leads.findFirst({
        where: { email: { equals: mapped.email, mode: 'insensitive' }, deleted_at: null },
        select: { id: true },
      });
      if (byEmail) return { id: byEmail.id, rule: 'email address' };
    }

    if (mapped.phone_normalized) {
      const byPhone = await this.prisma.leads.findFirst({
        where: { phone_normalized: mapped.phone_normalized, deleted_at: null },
        select: { id: true },
      });
      if (byPhone) return { id: byPhone.id, rule: 'phone number' };
    }
    return null;
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

    const existing = await this.findExisting(facebookLeadId, mapped);

    const metaFields = {
      facebook_lead_id: facebookLeadId,
      facebook_form_id: ctx.formId || null,
      facebook_page_id: ctx.pageId || null,
      meta_page_name: ctx.pageName ?? null,
      meta_form_name: ctx.formName ?? null,
      ...attribution,
      meta_created_at: createdAt,
      meta_imported_at: now,
      meta_raw: JSON.stringify(lead),
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

    const row = await this.prisma.leads.create({
      data: {
        ...metaFields,
        name: mapped.name.slice(0, 255),
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
    return { outcome: 'imported', leadId: row.id };
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

    for (const form of forms) {
      const page = conn.pages.find((p) => p.page_id === form.page_id);
      if (!page) { result.errors.push(`Page ${form.page_id} is no longer available on this connection.`); continue; }

      try {
        const leads = await this.graph.formLeads(form.form_id, page.token, MAX_LEADS_PER_FORM);
        result.forms++;
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

    const form = await this.prisma.meta_lead_forms.findFirst({ where: { form_id: formId, page_id: pageId, is_active: true } });
    if (!form) return finish('ignored', null, 'That lead form is not connected here.');

    const conn = await this.connections.find(form.user_id);
    const page = conn?.pages.find((p) => p.page_id === pageId);
    if (!conn || !page) return finish('failed', null, `No active Meta connection for page ${pageId}.`);

    try {
      const owner = await this.prisma.users.findUnique({ where: { id: form.user_id }, select: { id: true, name: true } });
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
  async webhookHealth(limit = 20): Promise<Record<string, unknown>> {
    const [rows, total, failed, lastRow] = await Promise.all([
      this.prisma.meta_webhook_events.findMany({ orderBy: { id: 'desc' }, take: Math.min(100, limit) }),
      this.prisma.meta_webhook_events.count(),
      this.prisma.meta_webhook_events.count({ where: { status: 'failed' } }),
      this.prisma.meta_webhook_events.findFirst({ orderBy: { id: 'desc' } }),
    ]);
    return {
      total,
      failed,
      last_received_at: lastRow?.received_at.toISOString() ?? null,
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
