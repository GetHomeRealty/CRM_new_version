import { auditDomain } from '../common/domain';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import {
  BROADCAST_TYPES, CRM_ADMIN_ROLES, CURRENCIES, DATE_FORMATS, DEFAULT_EMAIL_SETTINGS,
  DEFAULT_NOTIFICATIONS, DEFAULT_PREFERENCES, DEFAULT_TRIGGERS, DEFAULT_TRIGGER_TEMPLATES,
  EMAIL_SHAPE, LANGUAGES, NOTIFICATION_KEYS, THEMES, TIME_ZONES, TRIGGER_KEYS,
} from './crm-settings.constants';
import { MailerService } from '../email/mailer.service';
import { MailAccountService } from '../email/mail-account.service';

const str = (v: unknown): string => String(v ?? '').trim();
const bool = (v: unknown, fallback: boolean): boolean =>
  v === true || v === 'true' ? true : v === false || v === 'false' ? false : fallback;

/** Merge stored JSON over defaults, so a newly added field appears without a migration. */
function merge<T extends Record<string, unknown>>(stored: string | null, defaults: T): T {
  try {
    const parsed = JSON.parse(stored ?? '{}') as Record<string, unknown>;
    return { ...defaults, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...defaults };
  }
}

/**
 * CRM Settings.
 *
 * Scoping mirrors the CRM exactly: an administrator reads and writes the shared global row
 * (`user_id = null`), and everyone else reads and writes their own. Transaction Desk's own
 * settings are untouched — this lives in its own tables alongside them.
 */
@Injectable()
export class CrmSettingsService {
  private readonly log = new Logger(CrmSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly accounts: MailAccountService,
  ) {}

  isAdmin(user: AuthUserRecord): boolean {
    return CRM_ADMIN_ROLES.includes(str(user.role).toLowerCase());
  }

  /** null for an administrator (the global row), otherwise the user's own id. */
  private scopeId(user: AuthUserRecord): number | null {
    return this.isAdmin(user) ? null : user.id ?? -1;
  }

  // -------------------------------------------------------------- settings
  async getSettings(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const userId = this.scopeId(user);
    const row = await this.prisma.crm_settings.findFirst({ where: { user_id: userId } });
    return {
      scope: userId === null ? 'global' : 'user',
      is_admin: this.isAdmin(user),
      notifications: merge(row?.notifications ?? null, DEFAULT_NOTIFICATIONS),
      emailSettings: merge(row?.email_settings ?? null, DEFAULT_EMAIL_SETTINGS),
      preferences: merge(row?.preferences ?? null, DEFAULT_PREFERENCES),
      templates: merge(row?.templates ?? null, DEFAULT_TRIGGER_TEMPLATES),
      updated_by: row?.updated_by ?? null,
      updated_at: row?.updated_at?.toISOString() ?? null,
      options: {
        languages: LANGUAGES, time_zones: TIME_ZONES, currencies: CURRENCIES,
        date_formats: DATE_FORMATS, themes: THEMES, notification_keys: [...NOTIFICATION_KEYS],
      },
    };
  }

  /**
   * Save any subset of the four sections. The CRM rejected a body carrying none of them, and
   * that guard is kept so an empty PUT can't quietly wipe a section.
   */
  async saveSettings(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const has = (k: string) => body[k] !== undefined && body[k] !== null;
    if (!has('notifications') && !has('emailSettings') && !has('preferences') && !has('templates')) {
      throw new BadRequestException({ message: 'Invalid settings structure' });
    }

    const userId = this.scopeId(user);
    const existing = await this.prisma.crm_settings.findFirst({ where: { user_id: userId } });
    const now = new Date();
    const data: Record<string, unknown> = { updated_by: user.name, updated_at: now };

    if (has('notifications')) data.notifications = JSON.stringify(this.validateNotifications(body.notifications));
    if (has('emailSettings')) data.email_settings = JSON.stringify(this.validateEmailSettings(body.emailSettings));
    if (has('preferences')) data.preferences = JSON.stringify(this.validatePreferences(body.preferences));
    if (has('templates')) data.templates = JSON.stringify(this.validateTriggerTemplates(body.templates));

    if (existing) {
      await this.prisma.crm_settings.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.crm_settings.create({ data: { ...data, user_id: userId, created_at: now } });
    }

    await this.audit(user, 'CRM settings updated', userId === null ? 'Global settings' : `Settings for ${user.name}`,
      Object.keys(data).filter((k) => k !== 'updated_by' && k !== 'updated_at').join(', '));

    return { ...(await this.getSettings(user)), message: 'Settings saved successfully' };
  }

  private validateNotifications(raw: unknown): Record<string, boolean> {
    const input = (raw ?? {}) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const key of NOTIFICATION_KEYS) out[key] = bool(input[key], DEFAULT_NOTIFICATIONS[key]);
    return out;
  }

  private validateEmailSettings(raw: unknown): Record<string, unknown> {
    const input = (raw ?? {}) as Record<string, unknown>;
    const responder = (input.autoResponder ?? {}) as Record<string, unknown>;
    const forwarding = str(input.forwardingAddress);
    if (forwarding && !EMAIL_SHAPE.test(forwarding)) {
      throw new BadRequestException({ message: 'The forwarding address must be a valid email address.', errors: { forwardingAddress: ['Enter a valid email address.'] } });
    }
    const cap = (v: unknown, max: number, field: string) => {
      const s = str(v);
      if (s.length > max) throw new BadRequestException({ message: `${field} must be ${max} characters or fewer.`, errors: { [field]: [`Must be ${max} characters or fewer.`] } });
      return s;
    };
    return {
      signature: cap(input.signature, 5000, 'signature'),
      replyTemplate: cap(input.replyTemplate, 5000, 'replyTemplate'),
      // "Auto Sync" on the Settings screen. Stored as the user's preference; there is no IMAP
      // polling engine, so it records intent rather than driving a background sync — the UI says
      // as much rather than implying mail is pulled automatically.
      autoSync: bool(input.autoSync, DEFAULT_EMAIL_SETTINGS.autoSync ?? false),
      autoResponder: { enabled: bool(responder.enabled, false), message: cap(responder.message, 5000, 'autoResponder.message') },
      forwardingAddress: forwarding,
    };
  }

  private validatePreferences(raw: unknown): Record<string, unknown> {
    const input = (raw ?? {}) as Record<string, unknown>;
    const pick = (value: unknown, allowed: string[], fallback: string) => {
      const v = str(value);
      return allowed.includes(v) ? v : fallback;
    };
    return {
      language: pick(input.language, LANGUAGES.map((l) => l.value), DEFAULT_PREFERENCES.language),
      timeZone: pick(input.timeZone, TIME_ZONES, DEFAULT_PREFERENCES.timeZone),
      currency: pick(input.currency, CURRENCIES, DEFAULT_PREFERENCES.currency),
      dateFormat: pick(input.dateFormat, DATE_FORMATS, DEFAULT_PREFERENCES.dateFormat),
      theme: pick(input.theme, THEMES, DEFAULT_PREFERENCES.theme),
    };
  }

  private validateTriggerTemplates(raw: unknown): Record<string, unknown> {
    const input = (raw ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, unknown> = {};
    for (const [key, fallback] of Object.entries(DEFAULT_TRIGGER_TEMPLATES)) {
      const given = (input[key] ?? {}) as Record<string, unknown>;
      const entry: Record<string, unknown> = {
        enabled: bool(given.enabled, (fallback as { enabled: boolean }).enabled),
        template: str(given.template) || (fallback as { template: string }).template,
      };
      // Only the birthday trigger schedules ahead, matching the CRM's shape.
      if ('daysBefore' in fallback) {
        const n = Number(given.daysBefore);
        entry.daysBefore = Number.isInteger(n) && n >= 0 && n <= 365 ? n : (fallback as { daysBefore: number }).daysBefore;
      }
      out[key] = entry;
    }
    return out;
  }

  // -------------------------------------------------------- email settings
  async getEmailSettings(): Promise<Record<string, unknown>> {
    const row = await this.prisma.crm_email_settings.findFirst({ orderBy: { id: 'asc' } });
    return {
      smtpHost: row?.smtp_host ?? '',
      smtpPort: row?.smtp_port ?? '587',
      smtpUser: row?.smtp_user ?? '',
      adminEmail: row?.admin_email ?? '',
      autoSendEnabled: row?.auto_send_enabled ?? true,
      emailTemplates: merge(row?.template_toggles ?? null, DEFAULT_TRIGGERS),
      updated_by: row?.updated_by ?? null,
      updated_at: row?.updated_at?.toISOString() ?? null,
      trigger_keys: [...TRIGGER_KEYS],
    };
  }

  /** The CRM's `updateSettings` action. Only staff with settings access reach this. */
  async saveEmailSettings(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const adminEmail = str(body.adminEmail);
    if (adminEmail && !EMAIL_SHAPE.test(adminEmail)) {
      throw new BadRequestException({ message: 'The admin email must be a valid email address.', errors: { adminEmail: ['Enter a valid email address.'] } });
    }
    const port = str(body.smtpPort);
    if (port && !/^\d{1,5}$/.test(port)) {
      throw new BadRequestException({ message: 'The SMTP port must be a number.', errors: { smtpPort: ['Enter a port number.'] } });
    }

    const toggles: Record<string, boolean> = {};
    const given = (body.emailTemplates ?? {}) as Record<string, unknown>;
    for (const key of TRIGGER_KEYS) toggles[key] = bool(given[key], DEFAULT_TRIGGERS[key]);

    const now = new Date();
    const data = {
      smtp_host: str(body.smtpHost) || null,
      smtp_port: port || null,
      smtp_user: str(body.smtpUser) || null,
      admin_email: adminEmail || null,
      auto_send_enabled: bool(body.autoSendEnabled, true),
      template_toggles: JSON.stringify(toggles),
      updated_by: user.name,
      updated_at: now,
    };

    const existing = await this.prisma.crm_email_settings.findFirst({ orderBy: { id: 'asc' } });
    if (existing) await this.prisma.crm_email_settings.update({ where: { id: existing.id }, data });
    else await this.prisma.crm_email_settings.create({ data: { ...data, created_at: now } });

    await this.audit(user, 'CRM email settings updated', 'Email settings',
      `Auto-send ${data.auto_send_enabled ? 'on' : 'off'}; triggers: ${Object.entries(toggles).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);

    return { ...(await this.getEmailSettings()), message: 'Settings updated successfully' };
  }

  // --------------------------------------------------------------- profile
  async getProfile(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const row = await this.prisma.users.findUnique({
      where: { id: user.id ?? -1 },
      select: { id: true, name: true, username: true, email: true, phone: true, role: true, status: true },
    });
    return {
      id: row?.id ?? null,
      name: row?.name ?? '',
      username: row?.username ?? '',
      email: row?.email ?? '',
      phone: row?.phone ?? '',
      role: row?.role ?? 'agent',
      status: row?.status ?? 'Active',
    };
  }

  /**
   * The CRM's Personal Information form. Name and username are required there, so they are
   * required here; email and username uniqueness is enforced because both are unique columns.
   */
  async saveProfile(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const add = (f: string, m: string) => { (errors[f] ??= []).push(m); };

    const name = str(body.name);
    const username = str(body.username);
    const email = str(body.email);
    const phone = str(body.phone);

    const current = await this.prisma.users.findUnique({ where: { id: user.id ?? -1 }, select: { username: true } });

    if (!name) add('name', 'Name is required.');
    else if (name.length > 255) add('name', 'Must be 255 characters or fewer.');

    // The CRM made username mandatory because every CRM account had one. Transaction Desk's
    // column is nullable and existing accounts (including the admin) have none, so requiring it
    // outright would lock those users out of this form entirely. It stays required once an
    // account has a username — you cannot blank one out — and optional for accounts without.
    if (!username && str(current?.username)) add('username', 'Username is required.');
    else if (username.length > 255) add('username', 'Must be 255 characters or fewer.');
    if (email && !EMAIL_SHAPE.test(email)) add('email', 'Please enter a valid email address.');
    if (phone.length > 64) add('phone', 'Must be 64 characters or fewer.');

    const id = user.id ?? -1;
    if (username) {
      const clash = await this.prisma.users.findFirst({ where: { username, id: { not: id } }, select: { id: true } });
      if (clash) add('username', 'That username is already taken.');
    }
    if (email) {
      const clash = await this.prisma.users.findFirst({ where: { email, id: { not: id } }, select: { id: true } });
      if (clash) add('email', 'That email address is already in use.');
    }

    if (Object.keys(errors).length) {
      const first = Object.values(errors)[0][0];
      throw new BadRequestException({ message: first, errors });
    }

    await this.prisma.users.update({
      where: { id },
      // Role is deliberately not writable here — the CRM shows it read-only, "managed by
      // administrators", so accepting it from this form would be a privilege-escalation hole.
      data: { name, username: username || null, email: email || undefined, phone: phone || null, updated_at: new Date() },
    });

    await this.audit(user, 'CRM profile updated', name, `username: ${username}${phone ? ` · phone: ${phone}` : ''}`);
    return { ...(await this.getProfile(user)), message: 'Personal information updated successfully' };
  }

  // ------------------------------------------------------------ broadcasts
  /**
   * The CRM's "Send to All Users" broadcast. Transaction Desk has no notifications table — its
   * feeds are derived — so the message is stored here and listed back, rather than silently
   * doing nothing.
   */
  async broadcast(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const message = str(body.message);
    if (!message) throw new BadRequestException({ message: 'Please enter a message' });
    if (message.length > 5000) throw new BadRequestException({ message: 'The message must be 5,000 characters or fewer.' });
    const type = BROADCAST_TYPES.includes(str(body.type)) ? str(body.type) : 'info';

    // Recipients are active users who actually have an address. Counting every active user and
    // reporting that number was misleading: one without an email can never receive anything.
    const users = await this.prisma.users.findMany({
      where: { status: 'Active' },
      select: { id: true, name: true, email: true },
    });
    const to = users.map((u) => str(u.email).trim()).filter((e) => e.includes('@'));

    // Sent from the CRM mailbox — this is a CRM Settings action, and the two areas are separate.
    const sender = await this.accounts.defaultSender('crm');
    if (!sender) {
      throw new BadRequestException({
        message: 'No active CRM email account is connected. Connect one under CRM Settings → Integrations before sending a broadcast.',
      });
    }

    // Delivered one at a time rather than as a single message with everyone in To: recipients
    // must not see each other's addresses, and one bad address must not lose the whole send.
    const failures: string[] = [];
    for (const address of to) {
      try {
        await this.mailer.sendDirect(address, this.broadcastSubject(type), this.broadcastHtml(message, type), sender.id, [], user.id ?? null);
      } catch (err) {
        failures.push(`${address}: ${err instanceof Error ? err.message : String(err)}`);
        this.log.warn(`Broadcast to ${address} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const delivered = to.length - failures.length;
    const row = await this.prisma.crm_broadcasts.create({
      data: { message, type, recipients: delivered, sent_by: user.name, sent_by_id: user.id ?? null, created_at: new Date() },
    });

    await this.audit(user, 'CRM broadcast sent', `${delivered} of ${to.length} recipient(s)`, message.slice(0, 160));

    // Reported honestly. A broadcast that reached nobody used to return the same cheerful
    // message as one that reached everyone, which is how this went unnoticed.
    if (delivered === 0) {
      throw new BadRequestException({
        message: to.length === 0
          ? 'No active user has an email address, so there was nobody to send to.'
          : `The broadcast could not be delivered to any of the ${to.length} recipients. First error — ${failures[0]}`,
      });
    }
    return {
      id: row.id, recipients: delivered, type,
      message: failures.length
        ? `Broadcast sent to ${delivered} of ${to.length} users. ${failures.length} failed — check the mail account under Integrations.`
        : `Broadcast emailed to ${delivered} active user${delivered === 1 ? '' : 's'}.`,
    };
  }

  /** Subject line per broadcast type, so it is recognisable in an inbox. */
  private broadcastSubject(type: string): string {
    const label = type === 'alert' ? 'Alert' : type === 'warning' ? 'Important' : 'Announcement';
    return `${label} from Get Home Realty`;
  }

  /** Minimal, inline-styled HTML — the same constraints every mail client imposes. */
  private broadcastHtml(message: string, type: string): string {
    const accent = type === 'alert' ? '#dc2626' : type === 'warning' ? '#d97706' : '#4f46e5';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Author-entered text, so newlines carry meaning; everything else is escaped.
    const body = esc(message).replace(/\n/g, '<br />');
    return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.6;">
  <div style="border-left:4px solid ${accent};padding:12px 16px;background:#f8fafc;border-radius:6px;">
    ${body}
  </div>
  <p style="color:#6b7280;font-size:12px;margin-top:16px;">Sent to all active users of Transaction Desk.</p>
</div>`;
  }

  async listBroadcasts(limit = 50): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.crm_broadcasts.findMany({ orderBy: { id: 'desc' }, take: Math.min(200, limit) });
    return rows.map((b) => ({
      id: b.id, message: b.message, type: b.type, recipients: b.recipients,
      sent_by: b.sent_by, created_at: b.created_at?.toISOString() ?? null,
    }));
  }

  // ---------------------------------------------------------- integrations
  /** Live status of each integration the CRM Settings screen surfaced. */
  async integrations(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const [accounts, activeAccounts, meta] = await Promise.all([
      this.prisma.mail_accounts.count(),
      this.prisma.mail_accounts.count({ where: { is_active: true } }),
      this.prisma.meta_connections.findFirst({ where: { user_id: user.id ?? -1, is_active: true }, select: { facebook_user_name: true, last_sync: true } }),
    ]);
    return {
      email: {
        connected: activeAccounts > 0,
        detail: activeAccounts > 0
          ? `${activeAccounts} active account${activeAccounts === 1 ? '' : 's'} of ${accounts} configured`
          : 'No active SMTP account — add one under Mail Accounts above.',
      },
      google_calendar: {
        connected: false,
        // Stated plainly rather than shown as a dead button.
        detail: 'Not available — Google Calendar OAuth was not part of the migrated code and needs Google API credentials.',
      },
      meta: {
        connected: !!meta,
        detail: meta
          ? `Connected as ${meta.facebook_user_name ?? 'Facebook user'}${meta.last_sync ? ` · last sync ${meta.last_sync.toISOString().slice(0, 16).replace('T', ' ')}` : ''}`
          : 'Not connected — open the Meta screen to connect.',
      },
      mail_redirect: {
        active: !!(process.env.MAIL_REDIRECT_TO ?? '').trim(),
        detail: (process.env.MAIL_REDIRECT_TO ?? '').trim()
          ? `Every outgoing email is being diverted to ${(process.env.MAIL_REDIRECT_TO ?? '').trim()}.`
          : 'Outgoing email goes to real recipients.',
      },
    };
  }

  // ------------------------------------------------------------------ audit
  /** Best-effort audit entry under the existing global trail. */
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
      this.log.warn(`CRM settings audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
