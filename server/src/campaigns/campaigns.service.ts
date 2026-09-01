import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CrmEventNotifier } from '../notifications/crm-events.service';
import { CampaignAuditService } from './campaign-audit.service';
import { CrmAdvancedEmailService } from '../crm-settings/crm-advanced-email.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService, type MailAttachment } from '../email/mailer.service';
import { CampaignAudienceService, type AudienceFilter } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';
import { MailDeliverabilityService } from './mail-deliverability.service';
import { classifyBounce, nextRetryAt, MAX_SOFT_RETRIES } from './bounce-classifier';
import { MAX_RECIPIENTS, SEND_DELAY_MS } from './campaign.constants';
import type { AuthUserRecord } from '../auth/auth.types';
import { Prisma } from '@prisma/client';
import { can } from '../core/authz';
import { leadScopeWhere } from '../common/lead-scope';

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
  /**
   * The client's name for ONE commit attempt, so a repeat cannot become a second campaign.
   *
   * Generated once when the builder opens and reused for every retry of that same commit — a
   * double-click, a request the browser replayed, a second tab, a resend after a timeout. A NEW
   * campaign gets a NEW key, which is what keeps two deliberately identical campaigns a week apart
   * from being collapsed into one.
   *
   * Optional: a caller that sends none is not de-duplicated, exactly as before this existed.
   */
  idempotency_key?: unknown;
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
    /** Optional so existing constructions — including this service's specs — keep working. */
    private readonly crmEvents?: CrmEventNotifier,
    /** Also optional, for the same reason. Absent means no trail row, never a failed operation. */
    private readonly audit?: CampaignAuditService,
    /**
     * The CRM email log. Optional on the same terms as the two above, and for the same reason: this
     * service is constructed directly in several specs that have no interest in the log.
     */
    private readonly emailLog?: CrmAdvancedEmailService,
  ) {}

  /**
   * A campaign is private to whoever created it, for EVERY role. An admin or super-admin sees
   * their own campaigns, never another user's — the same rule the Leads and Calendar modules use,
   * applied through the `created_by_id` column.
   */
  private ownerScope(user: AuthUserRecord): Record<string, unknown> {
    return { created_by_id: user.id ?? -1 };
  }

  // ------------------------------------------------- idempotent commit

  /**
   * A campaign this caller already committed under this key, if there is one.
   *
   * SCOPED TO THE CALLER, and that is a security property rather than tidiness. The key is chosen by
   * the client, so a lookup on the key alone would hand back somebody else's campaign — including
   * its name, audience size and recipients — to anyone who guessed or observed one. `ownerScope` is
   * the same rule `list` and `get` already apply, so a replay can only ever be answered to the
   * account that made the original.
   */
  private async findByIdempotencyKey(key: string, user: AuthUserRecord) {
    return this.prisma.campaigns.findFirst({
      where: { idempotency_key: key, ...this.ownerScope(user) },
      include: { recipients: { orderBy: { id: 'asc' } } },
    });
  }

  /**
   * Insert the campaign, or discover that a concurrent request already did.
   *
   * ================================================================================================
   * THIS IS THE HALF THE UP-FRONT LOOKUP CANNOT DO. Two requests arriving together both look, both
   * find nothing, and both proceed — which is precisely what a double-click on a slow connection
   * produces. Only the database can break that tie, and `campaigns_creator_idempotency_key` does:
   * one insert succeeds, the other raises P2002, and the loser is handed the winner's row.
   *
   * The unique index is on `(created_by_id, idempotency_key)`. NULLs are never equal in PostgreSQL,
   * so every campaign created before this existed — and every caller that sends no key — coexists
   * freely under it and is simply not de-duplicated. That is the previous behaviour, unchanged.
   *
   * P2002 IS CAUGHT NARROWLY. Only a collision on this index means "somebody else got there first";
   * any other unique violation is a real fault and is rethrown rather than being quietly turned into
   * a success.
   * ================================================================================================
   *
   * DO NOT WRAP `createAndSend` IN AN OUTER TRANSACTION. This recovery depends on being able to run
   * a query AFTER the failed insert, and in PostgreSQL a unique violation ABORTS THE ENCLOSING
   * TRANSACTION: every later statement then fails with 25P02, "current transaction is aborted", so
   * the lookup below would fail and the caller would get that error instead of the winner's row.
   *
   * Today nothing wraps it — `campaigns.create` is its own implicit transaction, a collision rolls
   * back that statement alone, and the connection is clean for the lookup. Adding an outer one means
   * redesigning this first (a savepoint, or moving the claim to its own connection). This was found
   * rather than predicted: the race test failed on exactly this until it was moved out of the
   * rollback wrapper the other specs use — see `campaign-idempotency.spec.ts`. The same hazard is
   * documented on `NotificationDispatcher.sendInApp`, which is where it was first measured.
   */
  private async createOnce(
    key: string | null,
    user: AuthUserRecord,
    data: Prisma.campaignsCreateInput | Record<string, unknown>,
  ): Promise<{ campaign: Awaited<ReturnType<CampaignsService['findByIdempotencyKey']>> & object; replayed: boolean }> {
    try {
      const campaign = await this.prisma.campaigns.create({
        data: data as Prisma.campaignsCreateInput,
        include: { recipients: { orderBy: { id: 'asc' } } },
      });
      return { campaign, replayed: false };
    } catch (err) {
      const collision = key
        && err instanceof Prisma.PrismaClientKnownRequestError
        && err.code === 'P2002'
        && String((err.meta as { target?: unknown })?.target ?? '').includes('idempotency');
      if (!collision) throw err;

      const winner = await this.findByIdempotencyKey(key, user);
      // The row must exist — the constraint just said so — but if it somehow does not, failing is
      // safer than falling through and sending a second time.
      if (!winner) throw err;
      return { campaign: winner, replayed: true };
    }
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
    const c = await this.prisma.campaigns.findFirst({
      where: { id, ...this.ownerScope(user) },
      // Name and counts read BEFORE the delete: the cascade takes the recipients with it, so
      // afterwards there is nothing left to describe what was removed.
      select: { id: true, name: true, status: true, sent: true },
    });
    if (!c) throw new NotFoundException({ message: 'Campaign not found.' });
    // recipients cascade
    await this.prisma.campaigns.delete({ where: { id } });
    await this.audit?.record(
      user, 'Campaign deleted', c.name ?? `#${id}`,
      `Was ${c.status ?? 'unknown'}${c.sent ? ` after ${c.sent} sent` : ''} — recipients removed with it`,
    );
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
    /*
     * ============================================================================================
     * IDEMPOTENCY FIRST, BEFORE ANY WORK IS DONE OR ANY ROW IS WRITTEN.
     *
     * Sending is fan-out and irreversible, so a repeated request must not become a second campaign.
     * The builder still disables its own button — that is the right thing for the person watching —
     * but a disabled button is defeated by a network retry, a replayed request, a second tab or a
     * direct call to this endpoint, so the decision cannot live there.
     *
     * TWO CHECKS, NOT ONE, AND BOTH ARE NEEDED:
     *
     *   THE LOOKUP below answers the ordinary case — the second request arrives after the first has
     *   finished — cheaply, and without resolving an audience or touching the mailer.
     *
     *   THE UNIQUE INDEX answers the case the lookup cannot: two requests in flight at once, where
     *   both look, both find nothing, and both proceed. That race is exactly what a double-click on
     *   a slow connection produces. `create` then raises P2002 for the loser, which is caught at the
     *   insert below and turned into the same answer the winner got.
     *
     * A REPLAY RETURNS THE ORIGINAL, it does not error. The caller asked for one campaign and there
     * is one campaign; answering 409 would leave a correct client showing a failure for a send that
     * happened.
     * ============================================================================================
     */
    const idempotencyKey = String(input.idempotency_key ?? '').trim().slice(0, 64) || null;
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(idempotencyKey, user);
      if (existing) {
        this.log.log(`Campaign commit replayed (key ${idempotencyKey}) — returning #${existing.id} rather than creating a second.`);
        return this.summary(existing);
      }
    }

    const name = String(input.name ?? '').trim();
    if (!name) throw new BadRequestException({ message: 'Campaign name is required.' });
    /*
     * `campaigns.name` is VARCHAR(255). Without this the value reached Postgres and the driver
     * error surfaced as a bare HTTP 500 — measured at 500 characters — while every other refusal on
     * this endpoint returns a clean 400 naming the field. CRM-CAMP-M03.
     */
    if (name.length > 255) {
      throw new BadRequestException({
        message: 'The campaign name must be 255 characters or fewer.',
        errors: { name: ['Must be 255 characters or fewer.'] },
      });
    }

    const templateId = Number(input.template_id);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      throw new BadRequestException({ message: 'A valid template must be selected.' });
    }
    /*
     * Campaign templates only — Email Settings' transactional templates are a separate library
     * and must never be sent as marketing mail.
     *
     * AND ONLY ONE THE CALLER COULD HAVE PICKED. This matched any row in the table, so the two
     * things the builder's picker no longer offers — the shipped built-ins and another agent's
     * private drafts — were still sendable by anyone who knew or guessed an id. A screen that
     * removes a choice while the endpoint behind it still accepts it has not removed the choice.
     *
     * Existing campaigns are untouched by this: it guards the CREATE path only. A campaign already
     * built on a built-in keeps its own snapshot of the subject and body, and `attachmentsForSend`
     * resolves attachments by `template_id` with no ownership test, so resuming or finishing one
     * behaves exactly as before.
     */
    const template = await this.prisma.campaign_templates.findFirst({
      where: { id: templateId, deleted_at: null, ...CampaignTemplatesService.authoredWhere(user) },
    });
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

    const outcome = await this.createOnce(idempotencyKey, user, {
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
      idempotency_key: idempotencyKey,
      created_at: now,
      updated_at: now,
      recipients: {
        create: recipients.map((r, i) => ({
          lead_id: r.leadId, name: r.name, email: r.email, token: tokens[i], vars: JSON.stringify(r.vars ?? {}),
          status: 'pending', created_at: now, updated_at: now,
        })),
      },
    });

    /*
     * The other request won the race. It is already delivering (or scheduled) the very campaign this
     * one was about to build, so this request stops here and hands back that row — it must not fall
     * through and start a second delivery loop over the same recipients.
     */
    if (outcome.replayed) {
      this.log.log(`Campaign commit raced (key ${idempotencyKey}) — returning #${outcome.campaign.id}.`);
      return this.summary(outcome.campaign);
    }
    const campaign = outcome.campaign;

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
      await this.audit?.record(
        user, 'Campaign scheduled', name,
        `${recipients.length} recipient(s), to send ${scheduledFor.toISOString()}`,
      );
      return this.summary(held);
    }

    await this.prisma.campaigns.update({
      where: { id: campaign.id },
      // tracking_base_url is stored, not re-read at resume: messages already delivered carry the
      // URL they were built with, and the rest of the same campaign has to match them.
      data: { status: 'sending', tracking_base_url: input.baseUrl, updated_at: new Date() },
    });
    /*
     * Recorded HERE — at the decision to send — rather than when delivery finishes.
     *
     * The trail's question is who authorised mail to these people, and the answer is settled at this
     * line. Delivery runs detached and may take minutes, may partially fail, may be resumed by a
     * different process after a restart; none of that changes who pressed send. Per-recipient
     * outcomes are already on `campaign_recipients` for anyone asking what happened next.
     */
    await this.audit?.record(
      user, 'Campaign sent', name,
      `${recipients.length} recipient(s), subject "${template.subject}"`,
    );
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
   * SCOPED TO THE VIEWER'S OWN LEADS, for everyone except the roles that run marketing.
   *
   * This was brokerage-wide, and the reasoning written here was that an agent "must not be able to
   * work around a colleague's opt-out by not seeing it". That reasoning does not survive checking:
   * `CampaignAudienceService.suppressedEmails` filters every send against the WHOLE table
   * regardless of who is sending, so an address hidden from this list is still unmailable. Nothing
   * about visibility affects enforcement.
   *
   * What visibility does affect is disclosure. Every row is a real person's email address, and the
   * list showed every agent the addresses of every colleague's clients — the same boundary the lead
   * list, the campaign audience and the export all hold. A brokerage-wide list was the one place it
   * leaked.
   *
   * `campaigns.brokerage-audience` decides who still sees everything: the marketing and
   * administrative roles whose job is the brokerage's whole audience. An agent sees the opt-outs of people who are their own
   * leads, which is exactly the set they could have mailed.
   */
  async listSuppressions(
    user: AuthUserRecord | null,
    q: { page?: unknown; limit?: unknown; search?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    const search = String(q.search ?? '').trim().toLowerCase();

    const searchWhere = search ? { email: { contains: search, mode: 'insensitive' as const } } : {};

    /*
     * The addresses this person's own leads use. Suppressions key on the address, not on a lead id
     * — a person who opts out is opting the ADDRESS out — so the scope has to be expressed as the
     * set of addresses they own rather than as a join.
     */
    let where: Prisma.email_suppressionsWhereInput = searchWhere;
    if (!can(user, 'campaigns.brokerage-audience')) {
      const own = await this.prisma.leads.findMany({
        where: { deleted_at: null, ...leadScopeWhere(user) },
        select: { email: true },
      });
      const addresses = [...new Set(own.map((l) => (l.email ?? '').trim().toLowerCase()).filter(Boolean))];
      // No leads means no suppressions to show — an empty `in` would match everything.
      if (!addresses.length) {
        return { data: [], meta: { page, per_page: limit, total: 0, last_page: 1, can_remove: false, scoped: true } };
      }
      where = { ...searchWhere, email: { in: addresses, mode: 'insensitive' as const } };
    }

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
      meta: {
        page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)),
        /*
         * WHETHER THIS PERSON MAY UNDO AN OPT-OUT, answered by the rule that will decide it.
         *
         * The screen offered Remove on `campaigns:edit`, which an agent holds, while the server now
         * requires the marketing capability - so without this the button would be shown and then
         * refused, which is the exact shape of CRM-012. One rule, sent from where it lives.
         */
        can_remove: can(user, 'campaigns.brokerage-audience'),
        /*
         * WHETHER THIS IS THE WHOLE LIST OR THIS PERSON'S SLICE OF IT - CRM-045.
         *
         * An agent's view said '0 addresses suppressed' and 'Nobody is suppressed' at a moment
         * when the brokerage HAD a suppressed address. The screen was faithfully rendering what
         * it was given; what it was never given was the fact that it was looking at a slice.
         * 'Nobody is suppressed' is a claim, and it was a false one, on the one page a brokerage
         * would open to answer a compliance question.
         *
         * Sent from here rather than inferred from the viewer's role, for the same reason
         * `can_remove` is: the rule that decides the scope is in this method, and a screen that
         * works it out separately is a second copy of it waiting to disagree.
         */
        scoped: !can(user, 'campaigns.brokerage-audience'),
      },
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
  /**
   * Record an opt-out somebody gave by any means - telephone, in person, or a reply.
   *
   * WHY THIS HAD TO EXIST. The only route onto the suppression list was the client clicking the
   * link in an email. So a brokerage told "stop emailing me" on the telephone had no way to comply:
   * the lead's Unsubscribed badge is display-only, the editor has no field for it, and the
   * suppression API offered only read and delete. The one way to stop mailing somebody was to keep
   * mailing them until they clicked. Canadian anti-spam law expects a withdrawal of consent to be
   * honoured however it is expressed, not only when expressed through one particular link.
   *
   * THE ENFORCEMENT HALF WAS ALREADY BUILT and works: once an address is on this list the campaign
   * audience drops it and the per-lead Send button disables itself with a reason. Only the recording
   * was missing.
   *
   * DELIBERATELY EASIER THAN UNDOING IT. `removeSuppression` requires the marketing capability
   * because resuming mail to somebody who asked for silence is a compliance act. Recording the
   * request is the safe direction and stays on `campaigns:edit`, which an ordinary agent holds -
   * the agent who took the telephone call is exactly who should be able to act on it, and a rule
   * that made them find an administrator first would mean the brokerage kept mailing meanwhile.
   *
   * THE LEAD FLAG IS SET TOO, in the same breath. `resolveRecipients` reads both the suppression
   * list and `leads.unsubscribed`, and the per-lead Send button reads only the second - so writing
   * one without the other would honour the opt-out in campaigns and not on the lead's own page.
   * This is the exact mirror of what `removeSuppression` undoes.
   */
  async addSuppression(
    email: string, user: AuthUserRecord, reason?: string,
  ): Promise<{ added: boolean; already: boolean }> {
    const address = String(email ?? '').trim().toLowerCase();
    if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      throw new BadRequestException({ message: 'Enter the email address that asked to be removed.' });
    }

    const existing = await this.prisma.email_suppressions.findUnique({ where: { email: address } });
    const now = new Date();
    // `note` rather than a free vocabulary: the reason is written by staff and read by whoever asks
    // "why is this person on the list", so it is stored as given and clipped to the column.
    const note = String(reason ?? '').trim().slice(0, 190);

    await this.prisma.email_suppressions.upsert({
      where: { email: address },
      create: {
        email: address,
        reason: note ? `staff: ${note}` : 'staff',
        created_at: now,
        updated_at: now,
      },
      // An address already on the list stays as it was: the FIRST record of an opt-out is the one
      // that matters, and overwriting its reason would lose why they originally asked.
      update: {},
    });

    await this.prisma.$executeRaw`UPDATE "leads" SET "unsubscribed" = true, "unsubscribed_at" = ${now}, "updated_at" = ${now} WHERE LOWER("email") = ${address} AND "unsubscribed" = false`;

    this.log.warn(`Opt-out recorded for ${address} by ${user.name ?? 'unknown'}${note ? ` — ${note}` : ''}.`);
    await this.audit?.record(
      user, 'Opt-out recorded', address,
      note ? `Recorded by staff — ${note}` : 'Recorded by staff, received outside the unsubscribe link',
    );
    return { added: true, already: !!existing };
  }

  async removeSuppression(email: string, user: AuthUserRecord): Promise<{ removed: boolean }> {
    /*
     * UNDOING AN OPT-OUT IS NOT AN ORDINARY CAMPAIGN EDIT.
     *
     * This was guarded by `campaigns:edit` alone - which an ordinary agent holds - so an agent could
     * take somebody off the suppression list and mail to them would resume. Confirmed live rather
     * than inferred: the agent seat received `200 {"removed":true}`.
     *
     * The suppression list is the brokerage's record of who has said stop. Reversing an entry is the
     * one action in this module whose consequence lands outside the system, on a person who asked to
     * be left alone, and under CASL "who authorised that" has a legal answer. It belongs with the
     * roles accountable for the brokerage's marketing rather than with everyone who may build a
     * campaign.
     *
     * `campaigns.brokerage-audience` IS THE RIGHT RULE, not a new one. Its own documentation already
     * covers working with the brokerage's whole marketing audience "and see the whole opt-out list",
     * and it names admin, manager and crm for precisely this reason - marketing responsibility does
     * not run along the seniority ladder. An agent keeps every other campaign right they had.
     *
     * CHECKED HERE RATHER THAN ONLY ON THE ROUTE, so a second caller cannot reach it unguarded.
     */
    if (!can(user, 'campaigns.brokerage-audience')) {
      throw new ForbiddenException({
        message: 'Removing an address from the suppression list is restricted to marketing and '
          + 'administrative roles. Ask an administrator — reversing an opt-out resumes mail to '
          + 'somebody who asked for it to stop.',
      });
    }

    const address = String(email ?? '').trim().toLowerCase();
    if (!address) throw new BadRequestException({ message: 'An email address is required.' });

    const row = await this.prisma.email_suppressions.findUnique({ where: { email: address } });
    if (!row) throw new NotFoundException({ message: 'That address is not on the suppression list.' });

    const now = new Date();
    await this.prisma.email_suppressions.delete({ where: { email: address } });
    await this.prisma.$executeRaw`UPDATE "leads" SET "unsubscribed" = false, "unsubscribed_at" = NULL, "updated_at" = ${now} WHERE LOWER("email") = ${address}`;
    this.log.warn(`Suppression removed for ${address} by ${user.name ?? 'unknown'} — mail to this address will resume.`);
    /*
     * THE ROW THE COMMENT ABOVE ALREADY PROMISED. This method's own documentation said "deliberately
     * narrow, and audited … the record of who did it is the point", and there was no writer — only a
     * log line, which is not a record anybody can query a year later.
     *
     * This is the single most consequential action in the module: it resumes mail to somebody who
     * asked for it to stop. Under CASL the question "who authorised that, and when" has a legal
     * answer, and until now the system could not give one.
     */
    await this.audit?.record(
      user, 'Suppression removed', address,
      `Reason on the list was "${row.reason ?? 'unknown'}" — mail to this address resumes, and the matching leads were un-flagged`,
    );
    return { removed: true };
  }

  /**
   * Send a campaign whose time has come. Reuses the resume path, which is already written to send
   * only the recipients still `pending` — for a scheduled campaign that is all of them.
   */
  /**
   * Start a scheduled campaign — claiming it first, so only one worker can.
   *
   * THE CLAIM IS THE `WHERE` CLAUSE, and that is the whole mechanism. `UPDATE … WHERE id = ? AND
   * status = 'scheduled'` is atomic in PostgreSQL: whichever transaction gets there first flips the
   * row, and every other one matches zero rows and is told so by `count`. No lock table, no Redis,
   * no coordination — the database was already the shared thing.
   *
   * WHY THIS IS NOT MERELY TIDY. The previous version updated `where: { id }` with no condition, so
   * four application processes ticking at the same second all "succeeded" and all called `resume`.
   * Measured against the real send path, that is four copies of a campaign in every recipient's
   * inbox — a deliverability problem, a CASL problem, and the one failure this module elsewhere
   * describes as worse than not sending at all.
   *
   * DELIBERATELY NOT DEPENDENT ON REDIS. `clusterTick` stops the other three processes running the
   * sweep at all, which is better, but it is documented to RUN when Redis is absent rather than
   * silently stopping every scheduled job on a deployment that has none. So a deployment that adds
   * processes and forgets Redis would get the appearance of protection. For the one job that sends
   * mail to clients, the guarantee has to live somewhere that is always present. It lives here.
   *
   * Returns whether this caller won the claim, so a loser is not reported as a failure.
   */
  async dispatchScheduled(campaignId: number): Promise<boolean> {
    const claimed = await this.prisma.campaigns.updateMany({
      where: { id: campaignId, status: 'scheduled' },
      data: { status: 'sending', updated_at: new Date() },
    });
    // Zero means somebody else claimed it between our read and our write. That is a normal outcome
    // in a multi-process deployment, not an error, and it must not be logged as one.
    if (claimed.count === 0) return false;

    await this.resume(campaignId);
    return true;
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
      select: { id: true, status: true, name: true },
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
    await this.audit?.record(user, 'Campaign cancelled', c.name ?? `#${campaignId}`, 'Returned to draft before sending');
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

    /*
     * CONSENT IS RE-CHECKED HERE, IMMEDIATELY BEFORE DELIVERY — not only when the audience was built.
     *
     * A campaign's recipient rows are materialised when it is created or scheduled. For a scheduled
     * campaign that can be days ahead of the send, and `resolveRecipients` — which applies the
     * suppression list and the lead's own opt-out — ran once, back then. Anyone who unsubscribed in
     * between was still `pending` and was still sent to. Under CASL the violation is sending AFTER
     * consent is withdrawn, so the check has to happen at the moment of sending. Finding
     * CRM-CAMP-H02.
     *
     * Both sources are consulted, because they are set independently: `email_suppressions` is the
     * brokerage-wide do-not-email list (unsubscribes, hard bounces, manual additions), while
     * `leads.unsubscribed` is the flag on the lead record. An address can be on either.
     *
     * Excluded rows are MARKED, not silently skipped: a recipient dropped for consent is recorded as
     * such, so the campaign's own results explain the gap between "attempted" and "sent" rather than
     * leaving somebody to wonder where the missing recipients went.
     */
    const addresses = pending.map((r) => r.email);
    const [suppressed, optedOutLeads] = await Promise.all([
      this.audience.suppressedEmails(addresses),
      this.prisma.leads.findMany({
        where: { unsubscribed: true, email: { in: addresses, mode: 'insensitive' } },
        select: { email: true },
      }),
    ]);
    for (const l of optedOutLeads) suppressed.add(String(l.email ?? '').toLowerCase());

    const stillAllowed = pending.filter((r) => !suppressed.has(r.email.toLowerCase()));
    const withdrawn = pending.filter((r) => suppressed.has(r.email.toLowerCase()));

    if (withdrawn.length) {
      const now = new Date();
      this.log.warn(
        `Campaign #${campaignId}: ${withdrawn.length} recipient(s) opted out after this campaign was built — not sent.`,
      );
      await this.prisma.campaign_recipients.updateMany({
        where: { id: { in: withdrawn.map((r) => r.id) } },
        data: {
          status: 'failed',
          unsubscribed: true,
          error: 'Not sent — this address opted out after the campaign was created.',
          updated_at: now,
        },
      });
    }
    // Everyone left is gone; nothing to deliver.
    if (!stillAllowed.length) return;

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
      recipients: stillAllowed.map((r) => ({
        leadId: r.lead_id ?? null,
        name: r.name ?? '',
        email: r.email,
        vars: parseVars(r.vars),
      })) as never,
      rows: stillAllowed.map((r) => ({ id: r.id, retry_count: r.retry_count })),
      tokens: stillAllowed.map((r) => r.token),
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

    /*
     * Resolved ONCE for the whole run rather than per recipient: it reads the environment, it cannot
     * change mid-send, and the log wants the same answer against every row of one campaign.
     */
    const mailRedirect = MailerService.redirectTarget();

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

      /*
       * CLAIM BEFORE SENDING. This is the fix for CRM-CAMP-M02.
       *
       * The order used to be send-then-mark, so a crash in between left the row `pending` and the
       * resume sent to that person a SECOND time. The window was one database write wide, and a
       * deploy during a large campaign — which runs for minutes because of the inter-send delay — is
       * a realistic way to land in it.
       *
       * Marking `sending` first makes the crash detectable instead of invisible. `deliverPending`
       * selects `status: 'pending'` only, so a claimed row is never picked up again: after a crash
       * it stays `sending`, and the outcome is one message possibly not delivered rather than one
       * definitely delivered twice.
       *
       * THAT IS THE TRADE, AND IT IS THE ONE THIS MODULE ALREADY SAYS IT WANTS — the `delivering`
       * guard is documented as existing because "a second copy in somebody's inbox is the one
       * failure this module treats as worse than not sending at all". Send-then-mark optimised for
       * the opposite. A `sending` row is visible in the campaign's own results, so the ambiguity is
       * reported rather than silently resolved in either direction.
       *
       * No migration: `status` is VARCHAR(16) and holds this alongside pending/sent/failed.
       *
       * THE CLAIM IS NOW CONDITIONAL, and that is what makes it work across processes. Marking
       * `sending` was always the right idea; doing it with `where: { id }` was not, because two
       * workers both "succeeded" and both then sent. `WHERE id = ? AND status = 'pending'` means
       * exactly one of them updates a row — PostgreSQL serialises the two updates on the row lock —
       * and the loser is told by `count === 0` and skips.
       *
       * This is the guarantee that survives everything above it failing: even if the campaign-level
       * claim were bypassed, even with no Redis and four processes in the same `resume`, a recipient
       * can be claimed once. It is the last line, and it is the only one that is per-message.
       */
      if (!(await this.claimRecipient(row.id))) {
        // Another worker owns this recipient and will record its outcome. Not counted here as sent
        // or failed: this pass did not send it, and inventing a number would misreport the campaign.
        continue;
      }

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
        /*
         * THE CRM EMAIL LOG, which campaigns never reached.
         *
         * A client could receive a message from the brokerage and leave no mark on the one screen
         * built to show what the brokerage has sent - so anybody auditing "what did we send this
         * person" had to know to check two places, and nothing said so. The campaign's own record
         * was always complete; it was simply not where people look.
         */
        await this.logCampaignSend(user, r.email, subject, true, null, mailRedirect);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const verdict = classifyBounce(message);
        const attempt = (row.retry_count ?? 0) + 1;
        // A deferral is not an outcome yet — see `logCampaignSend`.
        let deferredForRetry = false;

        if (verdict.type === 'soft' && attempt <= MAX_SOFT_RETRIES) {
          /*
           * A transient refusal — mailbox full, greylisted, rate-limited. The address is fine and
           * the moment was not, so the recipient stays `pending` with a time it may be tried again.
           * It counts as neither sent nor failed while it waits: reporting it as a failure would
           * be wrong, and reporting it as sent would be a lie.
           */
          deferred++;
          deferredForRetry = true;
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

        // Recorded once the outcome is settled, so one eventual delivery is one row.
        if (!deferredForRetry) await this.logCampaignSend(user, r.email, subject, false, message, mailRedirect);

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

    /*
     * TELL THE OWNER — but only once the campaign has genuinely finished.
     *
     * `deferred > 0` leaves the status `sending`, because those recipients are queued for the retry
     * sweep rather than done with. Notifying there would report a final outcome for a campaign still
     * in flight, and the person would later see different numbers with no explanation. So a deferred
     * pass says nothing and the notification comes from the pass that actually settles it.
     *
     *   completed / partial → finished, something got through   → "campaign finished"
     *   failed              → finished, nothing got through     → "could not be completed"
     *
     * Never allowed to affect the send: the messages have already gone.
     */
    if (deferred === 0) {
      // The owner is read here rather than carried down: the `campaign` in scope at this point is a
      // narrowed projection for the send loop and does not include who created it.
      const owner = await this.prisma.campaigns
        .findUnique({ where: { id: campaign.id }, select: { created_by_id: true } })
        .catch(() => null);
      const summary = { recipients: recipients.length, sent, failed };

      if (sent === 0) {
        void this.crmEvents?.campaignFailed({ id: campaign.id, name }, owner?.created_by_id, 'no-recipients-reached');
      } else {
        void this.crmEvents?.campaignCompleted({ id: campaign.id, name }, owner?.created_by_id, summary);
      }
    }
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

    /*
     * A send that died mid-flight. The owner is told plainly and the technical reason goes to the
     * log above — a stack trace, an SMTP response or a provider error is not something a campaign
     * owner can act on, and it must not be delivered to their inbox or their phone.
     */
    const aborted = await this.prisma.campaigns
      .findUnique({ where: { id: job.campaignId }, select: { id: true, name: true, created_by_id: true } })
      .catch(() => null);
    if (aborted) {
      void this.crmEvents?.campaignFailed(
        { id: aborted.id, name: aborted.name },
        aborted.created_by_id,
        'delivery-aborted',
        err instanceof Error ? err.message : String(err),
      );
    }
   } finally {
    this.delivering.delete(job.campaignId);
   }
  }

  /**
   * Pre-flight check: send one test email through the exact account this user's campaigns would
   * use, so credentials can be verified before a real send. Never throws — the SMTP result
   * (success, or a message like Gmail's "535 BadCredentials") is returned for the UI to show.
   */
  /**
   * The address this person's campaigns will actually go out from.
   *
   * ASKED OF THE MAILER, not guessed from the user, because the answer is a chain: their default
   * account, then any active account of theirs, then the brokerage mailbox, and finally - when a
   * deployment has none of those - a COLLEAGUE'S mailbox, which is the case worth showing somebody
   * before they mail a hundred clients. `sendDirect` resolves it exactly this way at send time.
   *
   * Null rather than throwing when no account exists at all: this feeds a confirmation dialog, and
   * a screen that cannot name the sender should say so rather than fail to open.
   */
  async senderEmail(user: AuthUserRecord): Promise<string | null> {
    try {
      const account = await this.mailer.resolveSender(null, user.id ?? null);
      return account.from_email || null;
    } catch {
      return null;
    }
  }

  async sendTest(user: AuthUserRecord, to: string): Promise<{ ok: boolean; from?: string; account?: string; error?: string }> {
    /*
     * A TEST SEND IS A REAL EMAIL, and it was leaving no trace.
     *
     * The CRM email log is where somebody looks to prove what the brokerage sent and to whom. Every
     * other outgoing message lands there; this one did not, so a test that went to the wrong
     * address - or reached a client who should not have received it - left nothing behind at all.
     *
     * BOTH OUTCOMES ARE RECORDED. A refused send is as much a part of "what happened on this
     * account" as a delivered one, and the other writers to this log already record their failures.
     *
     * THE INTENDED RECIPIENT IS LOGGED, with `redirected` naming where it actually went - the same
     * pair the per-lead sends record. On a developer machine every message is diverted, and a log
     * showing only the diversion target would say nothing about who was aimed at.
     */
    const redirect = MailerService.redirectTarget();
    try {
      const res = await this.mailer.testForUser(user.id ?? null, to);
      await this.logTest(user, to, true, null, redirect);
      return { ok: true, from: res.from, account: res.account };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.logTest(user, to, false, message, redirect);
      return { ok: false, error: message };
    }
  }

  /**
   * Record one campaign message in the CRM email log.
   *
   * WHY A ROW PER RECIPIENT rather than one per campaign. The log answers "what did we send this
   * client, and did it arrive?" - a question asked about a person, not about a mailing. A single
   * summary row could not answer it, and the log already keeps per-recipient rows for every
   * automated message, so a campaign summary would be the odd shape out.
   *
   * WHAT IS NOT LOGGED, deliberately: a soft-retry deferral. A mailbox that is full at eleven and
   * fine at noon produces one delivery, and writing a row per attempt would make the log read as
   * several messages to one person. Only terminal outcomes are recorded - it went, or it did not.
   *
   * Failures here are swallowed for the same reason as everywhere else in this file: the email has
   * already left, and a log that cannot be written must not turn that into a failed send.
   */
  private async logCampaignSend(
    user: AuthUserRecord, to: string, subject: string,
    ok: boolean, error: string | null, redirect: string | null,
  ): Promise<void> {
    try {
      await this.emailLog?.recordExternalSend('campaign', to, subject, ok, error, user, redirect);
    } catch {
      /* the log is a record, not a gate */
    }
  }

  /** Never let the record of a send turn a sent email into a failed request. */
  private async logTest(
    user: AuthUserRecord, to: string, ok: boolean, error: string | null, redirect: string | null,
  ): Promise<void> {
    try {
      await this.emailLog?.recordExternalSend(
        'campaign_test', to, 'Test email', ok, error, user, redirect,
      );
    } catch {
      /* the log is a record, not a gate */
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
   * Take ownership of one recipient, or discover that somebody else already has.
   *
   * `updateMany` rather than `update`, because only `updateMany` accepts a non-unique `where` — and
   * the condition on `status` IS the lock. Two processes issuing this for the same row are
   * serialised by PostgreSQL on that row: the first sees `count === 1`, the second re-evaluates the
   * predicate against the committed row, finds `status = 'sending'`, matches nothing, and returns 0.
   *
   * Only `pending` is claimable. A row already `sending` belongs to another worker (or to a crashed
   * one, which the module deliberately leaves visible rather than silently re-sending — see the
   * claim comment in `deliver`). A row `sent` or `failed` is finished.
   */
  private async claimRecipient(id: number): Promise<boolean> {
    const claimed = await this.prisma.campaign_recipients.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'sending', error: null, updated_at: new Date() },
    });
    return claimed.count === 1;
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
   * Record an open. Fetched by a mail client, so there is no session behind it — the recipient is
   * identified by the token alone.
   *
   * Returns quietly whatever happens: the caller always serves the pixel so the email still
   * renders. That swallowing is by design and is also why a failure here is invisible — open
   * tracking simply reports zero and looks like nobody is opening anything.
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
  /** Where a link points, without attributing a click. Used when the fetch looks automated. */
  async linkDestination(campaignId: number, linkId: number): Promise<string | null> {
    const link = await this.prisma.campaign_links.findUnique({ where: { id: linkId } });
    return link && link.campaign_id === campaignId ? link.url : null;
  }

  /**
   * Record a click and return where to send the reader.
   *
   * Public, so no session, exactly like `recordOpen`. The destination comes from the stored row,
   * never from the request, which is what keeps this from being an open redirect.
   *
   * Returns null when anything does not line up; the caller then sends the reader to the site
   * rather than showing an error, because a broken tracking link should not be the recipient's
   * problem.
   */
  async recordClick(campaignId: number, token: string, linkId: number): Promise<string | null> {
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

  /** Called from the public pixel. */
  async isMachinePrefetch(campaignId: number): Promise<boolean> {
    const c = await this.prisma.campaigns.findUnique({ where: { id: campaignId }, select: { sent_at: true } });
    if (!c?.sent_at) return false;
    return Date.now() - c.sent_at.getTime() < CampaignsService.MACHINE_PREFETCH_WINDOW_MS;
  }

  /**
   * Process an unsubscribe: mark the recipient, add the address to the global suppression
   * list, and flag every matching lead so audience queries skip it.
   */
  /**
   * Opt a recipient out. Reached from a link in their email, so there is NO SESSION behind it.
   *
   * The only authority accepted is the 192-bit token, which is unguessable and pinned to its
   * campaign — the lookup cannot be steered to another recipient's record by choosing an input.
   * That is what makes an unauthenticated write safe here, and CASL requires it to work.
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
  /**
   * Every tag the caller could audience by — the ones in USE, plus the ones that merely EXIST.
   *
   * This used to read tags off the leads alone, so a tag created on the Tags screen and not yet
   * applied to anybody was missing from this dropdown. That is precisely backwards for building a
   * campaign: a brokerage creates "Spring-2026", goes to tag a segment with it, and cannot find it
   * in the list of things to filter by.
   *
   * `lead_tags` is the registry the Tags screen writes to; the per-lead `tags` column is where they
   * end up in use. Neither is a superset of the other — a tag applied before the registry existed
   * is on leads and not in it — so the answer is the union.
   *
   * THE SCOPE RULE IS UNCHANGED for the in-use half: those are still read through
   * `buildAudienceWhere`, so an agent's list cannot reveal a segment they could not send to.
   * Registry names carry no such signal — a tag's existence says nothing about whose leads hold it
   * — which is why they can be added without narrowing.
   */
  async leadTags(user: AuthUserRecord): Promise<string[]> {
    const [rows, registry] = await Promise.all([
      this.prisma.leads.findMany({
        where: this.audience.buildAudienceWhere({}, user),
        select: { tags: true },
      }),
      this.prisma.lead_tags.findMany({ select: { name: true } }),
    ]);
    const set = new Set<string>();
    for (const r of rows) for (const t of parseJsonArray(r.tags)) set.add(t);
    for (const t of registry) if (t.name) set.add(t.name);
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
