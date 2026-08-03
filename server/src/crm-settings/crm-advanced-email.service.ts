import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { TENANT_ID } from '../core/tenant';
import { DEFAULT_TRIGGERS, EMAIL_SHAPE, MAX_BULK_RECIPIENTS, type TriggerKey } from './crm-settings.constants';
// The same rule the Leads screen applies, so this path cannot reach further than the screens
// beside it. Restating it here would be a second copy free to drift.
import { leadScopeWhere } from '../common/lead-scope';
import type { AuthUserRecord } from '../auth/auth.types';

const str = (v: unknown): string => String(v ?? '').trim();
const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

export interface ReferralCode {
  code: string;
  discount: number;
  validUntil: Date | string;
  usageCount: number;
  maxUsage: number;
}

export interface PromotionalOffer {
  title?: string;
  description?: string;
  discount?: string | number;
  validUntil?: string;
  code?: string;
}

export interface SendOutcome {
  success: boolean;
  message: string;
  redirected?: string | null;
}

/**
 * The CRM's AdvancedEmailService, ported onto Transaction Desk's mailer.
 *
 * The CRM's own template markup was not part of the migrated files, so the bodies below are
 * written for Transaction Desk. Every send is gated on the matching trigger switch and recorded
 * in `crm_email_log`, exactly as the CRM gated on `isTriggerEnabled`.
 */
@Injectable()
export class CrmAdvancedEmailService {
  private readonly log = new Logger(CrmAdvancedEmailService.name);

  constructor(private readonly prisma: PrismaService, private readonly mailer: MailerService) {}

  /** Port of the CRM's `isTriggerEnabled` — reads the saved switches, defaulting to on. */
  async isTriggerEnabled(key: TriggerKey): Promise<boolean> {
    const row = await this.prisma.crm_email_settings.findFirst({ where: { company_id: TENANT_ID }, orderBy: { id: 'asc' } });
    if (!row) return DEFAULT_TRIGGERS[key] ?? true;
    try {
      const toggles = { ...DEFAULT_TRIGGERS, ...(JSON.parse(row.template_toggles ?? '{}') as Record<string, boolean>) };
      return toggles[key] !== false;
    } catch {
      return DEFAULT_TRIGGERS[key] ?? true;
    }
  }

  /** Whether automatic sending is on at all — the CRM's `autoSendEnabled`. */
  async autoSendEnabled(): Promise<boolean> {
    const row = await this.prisma.crm_email_settings.findFirst({ where: { company_id: TENANT_ID }, orderBy: { id: 'asc' } });
    return row ? row.auto_send_enabled : true;
  }

  // ------------------------------------------------------------- templates
  private shell(body: string, signature?: string): string {
    return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;max-width:600px;margin:0 auto;padding:8px">
${body}
${signature ? `<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0 12px"><div style="font-size:13px;color:#6b7280">${signature}</div>` : ''}
</div>`;
  }

  // ---------------------------------------------------------------- sends
  async sendWeddingCongratulations(leadName: string, leadEmail: string, weddingDate: string, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.isTriggerEnabled('wedding'))) return this.disabled('wedding');
    const when = str(weddingDate);
    return this.dispatch('wedding', leadName, leadEmail, 'Congratulations on your wedding!', this.shell(
      `<p>Dear ${esc(leadName || 'there')},</p>
<p>Congratulations on your wedding${when ? ` on ${esc(when)}` : ''}! Wishing you both every happiness in this next chapter.</p>
<p>If a new home is part of your plans together, I'd be glad to help whenever the time feels right.</p>
<p>With warm wishes,</p>`, signature), user);
  }

  async sendSeasonalWishes(leadName: string, leadEmail: string, season: string, year: string | number, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.isTriggerEnabled('seasonal'))) return this.disabled('seasonal');
    const s = str(season) || 'the season';
    const y = str(year) || String(new Date().getFullYear());
    return this.dispatch('seasonal', leadName, leadEmail, `${s} wishes from all of us`, this.shell(
      `<p>Dear ${esc(leadName || 'there')},</p>
<p>Wishing you a wonderful ${esc(s)} ${esc(y)} — thank you for your trust this year.</p>
<p>If there's anything property-related I can help with in the year ahead, just reply to this email.</p>`, signature), user);
  }

  async sendPromotionalOffer(leadName: string, leadEmail: string, offer: PromotionalOffer, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.isTriggerEnabled('promotional'))) return this.disabled('promotional');
    const title = str(offer?.title) || 'A special offer for you';
    return this.dispatch('promotional', leadName, leadEmail, title, this.shell(
      `<p>Hi ${esc(leadName || 'there')},</p>
<h3 style="margin:16px 0 8px">${esc(title)}</h3>
${offer?.description ? `<p>${esc(offer.description)}</p>` : ''}
<table style="border-collapse:collapse;margin:12px 0;font-size:14px">
  ${offer?.discount ? `<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Discount</td><td><strong>${esc(offer.discount)}</strong></td></tr>` : ''}
  ${offer?.code ? `<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Code</td><td><strong>${esc(offer.code)}</strong></td></tr>` : ''}
  ${offer?.validUntil ? `<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Valid until</td><td>${esc(offer.validUntil)}</td></tr>` : ''}
</table>
<p>Reply to this email if you'd like to take it up.</p>`, signature), user);
  }

  async sendReferralCode(leadName: string, leadEmail: string, referral: ReferralCode, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.isTriggerEnabled('referral'))) return this.disabled('referral');
    if (!referral?.code) throw new BadRequestException({ message: 'A referral code is required.' });
    const until = referral.validUntil instanceof Date ? referral.validUntil : new Date(String(referral.validUntil));
    const untilText = Number.isNaN(until.getTime()) ? '' : until.toISOString().slice(0, 10);
    return this.dispatch('referral', leadName, leadEmail, 'Your referral code', this.shell(
      `<p>Hi ${esc(leadName || 'there')},</p>
<p>Thank you for recommending us. Here is your referral code:</p>
<p style="font-size:22px;font-weight:700;letter-spacing:2px;background:#f5f3ff;border:1px dashed #c4b5fd;border-radius:10px;padding:14px;text-align:center;margin:16px 0">${esc(referral.code)}</p>
<p style="font-size:14px;color:#6b7280">
  Worth ${esc(referral.discount)}% off${untilText ? ` · valid until ${esc(untilText)}` : ''} · can be used ${esc(referral.maxUsage)} time(s)
</p>
<p>Pass it on to anyone who's buying or selling — it applies to them, and we'll look after them properly.</p>`, signature), user);
  }

  async sendCustomEmail(leadName: string, leadEmail: string, subject: string, content: string, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.isTriggerEnabled('custom'))) return this.disabled('custom');
    const s = str(subject);
    const body = str(content);
    if (!s) throw new BadRequestException({ message: 'A subject is required.' });
    if (!body) throw new BadRequestException({ message: 'The message body cannot be empty.' });
    // Content is authored by a signed-in staff member and sent as HTML, matching the CRM.
    return this.dispatch('custom', leadName, leadEmail, s, this.shell(body, signature), user);
  }

  /** Port of the CRM's `generateReferralCode`, persisted so a code can be looked up later. */
  async generateReferralCode(
    input: { discount?: unknown; validDays?: unknown; maxUsage?: unknown },
    user: AuthUserRecord,
  ): Promise<ReferralCode & { id: number }> {
    const num = (v: unknown, fallback: number, min: number, max: number): number => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    };
    const discount = num(input.discount, 10, 1, 100);
    const validDays = num(input.validDays, 30, 1, 3650);
    const maxUsage = num(input.maxUsage, 5, 1, 10000);

    // Unambiguous alphabet: no O/0 or I/1, so a code read off a screen can be typed back.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const pick = (n: number) => Array.from(randomBytes(n)).map((b) => alphabet[b % alphabet.length]).join('');

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = `GHR-${pick(6)}`;
      const clash = await this.prisma.crm_referral_codes.findUnique({ where: { code }, select: { id: true } });
      if (clash) continue;
      const row = await this.prisma.crm_referral_codes.create({
        data: {
          code,
          discount,
          valid_until: new Date(Date.now() + validDays * 24 * 60 * 60 * 1000),
          usage_count: 0,
          max_usage: maxUsage,
          created_by: user.name,
          created_at: new Date(),
        },
      });
      return {
        id: row.id, code: row.code, discount: row.discount,
        validUntil: row.valid_until, usageCount: row.usage_count, maxUsage: row.max_usage,
      };
    }
    throw new BadRequestException({ message: 'Could not generate a unique referral code. Try again.' });
  }

  async listReferralCodes(): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.crm_referral_codes.findMany({ orderBy: { id: 'desc' }, take: 100 });
    return rows.map((r) => ({
      id: r.id, code: r.code, discount: r.discount,
      validUntil: r.valid_until.toISOString().slice(0, 10),
      usageCount: r.usage_count, maxUsage: r.max_usage,
      expired: r.valid_until.getTime() < Date.now(),
      created_by: r.created_by,
      created_at: r.created_at?.toISOString() ?? null,
    }));
  }

  /**
   * Port of the CRM's `bulkSend`: one email per lead, each outcome recorded individually so a
   * single failure never hides the rest.
   */
  async bulkSend(
    leads: { name?: unknown; email?: unknown; referralCode?: unknown }[],
    emailType: string,
    emailData: Record<string, unknown>,
    user: AuthUserRecord,
    signature?: string,
  ): Promise<{ message: string; results: Record<string, unknown>[] }> {
    if (!Array.isArray(leads) || leads.length === 0) {
      throw new BadRequestException({ message: 'Select at least one recipient.' });
    }
    if (leads.length > MAX_BULK_RECIPIENTS) {
      throw new BadRequestException({ message: `That is ${leads.length} recipients, above the ${MAX_BULK_RECIPIENTS} limit for one bulk send.` });
    }

    const results: Record<string, unknown>[] = [];
    for (const lead of leads) {
      const name = str(lead.name);
      const email = str(lead.email);
      try {
        if (!EMAIL_SHAPE.test(email)) throw new Error('Not a valid email address');
        let outcome: SendOutcome;
        switch (emailType) {
          case 'wedding':
            outcome = await this.sendWeddingCongratulations(name, email, str(emailData.weddingDate), user, signature); break;
          case 'seasonal':
            outcome = await this.sendSeasonalWishes(name, email, str(emailData.season), str(emailData.year), user, signature); break;
          case 'promotional':
            outcome = await this.sendPromotionalOffer(name, email, (emailData.offer ?? {}) as PromotionalOffer, user, signature); break;
          case 'referral':
            // The CRM prefers a code carried on the lead itself, falling back to the shared one.
            outcome = await this.sendReferralCode(name, email, (lead.referralCode ?? emailData.referralCode) as ReferralCode, user, signature); break;
          case 'custom':
            outcome = await this.sendCustomEmail(name, email, str(emailData.subject), str(emailData.content), user, signature); break;
          default:
            throw new Error(`Unknown email type "${emailType}"`);
        }
        results.push({ name, email, success: outcome.success, message: outcome.message });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name, email, success: false, error: message });
        await this.record(emailType, name, email, null, false, message, user, null);
      }
    }

    const ok = results.filter((r) => r.success).length;
    return { message: `Bulk email completed. ${ok}/${results.length} emails sent successfully.`, results };
  }

  // ---------------------------------------------------------------- shared
  private disabled(kind: string): SendOutcome {
    return { success: false, message: `${kind.charAt(0).toUpperCase() + kind.slice(1)} email trigger is disabled` };
  }

  /**
   * The lead this address belongs to, if the caller is allowed to reach them.
   *
   * THE RECIPIENT USED TO COME STRAIGHT FROM THE REQUEST BODY. `leadEmail` was validated for shape
   * and handed to the mailer — no lead lookup, no ownership check — so anyone who could reach these
   * endpoints could send arbitrary HTML, with an arbitrary subject, from the brokerage's own
   * authenticated domain, to any address on earth. That is a phishing platform with the brokerage's
   * SPF and DKIM alignment behind it, and the fact that default permissions confine it to Super
   * Admin narrows who can do it without changing what it is.
   *
   * Every recipient now has to be somebody the brokerage actually has a relationship with, and one
   * the caller is entitled to contact — the same `leadScopeWhere` rule the Leads screen applies, so
   * this path cannot reach further than the screens it sits beside.
   *
   * The refusals are deliberately worded the same way whether the lead does not exist or belongs to
   * a colleague. Distinguishing them would turn this into the address-enumeration oracle that the
   * duplicate-email message already had to be fixed for.
   */
  private async resolveRecipient(email: string, user: AuthUserRecord): Promise<{ id: number; name: string } | null> {
    const address = email.trim().toLowerCase();
    return this.prisma.leads.findFirst({
      where: {
        email: { equals: address, mode: 'insensitive' },
        deleted_at: null,
        ...leadScopeWhere(user),
      },
      select: { id: true, name: true },
    });
  }

  /**
   * Whether this address has told the brokerage to stop, and why.
   *
   * Two records answer that, and both have to be consulted because they are written by different
   * paths: `email_suppressions` is the global opt-out list (an unsubscribe click, or a hard bounce),
   * and `leads.unsubscribed` is the flag the audience queries read. An address may carry one without
   * the other — a lead flagged before the suppression list existed, or a suppression for somebody
   * who is not a lead at all — so a check that consulted only one would let real opt-outs through.
   *
   * Matched case-insensitively: an unsubscribe recorded as `Bob@x.com` must still stop a send
   * addressed to `bob@x.com`.
   */
  private async optedOut(email: string): Promise<string | null> {
    const address = email.trim().toLowerCase();
    const [suppression, lead] = await Promise.all([
      this.prisma.email_suppressions.findUnique({ where: { email: address }, select: { reason: true } }),
      this.prisma.leads.findFirst({
        where: { email: { equals: address, mode: 'insensitive' }, unsubscribed: true, deleted_at: null },
        select: { id: true },
      }),
    ]);
    if (suppression) {
      return suppression.reason === 'hard_bounce'
        ? 'mail to this address has permanently bounced, so it is on the suppression list'
        : 'this address is on the suppression list because they unsubscribed';
    }
    if (lead) return 'this lead has unsubscribed';
    return null;
  }

  /**
   * Send one message, honouring the global redirect, and log the attempt either way.
   *
   * NOTHING GOES OUT WITHOUT THE OPT-OUT CHECK. These endpoints take the recipient from the request
   * body rather than from a lead, which is how they came over from the CRM — and it meant every one
   * of them reached the mailer without ever asking whether the person had told us to stop. The
   * Campaigns module filters every audience through `email_suppressions`, and
   * `LeadActivityService.sendEmail` refuses an unsubscribed lead for the reason its comment gives:
   * under CASL a one-off message is not exempt because it was typed by hand. This path honoured
   * neither, so the same address that a campaign correctly skipped could be mailed from here.
   *
   * A refusal is recorded in `crm_email_log` exactly like a send. The log is the evidence that the
   * opt-out was honoured, and an opt-out nobody can prove was honoured is most of the problem CASL
   * puts on the sender.
   */
  private async dispatch(kind: string, leadName: string, leadEmail: string, subject: string, html: string, user: AuthUserRecord): Promise<SendOutcome> {
    const email = str(leadEmail);
    if (!EMAIL_SHAPE.test(email)) throw new BadRequestException({ message: 'Enter a valid recipient email address.' });

    // The recipient has to be one of the caller's own leads. See `resolveRecipient` — this is what
    // stops the endpoint being a mail relay wearing a CRM's clothes.
    const recipient = await this.resolveRecipient(email, user);
    if (!recipient) {
      const message = 'Not sent — this address is not one of your leads. Add them as a lead first, or ask an administrator to reassign the lead to you.';
      this.log.warn(`CRM ${kind} email to ${email} refused: not a lead ${user.name ?? 'the caller'} may contact.`);
      await this.record(kind, leadName, email, subject, false, message, user, null);
      return { success: false, message };
    }

    const refusal = await this.optedOut(email);
    if (refusal) {
      const message = `Not sent — ${refusal}. Removing an address from the suppression list is done under Campaigns → Suppression List, and only when they have asked to be put back.`;
      this.log.warn(`CRM ${kind} email to ${email} refused: ${refusal}.`);
      await this.record(kind, leadName, email, subject, false, message, user, null);
      return { success: false, message };
    }

    const redirect = MailerService.redirectTarget();
    try {
      await this.mailer.sendDirect(email, subject, html);
      await this.record(kind, leadName, email, subject, true, null, user, redirect);
      return {
        success: true,
        redirected: redirect,
        message: redirect
          ? `Email sent — redirected to ${redirect} because MAIL_REDIRECT_TO is set.`
          : `${kind.charAt(0).toUpperCase() + kind.slice(1)} email sent successfully`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`CRM ${kind} email to ${email} failed: ${message}`);
      await this.record(kind, leadName, email, subject, false, message, user, redirect);
      return { success: false, message: `Failed to send ${kind} email: ${message}` };
    }
  }

  private async record(
    kind: string, leadName: string, recipient: string, subject: string | null,
    success: boolean, error: string | null, user: AuthUserRecord, redirected: string | null,
  ): Promise<void> {
    try {
      await this.prisma.crm_email_log.create({
        data: {
          kind, lead_name: leadName || null, recipient, subject,
          success, error, redirected, sent_by: user.name, created_at: new Date(),
        },
      });
    } catch (err) {
      // Logging must never turn a delivered email into a failed request.
      this.log.warn(`Could not write the CRM email log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async listLog(limit = 100): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.crm_email_log.findMany({ orderBy: { id: 'desc' }, take: Math.min(500, limit) });
    return rows.map((r) => ({
      id: r.id, kind: r.kind, lead_name: r.lead_name, recipient: r.recipient,
      subject: r.subject, success: r.success, error: r.error, redirected: r.redirected,
      sent_by: r.sent_by, created_at: r.created_at?.toISOString() ?? null,
    }));
  }
}
