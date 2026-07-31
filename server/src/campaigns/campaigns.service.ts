import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { CampaignAudienceService, type AudienceFilter } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';
import { MailDeliverabilityService } from './mail-deliverability.service';
import { MAX_RECIPIENTS, SEND_DELAY_MS } from './campaign.constants';
import type { AuthUserRecord } from '../auth/auth.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parseJsonArray = (v: string | null): string[] => {
  try { const a = JSON.parse(v ?? '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
};

export interface SendCampaignInput {
  name?: unknown;
  template_id?: unknown;
  leadStatus?: unknown;
  leadType?: unknown;
  leadSource?: unknown;
  clientType?: unknown;
  tag?: unknown;
  tags?: unknown;
  /** Absolute, publicly reachable base URL for tracking links. */
  baseUrl: string;
}

@Injectable()
export class CampaignsService {
  private readonly log = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: CampaignAudienceService,
    private readonly templates: CampaignTemplatesService,
    private readonly deliverability: MailDeliverabilityService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * A campaign is private to whoever created it, for EVERY role. An admin or super-admin sees
   * their own campaigns, never another user's — the same rule the Leads and Calendar modules use,
   * applied through the `created_by_id` column.
   */
  private ownerScope(user: AuthUserRecord): Record<string, unknown> {
    return { created_by_id: user.id ?? -1 };
  }

  // ------------------------------------------------------------------ read
  /** Recent campaigns without the heavy recipient list. */
  async list(user: AuthUserRecord, limit = 100): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.campaigns.findMany({
      where: this.ownerScope(user),
      orderBy: { id: 'desc' }, take: Math.min(200, limit),
    });
    return rows.map((c) => this.summary(c));
  }

  /** One campaign including every recipient's result. */
  async get(id: number, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const c = await this.prisma.campaigns.findFirst({
      where: { id, ...this.ownerScope(user) },
      include: { recipients: { orderBy: { id: 'asc' } } },
    });
    if (!c) throw new NotFoundException({ message: 'Campaign not found.' });
    return {
      ...this.summary(c),
      subject: c.subject,
      content: c.content,
      audience: JSON.parse(c.audience ?? '{}'),
      recipients: c.recipients.map((r) => ({
        id: r.id,
        lead_id: r.lead_id,
        name: r.name,
        email: r.email,
        status: r.status,
        error: r.error,
        opened: r.opened,
        opened_at: r.opened_at?.toISOString() ?? null,
        unsubscribed: r.unsubscribed,
        bounced: r.bounced,
      })),
    };
  }

  async remove(id: number, user: AuthUserRecord): Promise<{ success: boolean }> {
    // Scoped, so an agent cannot delete a campaign they did not create — nor learn that one
    // exists by getting a different error for it.
    const c = await this.prisma.campaigns.findFirst({ where: { id, ...this.ownerScope(user) }, select: { id: true } });
    if (!c) throw new NotFoundException({ message: 'Campaign not found.' });
    // recipients cascade
    await this.prisma.campaigns.delete({ where: { id } });
    return { success: true };
  }

  /** Recipient count + a small sample, for the builder's live audience preview. */
  async preview(filter: AudienceFilter, user: AuthUserRecord): Promise<{ count: number; sample: { name: string; email: string }[] }> {
    const recipients = await this.audience.resolveRecipients(filter, user);
    return {
      count: recipients.length,
      sample: recipients.slice(0, 5).map((r) => ({ name: r.name, email: r.email })),
    };
  }

  // ------------------------------------------------------------------ send
  /**
   * Create a campaign and send it to the resolved audience.
   *
   * The campaign row is written before the first send so the run is tracked even if
   * sending stalls, and each recipient's outcome is recorded individually.
   */
  async createAndSend(input: SendCampaignInput, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const name = String(input.name ?? '').trim();
    if (!name) throw new BadRequestException({ message: 'Campaign name is required.' });

    const templateId = Number(input.template_id);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      throw new BadRequestException({ message: 'A valid template must be selected.' });
    }
    // Campaign templates only — Email Settings' transactional templates are a separate library
    // and must never be sent as marketing mail.
    const template = await this.prisma.campaign_templates.findFirst({ where: { id: templateId, deleted_at: null } });
    if (!template) throw new NotFoundException({ message: 'Template not found.' });

    const filter: AudienceFilter = {
      leadStatus: String(input.leadStatus ?? '') || undefined,
      leadType: String(input.leadType ?? '') || undefined,
      leadSource: String(input.leadSource ?? '') || undefined,
      clientType: String(input.clientType ?? '') || undefined,
      tag: String(input.tag ?? '') || undefined,
    };

    // Scoped to the sender: an agent's campaign reaches only their own leads, never the whole book.
    const recipients = await this.audience.resolveRecipients(filter, user);
    if (recipients.length === 0) {
      throw new BadRequestException({ message: 'No leads match this audience. Adjust the filters and try again.' });
    }
    if (recipients.length > MAX_RECIPIENTS) {
      throw new BadRequestException({
        message: `This audience has ${recipients.length} recipients, above the ${MAX_RECIPIENTS} limit for a single campaign. Narrow the filters and split it into multiple campaigns.`,
      });
    }

    const now = new Date();
    const tokens = recipients.map(() => this.audience.newRecipientToken());
    const tags = Array.isArray(input.tags) ? (input.tags as unknown[]).map(String).map((t) => t.trim()).filter(Boolean) : [];

    const campaign = await this.prisma.campaigns.create({
      data: {
        name,
        template_id: template.id,
        template_name: template.name,
        category: template.category,
        subject: template.subject,
        content: template.content,
        audience: JSON.stringify(filter),
        tags: JSON.stringify(tags),
        status: 'sending',
        total: recipients.length,
        created_by: user.name,
        created_by_id: user.id ?? null,
        created_at: now,
        updated_at: now,
        recipients: {
          create: recipients.map((r, i) => ({
            lead_id: r.leadId, name: r.name, email: r.email, token: tokens[i],
            status: 'pending', created_at: now, updated_at: now,
          })),
        },
      },
      include: { recipients: { orderBy: { id: 'asc' } } },
    });

    const agentVars = {
      agentName: user.name,
      agentEmail: user.email ?? undefined,
      // AGENT_PHONE is offered as a fillable token, so it has to resolve to something real:
      // the sender's row on the agent roster, else the brokerage's own number.
      agentPhone: await this.agentPhone(user),
    };
    // Loaded once and reused for every recipient — re-reading the blobs per send would pull the
    // same megabytes out of the database hundreds of times.
    const attachments = await this.templates.attachmentsForSend(template.id);
    let sent = 0, failed = 0;

    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const row = campaign.recipients[i];

      // Bounce guard: an address whose domain cannot receive mail is recorded as bounced
      // rather than sent, so the campaign reports real deliverability.
      if (!(await this.deliverability.domainCanReceiveMail(r.email))) {
        failed++;
        await this.markRecipient(row.id, 'failed', true, 'Bounced: email domain cannot receive mail');
        continue;
      }

      const subject = this.audience.personalize(template.subject, { leadName: r.name, ...agentVars }, r.vars);
      let html = this.audience.personalize(template.content, { leadName: r.name, ...agentVars }, r.vars);
      html = this.audience.injectTracking(html, { baseUrl: input.baseUrl, campaignId: campaign.id, token: tokens[i] });

      try {
        // Pass the sending user's id so the campaign goes from THEIR own connected account (their
        // default, then any active one) and only falls back to the brokerage account if they have
        // none — matching how the rest of the app scopes mail. Without this every campaign used the
        // brokerage default regardless of who sent it.
        await this.mailer.sendDirect(r.email, subject, html, null, attachments, user.id ?? null);
        sent++;
        await this.markRecipient(row.id, 'sent', false, null);
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        await this.markRecipient(row.id, 'failed', true, message);
        // A missing/broken mail account fails every recipient — stop rather than hammer it.
        if (/no active smtp account/i.test(message)) {
          for (let j = i + 1; j < recipients.length; j++) {
            failed++;
            await this.markRecipient(campaign.recipients[j].id, 'failed', true, 'No active SMTP account is configured');
          }
          break;
        }
      }

      if (i < recipients.length - 1) await sleep(SEND_DELAY_MS);
    }

    const updated = await this.prisma.campaigns.update({
      where: { id: campaign.id },
      data: {
        sent, failed, bounced: failed,
        status: sent === 0 ? 'failed' : 'completed',
        sent_at: new Date(), updated_at: new Date(),
      },
    });
    this.log.log(`Campaign "${name}" (#${campaign.id}): ${sent} sent, ${failed} failed of ${recipients.length}.`);
    return this.summary(updated);
  }

  /**
   * Pre-flight check: send one test email through the exact account this user's campaigns would
   * use, so credentials can be verified before a real send. Never throws — the SMTP result
   * (success, or a message like Gmail's "535 BadCredentials") is returned for the UI to show.
   */
  async sendTest(user: AuthUserRecord, to: string): Promise<{ ok: boolean; from?: string; account?: string; error?: string }> {
    try {
      const res = await this.mailer.testForUser(user.id ?? null, to);
      return { ok: true, from: res.from, account: res.account };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * A contact number for {{AGENT_PHONE}}. Users have no phone column, so it comes from the agent
   * roster by name, falling back to the brokerage number. Empty when neither is on file — the
   * token is then stripped rather than left showing as literal text.
   */
  private async agentPhone(user: AuthUserRecord): Promise<string> {
    const agent = await this.prisma.agents.findFirst({
      where: { name: { equals: user.name, mode: 'insensitive' }, active: true },
      select: { phone: true },
    });
    if (agent?.phone) return agent.phone;
    const company = await this.prisma.company_settings.findFirst({ select: { phone: true } });
    return company?.phone ?? '';
  }

  private async markRecipient(id: number, status: string, bounced: boolean, error: string | null): Promise<void> {
    await this.prisma.campaign_recipients.update({
      where: { id },
      data: { status, bounced, error, updated_at: new Date() },
    });
  }

  // -------------------------------------------------------------- tracking
  /**
   * Record an open. Returns quietly whatever happens — the caller always serves the pixel
   * so the email still renders.
   */
  async recordOpen(campaignId: number, token: string): Promise<void> {
    const r = await this.prisma.campaign_recipients.findUnique({
      where: { token },
      include: { campaigns: { select: { id: true, sent_at: true } } },
    });
    if (!r || r.campaign_id !== campaignId) return;
    // A message that bounced or failed was never delivered, so it cannot have been read.
    if (r.bounced || r.status === 'failed') return;

    const now = new Date();
    if (!r.opened) {
      await this.prisma.$transaction([
        this.prisma.campaign_recipients.update({ where: { id: r.id }, data: { opened: true, opened_at: now, updated_at: now } }),
        this.prisma.campaigns.update({ where: { id: campaignId }, data: { opened: { increment: 1 }, updated_at: now } }),
      ]);
    } else {
      // Already counted — still record the latest open time.
      await this.prisma.campaign_recipients.update({ where: { id: r.id }, data: { opened_at: now, updated_at: now } });
    }
  }

  /** How long after sending a pixel hit is treated as a machine prefetch, not a read. */
  static readonly MACHINE_PREFETCH_WINDOW_MS = 10_000;

  /** Whether this open should be ignored because it arrived too soon after sending. */
  async isMachinePrefetch(campaignId: number): Promise<boolean> {
    const c = await this.prisma.campaigns.findUnique({ where: { id: campaignId }, select: { sent_at: true } });
    if (!c?.sent_at) return false;
    return Date.now() - c.sent_at.getTime() < CampaignsService.MACHINE_PREFETCH_WINDOW_MS;
  }

  /**
   * Process an unsubscribe: mark the recipient, add the address to the global suppression
   * list, and flag every matching lead so audience queries skip it.
   */
  async unsubscribe(campaignId: number, token: string): Promise<{ ok: boolean; email?: string }> {
    const r = await this.prisma.campaign_recipients.findUnique({ where: { token } });
    if (!r || r.campaign_id !== campaignId) return { ok: false };

    const now = new Date();
    const email = String(r.email ?? '').trim().toLowerCase();

    if (!r.unsubscribed) {
      await this.prisma.$transaction([
        this.prisma.campaign_recipients.update({ where: { id: r.id }, data: { unsubscribed: true, unsubscribed_at: now, updated_at: now } }),
        this.prisma.campaigns.update({ where: { id: campaignId }, data: { unsubscribed: { increment: 1 }, updated_at: now } }),
      ]);
    }

    if (email) {
      await this.prisma.email_suppressions.upsert({
        where: { email },
        create: { email, reason: 'unsubscribe', campaign_id: campaignId, created_at: now, updated_at: now },
        update: { reason: 'unsubscribe', campaign_id: campaignId, updated_at: now },
      });
      // Flag the lead(s) with this address so future audiences exclude them.
      await this.prisma.$executeRaw`UPDATE "leads" SET "unsubscribed" = true, "unsubscribed_at" = ${now}, "updated_at" = ${now} WHERE LOWER("email") = ${email}`;
    }
    return { ok: true, email };
  }

  // ----------------------------------------------------------------- leads
  /** Distinct tags across the leads the caller can audience, for the dropdowns. */
  async leadTags(user: AuthUserRecord): Promise<string[]> {
    const rows = await this.prisma.leads.findMany({
      // Scoped through the same audience rule, so an agent's tag list can't leak the existence of
      // segments they cannot actually send to.
      where: this.audience.buildAudienceWhere({}, user),
      select: { tags: true },
    });
    const set = new Set<string>();
    for (const r of rows) for (const t of parseJsonArray(r.tags)) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  // CSV lead import used to live here, as a second implementation of what `leads.service.ts` also
  // did — and the two had drifted: this one had no in-file de-duplication and no row cap, so the
  // same file behaved differently depending on which screen it was dropped on. Both now go through
  // `LeadImportEngine` and `LeadImportJobService`, which look up against an index, write in
  // batched transactions, and run off the request thread with progress a client can poll.

  /** Add or remove a tag across every lead matching a segment. */
  async tagSegment(filter: AudienceFilter, tag: string, mode: 'add' | 'remove', user: AuthUserRecord): Promise<{ count: number; message: string }> {
    const leads = await this.prisma.leads.findMany({ where: this.audience.buildAudienceWhere(filter, user), select: { id: true, tags: true } });
    const now = new Date();
    let changed = 0;
    for (const l of leads) {
      const tags = parseJsonArray(l.tags);
      const has = tags.includes(tag);
      if (mode === 'add' && has) continue;
      if (mode === 'remove' && !has) continue;
      const next = mode === 'add' ? [...tags, tag] : tags.filter((t) => t !== tag);
      await this.prisma.leads.update({ where: { id: l.id }, data: { tags: JSON.stringify(next), updated_at: now } });
      changed++;
    }
    return {
      count: changed,
      message: `${mode === 'add' ? 'Tagged' : 'Untagged'} ${changed} lead${changed === 1 ? '' : 's'} (${leads.length} matched).`,
    };
  }

  /** Count leads in a segment without changing anything. */
  async countSegment(filter: AudienceFilter, user: AuthUserRecord): Promise<number> {
    return this.prisma.leads.count({ where: this.audience.buildAudienceWhere(filter, user) });
  }


  // ---------------------------------------------------------------- output
  private summary(c: Record<string, unknown>): Record<string, unknown> {
    return {
      id: c.id,
      name: c.name,
      template_id: c.template_id,
      template_name: c.template_name,
      category: c.category,
      status: c.status,
      tags: parseJsonArray(c.tags as string | null),
      stats: {
        total: c.total, sent: c.sent, failed: c.failed,
        opened: c.opened, unsubscribed: c.unsubscribed, bounced: c.bounced,
      },
      created_by: c.created_by,
      created_at: c.created_at instanceof Date ? c.created_at.toISOString() : null,
      sent_at: c.sent_at instanceof Date ? c.sent_at.toISOString() : null,
    };
  }
}
