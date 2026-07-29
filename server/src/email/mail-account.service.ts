import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type mail_accounts } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { toDateTimeString } from '../common/serialize';

/**
 * Which area owns an integration. CRM Settings and Transaction Desk Settings keep separate
 * connections, so an address added on one side never shows up on the other.
 */
export type IntegrationScope = 'crm' | 'desk';

/** Read a scope off a query string or request body; anything unrecognised means "no filter". */
export const parseScope = (v: unknown): IntegrationScope | undefined =>
  (v === 'crm' || v === 'desk' ? v : undefined);

@Injectable()
export class MailAccountService {
  constructor(private readonly prisma: PrismaService, private readonly crypt: LaravelCryptService) {}

  /**
   * Brokerage accounts only (user_id = NULL), for admin Email Settings. A user's personal
   * accounts never appear here — those are managed through the per-user methods below.
   */
  async list(): Promise<mail_accounts[]> {
    const rows = await this.prisma.mail_accounts.findMany({ where: { user_id: null } });
    rows.sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id);
    return rows;
  }

  async index(): Promise<Record<string, unknown>[]> {
    return (await this.list()).map((a) => this.resource(a));
  }

  /**
   * Every account a Transaction Desk template may send from.
   *
   * Templates used to offer only brokerage accounts (user_id = NULL), which no longer exist:
   * accounts are now connected through Integrations and belong to the user who connected them.
   * The result was a "Sender account" dropdown with nothing in it but "Use default sender", so a
   * template could not be pointed at a specific address at all.
   *
   * CRM accounts are deliberately excluded. The two areas are separate by design, and a
   * Transaction Desk template offering the CRM mailbox would undo that.
   */
  async sendersForDesk(): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.mail_accounts.findMany({
      where: { is_active: true, OR: [{ scope: 'desk' }, { user_id: null }] },
    });
    rows.sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id);
    return rows.map((a) => this.resource(a));
  }

  /**
   * The account to fall back on when a template names none.
   *
   * Scoped, because `is_default` is per-user-and-area: with a default on each side an unscoped
   * lookup returns whichever row the database happens to yield first, so a Transaction Desk
   * email could go out from the CRM mailbox. Prefers the area's default, then any active
   * account in the area, then a brokerage account.
   */
  async defaultSender(scope: IntegrationScope): Promise<mail_accounts | null> {
    const inScope = { is_active: true, scope };
    return (
      (await this.prisma.mail_accounts.findFirst({ where: { ...inScope, is_default: true } }))
      ?? (await this.prisma.mail_accounts.findFirst({ where: inScope, orderBy: { id: 'asc' } }))
      ?? (await this.prisma.mail_accounts.findFirst({ where: { is_active: true, user_id: null, is_default: true } }))
      ?? (await this.prisma.mail_accounts.findFirst({ where: { is_active: true, user_id: null }, orderBy: { id: 'asc' } }))
    );
  }

  // --------------------------------------------------- per-user accounts
  /**
   * One user's own accounts. Everything below is scoped to `userId`, so a user can only ever see
   * or change their own — never another user's, and never the brokerage's.
   */
  /**
   * CRM Settings and Transaction Desk Settings are completely separate: an account belongs
   * to exactly one of them and is only ever listed there. The match is strict — an account
   * connected on one side never surfaces on the other, and there is no shared middle
   * ground.
   *
   * Passing no scope returns every account, which is what the personal Settings screen and
   * the sending pipeline want.
   */
  async indexForUser(userId: number, scope?: IntegrationScope): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.mail_accounts.findMany({
      where: { user_id: userId, ...(scope ? { scope } : {}) },
    });
    rows.sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id);
    return rows.map((a) => this.resource(a));
  }

  async storeForUser(userId: number, body: Record<string, unknown>, scope?: IntegrationScope): Promise<Record<string, unknown>> {
    const data = this.validate(body, false);
    if ((data.password ?? '') === '') delete data.password;
    else data.password = this.crypt.encryptString(String(data.password));

    const now = new Date();
    const account = await this.prisma.mail_accounts.create({
      // A new account belongs to the area it was added from — that is the whole point of
      // the split, so it is stamped at creation rather than left to be assigned later.
      data: { ...(data as Prisma.mail_accountsCreateInput), user_id: userId, scope: scope ?? null, created_at: now, updated_at: now },
    });
    // The user's first account becomes their default automatically, so there is always a sender.
    const count = await this.prisma.mail_accounts.count({ where: { user_id: userId } });
    if (account.is_default || count === 1) {
      await this.prisma.mail_accounts.update({ where: { id: account.id }, data: { is_default: true } });
      await this.makeSoleDefault(account.id, userId);
    }
    return this.resource((await this.find(account.id))!);
  }

  async updateForUser(userId: number, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ownOrThrow(userId, id);
    const data = this.validate(body, true);
    if (!Object.prototype.hasOwnProperty.call(data, 'password') || data.password === null || data.password === '') delete data.password;
    else data.password = this.crypt.encryptString(String(data.password));

    await this.prisma.mail_accounts.update({ where: { id }, data: { ...(data as Prisma.mail_accountsUpdateInput), updated_at: new Date() } });
    const fresh = (await this.find(id))!;
    if (fresh.is_default) await this.makeSoleDefault(id, userId);
    return this.resource((await this.find(id))!);
  }

  /**
   * Assign an existing account to an area — the picker for connections that pre-date the
   * split. `null` puts it back to unassigned, where it shows on both sides.
   */
  async setScopeForUser(userId: number, id: number, scope: IntegrationScope | null): Promise<Record<string, unknown>> {
    await this.ownOrThrow(userId, id);
    await this.prisma.mail_accounts.update({ where: { id }, data: { scope, updated_at: new Date() } });
    return this.resource((await this.find(id))!);
  }

  async destroyForUser(userId: number, id: number): Promise<{ message: string }> {
    await this.ownOrThrow(userId, id);
    await this.prisma.mail_accounts.delete({ where: { id } });
    return { message: 'Mail account deleted' };
  }

  async setDefaultForUser(userId: number, id: number): Promise<Record<string, unknown>> {
    await this.ownOrThrow(userId, id);
    await this.prisma.mail_accounts.update({ where: { id }, data: { is_default: true, is_active: true, updated_at: new Date() } });
    await this.makeSoleDefault(id, userId);
    return this.resource((await this.find(id))!);
  }

  /** The account a test send should go through, confirmed to belong to the user. */
  async findForUser(userId: number, id: number): Promise<mail_accounts> {
    return this.ownOrThrow(userId, id);
  }

  private async ownOrThrow(userId: number, id: number): Promise<mail_accounts> {
    const acc = await this.prisma.mail_accounts.findFirst({ where: { id, user_id: userId } });
    if (!acc) throw this.missing(id);
    return acc;
  }

  async store(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = this.validate(body, false);
    // A blank password on create simply stores none; otherwise store it Laravel-encrypted.
    if ((data.password ?? '') === '') delete data.password;
    else data.password = this.crypt.encryptString(String(data.password));

    const now = new Date();
    const account = await this.prisma.mail_accounts.create({ data: { ...(data as Prisma.mail_accountsCreateInput), created_at: now, updated_at: now } });
    if (account.is_default) await this.makeSoleDefault(account.id);
    return this.resource((await this.find(account.id))!);
  }

  async update(id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.find(id);
    if (!existing) throw this.missing(id);
    const data = this.validate(body, true);
    // Preserve the existing password when the field is blank/omitted; else store it encrypted.
    if (!Object.prototype.hasOwnProperty.call(data, 'password') || data.password === null || data.password === '') delete data.password;
    else data.password = this.crypt.encryptString(String(data.password));

    await this.prisma.mail_accounts.update({ where: { id }, data: { ...(data as Prisma.mail_accountsUpdateInput), updated_at: new Date() } });
    const fresh = (await this.find(id))!;
    if (fresh.is_default) await this.makeSoleDefault(id);
    return this.resource((await this.find(id))!);
  }

  async destroy(id: number): Promise<{ message: string }> {
    const existing = await this.find(id);
    if (!existing) throw this.missing(id);
    await this.prisma.mail_accounts.delete({ where: { id } });
    return { message: 'Mail account deleted' };
  }

  async setDefault(id: number): Promise<Record<string, unknown>> {
    const existing = await this.find(id);
    if (!existing) throw this.missing(id);
    await this.prisma.mail_accounts.update({ where: { id }, data: { is_default: true, is_active: true, updated_at: new Date() } });
    await this.makeSoleDefault(id);
    return this.resource((await this.find(id))!);
  }

  async find(id: number): Promise<mail_accounts | null> {
    return this.prisma.mail_accounts.findUnique({ where: { id } });
  }

  /**
   * Ensure exactly one row carries is_default = true WITHIN its scope. A user's default is chosen
   * among their own accounts; the brokerage default (user_id = null) among the brokerage's. One
   * scope's default never clears another's, so a user setting their default cannot disturb the
   * brokerage fallback.
   */
  private async makeSoleDefault(id: number, userId: number | null = null): Promise<void> {
    await this.prisma.mail_accounts.updateMany({
      where: { id: { not: id }, is_default: true, user_id: userId },
      data: { is_default: false },
    });
  }

  private missing(id: number): NotFoundException {
    return new NotFoundException({ message: `No query results for model [App\\Models\\MailAccount] ${id}.` });
  }

  resource(a: mail_accounts): Record<string, unknown> {
    const filled = a.password !== null && a.password !== undefined && String(a.password).trim() !== '';
    return {
      id: a.id,
      name: a.name,
      from_name: a.from_name,
      from_email: a.from_email,
      host: a.host,
      port: Number(a.port),
      username: a.username,
      encryption: a.encryption,
      is_active: !!a.is_active,
      is_default: !!a.is_default,
      has_password: filled,
      /** 'crm' | 'desk' | null. Null pre-dates the split and shows on both sides. */
      scope: a.scope ?? null,
      // ---- IMAP inbound sync ----
      imap_host: a.imap_host,
      imap_port: a.imap_port ? Number(a.imap_port) : null,
      imap_encryption: a.imap_encryption,
      inbound_enabled: !!a.inbound_enabled,
      last_synced_at: toDateTimeString(a.last_synced_at),
      sync_error: a.sync_error,
      created_at: toDateTimeString(a.created_at),
    };
  }

  // ---- validation (port of Store/UpdateMailAccountRequest) ----

  private validate(body: Record<string, unknown>, _isUpdate: boolean): Record<string, unknown> {
    const errors: FieldErrors = {};
    const push = (f: string, m: string): void => { (errors[f] ??= []).push(m); };
    const empty = (v: unknown): boolean => v === undefined || v === null || v === '';
    const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k);

    const strMax = (f: string, req: boolean, max: number): void => {
      if (empty(body[f])) { if (req) push(f, `The ${f.replace(/_/g, ' ')} field is required.`); return; }
      if (typeof body[f] !== 'string') push(f, `The ${f.replace(/_/g, ' ')} field must be a string.`);
      else if ([...(body[f] as string)].length > max) push(f, `The ${f.replace(/_/g, ' ')} field must not be greater than ${max} characters.`);
    };

    strMax('name', true, 255);
    strMax('from_name', false, 255);
    if (empty(body.from_email)) push('from_email', 'The from email field is required.');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.from_email))) push('from_email', 'The from email field must be a valid email address.');
    else if ([...String(body.from_email)].length > 255) push('from_email', 'The from email field must not be greater than 255 characters.');
    strMax('host', true, 255);

    if (!empty(body.port)) {
      if (!Number.isInteger(Number(body.port)) || String(body.port).trim() === '' || /[^0-9-]/.test(String(body.port))) push('port', 'The port field must be an integer.');
      else { const p = Number(body.port); if (p < 1) push('port', 'The port field must be at least 1.'); else if (p > 65535) push('port', 'The port field must not be greater than 65535.'); }
    }
    strMax('username', false, 255);
    strMax('password', false, 1000);
    if (!empty(body.encryption) && !['tls', 'ssl'].includes(String(body.encryption))) push('encryption', 'The selected encryption is invalid.');
    for (const f of ['is_active', 'is_default']) if (!empty(body[f]) && !this.isBoolean(body[f])) push(f, `The ${f.replace(/_/g, ' ')} field must be true or false.`);

    // ---- IMAP inbound sync (all optional) ----
    strMax('imap_host', false, 255);
    if (!empty(body.imap_port)) {
      const p = Number(body.imap_port);
      if (!Number.isInteger(p) || /[^0-9]/.test(String(body.imap_port))) push('imap_port', 'The IMAP port field must be an integer.');
      else if (p < 1 || p > 65535) push('imap_port', 'The IMAP port must be between 1 and 65535.');
    }
    if (!empty(body.imap_encryption) && !['tls', 'ssl'].includes(String(body.imap_encryption))) push('imap_encryption', 'The selected IMAP encryption is invalid.');
    if (!empty(body.inbound_enabled) && !this.isBoolean(body.inbound_enabled)) push('inbound_enabled', 'The inbound enabled field must be true or false.');
    // Turning sync on with nowhere to sync from is a configuration mistake worth catching early.
    if (this.toBool(body.inbound_enabled) && empty(body.imap_host)) push('imap_host', 'Enter the IMAP server to enable inbound sync.');

    if (Object.keys(errors).length) throwValidation(errors);

    // validated(): present keys only, with boolean/integer coercion applied on the way to Prisma.
    const out: Record<string, unknown> = {};
    for (const f of ['name', 'from_name', 'from_email', 'host', 'username', 'password', 'encryption', 'imap_host', 'imap_encryption']) if (has(f)) out[f] = body[f];
    if (has('port') && !empty(body.port)) out.port = Number(body.port);
    if (has('imap_port')) out.imap_port = empty(body.imap_port) ? null : Number(body.imap_port);
    for (const f of ['is_active', 'is_default', 'inbound_enabled']) if (has(f)) out[f] = this.toBool(body[f]);
    return out;
  }

  private isBoolean(v: unknown): boolean {
    return v === true || v === false || v === 1 || v === 0 || v === '1' || v === '0' || v === 'true' || v === 'false';
  }

  private toBool(v: unknown): boolean {
    return v === true || v === 1 || v === '1' || v === 'true';
  }
}
