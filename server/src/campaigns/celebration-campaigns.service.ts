import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { campaigns, mail_accounts } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { MailAccountService } from '../email/mail-account.service';
import { CrmAdvancedEmailService } from '../crm-settings/crm-advanced-email.service';
import { htmlToText } from '../email/html-to-text';
import { leadScopeWhere, hasBrokerageLeadScope } from '../common/lead-scope';
import type { AuthUserRecord } from '../auth/auth.types';
import { CampaignsService, publicBaseUrlProblem } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignAuditService } from './campaign-audit.service';
import { CelebrationAudienceService, parseRecipientSpec, type AudienceResult, type RecipientSpec } from './celebration-audience.service';
import { CelebrationFlyerService } from './celebration-flyer.service';
import {
  BRANDINGS, CELEBRATION_MAX_RECIPIENTS, DEFAULT_TIMEZONE, FLYER_CID, isOccasion, isValidTimeZone, occasionLabel,
  recipientVars, renderCelebrationHtml, unknownTokens, zonedTimeToUtc, type Signature,
} from './celebration';

const str = (v: unknown): string => String(v ?? '').trim();
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** The editable parts of a celebration, as saved on the campaign row. */
export interface CelebrationDraft {
  name: string;
  occasion: string;
  occasion_label: string | null;
  subject: string;
  preview_text: string | null;
  message: string;
  branding: 'brokerage' | 'agent';
  sender_account_id: number | null;
  reply_to: string | null;
  flyer_id: number | null;
  recipients: RecipientSpec;
  timezone: string;
  ai_assisted: boolean;
}

/** Statuses from which a celebration may still be edited, sent or scheduled. */
const EDITABLE = ['draft', 'cancelled'];

/**
 * Celebration & Wishes — festival, birthday, anniversary and general greetings, as campaigns.
 *
 * NOTHING HERE SENDS EXCEPT `send`, and `send` only on an explicit confirmation from the final step.
 * Saving, previewing, generating and resolving the audience never send. Delivery itself is the
 * Campaigns engine (`CampaignsService.resume`), so a celebration gets the same claim-then-send, the
 * same consent re-check at dispatch, the same unsubscribe link and suppression handling, and the
 * same scheduler, cancel and resume — plus the celebration's own re-check (see
 * `CelebrationAudienceService.recheckBeforeSend`).
 */
@Injectable()
export class CelebrationCampaignsService {
  private readonly log = new Logger(CelebrationCampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
    private readonly audience: CampaignAudienceService,
    private readonly celebrationAudience: CelebrationAudienceService,
    private readonly flyers: CelebrationFlyerService,
    private readonly mailer: MailerService,
    private readonly audit: CampaignAuditService,
    private readonly emailLog: CrmAdvancedEmailService,
  ) {}

  // ------------------------------------------------------------------------------------ drafts

  /** Validate a draft. `strict` is the send-time standard; a draft may be saved incomplete. */
  async parseDraft(body: Record<string, unknown>, user: AuthUserRecord, strict: boolean): Promise<CelebrationDraft> {
    const errors: Record<string, string[]> = {};
    const fail = (k: string, m: string) => { errors[k] = [...(errors[k] ?? []), m]; };

    const occasion = str(body.occasion);
    if (!isOccasion(occasion)) fail('occasion', 'Choose an occasion.');
    const occasionLabelRaw = str(body.occasion_label).slice(0, 120) || null;
    if ((occasion === 'custom-festival' || occasion === 'general') && !occasionLabelRaw && strict) {
      fail('occasion_label', 'Name the occasion.');
    }
    const name = str(body.name) || (isOccasion(occasion) ? `${occasionLabel(occasion, occasionLabelRaw)} greetings` : 'Celebration');
    if (name.length > 255) fail('name', 'Must be 255 characters or fewer.');
    const subject = str(body.subject);
    if (subject.length > 200) fail('subject', 'Must be 200 characters or fewer.');
    if (strict && !subject) fail('subject', 'Write a subject line.');
    const preview = str(body.preview_text).slice(0, 255) || null;
    const message = String(body.message ?? '').replace(/\r\n?/g, '\n').trim();
    if (message.length > 10000) fail('message', 'Keep the message under 10,000 characters.');
    if (strict && !message) fail('message', 'Write the message.');
    const bad = unknownTokens(subject, preview, message);
    if (bad.length) fail('message', `These merge fields cannot be filled: ${bad.map((t) => `{{${t}}}`).join(', ')}.`);

    const branding = (BRANDINGS as readonly string[]).includes(str(body.branding)) ? str(body.branding) as 'brokerage' | 'agent' : 'agent';
    const replyTo = str(body.reply_to) || null;
    if (replyTo && (!EMAIL.test(replyTo) || replyTo.length > 255)) fail('reply_to', 'Enter one valid email address, or leave it blank.');

    let sender: number | null = null;
    if (body.sender_account_id !== undefined && body.sender_account_id !== null && body.sender_account_id !== '') {
      const id = Number(body.sender_account_id);
      const ok = Number.isInteger(id) && id > 0 && await this.prisma.mail_accounts.findFirst({
        where: { id, ...MailAccountService.crmSenderWhere(user.id ?? null) }, select: { id: true },
      });
      if (!ok) fail('sender_account_id', 'That email account is not available to send from.');
      else sender = id;
    }

    let flyerId: number | null = null;
    if (body.flyer_id !== undefined && body.flyer_id !== null && body.flyer_id !== '') {
      const id = Number(body.flyer_id);
      const f = Number.isInteger(id) ? await this.prisma.campaign_flyers.findFirst({ where: { id, created_by_id: user.id ?? -1, deleted_at: null }, select: { id: true } }) : null;
      if (!f) fail('flyer_id', 'That flyer is not available.');
      else flyerId = id;
    }

    const timezone = str(body.timezone) || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(timezone)) fail('timezone', 'Choose a valid timezone.');

    const recipients = parseRecipientSpec(body.recipients);
    if (strict && (recipients.mode === 'selected' || recipients.mode === 'single') && !recipients.lead_ids.length) {
      fail('recipients', recipients.mode === 'single' ? 'Choose the lead to send to.' : 'Choose at least one lead.');
    }

    if (Object.keys(errors).length) {
      throw new BadRequestException({ message: Object.values(errors)[0][0], errors });
    }
    return {
      name, occasion, occasion_label: occasionLabelRaw, subject, preview_text: preview, message, branding,
      sender_account_id: sender, reply_to: replyTo, flyer_id: flyerId, recipients, timezone,
      ai_assisted: body.ai_assisted === true,
    };
  }

  private draftData(d: CelebrationDraft) {
    return {
      name: d.name, occasion: d.occasion, occasion_label: d.occasion_label, subject: d.subject,
      preview_text: d.preview_text, message: d.message, branding: d.branding, sender_account_id: d.sender_account_id,
      reply_to: d.reply_to, flyer_id: d.flyer_id, timezone: d.timezone, ai_assisted: d.ai_assisted,
      category: d.occasion, audience: JSON.stringify({ spec: d.recipients }),
    };
  }

  async create(body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const d = await this.parseDraft(body, user, false);
    const now = new Date();
    const row = await this.prisma.campaigns.create({
      data: {
        ...this.draftData(d), kind: 'celebration', status: 'draft', content: '',
        created_by: user.name, created_by_id: user.id ?? null, created_at: now, updated_at: now,
      },
    });
    await this.audit.record(user, 'Celebration draft saved', d.name, `Occasion: ${occasionLabel(d.occasion, d.occasion_label)}`);
    return this.get(row.id, user);
  }

  async update(id: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const c = await this.mine(id, user);
    if (!EDITABLE.includes(c.status)) {
      throw new BadRequestException({ message: c.status === 'scheduled' ? 'Cancel the schedule before editing this celebration.' : 'This celebration has already been sent and can no longer be edited.' });
    }
    const d = await this.parseDraft(body, user, false);
    await this.prisma.campaigns.update({ where: { id }, data: { ...this.draftData(d), status: 'draft', updated_at: new Date() } });
    return this.get(id, user);
  }

  async remove(id: number, user: AuthUserRecord): Promise<{ success: boolean }> {
    const c = await this.mine(id, user);
    if (c.status === 'sending' || c.status === 'scheduled') {
      throw new BadRequestException({ message: c.status === 'scheduled' ? 'Cancel the schedule first.' : 'This celebration is sending and cannot be deleted now.' });
    }
    await this.prisma.campaigns.delete({ where: { id } });
    await this.audit.record(user, 'Celebration deleted', c.name, `Was ${c.status}`);
    return { success: true };
  }

  private async mine(id: number, user: AuthUserRecord): Promise<campaigns> {
    const c = await this.prisma.campaigns.findFirst({ where: { id, kind: 'celebration', created_by_id: user.id ?? -1 } });
    if (!c) throw new NotFoundException({ message: 'Celebration not found.' });
    return c;
  }

  private specOf(c: campaigns): RecipientSpec {
    try { return parseRecipientSpec((JSON.parse(c.audience ?? '{}') as { spec?: unknown }).spec); } catch { return parseRecipientSpec({}); }
  }

  // ------------------------------------------------------------------------------------- reads

  async list(user: AuthUserRecord): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.campaigns.findMany({
      where: { kind: 'celebration', created_by_id: user.id ?? -1 },
      orderBy: { id: 'desc' },
      take: 200,
    });
    return rows.map((c) => this.summary(c));
  }

  private summary(c: campaigns): Record<string, unknown> {
    return {
      id: c.id, name: c.name, status: c.status, occasion: c.occasion, occasion_label: c.occasion_label,
      occasion_name: occasionLabel(c.occasion ?? 'general', c.occasion_label), subject: c.subject,
      automation_id: c.automation_id, ai_assisted: c.ai_assisted, flyer_id: c.flyer_id,
      stats: {
        total: c.total, sent: c.sent, diverted: c.diverted, failed: c.failed, skipped: c.skipped,
        bounced: c.bounced, opened: c.opened, clicked: c.clicked, unsubscribed: c.unsubscribed,
        pending: Math.max(0, c.total - c.sent - c.diverted - c.failed - c.skipped),
      },
      sender_email: c.sender_email, timezone: c.timezone,
      scheduled_for: c.scheduled_for?.toISOString() ?? null,
      sent_at: c.sent_at?.toISOString() ?? null,
      created_at: c.created_at?.toISOString() ?? null,
      updated_at: c.updated_at?.toISOString() ?? null,
    };
  }

  async get(id: number, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const c = await this.mine(id, user);
    const recipients = await this.prisma.campaign_recipients.findMany({
      where: { campaign_id: id },
      orderBy: { id: 'asc' },
      select: {
        id: true, lead_id: true, name: true, email: true, status: true, error: true, opened: true, opened_at: true,
        clicked_at: true, unsubscribed: true, bounced: true, bounce_type: true, failure_kind: true, retry_count: true,
        next_retry_at: true, provider_message_id: true, sent_at: true,
      },
    });
    const byStatus: Record<string, number> = {};
    for (const r of recipients) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    let snapshot: Record<string, unknown> = {};
    try { snapshot = JSON.parse(c.audience ?? '{}') as Record<string, unknown>; } catch { snapshot = {}; }
    const flyer = c.flyer_id ? await this.prisma.campaign_flyers.findUnique({ where: { id: c.flyer_id } }) : null;
    return {
      ...this.summary(c),
      preview_text: c.preview_text, message: c.message, branding: c.branding, reply_to: c.reply_to,
      sender_account_id: c.sender_account_id, recipients_spec: this.specOf(c),
      audience_snapshot: { exclusions: snapshot.exclusions ?? [], matched: snapshot.matched ?? null, not_permitted: snapshot.not_permitted ?? 0, built_at: snapshot.built_at ?? null },
      flyer: flyer ? this.flyers.present(flyer) : null,
      by_status: byStatus,
      retryable: recipients.filter((r) => r.status === 'failed' && (r.failure_kind === 'not_sent' || r.failure_kind === 'soft_exhausted')).length,
      unknown_outcome: recipients.filter((r) => r.failure_kind === 'unknown_outcome').length,
      recipients: recipients.map((r) => ({
        ...r,
        opened_at: r.opened_at?.toISOString() ?? null, clicked_at: r.clicked_at?.toISOString() ?? null,
        next_retry_at: r.next_retry_at?.toISOString() ?? null, sent_at: r.sent_at?.toISOString() ?? null,
      })),
    };
  }

  // ---------------------------------------------------------------------------------- audience

  /** The audience as it stands now, with every exclusion counted. Sends nothing. */
  async audiencePreview(body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const occasion = str(body.occasion);
    if (!isOccasion(occasion)) throw new BadRequestException({ message: 'Choose an occasion first.' });
    const tz = str(body.timezone) || DEFAULT_TIMEZONE;
    const at = this.parseAt(body);
    const result = await this.celebrationAudience.resolve(parseRecipientSpec(body.recipients), user, {
      occasion, occasionLabel: str(body.occasion_label), timezone: isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE, at,
    });
    const search = str(body.search).toLowerCase();
    const list = search
      ? result.recipients.filter((r) => r.name.toLowerCase().includes(search) || r.email.toLowerCase().includes(search))
      : result.recipients;
    return {
      count: result.recipients.length,
      matched: result.matched,
      not_permitted: result.not_permitted,
      exclusions: result.exclusions,
      excluded_total: result.exclusions.reduce((n, e) => n + e.count, 0),
      over_cap: result.over_cap,
      scan_capped: result.scan_capped,
      max_recipients: result.max_recipients,
      year: result.year,
      days: result.days,
      recipients: list.slice(0, 500).map((r) => ({ lead_id: r.leadId, name: r.name, email: r.email, first_name: r.vars.LEAD_FIRST_NAME })),
      scope: hasBrokerageLeadScope(user) ? 'brokerage' : 'own',
    };
  }

  /** When a schedule would send, so a date window ("today") is read on the send date. */
  private parseAt(body: Record<string, unknown>): Date {
    if (str(body.schedule_date) && str(body.schedule_time)) {
      const at = zonedTimeToUtc(str(body.schedule_date), str(body.schedule_time), str(body.timezone) || DEFAULT_TIMEZONE);
      if (at) return at;
    }
    return new Date();
  }

  /** Leads this person may pick by hand, searched by name or email. */
  async searchLeads(q: string, user: AuthUserRecord): Promise<Record<string, unknown>[]> {
    const search = str(q).slice(0, 80);
    const rows = await this.prisma.leads.findMany({
      where: {
        AND: [
          { deleted_at: null },
          leadScopeWhere(user),
          ...(search ? [{ OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] }] : []),
        ],
      },
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      take: 30,
      select: { id: true, name: true, email: true, lead_status: true, unsubscribed: true, date_of_birth: true, marriage_day: true },
    });
    const suppressed = await this.audience.suppressedEmails(rows.map((r) => str(r.email)).filter(Boolean));
    return rows.map((r) => {
      const email = str(r.email);
      const why = !email ? 'No email address' : !EMAIL.test(email) ? 'Invalid email address'
        : r.unsubscribed ? 'Unsubscribed' : suppressed.has(email.toLowerCase()) ? 'On the suppression list' : null;
      return {
        id: r.id, name: r.name, email: r.email, lead_status: r.lead_status, eligible: !why, reason: why,
        has_birthday: !!r.date_of_birth, has_anniversary: !!r.marriage_day,
      };
    });
  }

  // ---------------------------------------------------------------------------------- rendering

  private async agentPhone(user: AuthUserRecord, brokeragePhone: string): Promise<string> {
    if (str(user.phone)) return str(user.phone);
    const agent = await this.prisma.agents.findFirst({ where: { name: { equals: user.name, mode: 'insensitive' }, active: true }, select: { phone: true } });
    return str(agent?.phone) || brokeragePhone;
  }

  /** The sign-off and the AGENT_* merge values, both resolved from current details. */
  async senderDetails(user: AuthUserRecord, branding: string): Promise<{ signature: Signature; agentVars: Record<string, string> }> {
    const b = await this.celebrationAudience.brokerage();
    const phone = await this.agentPhone(user, b.phone);
    const agentVars = { AGENT_NAME: str(user.name) || b.name, AGENT_EMAIL: str(user.email) || b.email, AGENT_PHONE: phone };
    const signature: Signature = branding === 'brokerage'
      ? { name: b.name, phone: b.phone, email: b.email, brokerage: b.name }
      : { name: agentVars.AGENT_NAME, phone, email: agentVars.AGENT_EMAIL, brokerage: b.name };
    return { signature, agentVars };
  }

  async contentFor(d: { message: string; preview_text: string | null; flyer_id: number | null; branding: string }, user: AuthUserRecord, flyerSrc?: 'cid' | 'data') {
    const { signature, agentVars } = await this.senderDetails(user, d.branding);
    const flyer = d.flyer_id ? await this.prisma.campaign_flyers.findUnique({ where: { id: d.flyer_id } }) : null;
    const html = renderCelebrationHtml({
      message: d.message,
      previewText: d.preview_text,
      signature,
      flyer: flyer ? {
        alt: flyer.alt_text, width: flyer.width, height: flyer.height,
        src: flyerSrc === 'data' ? `data:${flyer.mime};base64,${Buffer.from(flyer.data).toString('base64')}` : `cid:${FLYER_CID}`,
      } : null,
    });
    return { html, agentVars, flyer };
  }

  /** The address the send will leave from — the chosen mailbox, or the one the CRM would resolve. */
  async senderAccount(senderAccountId: number | null, user: AuthUserRecord): Promise<mail_accounts | null> {
    if (senderAccountId) {
      return this.prisma.mail_accounts.findFirst({ where: { id: senderAccountId, ...MailAccountService.crmSenderWhere(user.id ?? null) } });
    }
    try { return await this.mailer.resolveSenderInArea(user.id ?? null, 'crm'); } catch { return null; }
  }

  /** Merge values for a preview or test: a real lead's, when one in this person's scope is named. */
  private async sampleVars(leadId: unknown, user: AuthUserRecord) {
    const id = Number(leadId);
    const b = await this.celebrationAudience.brokerage();
    if (Number.isInteger(id) && id > 0) {
      const lead = await this.prisma.leads.findFirst({
        where: { AND: [{ id, deleted_at: null }, leadScopeWhere(user)] },
        select: { id: true, name: true, first_name: true, email: true },
      });
      if (lead) return { lead, vars: recipientVars(lead, b) };
    }
    return { lead: null, vars: recipientVars({ name: '' }, b) };
  }

  /** The message exactly as one recipient would get it. Creates nothing, sends nothing. */
  async preview(body: Record<string, unknown>, user: AuthUserRecord, baseUrl: string): Promise<Record<string, unknown>> {
    const d = await this.parseDraft(body, user, false);
    const { html: layout, agentVars } = await this.contentFor(d, user, 'data');
    const { lead, vars } = await this.sampleVars(body.sample_lead_id, user);
    const all = { ...vars, ...agentVars };
    const subject = this.audience.personalize(d.subject, {}, all);
    const previewText = this.audience.personalize(d.preview_text ?? '', {}, all);
    const html = this.audience.injectTracking(this.audience.personalize(layout, {}, all), {
      baseUrl, campaignId: 0, token: 'preview', pixel: false,
    });
    const account = await this.senderAccount(d.sender_account_id, user);
    return {
      subject, preview_text: previewText, html, text: htmlToText(html),
      from: account ? { name: account.from_name || null, email: account.from_email } : null,
      reply_to: d.reply_to || account?.from_email || null,
      sample: lead ? { lead_id: lead.id, name: lead.name, email: lead.email } : null,
      merge_values: all,
      send_problem: publicBaseUrlProblem(baseUrl),
    };
  }

  // --------------------------------------------------------------------------------- test send

  /**
   * One real email of the message, personalised with a chosen lead's values, to an address the
   * author names. Recorded in the CRM email log like every test. Never touches the recipients.
   */
  async testSend(id: number, body: Record<string, unknown>, user: AuthUserRecord, baseUrl: string): Promise<Record<string, unknown>> {
    const c = await this.mine(id, user);
    const to = str(body.to);
    if (!EMAIL.test(to)) throw new BadRequestException({ message: 'Enter a valid email address to send the test to.', errors: { to: ['A valid email address is required.'] } });
    const d = { message: c.message ?? '', preview_text: c.preview_text, flyer_id: c.flyer_id, branding: c.branding ?? 'agent' };
    if (!c.subject || !d.message) throw new BadRequestException({ message: 'Write the subject and message before sending a test.' });
    const { html: layout, agentVars, flyer } = await this.contentFor(d, user, 'cid');
    const { vars } = await this.sampleVars(body.sample_lead_id, user);
    const all = { ...vars, ...agentVars };
    const subject = `[Test] ${this.audience.personalize(c.subject, {}, all)}`;
    const html = this.audience.injectTracking(this.audience.personalize(layout, {}, all), {
      baseUrl, campaignId: 0, token: 'test', pixel: false,
    });
    const redirect = MailerService.redirectTarget();
    const account = await this.senderAccount(c.sender_account_id, user);
    if (!account) {
      return { ok: false, error: 'No email account is connected to send from. Connect one under Settings → Email, then try again.' };
    }
    try {
      const res = await this.mailer.sendFromAccount(account, {
        to: [to], subject, html, text: htmlToText(html),
        attachments: flyer ? [{ data: Buffer.from(flyer.data).toString('base64'), name: 'greeting.jpg', mime: flyer.mime, cid: FLYER_CID }] : [],
        headers: c.reply_to ? { 'Reply-To': c.reply_to } : {},
        maxAttempts: 1,
      });
      await this.emailLog.recordExternalSend('campaign_test', to, subject, true, null, user, redirect).catch(() => undefined);
      return { ok: true, from: account.from_email, message_id: res.messageId, diverted_to: redirect };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emailLog.recordExternalSend('campaign_test', to, subject, false, message, user, redirect).catch(() => undefined);
      return { ok: false, error: message };
    }
  }

  // ------------------------------------------------------------------------------- send / schedule

  /**
   * Send now or schedule — the only thing in this feature that sends.
   *
   * Requires `confirm: true`, which only the final step's button sets. The draft is CLAIMED with a
   * conditional update (draft/cancelled → sending/scheduled) before any recipient is written, so a
   * double-click, a replayed request or a second tab produces one send, not two.
   */
  async send(id: number, body: Record<string, unknown>, user: AuthUserRecord, baseUrl: string): Promise<Record<string, unknown>> {
    if (body.confirm !== true) throw new BadRequestException({ message: 'Confirm the send from the final step.' });
    const c = await this.mine(id, user);
    if (!EDITABLE.includes(c.status)) throw new ConflictException({ message: `This celebration is already ${c.status}.` });

    const d = await this.parseDraft({
      name: c.name, occasion: c.occasion, occasion_label: c.occasion_label, subject: c.subject, preview_text: c.preview_text,
      message: c.message, branding: c.branding, sender_account_id: c.sender_account_id, reply_to: c.reply_to,
      flyer_id: c.flyer_id, timezone: str(body.timezone) || c.timezone, recipients: this.specOf(c), ai_assisted: c.ai_assisted,
    }, user, true);

    const problem = publicBaseUrlProblem(baseUrl);
    if (problem) throw new BadRequestException({ message: problem });
    const account = await this.senderAccount(d.sender_account_id, user);
    if (!account) throw new BadRequestException({ message: 'No email account is connected to send from. Connect one under Settings → Email, then try again.' });

    const mode = str(body.mode) === 'schedule' ? 'schedule' : 'now';
    let scheduledFor: Date | null = null;
    if (mode === 'schedule') {
      scheduledFor = zonedTimeToUtc(str(body.schedule_date), str(body.schedule_time), d.timezone);
      if (!scheduledFor) throw new BadRequestException({ message: 'Choose a valid date, time and timezone for the schedule.' });
      if (scheduledFor.getTime() < Date.now() + 60_000) throw new BadRequestException({ message: 'Choose a time at least a minute from now, or send now.' });
      if (scheduledFor.getTime() > Date.now() + 366 * 86400_000) throw new BadRequestException({ message: 'Schedules can be at most a year ahead.' });
    }

    const result: AudienceResult = await this.celebrationAudience.resolve(d.recipients, user, {
      occasion: d.occasion, occasionLabel: d.occasion_label, timezone: d.timezone, at: scheduledFor ?? new Date(),
    });
    if (!result.recipients.length) {
      throw new BadRequestException({ message: 'Nobody is eligible to receive this celebration. Check the recipients and the exclusions listed.' });
    }
    if (result.over_cap) {
      throw new BadRequestException({ message: `This would reach ${result.recipients.length} people, above the ${CELEBRATION_MAX_RECIPIENTS} limit for one celebration. Narrow the recipients and send it in parts.` });
    }

    const { html: content, agentVars } = await this.contentFor(d, user, 'cid');
    const now = new Date();
    const status = scheduledFor ? 'scheduled' : 'sending';
    const snapshot = {
      spec: d.recipients, built_at: now.toISOString(), matched: result.matched, not_permitted: result.not_permitted,
      exclusions: result.exclusions.map((e) => ({ reason: e.reason, label: e.label, count: e.count })),
    };

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.campaigns.updateMany({
        where: { id, created_by_id: user.id ?? -1, kind: 'celebration', status: { in: EDITABLE } },
        data: {
          status, content, scheduled_for: scheduledFor, timezone: d.timezone, tracking_base_url: baseUrl,
          total: result.recipients.length, sent: 0, failed: 0, bounced: 0, skipped: 0, diverted: 0,
          opened: 0, clicked: 0, unsubscribed: 0, sent_at: null,
          audience: JSON.stringify(snapshot), updated_at: now,
        },
      });
      if (claimed.count !== 1) throw new ConflictException({ message: 'This celebration was already sent or scheduled.' });
      // Anything left from a cancelled schedule was never attempted (cancel only succeeds while
      // nothing has gone), so it is rebuilt from the audience as it stands now.
      await tx.campaign_recipients.deleteMany({ where: { campaign_id: id } });
      await tx.campaign_recipients.createMany({
        data: result.recipients.map((r) => ({
          campaign_id: id, lead_id: r.leadId, name: r.name, email: r.email,
          token: this.audience.newRecipientToken(),
          vars: JSON.stringify({ ...r.vars, ...agentVars }),
          status: 'pending', created_at: now, updated_at: now,
        })),
      });
    });

    await this.audit.record(
      user, scheduledFor ? 'Celebration scheduled' : 'Celebration sent', d.name,
      `${result.recipients.length} recipient(s), ${result.exclusions.reduce((n, e) => n + e.count, 0)} excluded, subject "${d.subject}"`
      + (scheduledFor ? `, to send ${scheduledFor.toISOString()} (${d.timezone})` : ''),
    );

    if (!scheduledFor) this.startDelivery(id);
    return this.get(id, user);
  }

  /** Hand a celebration to the Campaigns delivery engine, detached. Never throws. */
  startDelivery(id: number): void {
    void this.campaigns.resume(id).catch(async (err) => {
      this.log.error(`Celebration #${id} could not start: ${err instanceof Error ? err.message : String(err)}`);
      await this.prisma.campaigns.updateMany({ where: { id, status: 'sending' }, data: { status: 'failed', updated_at: new Date() } }).catch(() => undefined);
    });
  }

  /** Call off a scheduled celebration. Only while nothing has gone — the claim decides. */
  async cancel(id: number, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const c = await this.mine(id, user);
    const done = await this.prisma.campaigns.updateMany({
      where: { id, status: 'scheduled' },
      data: { status: 'cancelled', scheduled_for: null, updated_at: new Date() },
    });
    if (done.count !== 1) {
      throw new BadRequestException({ message: c.status === 'sending' ? 'This celebration is already going out and cannot be cancelled.' : 'Only a scheduled celebration can be cancelled.' });
    }
    await this.prisma.campaign_recipients.deleteMany({ where: { campaign_id: id, status: 'pending' } });
    await this.prisma.campaigns.update({ where: { id }, data: { total: 0 } });
    await this.audit.record(user, 'Celebration cancelled', c.name, 'Cancelled before sending; nothing was sent');
    return this.get(id, user);
  }

  /**
   * Send again to the recipients whose message certainly did not leave (`not_sent`, or soft bounces
   * that ran out of retries). Sent, diverted, skipped, hard-bounced and outcome-unknown recipients
   * are never included. Eligibility is re-checked by the send itself.
   */
  async retryFailed(id: number, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const c = await this.mine(id, user);
    if (!['completed', 'partial', 'failed'].includes(c.status)) {
      throw new BadRequestException({ message: 'Only a finished celebration can retry its failed sends.' });
    }
    const rows = await this.prisma.campaign_recipients.findMany({
      where: { campaign_id: id, status: 'failed', failure_kind: { in: ['not_sent', 'soft_exhausted'] } },
      select: { id: true },
    });
    if (!rows.length) throw new BadRequestException({ message: 'There are no failed sends that are safe to retry.' });
    const claimed = await this.prisma.campaigns.updateMany({
      where: { id, status: { in: ['completed', 'partial', 'failed'] } },
      data: { status: 'sending', failed: { decrement: rows.length }, updated_at: new Date() },
    });
    if (claimed.count !== 1) throw new ConflictException({ message: 'This celebration is already being retried.' });
    await this.prisma.campaign_recipients.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: 'failed' },
      data: { status: 'pending', error: null, failure_kind: null, bounce_type: null, retry_count: 0, next_retry_at: null, updated_at: new Date() },
    });
    await this.audit.record(user, 'Celebration retry', c.name, `${rows.length} failed recipient(s) queued again`);
    this.startDelivery(id);
    return this.get(id, user);
  }
}
