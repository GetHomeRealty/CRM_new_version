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
  /**
   * The BROKERAGE-WIDE settings for an administrator, a person's own for everyone else.
   *
   * Reached only from `/api/crm-settings`, which is gated on the `settings` screen. The
   * self-scoped pair below exists because `/api/account` is not.
   */
  getSettings(user: AuthUserRecord): Promise<Record<string, unknown>> {
    return this.readSettings(user, this.scopeId(user));
  }

  saveSettings(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.writeSettings(user, this.scopeId(user), body);
  }

  /**
   * A PERSON'S OWN settings, whatever their role — the pair `/api/account` must use.
   *
   * WHY THIS EXISTS. `AccountController` is guarded by `AuthGuard` alone: no `ScreenGuard`, no
   * `@Screen()`. It called `getSettings`/`saveSettings`, and for every role in `CRM_ADMIN_ROLES`
   * those resolve to `user_id = null` — the shared brokerage row. Measured in the same session on
   * 2026-08-04: an Admin holding `settings: 'view'` was refused at `PUT /api/crm-settings` (403) and
   * accepted at `PUT /api/account/settings` (200, `scope: "global"`), and the Super Admin then read
   * that value back. The screen permission the CRM Settings write asks for was simply not on the
   * path an administrator's own Settings page took.
   *
   * It is also what `AccountSettingsPage` already promises in its own header comment — "everything
   * here is scoped to the signed-in user by the server" — which was true for four roles out of six.
   * An Admin now has a personal signature instead of silently editing the brokerage's, and two
   * Admins no longer overwrite each other.
   *
   * The scope is forced, not derived: passing the id rather than asking `scopeId` is what makes the
   * guarantee independent of the caller's role.
   */
  getOwnSettings(user: AuthUserRecord): Promise<Record<string, unknown>> {
    return this.readSettings(user, user.id ?? -1);
  }

  saveOwnSettings(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.writeSettings(user, user.id ?? -1, body);
  }

  private async readSettings(user: AuthUserRecord, userId: number | null): Promise<Record<string, unknown>> {
    const row = await this.prisma.crm_settings.findFirst({ where: { user_id: userId }, orderBy: { id: 'asc' } });
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
  private async writeSettings(
    user: AuthUserRecord, userId: number | null, body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const has = (k: string) => body[k] !== undefined && body[k] !== null;
    if (!has('notifications') && !has('emailSettings') && !has('preferences') && !has('templates')) {
      throw new BadRequestException({ message: 'Invalid settings structure' });
    }

    const existing = await this.prisma.crm_settings.findFirst({ where: { user_id: userId }, orderBy: { id: 'asc' } });
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

    // Re-read the row that was just written, not the one this caller's ROLE would resolve to —
    // otherwise an administrator saving their own settings gets the brokerage's back in the reply.
    return { ...(await this.readSettings(user, userId)), message: 'Settings saved successfully' };
  }

  /*
   * SILENT COERCION IS NOT VALIDATION.
   *
   * Every one of these used to take an unusable value, quietly substitute the default, and answer
   * 200. Measured on 2026-08-04: `timeZone: 'Mars/Olympus'` stored `America/Toronto`,
   * `currency: 'XBT'` stored `CAD`, `emailAlerts: 'nope'` stored `true` — the DEFAULT, not `false`,
   * so a client sending something truthy-looking got the opposite of what it asked for and was told
   * the save succeeded. An API that answers "saved" to a value it discarded is lying to whoever
   * wrote the client.
   *
   * An ABSENT key still takes the default: leaving a section out is how a partial save works and
   * always has. What is refused is a key that is present and unusable.
   */
  private validateNotifications(raw: unknown): Record<string, boolean> {
    const input = (raw ?? {}) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const key of NOTIFICATION_KEYS) {
      const given = input[key];
      if (given === undefined) { out[key] = DEFAULT_NOTIFICATIONS[key]; continue; }
      const asBool = bool(given, null as unknown as boolean);
      if (typeof asBool !== 'boolean') {
        throw new BadRequestException({
          message: `"${key}" must be true or false.`,
          errors: { [key]: ['Must be true or false.'] },
        });
      }
      out[key] = asBool;
    }
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
    /** Absent takes the default; present-and-unrecognised is refused rather than replaced. */
    const pick = (key: string, value: unknown, allowed: readonly string[], fallback: string): string => {
      if (value === undefined || value === null) return fallback;
      const v = str(value);
      if (allowed.includes(v)) return v;
      throw new BadRequestException({
        message: `"${v}" is not a valid ${key}. Choose one of: ${allowed.join(', ')}.`,
        errors: { [key]: [`Must be one of: ${allowed.join(', ')}.`] },
      });
    };
    return {
      language: pick('language', input.language, LANGUAGES.map((l) => l.value), DEFAULT_PREFERENCES.language),
      timeZone: pick('timeZone', input.timeZone, TIME_ZONES, DEFAULT_PREFERENCES.timeZone),
      currency: pick('currency', input.currency, CURRENCIES, DEFAULT_PREFERENCES.currency),
      dateFormat: pick('dateFormat', input.dateFormat, DATE_FORMATS, DEFAULT_PREFERENCES.dateFormat),
      theme: pick('theme', input.theme, THEMES, DEFAULT_PREFERENCES.theme),
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
        if (given.daysBefore === undefined || given.daysBefore === null) {
          entry.daysBefore = (fallback as { daysBefore: number }).daysBefore;
        } else {
          const n = Number(given.daysBefore);
          // 9999 used to store as 1 and answer 200. Refused now, for the same reason as the rest.
          if (!Number.isInteger(n) || n < 0 || n > 365) {
            throw new BadRequestException({
              message: `"${key}" days before must be a whole number of days between 0 and 365.`,
              errors: { [`templates.${key}.daysBefore`]: ['Must be between 0 and 365.'] },
            });
          }
          entry.daysBefore = n;
        }
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
    /*
     * These three are VarChar(255) and were length-checked nowhere, so an over-long value reached
     * Postgres and came back as a bare 500 "Internal server error" — measured at 400 characters for
     * `smtpHost` and `smtpUser`, and at a 306-character address for `adminEmail`, which passes
     * EMAIL_SHAPE and fails the column. A raw 500 on a form an administrator types into, with no
     * indication of which field caused it, while every other field on the same card returns a
     * proper 400 with an inline error. Checked here so the column limit is stated once, in words.
     */
    const capped = (value: unknown, field: string, label: string): string => {
      const s = str(value);
      if (s.length > 255) {
        throw new BadRequestException({
          message: `The ${label} must be 255 characters or fewer.`,
          errors: { [field]: ['Must be 255 characters or fewer.'] },
        });
      }
      return s;
    };

    const smtpHost = capped(body.smtpHost, 'smtpHost', 'SMTP host');
    /*
     * A HOST HAS TO LOOK LIKE A HOST. `<img src=x onerror=alert(1)>` round-tripped through this
     * field and came back intact — measured during the CRM › Triggers audit. It is not exploitable
     * today: React escapes it on render and nothing dials this value, because sending goes through
     * `mail_accounts`. But "not exploitable through the paths we happen to have today" is the same
     * weak guarantee the logo upload was fixed for, and the day something does read this field to
     * open a connection, the value it finds should be a hostname.
     *
     * Deliberately permissive about WHICH host: letters, digits, dots and hyphens, so an internal
     * name, an IPv4 address and a punycode domain all pass. Blank stays legal — the field is
     * optional and clearing it is how you unset it.
     */
    const hostLabelsValid = (host: string): boolean => host
      .split('.')
      // Per LABEL, not per string: `bad-.example.com` ends in a letter and passes a whole-string
      // check while still being an invalid name, because it is the label that may not end in a
      // hyphen. Caught by its own test rather than by reading the regex.
      .every((label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));

    if (smtpHost && !hostLabelsValid(smtpHost)) {
      throw new BadRequestException({
        message: 'The SMTP host must be a hostname or IP address — letters, digits, dots and hyphens only.',
        errors: { smtpHost: ['Enter a hostname such as smtp.example.com.'] },
      });
    }
    const smtpUser = capped(body.smtpUser, 'smtpUser', 'SMTP user');
    const adminEmail = capped(body.adminEmail, 'adminEmail', 'admin email');
    if (adminEmail && !EMAIL_SHAPE.test(adminEmail)) {
      throw new BadRequestException({ message: 'The admin email must be a valid email address.', errors: { adminEmail: ['Enter a valid email address.'] } });
    }
    // Digits alone is not a port: `99999` and `00000` were both accepted with 200. A TCP port is
    // 1–65535, and the field exists to hold one.
    const port = str(body.smtpPort);
    if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      throw new BadRequestException({
        message: 'The SMTP port must be a number between 1 and 65535.',
        errors: { smtpPort: ['Enter a port between 1 and 65535.'] },
      });
    }

    const toggles: Record<string, boolean> = {};
    const given = (body.emailTemplates ?? {}) as Record<string, unknown>;
    for (const key of TRIGGER_KEYS) toggles[key] = bool(given[key], DEFAULT_TRIGGERS[key]);

    const now = new Date();
    const data = {
      smtp_host: smtpHost || null,
      smtp_port: port || null,
      smtp_user: smtpUser || null,
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

    /*
     * A NAME ANOTHER ACCOUNT HOLDS IS REFUSED — active or deactivated.
     *
     * This form validated length, username and email and let the name through, so it was a second
     * door into the finding the Users audit opened with: two accounts sharing a name, and
     * `findFirst({ where: { name } })` resolving a commission profile to whichever row the planner
     * reached first. Measured during the CRM › Settings audit — an Admin renamed themselves to a
     * working agent's name and got a 200 and "Personal information updated successfully".
     *
     * DEACTIVATED ROWS COUNT, and that is the whole point rather than an oversight: a departed
     * agent's row keeps its name, keeps its commission split, and is exactly the row that gets
     * resolved by mistake. `users.service.ts` states the same rule at the other entry point; this
     * repeats the query rather than importing it, because reaching into the Users service from here
     * would couple two modules to save four lines.
     */
    if (name) {
      const namesake = await this.prisma.users.findFirst({
        where: { name, id: { not: id } },
        select: { id: true },
      });
      if (namesake) {
        add('name', 'Another account already has this name. Names identify people on transactions and commission statements, so they cannot be shared.');
      }
    }

    /*
     * CASE-INSENSITIVELY, BECAUSE THAT IS WHAT THE INDEX DECIDES.
     *
     * `users_email_lower_key` and `users_username_lower_key` are UNIQUE on `lower(...)`
     * (migration 20260803000000). These two lookups compared the raw string, so
     * `ADMIN@test.local` passed a check that `admin@test.local` would have failed, reached the
     * INSERT, violated the index and came back as a bare 500 — a stack-trace status code on an
     * administrator's own profile form, for a value the form could have told them about.
     *
     * `users.service.ts` already compares this way at the other entry point. Two doors onto one
     * `users` row and only one of them asked the question the database asks.
     */
    if (username) {
      const clash = await this.prisma.users.findFirst({
        where: { username: { equals: username, mode: 'insensitive' }, id: { not: id } },
        select: { id: true },
      });
      if (clash) add('username', 'That username is already taken.');
    }
    if (email) {
      const clash = await this.prisma.users.findFirst({
        where: { email: { equals: email, mode: 'insensitive' }, id: { not: id } },
        select: { id: true },
      });
      if (clash) add('email', 'That email address is already in use.');
    }

    if (Object.keys(errors).length) {
      const first = Object.values(errors)[0][0];
      throw new BadRequestException({ message: first, errors });
    }

    /*
     * A FIELD THAT WAS NOT SENT IS NOT A FIELD THAT WAS CLEARED.
     *
     * `phone: phone || null` wrote null whenever the key was absent, so a caller updating only the
     * name silently wiped the phone number — measured 2026-08-04: set to `416-555-9999`, then a PUT
     * without `phone` read back `""`. `email` in the same object used `|| undefined`, which leaves
     * it alone. Two fields, two contracts, neither written down, on an endpoint two screens share.
     *
     * Present-and-empty still clears — that is someone deliberately emptying the box. Absent means
     * "not mine to touch".
     */
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    await this.prisma.users.update({
      where: { id },
      // Role is deliberately not writable here — the CRM shows it read-only, "managed by
      // administrators", so accepting it from this form would be a privilege-escalation hole.
      data: {
        name,
        username: has('username') ? (username || null) : undefined,
        email: email || undefined,
        phone: has('phone') ? (phone || null) : undefined,
        updated_at: new Date(),
      },
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
    // Absent means "info"; present-and-unrecognised is refused. `type: 'alert'` used to be accepted
    // with 201 and silently stored as `info`, so the row said something the sender did not choose.
    const givenType = body.type;
    const type = (givenType === undefined || givenType === null) ? 'info' : str(givenType);
    if (!BROADCAST_TYPES.includes(type)) {
      throw new BadRequestException({
        message: `"${type}" is not a broadcast type. Choose one of: ${BROADCAST_TYPES.join(', ')}.`,
        errors: { type: [`Must be one of: ${BROADCAST_TYPES.join(', ')}.`] },
      });
    }

    // The duplicate check and the row's creation happen together under a per-sender lock, further
    // down in `claimBroadcast` — checking here and inserting later is what let two simultaneous
    // requests both through.

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

    // Nobody to send to is worth refusing while the person is still looking at the screen — it is
    // a configuration problem, not a delivery outcome, and there is nothing to report progress on.
    if (to.length === 0) {
      throw new BadRequestException({ message: 'No active user has an email address, so there was nobody to send to.' });
    }

    /*
     * PERSIST, RETURN, THEN DELIVER.
     *
     * This loop used to run inside the HTTP request: one SMTP round trip per active user, awaited
     * in turn. The Campaigns module removed exactly this shape and recorded why — at a few hundred
     * recipients it runs past most browser patience and past the 300 s `proxy_read_timeout` in the
     * deployment guide, and ANY interruption (closed tab, timeout, deploy) stops the loop midway
     * with some people emailed, some not, and the count written only if it reached the end. This
     * brokerage has hundreds of agents, so the old version was a timeout waiting for its first real
     * use.
     *
     * The row is written first with `status: 'sending'`, the caller gets it immediately, and
     * delivery runs detached, updating the row as it goes so the Broadcasts list can show progress.
     */
    const row = await this.claimBroadcast(user, message, type, to.length);

    await this.audit(user, 'CRM broadcast sent', `${to.length} recipient(s)`, message.slice(0, 160));

    // `void` is deliberate: nothing awaits this, and `deliverBroadcast` never throws.
    void this.deliverBroadcast(row.id, to, message, type, sender.id, user.id ?? null);

    return {
      id: row.id, recipients: 0, attempted: to.length, status: 'sending', type,
      message: `Broadcast queued for ${to.length} active user${to.length === 1 ? '' : 's'}. It is going out now — the Broadcasts list shows progress.`,
    };
  }

  /**
   * Refuse the same message from the same person twice in quick succession.
   *
   * THE SAME MESSAGE TWICE IS ALMOST NEVER MEANT. Two identical POSTs issued at the same moment
   * both returned 201 and both fanned out to every member of staff — measured 2026-08-04. The
   * button's own `disabled` guard covers a double CLICK and nothing else: a retried request, a
   * second tab or an impatient reload all get past it, and there is no undo on a message that has
   * already reached everybody's inbox.
   *
   * WHY AN ADVISORY LOCK AND NOT JUST A SELECT. Read-committed is the default isolation, so two
   * genuinely simultaneous requests both run the lookup before either writes its row, both see
   * nothing, and both proceed — which is precisely the case that was measured, and a plain check
   * would have passed the sequential test while leaving the real one open. `pg_advisory_xact_lock`
   * serialises the check-and-insert per sender for the length of the transaction; it needs no
   * schema change, and it is released when the transaction ends however it ends.
   *
   * Keyed on the sender, not the message: the contended resource is "this person sending a
   * broadcast", and two different people announcing different things must not queue behind each
   * other.
   *
   * A minute covers every accidental repeat and leaves a genuine follow-up — minutes or hours
   * later, and usually reworded — unaffected. Refused rather than silently de-duplicated, because
   * the sender needs to be told it did not go out again.
   */
  private async claimBroadcast(
    user: AuthUserRecord, message: string, type: string, attempted: number,
  ): Promise<{ id: number }> {
    // A stable per-sender lock id. Arbitrary constants, chosen only to spread ids apart from any
    // other advisory lock the application might take later.
    const key = BigInt(user.id ?? 0) * 1_000_003n + 8_675_309n;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;

      const recent = await tx.crm_broadcasts.findFirst({
        where: {
          message,
          sent_by_id: user.id ?? null,
          created_at: { gte: new Date(Date.now() - 60_000) },
        },
        select: { id: true },
      });
      if (recent) {
        throw new BadRequestException({
          message: 'That exact message was already sent to everyone less than a minute ago. It is in the Broadcasts list below — send it again only if you genuinely mean everyone to receive it twice.',
        });
      }

      // Created inside the lock, so the loser of the race sees it and is refused. A check that
      // commits before the insert is not a check.
      return tx.crm_broadcasts.create({
        data: {
          message, type,
          status: 'sending', attempted, recipients: 0, failed: 0,
          sent_by: user.name, sent_by_id: user.id ?? null, created_at: new Date(),
        },
        select: { id: true },
      });
    });
  }

  /**
   * Deliver a broadcast, one recipient at a time, off the request thread.
   *
   * Never throws — it is called with `void`, so an escaping error would be an unhandled rejection
   * that takes the process down. Everything is written to the broadcast row instead, which is what
   * the screen reads.
   *
   * One message per person rather than one message with everyone in `To:` — staff must not see each
   * other's addresses, and one bad address must not lose the whole send.
   */
  private async deliverBroadcast(
    id: number, to: string[], message: string, type: string, senderId: number, userId: number | null,
  ): Promise<void> {
    let delivered = 0;
    let failed = 0;
    let firstError: string | null = null;

    try {
      for (const address of to) {
        try {
          await this.mailer.sendDirect(address, this.broadcastSubject(type), this.broadcastHtml(message, type), senderId, [], userId);
          delivered++;
        } catch (err) {
          failed++;
          const reason = err instanceof Error ? err.message : String(err);
          firstError ??= `${address}: ${reason}`;
          this.log.warn(`Broadcast #${id} to ${address} failed: ${reason}`);
        }
        // Progress the screen can poll. One small write per recipient is nothing beside an SMTP
        // round trip, and it is the difference between a visible send and a black box.
        await this.prisma.crm_broadcasts
          .update({ where: { id }, data: { recipients: delivered, failed } })
          .catch(() => undefined);
      }

      await this.prisma.crm_broadcasts.update({
        where: { id },
        data: {
          recipients: delivered, failed,
          status: delivered === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed',
          error: firstError,
          completed_at: new Date(),
        },
      });
      this.log.log(`Broadcast #${id}: ${delivered} delivered, ${failed} failed of ${to.length}.`);
    } catch (err) {
      // A send that died mid-flight must not be left saying "sending" for ever, and must not take
      // the process with it. The counters already hold how far it reached.
      this.log.error(`Broadcast #${id} aborted: ${err instanceof Error ? err.message : String(err)}`);
      await this.prisma.crm_broadcasts
        .update({
          where: { id },
          data: { status: 'partial', recipients: delivered, failed, error: firstError, completed_at: new Date() },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Subject line per broadcast type, so it is recognisable in an inbox.
   *
   * `alert` used to have a branch here and in `broadcastHtml`. It is not a broadcast type —
   * `BROADCAST_TYPES` is info / warning / success — so the branch could never be reached, and the
   * validator above now refuses the value outright rather than storing it as `info`.
   */
  private broadcastSubject(type: string): string {
    return `${type === 'warning' ? 'Important' : 'Announcement'} from Get Home Realty`;
  }

  /** Minimal, inline-styled HTML — the same constraints every mail client imposes. */
  private broadcastHtml(message: string, type: string): string {
    const accent = type === 'warning' ? '#d97706' : type === 'success' ? '#059669' : '#4f46e5';
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

  /**
   * Close out broadcasts this process was delivering when it stopped.
   *
   * `deliverBroadcast` runs detached — `void this.deliverBroadcast(...)` — so a deploy, a restart or
   * a crash mid-loop leaves the row saying `sending` with nothing left alive to finish it or to
   * correct it. Nothing reconciled those, and they never aged out: measured on 2026-08-04, six of
   * eight rows in the QA database were still `sending`, the oldest created two days earlier. The
   * Broadcasts list is the only place an administrator can find out whether staff were emailed, and
   * for most of its rows it said "still going" for ever.
   *
   * Run once at boot, before anything can start a new send. The counters already on the row are
   * how far the interrupted run actually reached, so they are kept rather than zeroed — `partial`
   * with `recipients: 4 of 7` is the truth, and claiming either 0 or 7 would not be.
   *
   * The age floor matters: a row created seconds ago may belong to a send that is still running in
   * THIS process during a fast restart cycle, and marking that one finished would be the same class
   * of lie in the other direction.
   */
  async reconcileInterruptedBroadcasts(): Promise<number> {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);
    try {
      const stuck = await this.prisma.crm_broadcasts.findMany({
        where: { status: 'sending', created_at: { lt: cutoff } },
        select: { id: true, recipients: true, attempted: true },
      });
      for (const row of stuck) {
        await this.prisma.crm_broadcasts.update({
          where: { id: row.id },
          data: {
            // Nobody reached at all is a failure; some reached is a partial. Either way it is over.
            status: row.recipients === 0 ? 'failed' : 'partial',
            failed: Math.max(0, row.attempted - row.recipients),
            error: 'Delivery was interrupted — the server restarted while this broadcast was going out. Anyone not counted below was not emailed.',
            completed_at: new Date(),
          },
        }).catch(() => undefined);
      }
      if (stuck.length > 0) {
        this.log.warn(`Closed ${stuck.length} broadcast(s) left mid-delivery by a previous run.`);
      }
      return stuck.length;
    } catch (err) {
      // Never block boot over housekeeping.
      this.log.warn(`Could not reconcile interrupted broadcasts: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async listBroadcasts(limit = 50): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.crm_broadcasts.findMany({ orderBy: { id: 'desc' }, take: Math.min(200, limit) });
    return rows.map((b) => ({
      id: b.id, message: b.message, type: b.type, recipients: b.recipients,
      // Delivery happens after the request returns, so the list is where anyone finds out how it
      // went. Without these a broadcast still going out is indistinguishable from one that
      // reached nobody — both would read "0 recipients".
      status: b.status, attempted: b.attempted, failed: b.failed, error: b.error,
      completed_at: b.completed_at?.toISOString() ?? null,
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
