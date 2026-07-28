import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { type mail_accounts } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { MAIL_EVENTS, renderTemplate } from './mail-event-registry';

const e = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Sends emails through a MailAccount's SMTP settings (port of TemplateMailService). */
@Injectable()
export class MailerService {
  private readonly log = new Logger(MailerService.name);

  constructor(private readonly prisma: PrismaService, private readonly crypt: LaravelCryptService) {}

  /** The address every outgoing message is diverted to, or null when sending normally. */
  static redirectTarget(): string | null {
    const v = (process.env.MAIL_REDIRECT_TO ?? '').trim();
    return v === '' ? null : v;
  }

  /** Resolve the template + sender for an event, render vars, and dispatch (TemplateMailService::send). */
  async send(eventKey: string, vars: Record<string, unknown>, to: string | string[], cc: string[] = [], attachments: { data: string; name?: string; mime?: string }[] = []): Promise<void> {
    const meta = MAIL_EVENTS[eventKey];
    let template = await this.prisma.email_templates.findUnique({ where: { event_key: eventKey }, include: { mail_accounts: true } });
    if (!template && meta) {
      const now = new Date();
      await this.prisma.email_templates.create({ data: { event_key: eventKey, module: meta.module, name: meta.label, subject: meta.default_subject, body_html: meta.default_body_html, is_active: true, created_at: now, updated_at: now } });
      template = await this.prisma.email_templates.findUnique({ where: { event_key: eventKey }, include: { mail_accounts: true } });
    }
    if (!template || !template.is_active) throw new Error(`No active email template for event '${eventKey}'.`);

    const account = template.mail_accounts && template.mail_accounts.is_active
      ? template.mail_accounts
      : await this.prisma.mail_accounts.findFirst({ where: { is_active: true, is_default: true } });
    if (!account) throw new Error(`No SMTP sender is configured for '${eventKey}' (no template account and no default active account).`);

    const now = new Date();
    const merged = { current_date: `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`, current_year: String(now.getUTCFullYear()), ...vars };
    const subject = renderTemplate(template.subject, merged);
    const body = renderTemplate(template.body_html, merged);
    // Never CC an address that's already a primary recipient (mirrors dispatchViaAccount).
    const toList = (Array.isArray(to) ? to : [to]).map((e) => e.toLowerCase());
    const ccClean = [...new Set(cc)].filter((e) => e && !toList.includes(e.toLowerCase()));
    await this.dispatch(account, to, subject, body, ccClean, attachments);
  }

  /**
   * Send one already-rendered message through a mail account, bypassing the template
   * registry. Campaigns personalise and inject tracking per recipient, so the body is
   * built by the caller rather than resolved from an event key.
   */
  async sendDirect(to: string, subject: string, html: string, accountId?: number | null, attachments: { data: string; name?: string; mime?: string }[] = [], userId?: number | null): Promise<void> {
    const account = await this.resolveSender(accountId ?? null, userId ?? null);
    await this.dispatch(account, to, subject, html, [], attachments);
  }

  /**
   * Pick the mail account a campaign/direct send would use for this user, most specific first:
   *   1. an explicitly chosen account,
   *   2. the sending user's own default account, then any of their active accounts — so an
   *      agent's mail goes from their own address once they've connected one,
   *   3. the brokerage default, then any active brokerage account — the shared fallback.
   * Throws when nothing is configured, so callers surface the same "add an account" message.
   */
  async resolveSender(accountId: number | null, userId: number | null): Promise<mail_accounts> {
    const account = (accountId
      ? await this.prisma.mail_accounts.findFirst({ where: { id: accountId, is_active: true } })
      : null)
      ?? (userId
        ? (await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, is_active: true, is_default: true } })
          ?? await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, is_active: true } }))
        : null)
      ?? await this.prisma.mail_accounts.findFirst({ where: { user_id: null, is_active: true, is_default: true } })
      ?? await this.prisma.mail_accounts.findFirst({ where: { user_id: null, is_active: true } })
      ?? await this.prisma.mail_accounts.findFirst({ where: { is_active: true } });
    if (!account) throw new Error('No active SMTP account is configured. Add one under Settings.');
    return account;
  }

  /**
   * Send a one-off test message through the account the given user's campaigns would use, so an
   * agent can confirm their SMTP credentials before running a real campaign. Any SMTP error
   * (e.g. Gmail's "535 BadCredentials") propagates to the caller unchanged.
   */
  async testForUser(userId: number | null, to: string): Promise<{ from: string; account: string }> {
    const account = await this.resolveSender(null, userId);
    await this.test(account, to);
    return { from: account.from_email, account: account.name };
  }

  async test(account: mail_accounts, to: string): Promise<void> {
    const subject = 'Test email — ' + (account.from_name || account.name);
    const now = new Date();
    const sent = now.toISOString();
    const body =
      `<p>This is a test message confirming the SMTP account <strong>${e(account.name)}</strong> is configured correctly.</p>` +
      `<p>Host: ${e(account.host)}:${Number(account.port)}<br>Sent: ${sent}</p>`;

    await this.dispatch(account, to, subject, body);
  }

  private async dispatch(account: mail_accounts, to: string | string[], subject: string, body: string, cc: string[] = [], attachments: { data: string; name?: string; mime?: string }[] = []): Promise<void> {
    const transport = account.encryption === 'oauth'
      // Google OAuth account: `password` holds the encrypted refresh token. Nodemailer mints a
      // fresh access token from it (via the app's client id/secret) for each send with XOAUTH2.
      ? nodemailer.createTransport({
          host: account.host || 'smtp.gmail.com',
          port: Number(account.port) || 587,
          secure: Number(account.port) === 465,
          requireTLS: Number(account.port) !== 465,
          auth: {
            type: 'OAuth2',
            user: account.username || account.from_email,
            clientId: (process.env.GOOGLE_CLIENT_ID ?? '').trim(),
            clientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? '').trim(),
            refreshToken: this.crypt.decryptString(account.password) ?? '',
          },
          connectionTimeout: 30000,
          greetingTimeout: 30000,
        })
      : nodemailer.createTransport({
          host: account.host,
          port: Number(account.port),
          secure: account.encryption === 'ssl',
          requireTLS: account.encryption === 'tls',
          // The password is stored Laravel-encrypted (encrypted cast); decrypt for SMTP auth.
          auth: account.username ? { user: account.username, pass: this.crypt.decryptString(account.password) ?? account.password ?? '' } : undefined,
          connectionTimeout: 30000,
          greetingTimeout: 30000,
        });

    // Global safety valve. When MAIL_REDIRECT_TO is set every message goes there instead of the
    // real recipient, and the intended addresses are carried in the subject so nothing is lost.
    // Unset in production, so behaviour is unchanged; set it before running anything that sends.
    const redirect = (process.env.MAIL_REDIRECT_TO ?? '').trim();
    const realTo = Array.isArray(to) ? to.join(', ') : to;
    if (redirect) {
      this.log.warn(`MAIL_REDIRECT_TO is set — diverting mail for ${realTo} to ${redirect}.`);
    }

    await transport.sendMail({
      from: account.from_name ? { name: account.from_name, address: account.from_email } : account.from_email,
      to: redirect || to,
      cc: redirect ? undefined : (cc.length ? cc : undefined),
      subject: redirect ? `[redirected from ${realTo}] ${subject}` : subject,
      html: body,
      attachments: attachments.map((a) => ({ filename: a.name ?? 'attachment.pdf', content: Buffer.from(a.data.replace(/^data:[^;]+;base64,/, ''), 'base64'), contentType: a.mime ?? 'application/pdf' })),
    });
  }
}
