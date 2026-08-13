import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { type mail_accounts } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { MAIL_EVENTS, renderTemplate } from './mail-event-registry';
import { MailAccountService } from './mail-account.service';
import { mailClientId, mailClientSecret } from '../google/google.constants';

const e = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A file sent with a message.
 *
 * `cid` marks it as part of the body rather than something to download: the HTML refers to it as
 * `src="cid:<id>"` and the image travels inside the message. That is the only way an image renders
 * in a mail client without a URL the recipient can reach, which a brand logo cannot rely on.
 */
export interface MailAttachment {
  data: string;
  name?: string;
  mime?: string;
  cid?: string;
}

/** Total attempts per send, and the waits between them. Two retries, ~8s worst case. */
const SEND_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [2000, 6000];

/**
 * Whether a delivery failure is worth trying again.
 *
 * SMTP says this itself: a 4xx reply means "not now, ask again" and a 5xx means "no". Nodemailer
 * surfaces the code as `responseCode`, and network faults arrive as an errno instead. Anything not
 * recognised is treated as PERMANENT — retrying an unknown failure three times a night against a
 * real mail server is the kind of well-meaning loop that gets a sender blocklisted.
 */
export function isTransient(err: unknown): boolean {
  const e = err as { responseCode?: number; code?: string; message?: string } | undefined;
  if (!e) return false;

  if (typeof e.responseCode === 'number') return e.responseCode >= 400 && e.responseCode < 500;

  const code = String(e.code ?? '');
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ESOCKET', 'EAI_AGAIN', 'EPIPE', 'ECONNECTION', 'EDNS'].includes(code)) return true;

  // Some transports report the class in the text and nothing else.
  return /\b(421|450|451|452)\b|timed? ?out|temporar|try again|greylist|too many|rate limit/i.test(String(e.message ?? ''));
}

/** Sends emails through a MailAccount's SMTP settings (port of TemplateMailService). */
@Injectable()
export class MailerService {
  private readonly log = new Logger(MailerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypt: LaravelCryptService,
    private readonly accounts: MailAccountService,
  ) {}

  /**
   * The address every outgoing message is diverted to, or null when sending normally.
   *
   * OUTSIDE PRODUCTION THIS DEFAULTS TO A SINK RATHER THAN TO "SEND IT". The previous default was
   * `null` — send normally — and `MAIL_REDIRECT_TO` had to be remembered. It was not: on 2026-08-06
   * a development server running against the development database delivered real `lead_task_due`
   * notifications to real people, because a scheduler swept real rows and the mail path was live.
   * Nothing was misconfigured; the safe setting was simply absent, which is the failure mode a
   * default should absorb.
   *
   * Getting this wrong is asymmetric. A developer whose test mail lands in a sink notices in
   * seconds and sets one variable. A client who receives a reminder about somebody else's lead
   * cannot be un-emailed, and in this application the recipients are the brokerage's actual
   * customers.
   *
   * THE ESCAPE HATCH IS EXPLICIT: `MAIL_ALLOW_REAL_SEND=1` restores real delivery outside
   * production, for the occasions when the point of the exercise IS to watch a message arrive.
   * Explicit, per-run and greppable, rather than a default nobody remembers.
   *
   * PRODUCTION IS UNTOUCHED. With `NODE_ENV=production` this returns exactly what it always did —
   * whatever `MAIL_REDIRECT_TO` says, and `null` when it says nothing. Production mail behaviour
   * does not change, and `assertProductionConfig` already refuses to start a production server whose
   * environment is not what it claims.
   */
  static readonly DEV_SINK = 'dev-sink@localhost.invalid';

  static redirectTarget(): string | null {
    const explicit = (process.env.MAIL_REDIRECT_TO ?? '').trim();
    if (explicit !== '') return explicit;

    if (process.env.NODE_ENV === 'production') return null;
    if (/^(1|true|yes|on)$/i.test((process.env.MAIL_ALLOW_REAL_SEND ?? '').trim())) return null;

    // `.invalid` is reserved by RFC 2606 and can never resolve, so a message that somehow escapes
    // this guard still cannot reach a person.
    return MailerService.DEV_SINK;
  }

  /**
   * One line at boot saying where mail is going, so the answer is never a guess.
   *
   * Silence about a safety default is how the default becomes a mystery: somebody spends an
   * afternoon wondering why the email they are testing never arrives. Called from the module's
   * `onModuleInit`.
   */
  announceRedirect(): void {
    const target = MailerService.redirectTarget();
    if (!target) {
      if (process.env.NODE_ENV !== 'production') {
        this.log.warn('MAIL_ALLOW_REAL_SEND is set — outgoing mail will reach REAL recipients from a non-production process.');
      }
      return;
    }
    if (target === MailerService.DEV_SINK) {
      this.log.warn(
        `Outgoing mail is diverted to ${target} because this is not a production process. `
        + 'Set MAIL_REDIRECT_TO to send it somewhere you can read, or MAIL_ALLOW_REAL_SEND=1 to send for real.',
      );
    } else {
      this.log.log(`Outgoing mail is diverted to ${target} (MAIL_REDIRECT_TO).`);
    }
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

    // The template's own sender wins. Without one, fall back to the Transaction Desk default
    // rather than "any account flagged default" — CRM and Desk each have their own default, so
    // an unscoped lookup could send a Transaction Desk email from the CRM mailbox.
    const account = template.mail_accounts && template.mail_accounts.is_active
      ? template.mail_accounts
      : await this.accounts.defaultSender('desk');
    if (!account) throw new Error(`No SMTP sender is configured for '${eventKey}' (no template account and no default active account).`);

    const now = new Date();
    const merged = { current_date: `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`, current_year: String(now.getUTCFullYear()), ...vars };
    const subject = renderTemplate(template.subject, merged);
    const body = renderTemplate(template.body_html, merged);
    // Never CC an address that's already a primary recipient (mirrors dispatchViaAccount).
    const toList = (Array.isArray(to) ? to : [to]).map((e) => e.toLowerCase());
    const ccClean = [...new Set(cc)].filter((e) => e && !toList.includes(e.toLowerCase()));
    // Files attached to the template ride along with every send, ahead of anything the caller
    // supplied (a generated invoice PDF, say) so the fixed material comes first in the message.
    const stored = await this.prisma.email_template_attachments.findMany({
      where: { template_id: template.id },
      select: { filename: true, content_type: true, data: true },
    });
    const templateFiles = stored.map((a) => ({
      data: Buffer.from(a.data).toString('base64'),
      name: a.filename,
      mime: a.content_type,
    }));

    await this.dispatch(account, to, subject, body, ccClean, [...templateFiles, ...attachments]);
  }

  /**
   * Send one already-rendered message through a mail account, bypassing the template
   * registry. Campaigns personalise and inject tracking per recipient, so the body is
   * built by the caller rather than resolved from an event key.
   */
  /**
   * `headers` carries List-Unsubscribe for campaign mail.
   *
   * Gmail and Outlook both expect bulk senders to advertise a machine-readable opt-out, and they
   * weigh its absence against inbox placement — so omitting it makes legitimate campaign mail more
   * likely to land in spam, which then looks like a deliverability problem with the list.
   */
  async sendDirect(to: string, subject: string, html: string, accountId?: number | null, attachments: MailAttachment[] = [], userId?: number | null, headers?: Record<string, string>): Promise<void> {
    const account = await this.resolveSender(accountId ?? null, userId ?? null);
    await this.dispatch(account, to, subject, html, [], attachments, headers);
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

  private async dispatch(account: mail_accounts, to: string | string[], subject: string, body: string, cc: string[] = [], attachments: MailAttachment[] = [], headers?: Record<string, string>): Promise<void> {
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
            // The MAIL client, which is the one that issued this refresh token. It falls back to
            // the main pair, so this is unchanged unless a separate mail project is configured.
            clientId: mailClientId(),
            clientSecret: mailClientSecret(),
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

    /*
     * Global safety valve, and the ONLY place in the application that reaches a mail server — one
     * `createTransport`, one `sendMail`. Whatever `redirectTarget()` decides therefore governs every
     * outgoing message: campaigns, lead mail, notifications, reminders, all of it.
     *
     * Resolved through `redirectTarget()` rather than by reading the variable here, so the
     * non-production default lives in one place instead of being restated at the point where getting
     * it wrong sends the mail.
     */
    const redirect = MailerService.redirectTarget() ?? '';
    const realTo = Array.isArray(to) ? to.join(', ') : to;
    if (redirect) {
      this.log.warn(`Mail for ${realTo} diverted to ${redirect}.`);
    }

    const message = {
      // Extra RFC headers — List-Unsubscribe for campaign mail. Spread first so nothing here can
      // overwrite from/to/subject.
      ...(headers && Object.keys(headers).length ? { headers } : {}),
      from: account.from_name ? { name: account.from_name, address: account.from_email } : account.from_email,
      to: redirect || to,
      cc: redirect ? undefined : (cc.length ? cc : undefined),
      subject: redirect ? `[redirected from ${realTo}] ${subject}` : subject,
      html: body,
      attachments: attachments.map((a) => ({
        filename: a.name ?? 'attachment.pdf',
        content: Buffer.from(a.data.replace(/^data:[^;]+;base64,/, ''), 'base64'),
        contentType: a.mime ?? 'application/pdf',
        // Part of the body, not something to download — see MailAttachment.
        ...(a.cid ? { cid: a.cid, contentDisposition: 'inline' as const } : {}),
      })),
    };

    /*
     * Retry the transient failures, and only those.
     *
     * A dropped connection, a timeout or a 4xx "try again later" (greylisting, a rate limit, a
     * mailbox briefly busy) succeeds on a second attempt often enough to be worth waiting for. A
     * rejected recipient or a refused password does not: retrying those wastes the caller's time and
     * can look like an attack to the far end, so they are raised immediately and unchanged.
     *
     * Deliberately short. Some callers are inside a request — an invoice being emailed from the
     * screen — and a person is waiting, so this adds at most ~8 seconds before giving up rather
     * than the minutes a background queue could afford.
     */
    let lastError: unknown;
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      try {
        await transport.sendMail(message);
        if (attempt > 1) this.log.log(`Delivery to ${realTo} succeeded on attempt ${attempt}.`);
        return;
      } catch (err) {
        lastError = err;
        if (attempt === SEND_ATTEMPTS || !isTransient(err)) break;
        const wait = RETRY_BACKOFF_MS[attempt - 1];
        this.log.warn(`Delivery to ${realTo} failed (${(err as Error)?.message ?? err}); retrying in ${wait / 1000}s.`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastError;
  }
}
