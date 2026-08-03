import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService, type MailAttachment } from '../email/mailer.service';
import { CampaignAudienceService, type AudienceFilter } from './campaign-audience.service';
import { runAsSystem } from '../core/tenant-context';
import { CampaignTemplatesService } from './campaign-templates.service';
import { MailDeliverabilityService } from './mail-deliverability.service';
import { classifyBounce, nextRetryAt, MAX_SOFT_RETRIES } from './bounce-classifier';
import { MAX_RECIPIENTS, SEND_DELAY_MS } from './campaign.constants';
import type { AuthUserRecord } from '../auth/auth.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The receiving domain, lowercased. Unparseable addresses share one bucket, which is the safe side. */
/** Stored personalisation values, or nothing if the column is empty or corrupt. */
const parseVars = (raw: string | null): Record<string, string> => {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch { return {}; }
};

/**
 * The requested send time, or null for send-now.
 *
 * Anything unparseable is treated as "now" rather than rejected: a campaign the author believed
 * they had queued must not sit in a draft state because a date string was malformed. Sending
 * immediately is the visible outcome; silently never sending is not.
 */
const parseSchedule = (raw: unknown): Date | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
};

const domainOf = (email: string): string => String(email ?? '').split('@')[1]?.toLowerCase() ?? '';

/**
 * List-Unsubscribe headers for a campaign message.
 *
 * Both forms: the mailto is the long-standing convention, the https URL plus One-Click is what
 * Gmail and Outlook actually surface as an unsubscribe button. One-Click requires the target to
 * accept POST, which is why the unsubscribe endpoint is a POST.
 */
function unsubHeaders(baseUrl: string, campaignId: number, token: string): Record<string, string> {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return {};
  const url = `${base}/api/campaigns/unsubscribe?c=${campaignId}&t=${encodeURIComponent(token)}`;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
const parseJsonArray = (v: string | null): string[] => {
  try { const a = JSON.parse(v ?? '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
};

export interface SendCampaignInput {
  /** ISO instant to send at. Absent or past means send now. */
  scheduled_for?: unknown;
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

  /**
   * Campaigns currently being delivered by this process.
   *
   * Two delivery passes over one campaign would both load its `pending` recipients and both send
   * to them — a second copy in somebody's inbox, which is the one failure this module treats as
   * worse than not sending at all. The risk arrived with soft-bounce retries: the retry sweep runs
   * every minute, and a large campaign's first pass can still be running when it fires.
   *
   * In-process only, which is enough because the sweeps are armed on a single scheduler owner
   * (see `schedulersEnabled`). Per-recipient status is still what makes a resume safe; this stops
   * two passes from racing before those writes land.
   */
  private readonly delivering = new Set<number>();

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
        // hard = the mailbox is gone and the address is now suppressed; soft = deferred and being
        // retried; unknown = a fault at our end that says nothing about the address. The results
        // screen has to show these differently — one is a list problem, one is a wait, one is ours.
        bounce_type: r.bounce_type,
        retry_count: r.retry_count,
        next_retry_at: r.next_retry_at?.toISOString() ?? null,
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
            lead_id: r.leadId, name: r.name, email: r.email, token: tokens[i], vars: JSON.stringify(r.vars ?? {}),
            status: 'pending', created_at: now, updated_at: now,
          })),
        },
      },
      include: { recipients: { orderBy: { id: 'asc' } } },
    });

    const agentVars = await this.agentVarsFor(user);
    // Loaded once and reused for every recipient — re-reading the blobs per send would pull the
    // same megabytes out of the database hundreds of times.
    const attachments = await this.templates.attachmentsForSend(template.id);

    /*
     * Hand the campaign back NOW and deliver in the background.
     *
     * Delivery used to be awaited by the controller, so the HTTP request stayed open for the whole
     * send: 400 ms per recipient plus an SMTP round trip each. Against the brokerage's own list
     * (512 leads) that is over three minutes on one request — past most browser patience and, at
     * ~750 recipients, past the 300 s proxy_read_timeout in the deployment guide. Worse, ANY
     * interruption — closed tab, timeout, deploy — stopped the loop midway, leaving some people
     * emailed and some not, with nothing recording where it got to.
     *
     * Now the campaign is persisted as `sending`, the caller gets it immediately, and the loop
     * runs detached, writing progress as it goes so the screen can poll. `void` is deliberate:
     * nothing awaits this, and `deliver` never throws.
     */
    /*
     * Scheduled for later? Persist and stop. The dispatcher picks it up when it comes due.
     *
     * Everything the send needs is already on the row by this point — recipients with their tokens
     * and personalisation, the subject and content as they were when the author approved them, the
     * tracking base URL — which is what makes a delayed send safe: it delivers what was written,
     * not what the template happens to say next Tuesday.
     *
     * A time in the past is treated as "now" rather than refused. Somebody scheduling 9am at 9:01,
     * or a clock a few seconds out, means send it — not an error about a moment that has passed.
     */
    const scheduledFor = parseSchedule(input.scheduled_for);
    if (scheduledFor && scheduledFor.getTime() > Date.now()) {
      const held = await this.prisma.campaigns.update({
        where: { id: campaign.id },
        data: {
          status: 'scheduled',
          scheduled_for: scheduledFor,
          tracking_base_url: input.baseUrl,
          updated_at: new Date(),
        },
      });
      this.log.log(`Campaign "${name}" (#${campaign.id}) scheduled for ${scheduledFor.toISOString()} (${recipients.length} recipients).`);
      return this.summary(held);
    }

    await this.prisma.campaigns.update({
      where: { id: campaign.id },
      // tracking_base_url is stored, not re-read at resume: messages already delivered carry the
      // URL they were built with, and the rest of the same campaign has to match them.
      data: { status: 'sending', tracking_base_url: input.baseUrl, updated_at: new Date() },
    });
    void this.deliver({
      campaignId: campaign.id, name, recipients, rows: campaign.recipients, tokens,
      template, agentVars, attachments, baseUrl: input.baseUrl, userId: user.id ?? null,
    });

    return this.summary(await this.prisma.campaigns.findUniqueOrThrow({ where: { id: campaign.id } }));
  }

  // ------------------------------------------------------------- suppression list
  /**
   * Who the brokerage may no longer email, and why.
   *
   * `email_suppressions` was written to and never read back by any screen, so the one question
   * compliance actually gets asked — "did we honour this person's opt-out?" — could only be
   * answered with a database query. CASL puts the burden of proof on the sender, so the record
   * being unreadable is most of the problem.
   *
   * Brokerage-wide by design, not per agent. A suppression is the recipient's decision about the
   * brokerage, and an agent must not be able to work around a colleague's opt-out by not seeing it.
   */
  async listSuppressions(q: { page?: unknown; limit?: unknown; search?: unknown } = {}): Promise<Record<string, unknown>> {
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    const search = String(q.search ?? '').trim().toLowerCase();
    const where = search ? { email: { contains: search, mode: 'insensitive' as const } } : {};

    const [rows, total] = await Promise.all([
      this.prisma.email_suppressions.findMany({
        where,
        orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.email_suppressions.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        email: r.email,
        reason: r.reason,
        campaign_id: r.campaign_id,
        created_at: r.created_at?.toISOString() ?? null,
        updated_at: r.updated_at?.toISOString() ?? null,
      })),
      meta: { page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /**
   * Take somebody off the suppression list.
   *
   * Deliberately narrow, and audited. Removing a suppression means resuming mail to a person who
   * asked for it to stop, so it is only ever right when they have asked to be put back — and the
   * record of who did it is the point. The matching `leads.unsubscribed` flags are cleared too;
   * leaving them would produce the confusing half-state where the address is no longer suppressed
   * but the lead is still excluded from every audience.
   */
  async removeSuppression(email: string, user: AuthUserRecord): Promise<{ removed: boolean }> {
    const address = String(email ?? '').trim().toLowerCase();
    if (!address) throw new BadRequestException({ message: 'An email address is required.' });

    const row = await this.prisma.email_suppressions.findUnique({ where: { email: address } });
    if (!row) throw new NotFoundException({ message: 'That address is not on the suppression list.' });

    const now = new Date();
    await this.prisma.email_suppressions.delete({ where: { email: address } });
    await this.prisma.$executeRaw`UPDATE "leads" SET "unsubscribed" = false, "unsubscribed_at" = NULL, "updated_at" = ${now} WHERE LOWER("email") = ${address}`;
    this.log.warn(`Suppression removed for ${address} by ${user.name ?? 'unknown'} — mail to this address will resume.`);
    return { removed: true };
  }

  /**
   * Send a campaign whose time has come. Reuses the resume path, which is already written to send
   * only the recipients still `pending` — for a scheduled campaign that is all of them.
   */
  async dispatchScheduled(campaignId: number): Promise<void> {
    await this.prisma.campaigns.update({
      where: { id: campaignId },
      data: { status: 'sending', updated_at: new Date() },
    });
    await this.resume(campaignId);
  }

  /**
   * Call a scheduled campaign off before it goes.
   *
   * Only while it is still `scheduled`. Once delivery starts there is no taking it back — some
   * recipients already have it — and pretending otherwise would be worse than refusing.
   */
  async cancelScheduled(campaignId: number, user: AuthUserRecord): Promise<{ cancelled: boolean }> {
    const c = await this.prisma.campaigns.findFirst({
      where: { id: campaignId, ...this.ownerScope(user) },
      select: { id: true, status: true },
    });
    if (!c) throw new NotFoundException({ message: 'Campaign not found.' });
    if (c.status !== 'scheduled') {
      throw new BadRequestException({
        message: c.status === 'sending'
          ? 'This campaign is already going out and cannot be cancelled.'
          : 'Only a scheduled campaign can be cancelled.',
      });
    }
    await this.prisma.campaigns.update({
      where: { id: campaignId },
      data: { status: 'draft', scheduled_for: null, updated_at: new Date() },
    });
    return { cancelled: true };
  }

  /**
   * Continue a campaign a restart interrupted.
   *
   * Rebuilds the job from what was persisted and hands it to the same delivery loop, filtered to
   * the recipients still `pending`. Anyone already marked `sent` or `failed` is skipped, which is
   * what makes this safe to run: the worst outcome of resuming twice is that it finds nothing to
   * do, never a second copy in somebody's inbox.
   */
  /**
   * The sender's own tokens, shared by a fresh send and a resumed one so both address recipients
   * identically. AGENT_PHONE is offered as a fillable token, so it has to resolve to something
   * real: the sender's row on the agent roster, else the brokerage's own number.
   */
  private async agentVarsFor(user: AuthUserRecord): Promise<Record<string, string | undefined>> {
    return {
      agentName: user.name,
      agentEmail: user.email ?? undefined,
      agentPhone: await this.agentPhone(user),
    };
  }

  async resume(campaignId: number): Promise<void> {
    const campaign = await this.prisma.campaigns.findUnique({ where: { id: campaignId } });
    if (!campaign) return;

    /*
     * The recipients still outstanding AND due now.
     *
     * `next_retry_at` is null for anyone never attempted — the state every recipient starts in, so
     * an interrupted campaign resumes exactly as before. It carries a time only for a soft bounce
     * waiting out its backoff, and honouring that is the whole point: retrying a full mailbox or a
     * greylisting server the instant it refuses us is indistinguishable from hammering it.
     */
    const pending = await this.prisma.campaign_recipients.findMany({
      where: {
        campaign_id: campaignId,
        status: 'pending',
        OR: [{ next_retry_at: null }, { next_retry_at: { lte: new Date() } }],
      },
      orderBy: { id: 'asc' },
    });
    if (!pending.length) return;

    const user = { id: campaign.created_by_id ?? null, name: campaign.created_by ?? '' } as AuthUserRecord;
    const attachments = campaign.template_id
      ? await this.templates.attachmentsForSend(campaign.template_id)
      : [];

    await this.deliver({
      campaignId,
      name: campaign.name,
      // Subject and content come from the CAMPAIGN row, not the template: a template edited since
      // the send began must not change what the second half of the campaign says.
      template: { subject: campaign.subject, content: campaign.content },
      recipients: pending.map((r) => ({
        leadId: r.lead_id ?? null,
        name: r.name ?? '',
        email: r.email,
        vars: parseVars(r.vars),
      })) as never,
      rows: pending.map((r) => ({ id: r.id, retry_count: r.retry_count })),
      tokens: pending.map((r) => r.token),
      agentVars: await this.agentVarsFor(user),
      attachments,
      baseUrl: campaign.tracking_base_url ?? '',
      userId: campaign.created_by_id ?? null,
    });
  }

  /**
   * Deliver one campaign, one recipient at a time, off the request thread.
   *
   * Never throws — it is called with `void`, so an escaping error would be an unhandled rejection
   * that takes the process down. Everything is written to the campaign row instead, which is what
   * the screen polls.
   */
  private async deliver(job: {
    campaignId: number; name: string; recipients: Awaited<ReturnType<CampaignAudienceService['resolveRecipients']>>;
    /** The recipient rows this pass owns. `retry_count` carries how many attempts each has had. */
    rows: { id: number; retry_count?: number | null }[]; tokens: string[]; template: { subject: string; content: string };
    agentVars: Record<string, string | undefined>; attachments: MailAttachment[];
    baseUrl: string; userId: number | null;
  }): Promise<void> {
   // Already going out. Whatever this pass was asked to send, the pass that holds the campaign is
   // working through the same `pending` rows and will reach them.
   if (this.delivering.has(job.campaignId)) {
     this.log.warn(`Campaign #${job.campaignId} is already being delivered — this pass was skipped rather than sending twice.`);
     return;
   }
   this.delivering.add(job.campaignId);
   try {
    const { recipients, tokens, template, agentVars, attachments, baseUrl } = job;
    const campaign = { id: job.campaignId, recipients: job.rows };
    const user = { id: job.userId } as AuthUserRecord;
    const name = job.name;

    /*
     * Continue the campaign's existing counters rather than restarting them at zero.
     *
     * This pass may be a resume or a soft-bounce retry, which is handed only the recipients still
     * outstanding — counting from zero would write those few results over the totals from the rest
     * of the send, so a campaign that reached 480 people and then retried 3 would report 3. A
     * deferred recipient counts as neither sent nor failed while it waits, so nothing is
     * double-counted when it is finally settled here.
     */
    const prior = await this.prisma.campaigns.findUnique({
      where: { id: campaign.id },
      select: { sent: true, failed: true, bounced: true, sent_at: true },
    });
    let sent = prior?.sent ?? 0, failed = prior?.failed ?? 0, bounced = prior?.bounced ?? 0;
    /** Soft bounces left queued for a later attempt. They keep the campaign open. */
    let deferred = 0;
    /** When we last sent to each receiving domain, so the wait is per-domain rather than global. */
    const lastSendByDomain = new Map<string, number>();

    /*
     * Register the body's links once, up front, and reuse the ids for every recipient.
     *
     * Per-recipient rows would mean one `campaign_links` row per recipient per link — 500 people
     * and 6 links is 3,000 rows saying the same six things — and would make "which link was
     * popular" a grouping problem instead of a lookup. The recipient is identified by their token
     * in the tracking URL, so nothing is lost by sharing the link row.
     */
    const linkIds = new Map<string, number>();
    try {
      for (const url of this.audience.extractLinks(template.content)) {
        const row = await this.prisma.campaign_links.create({
          data: { campaign_id: campaign.id, url, created_at: new Date() },
        });
        linkIds.set(url, row.id);
      }
    } catch (err) {
      // Tracking is not worth failing a send over: without ids the links are simply left alone and
      // still work, which is the right way for this to degrade.
      this.log.warn(`Campaign #${campaign.id}: could not register links for click tracking — ${err instanceof Error ? err.message : String(err)}`);
    }

    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const row = campaign.recipients[i];

      /*
       * Bounce guard: a domain that does not exist cannot receive mail, now or ever. That is the
       * definition of a hard bounce, so it is treated as one — recorded as bounced rather than
       * sent, and the address suppressed so no future campaign spends a send on it.
       */
      if (!(await this.deliverability.domainCanReceiveMail(r.email))) {
        failed++;
        bounced++;   // a real bounce — the only thing that may be counted as one
        await this.markRecipient(row.id, {
          status: 'failed', bounced: true, bounce_type: 'hard',
          error: 'Hard bounce: the email domain does not exist and cannot receive mail.',
        });
        await this.suppressHardBounce(r.email, campaign.id);
        continue;
      }

      lastSendByDomain.set(domainOf(r.email), Date.now());
      const subject = this.audience.personalize(template.subject, { leadName: r.name, ...agentVars }, r.vars);
      let html = this.audience.personalize(template.content, { leadName: r.name, ...agentVars }, r.vars);
      // Rewrite BEFORE injectTracking appends the unsubscribe link, so that link stays direct —
      // opting out must not depend on the click endpoint being healthy.
      html = this.audience.rewriteLinks(html, { baseUrl, campaignId: campaign.id, token: tokens[i], links: linkIds });
      html = this.audience.injectTracking(html, { baseUrl, campaignId: campaign.id, token: tokens[i] });

      try {
        // Pass the sending user's id so the campaign goes from THEIR own connected account (their
        // default, then any active one) and only falls back to the brokerage account if they have
        // none — matching how the rest of the app scopes mail. Without this every campaign used the
        // brokerage default regardless of who sent it.
        await this.mailer.sendDirect(
          r.email, subject, html, null, attachments, user.id ?? null,
          // RFC 2369 / RFC 8058. Gmail and Outlook weigh a missing List-Unsubscribe against inbox
          // placement for bulk senders, so its absence makes legitimate campaign mail look like
          // spam — which then reads as a list problem. One-Click points at the POST endpoint,
          // which is why that endpoint had to exist as a POST.
          unsubHeaders(baseUrl, campaign.id, tokens[i]),
        );
        sent++;
        await this.markRecipient(row.id, { status: 'sent', bounced: false, error: null, bounce_type: null, next_retry_at: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const verdict = classifyBounce(message);
        const attempt = (row.retry_count ?? 0) + 1;

        if (verdict.type === 'soft' && attempt <= MAX_SOFT_RETRIES) {
          /*
           * A transient refusal — mailbox full, greylisted, rate-limited. The address is fine and
           * the moment was not, so the recipient stays `pending` with a time it may be tried again.
           * It counts as neither sent nor failed while it waits: reporting it as a failure would
           * be wrong, and reporting it as sent would be a lie.
           */
          deferred++;
          const due = nextRetryAt(attempt);
          await this.markRecipient(row.id, {
            status: 'pending', bounced: false, bounce_type: 'soft',
            retry_count: attempt, next_retry_at: due,
            error: `${verdict.reason} (attempt ${attempt} of ${MAX_SOFT_RETRIES}, next try ${due.toISOString()})`,
          });
        } else if (verdict.type === 'hard') {
          /*
           * The mailbox is gone. Suppress the address: continuing to mail somewhere that has
           * already said "no such user" is precisely what mailbox providers score a sender down
           * for, and the next campaign would otherwise make the same attempt.
           */
          failed++;
          bounced++;
          await this.markRecipient(row.id, {
            status: 'failed', bounced: true, bounce_type: 'hard', next_retry_at: null,
            error: `Hard bounce: ${verdict.reason}`,
          });
          await this.suppressHardBounce(r.email, campaign.id);
        } else if (verdict.type === 'soft') {
          // Retries exhausted. Still not a hard bounce, so the address is NOT suppressed — a
          // mailbox that was full all day is not a mailbox that is gone.
          failed++;
          await this.markRecipient(row.id, {
            status: 'failed', bounced: false, bounce_type: 'soft', retry_count: attempt, next_retry_at: null,
            error: `Gave up after ${MAX_SOFT_RETRIES} attempts — the receiving server kept deferring: ${verdict.reason}`,
          });
        } else {
          /*
           * Our own fault — bad credentials, no connection, a certificate problem. `bounced` stays
           * false and the address is untouched: an expired SMTP password says nothing about the
           * recipient, and counting it as a bounce is what once made an auth failure look like a
           * dead list.
           */
          failed++;
          await this.markRecipient(row.id, { status: 'failed', bounced: false, bounce_type: 'unknown', error: message });
        }

        // A missing/broken mail account fails every recipient — stop rather than hammer it.
        if (/no active smtp account/i.test(message)) {
          for (let j = i + 1; j < recipients.length; j++) {
            failed++;
            await this.markRecipient(campaign.recipients[j].id, {
              status: 'failed', bounced: false, bounce_type: 'unknown',
              error: 'No active SMTP account is configured',
            });
          }
          break;
        }
      }

      // Progress the screen can poll. Written every recipient rather than batched: the whole point
      // is that a long send stops being a black box, and one small update per 400 ms is nothing.
      await this.prisma.campaigns.update({
        where: { id: campaign.id },
        data: { sent, failed, bounced, updated_at: new Date() },
      });

      /*
       * Throttle per receiving domain, not per message.
       *
       * A flat 400 ms between every send was simultaneously too slow and no protection: a list of
       * 500 addresses spread over 200 domains waited three and a half minutes for no reason, while
       * 500 addresses at ONE domain — which is what a corporate client list looks like — hit that
       * provider as fast as the flat delay allowed, which is exactly the pattern that gets a sender
       * throttled or blocked.
       *
       * Now the wait is only as long as that domain needs. Consecutive messages to the same domain
       * are spaced by SEND_DELAY_MS; a different domain proceeds immediately.
       */
      if (i < recipients.length - 1) {
        const nextDomain = domainOf(recipients[i + 1].email);
        const lastAt = lastSendByDomain.get(nextDomain);
        const wait = lastAt === undefined ? 0 : SEND_DELAY_MS - (Date.now() - lastAt);
        if (wait > 0) await sleep(wait);
      }
    }

    const updated = await this.prisma.campaigns.update({
      where: { id: campaign.id },
      data: {
        sent,
        failed,
        /*
         * Real bounces only — addresses the deliverability check rejected.
         *
         * This was `bounced: failed`, so every SMTP auth rejection, network blip and
         * "no active SMTP account" was reported to the brokerage as a bounce. Bounce rate is the
         * number mailbox providers judge a sender on, so an expired password showed up as a dead
         * list — and the reasonable response to a 100% bounce rate is to start deleting good
         * contacts. The distinction already existed a few lines above; it was simply discarded here.
         */
        bounced,
        /*
         * `partial` when some recipients were reached and some were not. It used to report
         * `completed` whenever a single message got through, so 1 sent of 500 looked like success
         * in the campaign list — the one place somebody would go to check.
         *
         * Anything soft-bounced keeps the campaign `sending`: those recipients are queued, not
         * finished with, and the retry sweep looks for exactly this status. Settling it early
         * would strand them — the campaign would read as done while people it is still trying to
         * reach sit waiting for an attempt that never comes.
         */
        status: deferred > 0 ? 'sending' : sent === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed',
        // First delivery only. A retry pass hours later must not move this: it is when the
        // campaign went out, and the open-tracking prefetch window is measured from it.
        sent_at: prior?.sent_at ?? new Date(),
        updated_at: new Date(),
      },
    });
    void updated;
    this.log.log(
      `Campaign "${name}" (#${campaign.id}): ${sent} sent, ${failed} failed`
      + `${deferred ? `, ${deferred} deferred for retry` : ''} (this pass covered ${recipients.length}).`,
    );
   } catch (err) {
    // A send that died mid-flight must not be left saying "sending" for ever, and must not take
    // the process with it. Record what happened; the counters already hold how far it reached.
    this.log.error(
      `Campaign #${job.campaignId} delivery aborted: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
    await this.prisma.campaigns
      .update({ where: { id: job.campaignId }, data: { status: 'partial', updated_at: new Date() } })
      .catch(() => undefined);
   } finally {
    this.delivering.delete(job.campaignId);
   }
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

  private async markRecipient(id: number, data: {
    status: string;
    bounced?: boolean;
    error?: string | null;
    /** hard | soft | unknown — see bounce-classifier.ts. */
    bounce_type?: string | null;
    retry_count?: number;
    next_retry_at?: Date | null;
  }): Promise<void> {
    await this.prisma.campaign_recipients.update({
      where: { id },
      data: { ...data, updated_at: new Date() },
    });
  }

  /**
   * Put a hard-bounced address on the suppression list.
   *
   * The same list an unsubscribe writes to, because it answers the same question — may we mail
   * this person — and `resolveRecipients` already filters every audience through it. Recording the
   * bounce there is what stops the next campaign spending a send, and a reputation hit, on a
   * mailbox that has already said it does not exist.
   *
   * An address that is already suppressed is left exactly as it is. If somebody unsubscribed and
   * their mailbox was later closed, the record that matters for compliance is the unsubscribe —
   * their own decision — not the bounce that followed it.
   *
   * Never throws: a campaign must not die because the suppression write failed. The recipient row
   * already records the hard bounce either way.
   */
  private async suppressHardBounce(email: string, campaignId: number): Promise<void> {
    const address = String(email ?? '').trim().toLowerCase();
    if (!address) return;
    const now = new Date();
    try {
      await this.prisma.email_suppressions.upsert({
        where: { email: address },
        create: { email: address, reason: 'hard_bounce', campaign_id: campaignId, created_at: now, updated_at: now },
        update: {},
      });
      this.log.warn(`Hard bounce for ${address} (campaign #${campaignId}) — address suppressed from future sends.`);
    } catch (err) {
      this.log.error(`Could not suppress hard-bounced address ${address}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------- tracking
  /**
   * Record an open. Returns quietly whatever happens — the caller always serves the pixel
   * so the email still renders.
   */
  /**
   * Record an open. Same situation as unsubscribe — fetched by a mail client with no session, so
   * no tenant — and the same fix. This failed for every open ever recorded; nobody noticed because
   * the pixel handler swallows errors by design so the image always renders, which meant open
   * tracking reported zero and looked like recipients simply were not opening anything.
   */
  async recordOpen(campaignId: number, token: string): Promise<void> {
    return runAsSystem(() => this.recordOpenUnscoped(campaignId, token));
  }

  private async recordOpenUnscoped(campaignId: number, token: string): Promise<void> {
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
  /** Where a link points, without attributing a click. Used when the fetch looks automated. */
  async linkDestination(campaignId: number, linkId: number): Promise<string | null> {
    return runAsSystem(async () => {
      const link = await this.prisma.campaign_links.findUnique({ where: { id: linkId } });
      return link && link.campaign_id === campaignId ? link.url : null;
    });
  }

  /**
   * Record a click and return where to send the reader.
   *
   * Public, so no session and no tenant — `runAsSystem` for the same reason as `recordOpen`. The
   * destination comes from the stored row, never from the request, which is what keeps this from
   * being an open redirect.
   *
   * Returns null when anything does not line up; the caller then sends the reader to the site
   * rather than showing an error, because a broken tracking link should not be the recipient's
   * problem.
   */
  async recordClick(campaignId: number, token: string, linkId: number): Promise<string | null> {
    return runAsSystem(() => this.recordClickUnscoped(campaignId, token, linkId));
  }

  private async recordClickUnscoped(campaignId: number, token: string, linkId: number): Promise<string | null> {
    const link = await this.prisma.campaign_links.findUnique({ where: { id: linkId } });
    if (!link || link.campaign_id !== campaignId) return null;

    const recipient = await this.prisma.campaign_recipients.findUnique({ where: { token } });
    // The link is valid even if the recipient is not, so still redirect — just do not attribute it.
    if (!recipient || recipient.campaign_id !== campaignId) return link.url;

    const now = new Date();
    try {
      // One row per recipient per link. A second click updates the timestamp rather than inserting,
      // so `clicked` stays a count of PEOPLE while `campaign_links.clicks` counts every click.
      const existing = await this.prisma.campaign_clicks.findUnique({
        where: { recipient_id_link_id: { recipient_id: recipient.id, link_id: linkId } },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.campaign_clicks.update({ where: { id: existing.id }, data: { clicked_at: now } });
      } else {
        await this.prisma.campaign_clicks.create({
          data: { campaign_id: campaignId, recipient_id: recipient.id, link_id: linkId, clicked_at: now },
        });
      }
      await this.prisma.campaign_links.update({ where: { id: linkId }, data: { clicks: { increment: 1 } } });

      // The campaign counter is distinct clickers, so it moves only the first time this person
      // clicks anything at all.
      if (!recipient.clicked_at) {
        await this.prisma.$transaction([
          this.prisma.campaign_recipients.update({ where: { id: recipient.id }, data: { clicked_at: now, updated_at: now } }),
          this.prisma.campaigns.update({ where: { id: campaignId }, data: { clicked: { increment: 1 }, updated_at: now } }),
        ]);
      }
    } catch (err) {
      // Never cost the reader their destination over bookkeeping.
      this.log.warn(`Click not recorded for campaign #${campaignId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return link.url;
  }

  /** Called from the public pixel, so it needs the same system context. */
  async isMachinePrefetch(campaignId: number): Promise<boolean> {
    return runAsSystem(() => this.isMachinePrefetchUnscoped(campaignId));
  }

  private async isMachinePrefetchUnscoped(campaignId: number): Promise<boolean> {
    const c = await this.prisma.campaigns.findUnique({ where: { id: campaignId }, select: { sent_at: true } });
    if (!c?.sent_at) return false;
    return Date.now() - c.sent_at.getTime() < CampaignsService.MACHINE_PREFETCH_WINDOW_MS;
  }

  /**
   * Process an unsubscribe: mark the recipient, add the address to the global suppression
   * list, and flag every matching lead so audience queries skip it.
   */
  /**
   * Opt a recipient out. Reached from a link in their email, so there is NO SESSION and therefore
   * no tenant in context — every query below has to say so explicitly or the tenant extension
   * rejects it.
   *
   * This was the bug that made unsubscribe fail for every token, not just unknown ones: the
   * extension threw "No tenant in context", the controller's catch swallowed it without logging,
   * and the recipient was told to try again later. CASL requires this to work.
   *
   * `runAsSystem` is the sanctioned way to say "this genuinely spans brokerages". It is safe here
   * because the only authority accepted is the 192-bit token, which is unguessable and pinned to
   * its campaign — the lookup cannot be steered to another brokerage's data by choosing an input.
   */
  async unsubscribe(campaignId: number, token: string): Promise<{ ok: boolean; email?: string }> {
    return runAsSystem(() => this.unsubscribeUnscoped(campaignId, token));
  }

  private async unsubscribeUnscoped(campaignId: number, token: string): Promise<{ ok: boolean; email?: string }> {
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
      // Always an absolute instant, never a local wall-clock string: the screen renders it in the
      // reader's own timezone, and a campaign scheduled either side of a DST change would
      // otherwise move by an hour between being set and being sent.
      scheduled_for: c.scheduled_for instanceof Date ? c.scheduled_for.toISOString() : null,
      sent_at: c.sent_at instanceof Date ? c.sent_at.toISOString() : null,
    };
  }
}
