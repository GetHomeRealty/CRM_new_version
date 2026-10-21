import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { celebration_automations } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailAccountService } from '../email/mail-account.service';
import { schedulerSkipReason, schedulersEnabled } from '../common/schedulers';
import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { CampaignAuditService } from './campaign-audit.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { publicBaseUrlProblem } from './campaigns.service';
import { CelebrationAudienceService, parseRecipientSpec, type AudienceResult } from './celebration-audience.service';
import { CelebrationCampaignsService } from './celebration-campaigns.service';
import {
  BRANDINGS, CELEBRATION_MAX_RECIPIENTS, FEB29_RULES, isValidTimeZone, occasionLabel, unknownTokens, zonedDate, zonedParts,
} from './celebration';

/** Every five minutes: a greeting is owed on a day at a time, so this is about the minute, not the second. */
const TICK_MS = 5 * 60 * 1000;
const FIRST_PASS_MS = 2 * 60 * 1000;

const str = (v: unknown): string => String(v ?? '').trim();
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const dateOnly = (ymd: string): Date => new Date(`${ymd}T00:00:00.000Z`);
const ymdOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Annual birthday and anniversary greetings, as rules in Campaigns.
 *
 * NOTHING RECURRING SENDS UNTIL SOMEBODY SWITCHES IT ON. A rule is created paused, and activating it
 * is a separate, explicit action. A run sends the SAVED message and flyer — it never generates new
 * AI content.
 *
 * EACH RUN IS A CELEBRATION CAMPAIGN, so the day's greetings appear in the Celebrations list with
 * per-recipient results, and delivery is the Campaigns engine with its re-checks: the creator's
 * permission and lead scope, consent, the suppression list and the one-per-address-per-year mark —
 * which is shared with the Settings greeting sweep through the CRM email log, so a lead greeted by
 * either is not greeted again by the other.
 *
 * ONE RUN PER RULE PER LOCAL DAY, claimed with a conditional update on `last_run_on`, so two
 * processes or a restart mid-run cannot produce a second campaign for the same day.
 */
@Injectable()
export class CelebrationAutomationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CelebrationAutomationService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: CampaignAudienceService,
    private readonly celebrationAudience: CelebrationAudienceService,
    private readonly celebrations: CelebrationCampaignsService,
    private readonly audit: CampaignAuditService,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.CELEBRATION_AUTOMATIONS_DISABLED === '1') {
      this.log.log(`Celebration automations not scheduled (${process.env.CELEBRATION_AUTOMATIONS_DISABLED === '1' ? 'CELEBRATION_AUTOMATIONS_DISABLED=1' : schedulerSkipReason()}).`);
      return;
    }
    registerWorker('celebration-automations', TICK_MS);
    const tick = clusterTick({ redis: this.redis, cache: this.cache }, 'celebration-automations', () => this.sweep());
    setTimeout(tick, FIRST_PASS_MS).unref?.();
    this.timer = setInterval(tick, TICK_MS);
    this.timer.unref?.();
    this.log.log(`Celebration automations checked every ${TICK_MS / 60000} min.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------------------------- rules

  private async parse(body: Record<string, unknown>, user: AuthUserRecord) {
    const errors: Record<string, string[]> = {};
    const fail = (k: string, m: string) => { errors[k] = [...(errors[k] ?? []), m]; };
    const occasion = str(body.occasion);
    if (occasion !== 'birthday' && occasion !== 'anniversary') fail('occasion', 'Choose birthday or anniversary.');
    const name = str(body.name) || `${occasion === 'anniversary' ? 'Anniversary' : 'Birthday'} greetings`;
    if (name.length > 255) fail('name', 'Must be 255 characters or fewer.');
    const subject = str(body.subject);
    if (!subject) fail('subject', 'Write a subject line.');
    if (subject.length > 200) fail('subject', 'Must be 200 characters or fewer.');
    const preview = str(body.preview_text).slice(0, 255) || null;
    const message = String(body.message ?? '').replace(/\r\n?/g, '\n').trim();
    if (!message) fail('message', 'Write the message.');
    if (message.length > 10000) fail('message', 'Keep the message under 10,000 characters.');
    const bad = unknownTokens(subject, preview, message);
    if (bad.length) fail('message', `These merge fields cannot be filled: ${bad.map((t) => `{{${t}}}`).join(', ')}.`);
    const branding = (BRANDINGS as readonly string[]).includes(str(body.branding)) ? str(body.branding) : 'agent';
    const replyTo = str(body.reply_to) || null;
    if (replyTo && !EMAIL.test(replyTo)) fail('reply_to', 'Enter one valid email address, or leave it blank.');
    const sendTime = str(body.send_time) || '09:00';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) fail('send_time', 'Choose a send time (HH:MM).');
    const timezone = str(body.timezone);
    if (!isValidTimeZone(timezone)) fail('timezone', 'Choose the timezone the send time is in.');
    const feb29 = (FEB29_RULES as readonly string[]).includes(str(body.feb29_rule)) ? str(body.feb29_rule) : 'feb28';
    let sender: number | null = null;
    if (body.sender_account_id !== undefined && body.sender_account_id !== null && body.sender_account_id !== '') {
      const id = Number(body.sender_account_id);
      const ok = Number.isInteger(id) && await this.prisma.mail_accounts.findFirst({ where: { id, ...MailAccountService.crmSenderWhere(user.id ?? null) }, select: { id: true } });
      if (!ok) fail('sender_account_id', 'That email account is not available to send from.'); else sender = id;
    }
    let flyerId: number | null = null;
    if (body.flyer_id !== undefined && body.flyer_id !== null && body.flyer_id !== '') {
      const id = Number(body.flyer_id);
      const f = Number.isInteger(id) ? await this.prisma.campaign_flyers.findFirst({ where: { id, created_by_id: user.id ?? -1, deleted_at: null }, select: { id: true } }) : null;
      if (!f) fail('flyer_id', 'That flyer is not available.'); else flyerId = id;
    }
    // Hand-picked recipients make no sense for a yearly rule; the date decides who is greeted.
    const spec = parseRecipientSpec(body.recipients);
    const filters = { mode: spec.mode === 'filtered' ? 'filtered' : 'all', filters: { ...spec.filters, date_window: undefined, date_on: undefined }, excluded_lead_ids: spec.excluded_lead_ids };
    if (Object.keys(errors).length) throw new BadRequestException({ message: Object.values(errors)[0][0], errors });
    return {
      name, occasion, subject, preview_text: preview, message, branding, reply_to: replyTo, send_time: sendTime,
      timezone, feb29_rule: feb29, sender_account_id: sender, flyer_id: flyerId, filters: JSON.stringify(filters),
    };
  }

  async list(user: AuthUserRecord): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.celebration_automations.findMany({
      where: { created_by_id: user.id ?? -1, deleted_at: null }, orderBy: { id: 'desc' },
    });
    return rows.map((r) => this.present(r));
  }

  present(r: celebration_automations): Record<string, unknown> {
    let filters: unknown = null; let summary: unknown = null;
    try { filters = r.filters ? JSON.parse(r.filters) : null; } catch { filters = null; }
    try { summary = r.last_run_summary ? JSON.parse(r.last_run_summary) : null; } catch { summary = r.last_run_summary; }
    return {
      id: r.id, name: r.name, occasion: r.occasion, status: r.status, subject: r.subject, preview_text: r.preview_text,
      message: r.message, branding: r.branding, flyer_id: r.flyer_id, sender_account_id: r.sender_account_id,
      reply_to: r.reply_to, send_time: r.send_time, timezone: r.timezone, feb29_rule: r.feb29_rule, recipients: filters,
      last_run_on: ymdOf(r.last_run_on), last_run_at: r.last_run_at?.toISOString() ?? null, last_run_summary: summary,
      next_run: r.status === 'active' ? this.nextRun(r) : null,
      created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
    };
  }

  /** When the next run is due, said in the rule's own timezone. */
  private nextRun(r: celebration_automations, now = new Date()): string {
    const today = zonedDate(now, r.timezone);
    const p = zonedParts(now, r.timezone);
    const hhmm = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
    if (ymdOf(r.last_run_on) !== today) {
      return hhmm >= r.send_time ? `Within ${TICK_MS / 60000} minutes (today's ${r.send_time} has passed)` : `Today at ${r.send_time} ${r.timezone}`;
    }
    return `Tomorrow at ${r.send_time} ${r.timezone}`;
  }

  async mine(id: number, user: AuthUserRecord): Promise<celebration_automations> {
    const r = await this.prisma.celebration_automations.findFirst({ where: { id, created_by_id: user.id ?? -1, deleted_at: null } });
    if (!r) throw new NotFoundException({ message: 'Automation not found.' });
    return r;
  }

  async create(body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const data = await this.parse(body, user);
    const now = new Date();
    const r = await this.prisma.celebration_automations.create({
      data: { ...data, status: 'paused', created_by_id: user.id as number, created_by: user.name, created_at: now, updated_at: now },
    });
    await this.audit.record(user, 'Celebration automation created (paused)', r.name, `${r.occasion} at ${r.send_time} ${r.timezone}`);
    return this.present(r);
  }

  async update(id: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.mine(id, user);
    const data = await this.parse(body, user);
    const r = await this.prisma.celebration_automations.update({ where: { id }, data: { ...data, updated_at: new Date() } });
    await this.audit.record(user, 'Celebration automation edited', r.name, `Status ${r.status}`);
    return this.present(r);
  }

  async remove(id: number, user: AuthUserRecord): Promise<{ success: boolean }> {
    const r = await this.mine(id, user);
    await this.prisma.celebration_automations.update({ where: { id }, data: { status: 'paused', deleted_at: new Date(), updated_at: new Date() } });
    await this.audit.record(user, 'Celebration automation deleted', r.name, '');
    return { success: true };
  }

  async setStatus(id: number, status: 'active' | 'paused', confirm: boolean, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const r = await this.mine(id, user);
    if (status === 'active') {
      if (!confirm) throw new BadRequestException({ message: 'Confirm that this rule should send every year.' });
      if (!this.celebrationAudience.maySend(user)) throw new BadRequestException({ message: 'You do not have permission to send campaigns.' });
    }
    const u = await this.prisma.celebration_automations.update({ where: { id }, data: { status, updated_at: new Date() } });
    await this.audit.record(user, status === 'active' ? 'Celebration automation switched ON' : 'Celebration automation paused', r.name, `${r.occasion} at ${r.send_time} ${r.timezone}`);
    return this.present(u);
  }

  private specFor(r: celebration_automations, day: string) {
    let saved: Record<string, unknown> = {};
    try { saved = r.filters ? JSON.parse(r.filters) as Record<string, unknown> : {}; } catch { saved = {}; }
    const base = parseRecipientSpec(saved);
    return parseRecipientSpec({
      mode: base.mode === 'filtered' ? 'filtered' : 'all',
      filters: { ...base.filters, date_window: 'on_date', date_on: day, feb29_rule: r.feb29_rule },
      excluded_lead_ids: base.excluded_lead_ids,
    });
  }

  /** Who a rule would greet on a day, and who it would skip and why. Sends nothing. */
  async dryRun(id: number, date: string, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const r = await this.mine(id, user);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(str(date)) ? str(date) : zonedDate(new Date(), r.timezone);
    const result = await this.celebrationAudience.resolve(this.specFor(r, day), user, { occasion: r.occasion, timezone: r.timezone });
    return {
      date: day, count: result.recipients.length, exclusions: result.exclusions, over_cap: result.over_cap,
      recipients: result.recipients.slice(0, 200).map((x) => ({ lead_id: x.leadId, name: x.name, email: x.email })),
    };
  }

  // ------------------------------------------------------------------------------------- sweep

  async sweep(now: Date = new Date()): Promise<{ ran: number }> {
    if (this.running) return { ran: 0 };
    this.running = true;
    let ran = 0;
    try {
      const rules = await this.prisma.celebration_automations.findMany({ where: { status: 'active', deleted_at: null }, orderBy: { id: 'asc' } });
      for (const r of rules) {
        if (!isValidTimeZone(r.timezone)) continue;
        const today = zonedDate(now, r.timezone);
        const p = zonedParts(now, r.timezone);
        const hhmm = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
        if (hhmm < r.send_time || ymdOf(r.last_run_on) === today) continue;
        // THE CLAIM: only one process, once per local day.
        const claimed = await this.prisma.celebration_automations.updateMany({
          where: { id: r.id, status: 'active', deleted_at: null, OR: [{ last_run_on: null }, { last_run_on: { lt: dateOnly(today) } }] },
          data: { last_run_on: dateOnly(today), last_run_at: now, updated_at: now },
        });
        if (claimed.count !== 1) continue;
        ran += 1;
        try {
          await this.run(r, today, now);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.error(`Celebration automation #${r.id} failed on ${today}: ${message}`);
          await this.summarise(r.id, { date: today, error: message });
        }
      }
    } finally {
      this.running = false;
    }
    return { ran };
  }

  private async summarise(id: number, summary: Record<string, unknown>): Promise<void> {
    await this.prisma.celebration_automations.update({ where: { id }, data: { last_run_summary: JSON.stringify(summary), updated_at: new Date() } }).catch(() => undefined);
  }

  /** One day's run of one rule: resolve, record exclusions, create the day's campaign and send it. */
  async run(r: celebration_automations, day: string, now: Date = new Date()): Promise<Record<string, unknown>> {
    const creator = await this.celebrationAudience.creator(r.created_by_id);
    if (!this.celebrationAudience.maySend(creator)) {
      await this.prisma.celebration_automations.update({ where: { id: r.id }, data: { status: 'paused', updated_at: new Date() } });
      const summary = { date: day, error: 'Paused automatically: the person who created this rule can no longer send campaigns (account inactive or permission removed).' };
      await this.summarise(r.id, summary);
      return summary;
    }
    const user = creator as AuthUserRecord;
    const baseUrl = str(process.env.CAMPAIGN_PUBLIC_URL).replace(/\/+$/, '');
    const problem = publicBaseUrlProblem(baseUrl);
    if (problem) { const s = { date: day, error: problem }; await this.summarise(r.id, s); return s; }
    const account = await this.celebrations.senderAccount(r.sender_account_id, user);
    if (!account) { const s = { date: day, error: 'No email account is available to send from — the chosen mailbox was disconnected, or none is connected.' }; await this.summarise(r.id, s); return s; }

    const result: AudienceResult = await this.celebrationAudience.resolve(this.specFor(r, day), user, { occasion: r.occasion, timezone: r.timezone, at: now });
    const exclusions = result.exclusions.map((e) => ({ reason: e.reason, label: e.label, count: e.count }));
    if (!result.recipients.length) {
      const s = { date: day, recipients: 0, exclusions, note: `Nobody's ${r.occasion} falls on ${day}, or everyone matching was excluded.` };
      await this.summarise(r.id, s);
      return s;
    }
    // A day that would exceed the cap sends the first part and says so, rather than nobody.
    const recipients = result.recipients.slice(0, CELEBRATION_MAX_RECIPIENTS);

    const { html: content, agentVars } = await this.celebrations.contentFor(
      { message: r.message, preview_text: r.preview_text, flyer_id: r.flyer_id, branding: r.branding }, user, 'cid',
    );
    const stamp = new Date();
    const campaign = await this.prisma.campaigns.create({
      data: {
        kind: 'celebration', automation_id: r.id, name: `${r.name} — ${day}`, occasion: r.occasion,
        category: r.occasion, subject: r.subject, preview_text: r.preview_text, message: r.message, content,
        branding: r.branding, flyer_id: r.flyer_id, sender_account_id: r.sender_account_id, reply_to: r.reply_to,
        timezone: r.timezone, status: 'sending', total: recipients.length, tracking_base_url: baseUrl,
        audience: JSON.stringify({ spec: this.specFor(r, day), built_at: stamp.toISOString(), matched: result.matched, exclusions }),
        created_by: user.name, created_by_id: user.id, created_at: stamp, updated_at: stamp,
        recipients: {
          create: recipients.map((x) => ({
            lead_id: x.leadId, name: x.name, email: x.email, token: this.audience.newRecipientToken(),
            vars: JSON.stringify({ ...x.vars, ...agentVars }), status: 'pending', created_at: stamp, updated_at: stamp,
          })),
        },
      },
    });
    const summary = {
      date: day, campaign_id: campaign.id, recipients: recipients.length, exclusions,
      ...(result.recipients.length > recipients.length ? { note: `${result.recipients.length - recipients.length} more matched than the ${CELEBRATION_MAX_RECIPIENTS} limit and were not sent today.` } : {}),
    };
    await this.summarise(r.id, summary);
    await this.audit.record(user, 'Celebration automation ran', r.name, `${occasionLabel(r.occasion)} ${day}: ${recipients.length} recipient(s), campaign #${campaign.id}`);
    this.celebrations.startDelivery(campaign.id);
    return summary;
  }
}
