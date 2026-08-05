import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SHAPE, FILLABLE_TOKENS } from './campaign.constants';
import type { AuthUserRecord } from '../auth/auth.types';
import { can } from '../core/authz';

/** The lead-segment filter a campaign targets. */
export interface AudienceFilter {
  leadStatus?: string;
  leadType?: string;
  leadSource?: string;
  clientType?: string;
  tag?: string;
}

export interface CampaignRecipient {
  leadId: number;
  name: string;
  email: string;
  /** Per-recipient property tokens, filled from that lead's own record. */
  vars: Record<string, string>;
}

/**
 * Audience resolution, personalisation and tracking injection — the port of the source
 * project's campaign-service. Kept separate from the send loop so it can be unit tested.
 */
@Injectable()
export class CampaignAudienceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Which leads this person may build an audience from.
   *
   * THE COMMENT THAT WAS HERE SAID THE OPPOSITE, and is worth recording rather than deleting
   * silently. It stated that every role "may only mail their own book" and that anything else was
   * "a privacy breach and, under CASL, a consent problem — those leads consented to hear from the
   * person handling them, not from whoever opened the builder."
   *
   * That is the right argument about an AGENT and the wrong one about the brokerage. Consent under
   * CASL is given to the organisation, not to an individual salesperson, and the roles listed on
   * `campaigns.brokerage-audience` act for the brokerage: preparing campaigns on agents' behalf is
   * the CRM role's stated job. The unchanged half of the argument is the important half — an agent
   * is still capped, and every consent control below still runs for everyone.
   *
   * `{}` — no owner restriction — for the marketing and administrative roles, which select ELIGIBLE
   * leads across the brokerage. Everyone else is capped to leads they own or are assigned.
   *
   * WIDENING THE POOL IS NOT BYPASSING THE RULES. This decides only which leads are candidates.
   * Everything that narrows the list still runs, in `buildAudienceWhere` and `resolveRecipients`
   * below and unchanged by this:
   *
   *   · `deleted_at: null`          — deleted leads are never candidates
   *   · `unsubscribed: false`       — the lead's own opt-out flag
   *   · the campaign's own filters  — status, type, source, client type, tag
   *   · `EMAIL_SHAPE`               — malformed addresses dropped
   *   · `seen`                      — duplicate addresses dropped
   *   · `suppressedEmails()`        — the brokerage suppression list, applied last and to everyone
   *
   * The comment this replaces claimed "staff and admins see the whole book", which was not true of
   * the code — every role was capped, including the one whose job is brokerage-wide marketing.
   */
  private ownerScope(user?: AuthUserRecord | null): Record<string, unknown> {
    if (can(user, 'campaigns.brokerage-audience')) return {};
    const id = user?.id ?? -1;
    return { OR: [{ assigned_to: id }, { owner_user_id: id }] };
  }

  /** Build the lead query for a segment. Always excludes opt-outs and malformed emails. */
  buildAudienceWhere(a: AudienceFilter, user?: AuthUserRecord | null): Record<string, unknown> {
    const where: Record<string, unknown> = {
      deleted_at: null,
      // Never send to leads who have opted out (CASL suppression).
      unsubscribed: false,
    };
    // Status is matched case-insensitively, as the source did.
    if (a.leadStatus) where.lead_status = { equals: a.leadStatus, mode: 'insensitive' };
    if (a.leadType) where.lead_type = a.leadType;
    if (a.leadSource) where.lead_source = a.leadSource;
    if (a.clientType) where.client_type = a.clientType;
    // tags is a JSON array in a text column; `contains` on the quoted value avoids
    // matching "Buyer" inside "First Buyer".
    if (a.tag) where.tags = { contains: `"${a.tag}"` };
    // Capped to their own leads, unless they hold the brokerage-audience capability.
    const scope = this.ownerScope(user);
    return Object.keys(scope).length ? { AND: [where, scope] } : where;
  }

  /** Resolve the concrete recipient list: deduped, email-validated, suppression-filtered. */
  async resolveRecipients(a: AudienceFilter, user?: AuthUserRecord | null): Promise<CampaignRecipient[]> {
    const leads = await this.prisma.leads.findMany({
      where: this.buildAudienceWhere(a, user),
      orderBy: { id: 'asc' },
    });

    const seen = new Set<string>();
    const recipients: CampaignRecipient[] = [];
    for (const lead of leads) {
      const email = String(lead.email ?? '').trim();
      const key = email.toLowerCase();
      // Defence in depth: skip anything that isn't a real email, or a duplicate.
      if (!EMAIL_SHAPE.test(email) || seen.has(key)) continue;
      seen.add(key);
      recipients.push({ leadId: lead.id, name: lead.name ?? '', email, vars: this.leadPropertyVars(lead) });
    }

    // Second safety net: drop anything on the global suppression list.
    const suppressed = await this.suppressedEmails(recipients.map((r) => r.email));
    return suppressed.size === 0 ? recipients : recipients.filter((r) => !suppressed.has(r.email.toLowerCase()));
  }

  /** Addresses on the global opt-out list. */
  async suppressedEmails(emails: string[]): Promise<Set<string>> {
    const lowered = [...new Set(emails.map((e) => e.trim().toLowerCase()))];
    if (!lowered.length) return new Set();
    const rows = await this.prisma.email_suppressions.findMany({
      where: { email: { in: lowered } },
      select: { email: true },
    });
    return new Set(rows.map((r) => r.email.toLowerCase()));
  }

  /** The property personalisation tokens for one lead. Missing values stay blank. */
  leadPropertyVars(lead: Record<string, unknown>): Record<string, string> {
    const s = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
    return {
      PROPERTY_ADDRESS: s(lead.property_address) || s(lead.location),
      PROPERTY_PRICE: s(lead.property_price),
      BEDROOMS: s(lead.bedrooms),
      BATHROOMS: s(lead.bathrooms),
      SQUARE_FOOTAGE: s(lead.square_footage),
      KEY_FEATURES: s(lead.key_features),
    };
  }

  /**
   * Fill personalisation tokens. Known tokens get real values; any other {{TOKEN}} is
   * removed, so a raw placeholder never reaches a recipient.
   */
  personalize(
    text: string,
    vars: { leadName?: string; agentName?: string; agentEmail?: string; agentPhone?: string },
    extra?: Record<string, string>,
  ): string {
    const map: Record<string, string> = {
      LEAD_NAME: vars.leadName || 'there',
      AGENT_NAME: vars.agentName || 'Get Home Realty',
      AGENT_EMAIL: vars.agentEmail || 'info@gethomerealty.ca',
      AGENT_PHONE: vars.agentPhone || '',
      ...(extra ?? {}),
    };
    return String(text ?? '').replace(/{{\s*([A-Z0-9_]+)\s*}}/g, (_m, token: string) => (token in map ? map[token] : ''));
  }

  /** Unguessable per-recipient token for the open pixel and unsubscribe link. */
  newRecipientToken(): string {
    return crypto.randomBytes(24).toString('hex');
  }

  /** Append the open pixel and unsubscribe link so opens are recorded and opt-out works. */
  /**
   * Rewrite every real link in the body so clicks are recorded.
   *
   * `links` maps a destination URL to the id it was stored under at send time. Only URLs already
   * in that map are rewritten: anything unrecognised is left exactly as the author wrote it, so a
   * link the send path did not register still works rather than becoming a dead tracking URL.
   *
   * Deliberately skips `mailto:`, `tel:` and in-document anchors — routing those through an HTTP
   * redirect would break them — and skips the unsubscribe link, which must stay direct so opting
   * out never depends on the tracking endpoint being healthy.
   */
  rewriteLinks(html: string, opts: { baseUrl: string; campaignId: number; token: string; links: Map<string, number> }): string {
    const base = opts.baseUrl.replace(/\/+$/, '');
    if (!base || !opts.links.size) return html;
    return html.replace(/href\s*=\s*"([^"]+)"/gi, (whole, url: string) => {
      const id = opts.links.get(url);
      if (id === undefined) return whole;
      const q = `c=${encodeURIComponent(String(opts.campaignId))}&t=${encodeURIComponent(opts.token)}&l=${id}`;
      return `href="${base}/api/campaigns/track/click?${q}"`;
    });
  }

  /** Every http(s) link in a body, in document order, deduplicated — what gets registered. */
  extractLinks(html: string): string[] {
    const out = new Set<string>();
    for (const m of html.matchAll(/href\s*=\s*"([^"]+)"/gi)) {
      const url = m[1].trim();
      if (/^https?:\/\//i.test(url)) out.add(url);
    }
    return [...out];
  }

  injectTracking(html: string, opts: { baseUrl: string; campaignId: number; token: string }): string {
    const base = opts.baseUrl.replace(/\/+$/, '');
    const q = `c=${encodeURIComponent(String(opts.campaignId))}&t=${encodeURIComponent(opts.token)}`;
    const unsub = `<div style="text-align:center;margin-top:16px;font-family:Arial,sans-serif;font-size:12px;color:#9ca3af;">`
      + `<a href="${base}/api/campaigns/unsubscribe?${q}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a> from these emails.`
      + `</div>`;
    const pixel = `<img src="${base}/api/campaigns/track/open?${q}" alt="" width="1" height="1" style="display:none;width:1px;height:1px;" />`;
    return `${html}\n${unsub}\n${pixel}`;
  }

  /** Tokens in a template that this engine cannot fill (they would send blank). */
  unfillableVariables(variables: string[] = []): string[] {
    const fillable = new Set<string>(FILLABLE_TOKENS);
    return variables.filter((v) => !fillable.has(v));
  }

  /** Every {{TOKEN}} used by a piece of template text. */
  extractTokens(...texts: string[]): string[] {
    const found = new Set<string>();
    for (const t of texts) {
      for (const m of String(t ?? '').matchAll(/{{\s*([A-Z0-9_]+)\s*}}/g)) found.add(m[1]);
    }
    return [...found];
  }
}
