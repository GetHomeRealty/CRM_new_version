import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { auditDomain } from '../common/domain';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { MailAccountService } from '../email/mail-account.service';
import { MAIL_EVENTS, renderTemplate } from '../email/mail-event-registry';
import { EMAIL_SHAPE, MAX_BULK_RECIPIENTS } from './crm-settings.constants';
import { CrmTriggersService } from './crm-triggers.service';
// The same rule the Leads screen applies, so this path cannot reach further than the screens
// beside it. Restating it here would be a second copy free to drift.
import { hasBrokerageLeadScope, leadScopeWhere } from '../common/lead-scope';
// "May this person act on records that are not their own?" — the same question the rest of the
// application asks, rather than a second list of which roles count as administrators.
import { can } from '../core/authz';
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

/** The lead's own first name, for a greeting that reads like a person wrote it. */
const firstNameOf = (full: string): string => str(full).split(/\s+/)[0] ?? '';

/**
 * Who a welcome email comes from, resolved before the send.
 *
 * `user` decides the mailbox, the name in the log and the signature; the rest are what the template
 * may print. They are separate fields because they are not always the same thing: a lead with no
 * agent is sent from the brokerage, and then `agentName` IS the brokerage's name — a default
 * template must not greet somebody from nobody. See `LeadWelcomeService.senderFor`, which is the
 * one place either shape is built.
 */
export interface WelcomeSender {
  user: AuthUserRecord;
  agentName: string;
  agentEmail: string;
  agentPhone: string;
  brokerageName: string;
  brokerageContact: string;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly accounts: MailAccountService,
    private readonly triggers: CrmTriggersService,
  ) {}

  /** Whether automatic sending is on at all — the CRM's `autoSendEnabled`. */
  async autoSendEnabled(): Promise<boolean> {
    const row = await this.prisma.crm_email_settings.findFirst({ orderBy: { id: 'asc' } });
    return row ? row.auto_send_enabled : true;
  }

  // ------------------------------------------------------------- templates
  /**
   * Strip anything executable from author-written HTML before it goes into a message.
   *
   * The signature was interpolated raw. It is written by a signed-in member of staff, so this was
   * never the hole an unescaped LEAD field would be — but the value is stored once and appended to
   * every CRM email thereafter, it reaches addresses outside the brokerage, and mail clients differ
   * wildly in what they will run. Escaping outright was the wrong answer: a signature legitimately
   * carries `<b>`, `<a href>` and a line break, and turning those into visible angle brackets would
   * break every signature already saved.
   *
   * So it is sanitised, not escaped — the same rule the brand logo's SVG gets, for the same reason:
   * keep what the author meant, remove what can execute.
   */
  private static sanitizeHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<script[^>]*\/?>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe\s*>/gi, '')
      .replace(/<object[\s\S]*?<\/object\s*>/gi, '')
      .replace(/<embed[^>]*\/?>/gi, '')
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
      .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
  }

  private shell(body: string, signature?: string): string {
    const sig = signature ? CrmAdvancedEmailService.sanitizeHtml(signature) : '';
    return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;max-width:600px;margin:0 auto;padding:8px">
${body}
${sig ? `<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0 12px"><div style="font-size:13px;color:#6b7280">${sig}</div>` : ''}
</div>`;
  }

  /**
   * Resolve this CRM email's subject and body from Settings → Templates.
   *
   * WHY THIS EXISTS. These four emails carried their wording in this file, so changing a greeting
   * meant a code change and a deploy. They now read the same `email_templates` row every other
   * automated email in the application reads, keyed by event — which is what makes them editable,
   * deactivatable, and visibly linked to the thing that sends them.
   *
   * FIRST CALL SEEDS THE ROW, exactly as `MailerService.send` does: absent a stored template the
   * registry default is written to the database and used. So an upgraded brokerage sees the same
   * wording it saw yesterday, now with a row it can edit, and nobody has to run a seed script.
   *
   * AN INACTIVE TEMPLATE REFUSES. Switching a template off on the Templates screen has to stop the
   * email, or the switch is decorative — the same failure the CRM trigger toggles were deleted for.
   * The refusal is thrown and the caller records it, so it lands in the CRM email log with a reason
   * rather than disappearing.
   *
   * NOT ROUTED THROUGH `MailerService.send`, deliberately. That method resolves its own sender and
   * dispatches; these emails must keep going through `dispatch` below, which applies the brokerage
   * master switch, the "recipient must be one of your leads" rule, the unsubscribe and suppression
   * checks, and the `crm_email_log` entry. Only the WORDING moves; every guard stays where it was.
   */
  private async fromTemplate(
    eventKey: string,
    vars: Record<string, unknown>,
    signature?: string,
  ): Promise<{ subject: string; html: string }> {
    const meta = MAIL_EVENTS[eventKey];
    if (!meta) throw new BadRequestException({ message: `No CRM email is registered for '${eventKey}'.` });

    let template = await this.prisma.email_templates.findUnique({ where: { event_key: eventKey } });
    if (!template) {
      const now = new Date();
      try {
        await this.prisma.email_templates.create({
          data: {
            event_key: eventKey, module: meta.module, name: meta.label,
            subject: meta.default_subject, body_html: meta.default_body_html,
            is_active: true, created_at: now, updated_at: now,
          },
        });
      } catch {
        // A concurrent send seeded it first; the read below picks that row up.
      }
      template = await this.prisma.email_templates.findUnique({ where: { event_key: eventKey } });
    }
    if (!template) throw new Error(`Could not resolve the '${eventKey}' email template.`);
    if (!template.is_active) {
      throw new BadRequestException({
        message: `Not sent — the "${template.name}" template is switched off under Settings → Templates.`,
      });
    }

    const now = new Date();
    const merged: Record<string, unknown> = {
      current_date: now.toISOString().slice(0, 10),
      current_year: String(now.getFullYear()),
      ...vars,
    };
    // The body goes inside the same shell as before, so the signature block, width and typography
    // are unchanged; only the paragraphs between them come from the template now.
    return {
      subject: renderTemplate(template.subject, merged),
      html: this.shell(renderTemplate(template.body_html, merged), signature),
    };
  }

  // ---------------------------------------------------------------- sends
  /*
   * WEDDING CONGRATULATIONS HAS BEEN RETIRED. `sendWeddingCongratulations` stood here, gated on a
   * `wedding` trigger, reachable from the `sendWeddingEmail` action and from `bulkSend`. The
   * brokerage's decision is that Anniversary Greeting — which fires on the date the couple actually
   * recorded, on a schedule, rather than needing somebody to remember — covers what it was for.
   *
   * Every route to it is gone: the button, the action, this method, the trigger key and the
   * registry entry. `crm_email_log` and `audit_logs` rows for weddings already sent are untouched,
   * and so is the `crm.wedding_congratulations` template — see the note in the registry.
   */

  /*
   * The two date-driven greetings. Same shape as every other send here — trigger check, then
   * `dispatch`, which applies the master switch, the "must be one of your leads" rule and the
   * `crm_email_log` entry. Nothing about them is special-cased for being sent by a timer; the
   * scheduler that calls them is just another caller.
   *
   * Neither mentions an age or a number of years. The birth year is on file and the anniversary
   * count is arithmetic, but "Happy 60th!" from a brokerage is a different message from "Happy
   * birthday", and getting it wrong from a mistyped year is worse than not saying it.
   */
  /**
   * The welcome a new lead gets, once, shortly after they arrive.
   *
   * WHO IT COMES FROM. `sender` carries the answer, and it is the same answer `senderFor` would
   * give: the lead's own agent when they have one, the brokerage when they do not. Passing the
   * agent as `user` therefore selects their connected CRM mailbox, their name in the log, and their
   * signature; passing a brokerage stand-in with `id: null` falls through to the brokerage's CRM
   * account. Either way it is a CRM mailbox — `senderFor(..., 'crm')` — so a Transaction Desk
   * account can never send it, which is the separation `mail_accounts.scope` exists for.
   *
   * WHY IT TAKES `leadId`. This is the one send with no human caller, so the "must be one of your
   * leads" rule has nobody to be about — and a brokerage-owned lead is in no agent's scope at all.
   * See `dispatch`: naming the lead is a narrower claim than the scope query, not an escape from it.
   *
   * The trigger check uses the AGENT's switch when there is an agent, so somebody who has turned
   * their own CRM emails off does not have welcomes going out under their name. With no agent there
   * is no personal switch to consult and the brokerage default decides.
   */
  async sendWelcomeEmail(
    lead: { id: number; name: string | null; email: string },
    sender: WelcomeSender,
    signature?: string,
  ): Promise<SendOutcome> {
    const leadName = lead.name ?? '';
    if (!(await this.welcomeEnabledFor(sender.user))) {
      return this.refuse('welcome', leadName, lead.email, sender.user);
    }

    const t = await this.fromTemplate('crm.lead_welcome', {
      lead_first_name: firstNameOf(leadName) || 'there',
      lead_name: leadName || 'there',
      agent_name: sender.agentName,
      agent_email: sender.agentEmail,
      agent_phone: sender.agentPhone,
      brokerage_name: sender.brokerageName,
      brokerage_contact: sender.brokerageContact,
    }, signature);

    return this.dispatch('welcome', leadName, lead.email, t.subject, t.html, sender.user, lead.id);
  }

  /**
   * Is the welcome switched on for whoever is sending it?
   *
   * An agent has their own switch, inheriting the brokerage default. A brokerage-owned lead has no
   * agent, so there is no personal row to read and the brokerage default is the whole answer —
   * asking `isEnabledFor` with a null id would look up overrides for user -1 and get the same
   * answer by accident rather than on purpose.
   */
  /**
   * Would importing a file email the people in it?
   *
   * ASKED BY THE IMPORT WINDOW, before anything is imported. Importing a spreadsheet does not only
   * create records: every new lead becomes eligible for the welcome sweep, so a five-hundred-row
   * file is five hundred members of the public emailed by the brokerage - and the sweep runs on a
   * delay, so the operator has usually closed the window before the first one goes.
   *
   * IT ASKS THE SAME QUESTIONS THE SEND WILL. The per-user trigger, the brokerage kill switch, the
   * template and the connected mailbox - all four decide whether a welcome actually leaves, so a
   * warning built on any subset would cry wolf or, worse, promise silence it cannot deliver.
   */
  async importWillEmail(user: AuthUserRecord): Promise<{ willEmail: boolean; reason: string | null }> {
    if (!(await this.welcomeEnabledFor(user))) {
      return { willEmail: false, reason: 'the welcome email is switched off' };
    }
    const blocked = await this.welcomeBlockedReason(user.id ?? null);
    return blocked ? { willEmail: false, reason: blocked } : { willEmail: true, reason: null };
  }

  private async welcomeEnabledFor(user: AuthUserRecord): Promise<boolean> {
    if (user.id) return this.triggers.isEnabledFor(user, 'welcome');
    return (await this.triggers.brokerageDefaultFor('welcome'));
  }

  /**
   * Everything that would refuse a welcome for a reason that is NOT about this lead.
   *
   * WHY THIS IS SEPARATE FROM SENDING. `dispatch` records every refusal in `crm_email_log`, and the
   * sweep treats any logged welcome as "this lead has had theirs" — which is what stops imports and
   * retries producing duplicates. Those two together mean a brokerage that has not connected a CRM
   * mailbox yet would have every lead's one-and-only welcome permanently spent on a refusal, and
   * connecting the account later would fix nothing. So the sweep asks THIS first and skips quietly,
   * leaving the lead eligible; only a real attempt to deliver spends the one chance.
   *
   * Returns the reason, or null when there is nothing in the way.
   */
  async welcomeBlockedReason(userId: number | null): Promise<string | null> {
    if (!(await this.autoSendEnabled())) {
      return 'the CRM\'s per-lead emails are switched off for the brokerage (CRM → Communications → Brokerage Controls)';
    }
    const template = await this.prisma.email_templates.findUnique({ where: { event_key: 'crm.lead_welcome' } });
    if (template && !template.is_active) {
      return `the "${template.name}" template is switched off (CRM Settings → Templates → CRM)`;
    }
    if (!(await this.accounts.senderFor(userId, 'crm'))) {
      return 'no CRM email account is connected (CRM Settings → Integrations)';
    }
    return null;
  }

  async sendBirthdayWishes(leadName: string, leadEmail: string, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.triggers.isEnabledFor(user, 'birthday'))) return this.refuse('birthday', leadName, leadEmail, user);
    const t = await this.fromTemplate('crm.birthday_greeting',
      { lead_name: leadName || 'there', agent_name: user.name ?? '' }, signature);
    return this.dispatch('birthday', leadName, leadEmail, t.subject, t.html, user);
  }

  async sendAnniversaryWishes(leadName: string, leadEmail: string, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.triggers.isEnabledFor(user, 'anniversary'))) return this.refuse('anniversary', leadName, leadEmail, user);
    const t = await this.fromTemplate('crm.anniversary_greeting',
      { lead_name: leadName || 'there', agent_name: user.name ?? '' }, signature);
    return this.dispatch('anniversary', leadName, leadEmail, t.subject, t.html, user);
  }

  async sendSeasonalWishes(leadName: string, leadEmail: string, season: string, year: string | number, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.triggers.isEnabledFor(user, 'seasonal'))) return this.refuse('seasonal', leadName, leadEmail, user);
    const s = str(season) || 'the season';
    const y = str(year) || String(new Date().getFullYear());
    const t = await this.fromTemplate('crm.seasonal_wishes',
      { lead_name: leadName || 'there', agent_name: user.name ?? '', season: s, year: y }, signature);
    return this.dispatch('seasonal', leadName, leadEmail, t.subject, t.html, user);
  }

  async sendPromotionalOffer(leadName: string, leadEmail: string, offer: PromotionalOffer, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.triggers.isEnabledFor(user, 'promotional'))) return this.refuse('promotional', leadName, leadEmail, user);
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

  /**
   * Email a referral code to a lead.
   *
   * THE CODE IS LOOKED UP, NOT TAKEN ON TRUST. Every figure in this email used to come straight from
   * the request body: the code itself, the discount, the expiry and the usage limit. Measured on
   * 2026-08-04 — a code that had never been issued (`GHR-NEVERISSUED`), expired in 2020 and carrying
   * a 99% discount was accepted and sent, over the brokerage's own signature, telling the recipient
   * it was worth 99% off. Nothing checked that the code existed, and the Referral Codes table two
   * cards up was the only place it could have been checked against.
   *
   * So the row is the authority now. The client supplies a code and nothing else that matters;
   * discount, expiry and remaining uses are read from `crm_referral_codes`, which is what the table
   * on screen shows and what anyone honouring the code at the other end would look at.
   *
   * AND THE USE IS RECORDED. `usage_count` was written once, as `0`, and incremented by nothing
   * anywhere in the codebase — so the table's "Used 0 / 5" was decorative and `max_usage` was
   * unenforceable. Sending the code is the moment a use happens, so that is where it is counted.
   */
  async sendReferralCode(leadName: string, leadEmail: string, referral: ReferralCode, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.triggers.isEnabledFor(user, 'referral'))) return this.refuse('referral', leadName, leadEmail, user);

    const code = str(referral?.code).toUpperCase();
    if (!code) throw new BadRequestException({ message: 'A referral code is required.' });

    const row = await this.prisma.crm_referral_codes.findUnique({ where: { code } });
    if (!row) {
      throw new BadRequestException({
        message: `No referral code "${code}" has been issued. Generate one under CRM Settings → Referral Codes, or check the code you typed.`,
      });
    }
    if (row.valid_until.getTime() < Date.now()) {
      throw new BadRequestException({
        message: `Referral code ${code} expired on ${row.valid_until.toISOString().slice(0, 10)}. Generate a new one rather than sending an expired code.`,
      });
    }
    if (row.usage_count >= row.max_usage) {
      throw new BadRequestException({
        message: `Referral code ${code} has been used ${row.usage_count} of ${row.max_usage} times and has none left. Generate a new one.`,
      });
    }

    const remaining = row.max_usage - row.usage_count;
    const untilText = row.valid_until.toISOString().slice(0, 10);
    const outcome = await this.dispatch('referral', leadName, leadEmail, 'Your referral code', this.shell(
      `<p>Hi ${esc(leadName || 'there')},</p>
<p>Thank you for recommending us. Here is your referral code:</p>
<p style="font-size:22px;font-weight:700;letter-spacing:2px;background:#f5f3ff;border:1px dashed #c4b5fd;border-radius:10px;padding:14px;text-align:center;margin:16px 0">${esc(row.code)}</p>
<p style="font-size:14px;color:#6b7280">
  Worth ${esc(row.discount)}% off · valid until ${esc(untilText)} · can be used ${esc(remaining)} more time(s)
</p>
<p>Pass it on to anyone who's buying or selling — it applies to them, and we'll look after them properly.</p>`, signature), user);

    /*
     * Counted only when the message actually went, and guarded on the count this send was authorised
     * against. Two people sending the last use of a code at the same moment both read
     * `usage_count = 4` above; the `lt: max_usage` here means the database decides which one gets
     * it, rather than both incrementing past the limit.
     */
    if (outcome.success) {
      await this.prisma.crm_referral_codes
        .updateMany({
          where: { id: row.id, usage_count: { lt: row.max_usage } },
          data: { usage_count: { increment: 1 } },
        })
        .catch((err: unknown) => {
          // A delivered email must not become a failed request because the counter would not move.
          this.log.warn(`Could not record use of referral code ${code}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    return outcome;
  }

  async sendCustomEmail(leadName: string, leadEmail: string, subject: string, content: string, user: AuthUserRecord, signature?: string): Promise<SendOutcome> {
    if (!(await this.triggers.isEnabledFor(user, 'custom'))) return this.refuse('custom', leadName, leadEmail, user);
    const s = str(subject);
    const body = str(content);
    if (!s) throw new BadRequestException({ message: 'A subject is required.' });
    if (!body) throw new BadRequestException({ message: 'The message body cannot be empty.' });
    // Authored by a signed-in staff member and sent as HTML, matching the CRM — and put through the
    // same sanitiser as the signature, because "a colleague typed it" is not a reason to relay a
    // script to a client's inbox.
    return this.dispatch('custom', leadName, leadEmail, s, this.shell(CrmAdvancedEmailService.sanitizeHtml(body), signature), user);
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
          // `wedding` was here. Retired — see the note above `sendSeasonalWishes`. An old client
          // asking for it falls through to the `default` below and is told the type is unknown,
          // rather than silently sending nothing and reporting success.
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
  /**
   * Refuse a send because the sender's own trigger is off — and RECORD IT.
   *
   * This returned a message and wrote nothing. Every other refusal in this service is logged: an
   * opt-out, an address that is not a lead, the brokerage kill switch, a delivery failure. Counted
   * during the CRM › Triggers audit: nine master-switch refusals in `crm_email_log` against zero
   * trigger refusals — so the one gate an administrator uses to say "do not send this" was the one
   * whose refusals could not be shown afterwards. Under CASL the evidence is most of the value.
   */
  private async refuse(kind: string, leadName: string, leadEmail: string, user: AuthUserRecord): Promise<SendOutcome> {
    const label = kind.charAt(0).toUpperCase() + kind.slice(1);
    // Names where the switch actually is. It said "CRM › Triggers" while that screen existed; the
    // switch moved to Communications with the rest of it, and a refusal that sends somebody to a
    // screen that no longer exists is worse than one that gives no direction at all.
    const message = `Not sent — your "${label}" trigger is switched off. Turn it back on under CRM › Communications.`;
    this.log.warn(`CRM ${kind} email to ${leadEmail} refused: ${user.name ?? 'the caller'} has this trigger off.`);
    await this.record(kind, leadName, str(leadEmail), null, false, message, user, null);
    return { success: false, message };
  }

  /**
   * The lead this address belongs to, if the caller is allowed to reach them.
   *
   * THE RECIPIENT USED TO COME STRAIGHT FROM THE REQUEST BODY. `leadEmail` was validated for shape
   * and handed to the mailer — no lead lookup, no ownership check — so anyone who could reach these
   * endpoints could send arbitrary HTML, with an arbitrary subject, from the brokerage's own
   * authenticated domain, to any address on earth. That is a phishing platform with the brokerage's
   * SPF and DKIM alignment behind it. Requiring a real, live lead is what closed it, and that
   * requirement is unchanged: an address the brokerage has no relationship with is still refused.
   *
   * WHAT CHANGED, AND WHY. The rule was `leadScopeWhere(user)` — assigned to you, or owned by you.
   * That is correct for an agent and wrong for the only people who can open this screen. "Send a
   * CRM Email" lives on the CRM Settings tab, which requires the `settings` screen, which only
   * Super Admin and Admin hold. Neither owns leads: at a brokerage with hundreds of agents every
   * lead belongs to an agent. Measured on 2026-08-04, as Super Admin, against every seeded lead:
   * "Not sent — this address is not one of your leads." The card refused every recipient it was
   * ever going to be given, and the seven trigger switches, the referral generator and the send log
   * were all scaffolding on a feature that could not run.
   *
   * The fix for that was `data.read-all` — "may this person act on records belonging to someone
   * other than themselves" — and it went one step too far. `data.read-all` is unscoped: it resolved
   * ANY lead in the database, so a Manager could email an agent's private client. The problem it
   * was solving was narrower than that. The administrator needs THE BROKERAGE'S leads, which is a
   * category this database already distinguishes and which `leadScopeWhere` now returns.
   *
   * SO THE TEST IS THE SAME ONE THE LEADS SCREEN APPLIES, and deliberately nothing more:
   *
   *   permission to send   `settings` / the screen guard, decided before this runs
   *   AND
   *   target in scope      this function
   *
   * Both must pass. Holding the first has never been a reason to skip the second — that is exactly
   * how "Manager can email every agent's private lead" happened. An administrator can still email a
   * lead sitting on an agent's desk when the BROKERAGE owns it, which is the case the card exists
   * for; what they can no longer do is reach into a book that is not the brokerage's.
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
   * The named lead, if that really is their address.
   *
   * Used only by the automatic welcome, where the sweep already has the lead in hand. It asserts
   * the pair rather than trusting the id: an address that has since been edited to somebody else's
   * no longer matches, and the send is refused exactly as an unknown address would be.
   */
  private async resolveNamedLead(email: string, leadId: number): Promise<{ id: number; name: string } | null> {
    return this.prisma.leads.findFirst({
      where: {
        id: leadId,
        email: { equals: email.trim().toLowerCase(), mode: 'insensitive' },
        deleted_at: null,
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
  private async dispatch(
    kind: string, leadName: string, leadEmail: string, subject: string, html: string, user: AuthUserRecord,
    /**
     * The lead this send is FOR, when the sender is the system rather than a person.
     *
     * `resolveRecipient` normally asks "is this address one of the caller's leads?", which is the
     * rule that stops this endpoint being a mail relay. The automatic welcome has no caller in that
     * sense: the sweep found the lead, and a lead nobody owns — the brokerage's own — belongs to no
     * agent whose scope could contain it. Naming the lead is a NARROWER claim than the scope query,
     * not a way around it: the address still has to be that exact lead's, the lead still has to
     * exist and not be deleted, and every other guard below is unchanged.
     */
    forLeadId?: number,
  ): Promise<SendOutcome> {
    const email = str(leadEmail);
    if (!EMAIL_SHAPE.test(email)) throw new BadRequestException({ message: 'Enter a valid recipient email address.' });

    /*
     * THE MASTER SWITCH, WHICH USED TO BE DECORATIVE.
     *
     * `autoSendEnabled()` has existed on this service since the migration and had NO CALLER — a
     * repository-wide grep found the definition and nothing else. Meanwhile CRM Settings renders it
     * as "Allow CRM emails — Master switch — turn off to block every send below" and disables the
     * per-trigger toggles beneath it. Measured on 2026-08-04: saved with the switch off, a custom
     * email went straight through to the SMTP layer. The switch below it, one line down the same
     * card, worked correctly — so the screen offered one gate that held and one that did not, with
     * the ineffective one labelled as the stronger.
     *
     * WHERE IT LIVES NOW: CRM → Communications → Brokerage Controls, above the per-communication
     * rows it can make inert, behind the `settings: edit` permission this endpoint's siblings
     * already enforce. It went to the Triggers screen first, then here with the rest of that
     * screen's controls, so that one place answers "what can the CRM send, and why is it not?".
     *
     * NOT checked before the trigger, despite what this comment claimed until 2026-08-08. Each of
     * the five entry points calls `triggers.isEnabledFor` and returns before `dispatch` is reached,
     * so a caller whose own trigger is also off is told about the trigger and the log records a
     * trigger refusal. Nothing sends either way — the order only decides which of two true reasons
     * is reported, and rearranging it would rewrite the meaning of existing `crm_email_log` rows.
     */
    if (!(await this.autoSendEnabled())) {
      const message = 'Not sent — the CRM\'s per-lead emails are switched off for the brokerage. Turn them back on under CRM → Communications → Brokerage Controls.';
      this.log.warn(`CRM ${kind} email to ${email} refused: CRM sending is switched off.`);
      await this.record(kind, leadName, email, subject, false, message, user, null);
      return { success: false, message };
    }

    // The recipient has to be one of the caller's own leads. See `resolveRecipient` — this is what
    // stops the endpoint being a mail relay wearing a CRM's clothes.
    const recipient = forLeadId
      ? await this.resolveNamedLead(email, forLeadId)
      : await this.resolveRecipient(email, user);
    if (!recipient) {
      /*
       * The wording follows the SAME test the lookup just applied, so the message can never describe
       * a rule the code is not enforcing. It says what the reader can act on and no more — neither
       * branch reveals whether the address exists on somebody else's book, which would make this an
       * enumeration oracle.
       */
      const message = hasBrokerageLeadScope(user)
        ? 'Not sent — no brokerage lead has this address. CRM emails only go to people the brokerage already has a record of; a lead in an agent\'s own book must be emailed by that agent.'
        : 'Not sent — this address is not one of your leads. Add them as a lead first, or ask an administrator to reassign the lead to you.';
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

    /*
     * SENT FROM A CRM MAILBOX, AND FROM THIS PERSON'S IF THEY HAVE ONE.
     *
     * This was `sendDirect(email, subject, html)` — no account, no user — so `resolveSender(null,
     * null)` fell through to "any active account", with no `scope` filter at all. A CRM email could
     * therefore leave from a Transaction Desk mailbox, which is precisely what `mail_accounts.scope`
     * exists to prevent, and what `broadcast()` in the sibling service already takes care to avoid.
     * Two send paths in one module, one honouring the separation and one ignoring it.
     *
     * Refused rather than sent from the wrong address when nothing is connected: an email leaving
     * under an address the recipient does not recognise is worse than one that did not leave, and
     * the person is still looking at the screen.
     */
    const sender = await this.accounts.senderFor(user.id ?? null, 'crm');
    if (!sender) {
      const message = 'Not sent — no CRM email account is connected. Connect one under CRM Settings → Integrations.';
      await this.record(kind, leadName, email, subject, false, message, user, null);
      return { success: false, message };
    }

    const redirect = MailerService.redirectTarget();
    try {
      await this.mailer.sendDirect(email, subject, html, sender.id, [], user.id ?? null);
      await this.record(kind, leadName, email, subject, true, null, user, redirect);
      return {
        success: true,
        redirected: redirect,
        // Not "because MAIL_REDIRECT_TO is set" — outside production mail is diverted by default,
        // so naming one possible cause would send somebody looking for a variable that is not there.
        message: redirect
          ? `Email sent — redirected to ${redirect}, so it did not reach the real recipient.`
          : `${kind.charAt(0).toUpperCase() + kind.slice(1)} email sent successfully`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`CRM ${kind} email to ${email} failed: ${message}`);
      await this.record(kind, leadName, email, subject, false, message, user, redirect);
      return { success: false, message: `Failed to send ${kind} email: ${message}` };
    }
  }

  /**
   * Record an email that another module sent, in the log this one owns.
   *
   * WHY THIS EXISTS RATHER THAN A SECOND WRITER. A campaign TEST SEND is a real email leaving the
   * brokerage, and it was reaching nobody's record of it: the log is where somebody looks to prove
   * what was sent, and one whole class of outgoing mail was missing from it. Campaigns could have
   * inserted its own row, but this table is a compliance surface and two independent writers to it
   * would drift - one would gain the redirect column, or the scoping, and the other would not.
   *
   * Deliberately narrow: `kind`, who sent it, where it went and whether it worked. Everything the
   * reader of `listLogPage` already expects to find on every other row.
   */
  async recordExternalSend(
    kind: string, recipient: string, subject: string | null,
    success: boolean, error: string | null, user: AuthUserRecord, redirected: string | null,
  ): Promise<void> {
    await this.record(kind, '', recipient, subject, success, error, user, redirected);
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

  /**
   * The send log — filtered by WHO MAY READ ACROSS DESKS *and* by WHOSE LEAD each row is about.
   *
   * ================================================================================================
   * TWO CONDITIONS, AND THE SECOND IS THE ONE THAT WAS MISSING.
   *
   *   1. the log permission   `data.read-all` — everyone's sends, or only your own
   *   2. the lead scope       every row names a client; may this person see that client?
   *
   * `data.read-all` alone used to decide it, which made this the one surface where lead identities
   * escaped `leadScopeWhere`. A Manager could not open an agent's private lead — 404 from the Leads
   * module, from search, from campaigns and from direct email — and could then read that same
   * client's NAME, EMAIL ADDRESS and SUBJECT LINES here, one row at a time. A permission about
   * reading OTHER PEOPLE'S SENDS was acting as permission to read OTHER PEOPLE'S CLIENTS.
   *
   * A broad permission may widen which senders you see. It may not widen which clients you see.
   * ================================================================================================
   *
   * HOW A ROW IS MATCHED TO A LEAD. `crm_email_log` carries no lead id — only `recipient`, the
   * address — so the address is resolved back to leads and the caller's own scope decides. Three
   * outcomes, and the middle one is the case that keeps this correct rather than merely strict:
   *
   *   the address is nobody's lead      → shown. Not about a client at all: a test send, or a lead
   *                                        long since purged. Nothing private to protect.
   *   the address is a lead they CAN    → shown. They can already read that client's name and
   *     see, even if other people also     address on the Leads screen, so the log discloses
   *     hold a lead at that address       nothing new. The same person legitimately appears in two
   *                                        books — that is why `leads_owner_email_key` is per book.
   *   every lead at that address is     → HIDDEN ENTIRELY. Not redacted field by field: the row's
   *     out of scope                      existence, kind, subject and timestamp would each say
   *                                        something about a client they may not know exists.
   *
   * DELETED LEADS COUNT AS LEADS on both sides of that test. A private lead moved to the bin must
   * not have its correspondence become readable by the brokerage, so the lookup ignores `deleted_at`
   * — and the owner keeps seeing their own for the same reason.
   *
   * A PAGE MAY THEREFORE RETURN FEWER ROWS THAN `limit`, and that is the honest behaviour: the
   * alternative is telling the reader how many rows were withheld, which is itself a disclosure that
   * private correspondence exists.
   */
  /**
   * Records a CRM Settings action in the shared trail. Best-effort, exactly like the copy in
   * `CrmSettingsService`: an audit write that throws must never fail the operation it describes,
   * because the alternative is a delete that half-happened.
   */
  private async audit(user: AuthUserRecord, action: string, subject: string, details = ''): Promise<void> {
    try {
      const now = new Date();
      await this.prisma.audit_logs.create({
        data: {
          category: 'Settings', transaction_id: null, who: user.name, user_id: user.id ?? null,
          section: 'CRM Settings', action, source: 'Manual',
          domain: auditDomain({ category: 'Settings', section: 'CRM Settings' }),
          new_value: subject.slice(0, 255),
          details: `${action}: ${subject}${details ? ` — ${details}` : ''}`,
          created_at: now, updated_at: now,
        },
      });
    } catch (err) {
      this.log.warn(`CRM email-log audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Remove one row from the CRM send log.
   *
   * DELETION IS GATED ON THE SAME VISIBILITY AS READING, and that is the whole point of routing it
   * through here rather than letting the controller call `delete` on an id. `listLog` narrows twice
   * — to the caller's own sends unless they hold `data.read-all`, and then to recipients they are
   * allowed to see — so an id that never appears in their list must not be deletable by guessing
   * it. Answering "not found" rather than "forbidden" keeps the refusal from confirming that a row
   * with that id exists at all, which is the same wording `listLog`'s filtering already implies.
   *
   * A hard delete, audited, for the same reason as `deleteBroadcast`: no `deleted_at` column exists,
   * and the audit trail is what preserves the fact that a record was removed.
   */
  async deleteLogEntry(user: AuthUserRecord, id: number): Promise<{ deleted: boolean }> {
    const row = await this.prisma.crm_email_log.findUnique({
      where: { id },
      select: { id: true, kind: true, recipient: true, subject: true, sent_by: true, created_at: true },
    });
    // Re-applies `listLog`'s first narrowing: your own sends, unless you may read everyone's.
    if (!row || (!can(user, 'data.read-all') && row.sent_by !== (user.name ?? ''))) {
      throw new NotFoundException({ message: 'That log entry no longer exists.' });
    }
    // …and its second: the recipient must be someone this person is allowed to see.
    const visible = await this.readableRecipients(user, [row.recipient]);
    if (!visible.has(row.recipient.trim().toLowerCase())) {
      throw new NotFoundException({ message: 'That log entry no longer exists.' });
    }

    await this.prisma.crm_email_log.delete({ where: { id } });
    await this.audit(
      user, 'CRM email log entry deleted', row.recipient,
      `${row.kind}${row.subject ? ` — ${row.subject.slice(0, 120)}` : ''}`
      + ` — sent ${row.created_at?.toISOString().slice(0, 16).replace('T', ' ') ?? 'unknown'}`,
    );
    return { deleted: true };
  }

  /** How deep one scan of the log goes. The existing clamp, named so the paging can report it. */
  private static readonly LOG_SCAN = 500;

  async listLog(user: AuthUserRecord, limit = 100): Promise<Record<string, unknown>[]> {
    return (await this.readableLog(user, limit)).rows;
  }

  /**
   * The log this person may see, and whether that is all of it.
   *
   * `reachedCap` is the honest half. Rows are filtered for readability AFTER the database has been
   * asked for a page of them, so the number returned is not the number that exist and a caller
   * cannot infer a total from a short page. When the scan hits its cap there may be more behind it,
   * and a screen that said "showing 25 of 63" off the back of a capped scan would be inventing the
   * 63.
   */
  /**
   * The `kind` filter, and why it is applied in the QUERY rather than afterwards.
   *
   * Campaign sends write one row per recipient - correctly, because the log answers "what did we
   * send this person". But the scan window is 500 rows, so a thousand-recipient mailing fills it
   * entirely and a brokerage looking for last week's welcome emails finds nothing but campaign
   * rows. Filtering after the scan would not help: the window would still be full of the rows being
   * discarded. In the WHERE, choosing a kind gives a full window OF THAT KIND.
   *
   * `transactional` is the one named value that is not a kind: it means everything the CRM sent on
   * its own initiative or on somebody's instruction, as opposed to a mailing - which is the
   * question people actually arrive with, and it should not cost them a guess at which of half a
   * dozen kinds to try.
   */
  private static kindWhere(kind?: string): Record<string, unknown> {
    const k = String(kind ?? '').trim();
    if (!k) return {};
    if (k === 'transactional') return { kind: { notIn: ['campaign', 'campaign_test'] } };
    return { kind: k };
  }

  private async readableLog(
    user: AuthUserRecord,
    limit: number,
    kind?: string,
  ): Promise<{ rows: Record<string, unknown>[]; reachedCap: boolean }> {
    const take = Math.min(CrmAdvancedEmailService.LOG_SCAN, limit);
    const rows = await this.prisma.crm_email_log.findMany({
      where: {
        ...(can(user, 'data.read-all') ? {} : { sent_by: user.name ?? '' }),
        ...CrmAdvancedEmailService.kindWhere(kind),
      },
      orderBy: { id: 'desc' },
      take,
    });
    if (!rows.length) return { rows: [], reachedCap: false };

    const visible = await this.readableRecipients(user, rows.map((r) => r.recipient));
    return {
      reachedCap: rows.length >= take,
      rows: rows
        .filter((r) => visible.has(r.recipient.trim().toLowerCase()))
        .map((r) => ({
          id: r.id, kind: r.kind, lead_name: r.lead_name, recipient: r.recipient,
          subject: r.subject, success: r.success, error: r.error, redirected: r.redirected,
          sent_by: r.sent_by, created_at: r.created_at?.toISOString() ?? null,
        })),
    };
  }

  /**
   * One page of the log, and how much of it there is.
   *
   * THE SCREEN COULD NOT SAY WHAT IT WAS HIDING. It asked for a fixed number of rows and the
   * endpoint answered with a bare array - no total, no next page, nothing a "showing 25 of 63"
   * could be built from. On this brokerage's data that silently withheld a fortnight, and the
   * withheld part is where the failures are: an email log is the record of what was sent to whom,
   * so the window that matters to somebody investigating a complaint is precisely the older one.
   *
   * `listLog` is left exactly as it was. It is what the lead-ownership scope tests drive, and those
   * assert who may see whose correspondence - not a shape worth disturbing for a paging change.
   */
  async listLogPage(
    user: AuthUserRecord,
    opts: { limit?: number; offset?: number; kind?: string } = {},
  ): Promise<{ data: Record<string, unknown>[]; meta: Record<string, unknown> }> {
    const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 50) || 50));
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0) || 0);
    const { rows, reachedCap } = await this.readableLog(user, CrmAdvancedEmailService.LOG_SCAN, opts.kind);
    return {
      data: rows.slice(offset, offset + limit),
      meta: {
        total: rows.length,
        limit,
        offset,
        // False means "there may be older entries than this total accounts for" - said plainly
        // rather than letting the screen present a capped scan as a complete count.
        complete: !reachedCap,
        // Echoed so the screen can show what it is looking at rather than inferring it.
        kind: String(opts.kind ?? '').trim() || null,
      },
    };
  }

  /**
   * Of these addresses, which may this person be shown correspondence for?
   *
   * Two lookups rather than one, because "in scope" and "not a lead at all" are different answers
   * that both permit the row, and only their combination is safe:
   *
   *   known    every address that belongs to ANY lead, in or out of the bin. Used only to decide
   *            whether an address is a client's at all — never returned, so it discloses nothing.
   *   mine     the subset the caller's own `leadScopeWhere` admits.
   *
   * An address is readable when it is in `mine`, or in neither. Scope is asked through the shared
   * rule, so this cannot drift from what the Leads screen, campaigns and direct email decide.
   */
  private async readableRecipients(user: AuthUserRecord, recipients: string[]): Promise<Set<string>> {
    const wanted = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];
    if (!wanted.length) return new Set();

    const [known, mine] = await Promise.all([
      this.prisma.leads.findMany({
        where: { email: { in: wanted, mode: 'insensitive' } },
        select: { email: true },
      }),
      this.prisma.leads.findMany({
        where: { AND: [{ email: { in: wanted, mode: 'insensitive' } }, leadScopeWhere(user)] },
        select: { email: true },
      }),
    ]);

    const lower = (rows: { email: string }[]) => new Set(rows.map((r) => r.email.trim().toLowerCase()));
    const knownSet = lower(known);
    const mineSet = lower(mine);
    return new Set(wanted.filter((a) => mineSet.has(a) || !knownSet.has(a)));
  }
}
