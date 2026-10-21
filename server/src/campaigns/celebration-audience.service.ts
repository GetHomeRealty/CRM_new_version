import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, campaign_recipients, campaigns } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionService } from '../auth/permission.service';
import { leadScopeWhere, liveLeadWhere } from '../common/lead-scope';
import type { AuthUserRecord } from '../auth/auth.types';
import type { MailAttachment } from '../email/mailer.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { EMAIL_SHAPE } from './campaign.constants';
import {
  CELEBRATION_MAX_RECIPIENTS, DEFAULT_TIMEZONE, FLYER_CID, celebratedOn, emailLogKind, isDateOccasion,
  isImplausibleDate, occasionKey, recipientVars, windowDays, zonedDate, zonedTimeToUtc,
} from './celebration';

/** Who a celebration goes to, as the author chose it. */
export interface RecipientSpec {
  mode: 'all' | 'filtered' | 'selected' | 'single';
  filters: {
    agent_id?: number | null;
    status?: string;
    tags?: string[];
    location?: string;
    source?: string;
    lead_type?: string;
    client_type?: string;
    /** Birthday / anniversary only: today | next7 | this_month | on_date. */
    date_window?: string;
    date_on?: string;
    feb29_rule?: string;
  };
  lead_ids: number[];
  excluded_lead_ids: number[];
}

export interface ResolvedRecipient { leadId: number; name: string; email: string; vars: Record<string, string> }

export interface Exclusion { reason: string; label: string; count: number; sample: { lead_id: number; name: string; email: string | null }[] }

export interface AudienceResult {
  recipients: ResolvedRecipient[];
  exclusions: Exclusion[];
  /** Leads that matched the selection before any exclusion. */
  matched: number;
  /** Picked by id but not among this person's leads — counted, never described. */
  not_permitted: number;
  /** More leads matched than one resolution reads. */
  scan_capped: boolean;
  over_cap: boolean;
  max_recipients: number;
  /** The year duplicate prevention counts against. */
  year: number;
  /** The calendar days a birthday/anniversary window covered. */
  days: string[];
}

export const EXCLUSION_LABELS: Record<string, string> = {
  excluded_by_you: 'Excluded by you',
  missing_email: 'No email address',
  invalid_email: 'Invalid email address',
  unsubscribed: 'Unsubscribed',
  suppressed: 'On the suppression list (opted out or bounced)',
  duplicate_email: 'Duplicate email address (sent once)',
  missing_date: 'No date on file',
  invalid_date: 'Date on file looks wrong (before 1900 or in the future)',
  already_greeted: 'Already received this greeting this year',
  no_longer_permitted: 'No longer one of the sender’s leads, or deleted',
  email_changed: 'Email address changed after this was scheduled',
  sender_not_permitted: 'The sender may no longer send campaigns',
};

const SCAN_LIMIT = CELEBRATION_MAX_RECIPIENTS * 10;
const str = (v: unknown): string => String(v ?? '').trim();

/** Normalise whatever the screen sent into a spec, discarding anything unrecognised. */
export function parseRecipientSpec(raw: unknown): RecipientSpec {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const f = (o.filters && typeof o.filters === 'object' ? o.filters : {}) as Record<string, unknown>;
  const ids = (v: unknown): number[] => (Array.isArray(v) ? v : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, CELEBRATION_MAX_RECIPIENTS);
  const mode = ['all', 'filtered', 'selected', 'single'].includes(str(o.mode)) ? str(o.mode) as RecipientSpec['mode'] : 'all';
  const agent = Number(f.agent_id);
  return {
    mode,
    filters: {
      agent_id: Number.isInteger(agent) && agent > 0 ? agent : null,
      status: str(f.status) || undefined,
      tags: (Array.isArray(f.tags) ? f.tags : []).map(str).filter(Boolean).slice(0, 20),
      location: str(f.location).slice(0, 120) || undefined,
      source: str(f.source) || undefined,
      lead_type: str(f.lead_type) || undefined,
      client_type: str(f.client_type) || undefined,
      date_window: ['today', 'next7', 'this_month', 'on_date'].includes(str(f.date_window)) ? str(f.date_window) : undefined,
      date_on: /^\d{4}-\d{2}-\d{2}$/.test(str(f.date_on)) ? str(f.date_on) : undefined,
      feb29_rule: ['feb28', 'mar1', 'skip'].includes(str(f.feb29_rule)) ? str(f.feb29_rule) : 'feb28',
    },
    lead_ids: mode === 'single' ? ids(o.lead_ids).slice(0, 1) : ids(o.lead_ids),
    excluded_lead_ids: ids(o.excluded_lead_ids),
  };
}

/** What a send pass needs to know about a celebration that a standard campaign does not have. */
export interface CelebrationDelivery {
  occasionKey: string | null;
  year: number;
  logKind: string;
  replyTo: string | null;
  maxAttempts: number;
}

/**
 * Who a celebration reaches — resolved through the CRM's one lead-scope rule, then narrowed by every
 * sending-eligibility rule, with each exclusion counted and named.
 *
 * "All leads" is "all of this person's eligible leads": the scope is `leadScopeWhere`, exactly as the
 * Leads screen and every campaign use it, so an agent reaches their own book (and their team's) and
 * a brokerage-scope role reaches the brokerage's leads plus their own — never another agent's
 * private book. Nothing here widens that.
 */
@Injectable()
export class CelebrationAudienceService {
  private readonly log = new Logger(CelebrationAudienceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: CampaignAudienceService,
    private readonly permissions: PermissionService,
  ) {}

  async brokerage(): Promise<{ name: string; phone: string; email: string }> {
    const c = await this.prisma.company_settings.findFirst({ select: { name: true, phone: true, email: true } });
    return { name: str(c?.name) || 'Get Home Realty', phone: str(c?.phone), email: str(c?.email) };
  }

  private filterWhere(spec: RecipientSpec): Prisma.leadsWhereInput[] {
    const f = spec.filters;
    const and: Prisma.leadsWhereInput[] = [];
    if (spec.mode === 'selected' || spec.mode === 'single') {
      and.push({ id: { in: spec.lead_ids.length ? spec.lead_ids : [-1] } });
      return and;
    }
    if (spec.mode !== 'filtered') return and;
    if (f.agent_id) and.push({ OR: [{ assigned_to: f.agent_id }, { owner_user_id: f.agent_id }] });
    if (f.status) and.push({ lead_status: { equals: f.status, mode: 'insensitive' } });
    if (f.source) and.push({ lead_source: f.source });
    if (f.client_type) and.push({ client_type: f.client_type });
    if (f.lead_type) and.push({ OR: [{ lead_type: f.lead_type }, { lead_type: { contains: `"${f.lead_type}"` } }] });
    if (f.location) and.push({ location: { contains: f.location, mode: 'insensitive' } });
    // tags is a JSON array in a text column; matching the quoted value avoids "Buyer" in "First Buyer".
    if (f.tags?.length) and.push({ OR: f.tags.map((t) => ({ tags: { contains: `"${t}"` } })) });
    return and;
  }

  /**
   * The audience for a celebration, as of `at` (the moment it would send).
   *
   * Reads leads WITHOUT the opt-out filter so that opt-outs can be counted rather than silently
   * missing; every exclusion below is applied before anything is returned as a recipient.
   */
  async resolve(
    rawSpec: RecipientSpec,
    user: AuthUserRecord,
    ctx: { occasion: string; occasionLabel?: string | null; timezone?: string | null; at?: Date },
  ): Promise<AudienceResult> {
    const spec = parseRecipientSpec(rawSpec);
    const tz = ctx.timezone || DEFAULT_TIMEZONE;
    const at = ctx.at ?? new Date();
    const today = zonedDate(at, tz);
    const year = Number(today.slice(0, 4));
    // The date window narrows "all" and "filtered" audiences. Leads picked by hand are greeted
    // because they were picked, whatever date is (or is not) on file.
    const dated = isDateOccasion(ctx.occasion) && (spec.mode === 'all' || spec.mode === 'filtered');
    const column = ctx.occasion === 'anniversary' ? 'marriage_day' : 'date_of_birth';
    const days = dated ? windowDays(spec.filters.date_window ?? 'today', today, spec.filters.date_on) : [];

    const where: Prisma.leadsWhereInput = { AND: [{ deleted_at: null }, leadScopeWhere(user), ...this.filterWhere(spec)] };
    const leads = await this.prisma.leads.findMany({
      where,
      orderBy: { id: 'asc' },
      select: {
        id: true, name: true, first_name: true, email: true, unsubscribed: true,
        date_of_birth: true, marriage_day: true,
      },
      take: SCAN_LIMIT,
    });

    const notPermitted = spec.mode === 'selected' || spec.mode === 'single'
      ? Math.max(0, new Set(spec.lead_ids).size - leads.length)
      : 0;

    const excluded = new Map<string, Exclusion>();
    const exclude = (reason: string, lead: { id: number; name: string | null; email: string | null }) => {
      const e = excluded.get(reason) ?? { reason, label: EXCLUSION_LABELS[reason] ?? reason, count: 0, sample: [] };
      e.count += 1;
      if (e.sample.length < 25) e.sample.push({ lead_id: lead.id, name: lead.name ?? '', email: lead.email });
      excluded.set(reason, e);
    };

    const excludedIds = new Set(spec.excluded_lead_ids);
    const candidates: typeof leads = [];
    let matched = 0;
    for (const lead of leads) {
      if (dated) {
        const d = (lead as Record<string, unknown>)[column] as Date | null;
        // A lead with no date cannot match a date window: reported as skipped rather than vanishing.
        if (!d) { exclude('missing_date', lead); continue; }
        if (isImplausibleDate(d, at)) { exclude('invalid_date', lead); continue; }
        if (!days.some((day) => celebratedOn(d, day, spec.filters.feb29_rule))) continue;
      }
      matched += 1;
      if (excludedIds.has(lead.id)) { exclude('excluded_by_you', lead); continue; }
      candidates.push(lead);
    }

    const shaped: typeof leads = [];
    for (const lead of candidates) {
      const email = str(lead.email);
      if (!email) { exclude('missing_email', lead); continue; }
      if (!EMAIL_SHAPE.test(email)) { exclude('invalid_email', lead); continue; }
      if (lead.unsubscribed) { exclude('unsubscribed', lead); continue; }
      shaped.push(lead);
    }

    const suppressed = await this.audience.suppressedEmails(shaped.map((l) => str(l.email)));
    const key = occasionKey(ctx.occasion, ctx.occasionLabel);
    const greeted = await this.alreadyGreeted(key, ctx.occasion, shaped.map((l) => str(l.email)), year, tz);

    const brokerage = await this.brokerage();
    const seen = new Set<string>();
    const recipients: ResolvedRecipient[] = [];
    for (const lead of shaped) {
      const email = str(lead.email);
      const lower = email.toLowerCase();
      if (suppressed.has(lower)) { exclude('suppressed', lead); continue; }
      if (seen.has(lower)) { exclude('duplicate_email', lead); continue; }
      seen.add(lower);
      if (greeted.has(lower)) { exclude('already_greeted', lead); continue; }
      recipients.push({ leadId: lead.id, name: lead.name ?? '', email, vars: recipientVars(lead, brokerage) });
    }

    return {
      recipients,
      exclusions: [...excluded.values()].sort((a, b) => b.count - a.count),
      matched,
      not_permitted: notPermitted,
      scan_capped: leads.length >= SCAN_LIMIT,
      over_cap: recipients.length > CELEBRATION_MAX_RECIPIENTS,
      max_recipients: CELEBRATION_MAX_RECIPIENTS,
      year,
      days: days.length > 31 ? [] : days,
    };
  }

  /**
   * Addresses already greeted for this occasion in this year — by any celebration, and for birthdays
   * and anniversaries also by the Settings greeting sweep (its sends are in the CRM email log).
   */
  async alreadyGreeted(key: string | null, occasion: string, emails: string[], year: number, tz: string): Promise<Set<string>> {
    const lowered = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const out = new Set<string>();
    if (!lowered.length) return out;
    if (key) {
      const rows = await this.prisma.celebration_sends.findMany({
        where: { occasion_key: key, year, email_key: { in: lowered } },
        select: { email_key: true },
      });
      for (const r of rows) out.add(r.email_key);
    }
    if (isDateOccasion(occasion)) {
      const yearStart = zonedTimeToUtc(`${year}-01-01`, '00:00', tz) ?? new Date(Date.UTC(year, 0, 1));
      const logged = await this.prisma.crm_email_log.findMany({
        where: { kind: emailLogKind(occasion), created_at: { gte: yearStart }, recipient: { in: lowered, mode: 'insensitive' } },
        select: { recipient: true },
      });
      for (const r of logged) out.add(String(r.recipient ?? '').toLowerCase());
    }
    return out;
  }

  /** The creator of a campaign as a full user record, or null when the account is gone or inactive. */
  async creator(id: number | null | undefined): Promise<AuthUserRecord | null> {
    if (!id) return null;
    const u = await this.prisma.users.findFirst({
      where: { id, status: 'Active' },
      include: { user_permissions: true, user_modules: true },
    });
    return (u as AuthUserRecord | null) ?? null;
  }

  /** Whether this person may still send campaigns — the same check the Send button's route makes. */
  maySend(user: AuthUserRecord | null): boolean {
    return !!user && this.permissions.can(user.role || 'agent', user.user_permissions, 'campaigns', 'edit');
  }

  /**
   * ELIGIBILITY AND PERMISSION, RE-CHECKED IMMEDIATELY BEFORE SENDING.
   *
   * A celebration's recipients are written when it is sent or scheduled; for a scheduled one that
   * can be days earlier. Between then and now a lead can opt out, be deleted, be reassigned away
   * from the sender, change address or receive the same greeting from elsewhere — and the sender
   * can lose the right to send at all. Each of those recipients is marked `skipped` with the reason,
   * not sent and not silently dropped.
   */
  async recheckBeforeSend(
    campaign: campaigns,
    pending: campaign_recipients[],
  ): Promise<{ allowed: campaign_recipients[]; delivery: CelebrationDelivery; flyer: MailAttachment | null }> {
    const tz = campaign.timezone || DEFAULT_TIMEZONE;
    const year = Number(zonedDate(new Date(), tz).slice(0, 4));
    const occasion = campaign.occasion ?? 'general';
    const delivery: CelebrationDelivery = {
      occasionKey: occasionKey(occasion, campaign.occasion_label),
      year,
      logKind: emailLogKind(occasion),
      replyTo: campaign.reply_to || null,
      // One transport attempt: a send that may have reached the server is never repeated inside the
      // mailer. Soft bounces still get the campaign module's own spaced retries.
      maxAttempts: 1,
    };

    const skips = new Map<string, number[]>();
    const skip = (reason: string, id: number) => skips.set(reason, [...(skips.get(reason) ?? []), id]);

    const creator = await this.creator(campaign.created_by_id);
    let allowed: campaign_recipients[] = [];
    if (!this.maySend(creator)) {
      for (const r of pending) skip('sender_not_permitted', r.id);
    } else {
      const leadIds = [...new Set(pending.map((r) => r.lead_id).filter((n): n is number => !!n))];
      const leads = await this.prisma.leads.findMany({
        where: { AND: [{ id: { in: leadIds.length ? leadIds : [-1] } }, liveLeadWhere(creator)] },
        select: { id: true, email: true, unsubscribed: true },
      });
      const byId = new Map(leads.map((l) => [l.id, l]));
      const suppressed = await this.audience.suppressedEmails(pending.map((r) => r.email));
      const greeted = await this.alreadyGreeted(delivery.occasionKey, occasion, pending.map((r) => r.email), year, tz);
      for (const r of pending) {
        const lead = r.lead_id ? byId.get(r.lead_id) : undefined;
        const email = r.email.toLowerCase();
        if (!lead) { skip('no_longer_permitted', r.id); continue; }
        if (str(lead.email).toLowerCase() !== email) { skip('email_changed', r.id); continue; }
        if (lead.unsubscribed) { skip('unsubscribed', r.id); continue; }
        if (suppressed.has(email)) { skip('suppressed', r.id); continue; }
        if (greeted.has(email)) { skip('already_greeted', r.id); continue; }
        allowed.push(r);
      }
    }

    let skipped = 0;
    const now = new Date();
    for (const [reason, ids] of skips) {
      const done = await this.prisma.campaign_recipients.updateMany({
        where: { id: { in: ids }, status: 'pending' },
        data: {
          status: 'skipped',
          unsubscribed: reason === 'unsubscribed' || reason === 'suppressed' ? true : undefined,
          error: `Not sent — ${EXCLUSION_LABELS[reason] ?? reason}.`,
          updated_at: now,
        },
      });
      skipped += done.count;
    }
    if (skipped) {
      await this.prisma.campaigns.update({ where: { id: campaign.id }, data: { skipped: { increment: skipped }, updated_at: now } });
      this.log.warn(`Celebration #${campaign.id}: ${skipped} recipient(s) skipped at send time (${[...skips.keys()].join(', ')}).`);
    }
    if (!this.maySend(creator)) allowed = [];

    let flyer: MailAttachment | null = null;
    if (campaign.flyer_id) {
      const f = await this.prisma.campaign_flyers.findUnique({ where: { id: campaign.flyer_id } });
      if (f) flyer = { data: Buffer.from(f.data).toString('base64'), name: `greeting.${f.mime === 'image/png' ? 'png' : 'jpg'}`, mime: f.mime, cid: FLYER_CID };
    }
    return { allowed, delivery, flyer };
  }
}
