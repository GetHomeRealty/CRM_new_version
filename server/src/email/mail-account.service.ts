import { assertCanConnectEmail } from './agent-email-limit';
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
   * email could go out from the CRM mailbox.
   *
   * THE BROKERAGE'S OWN ACCOUNTS COME FIRST. The first two lookups did not filter `user_id`, so
   * "the account this area uses" could resolve to a COLLEAGUE'S personal mailbox — and in the QA
   * fixture, where the only connected account belongs to an agent, that is exactly what happened:
   * a brokerage-wide broadcast would have gone out from that agent's address. A shared send should
   * come from the shared address; a personal one is the fallback, not the first answer. Callers
   * wanting "this person's mailbox" ask `senderFor`, which is what that method is for.
   */
  async defaultSender(scope: IntegrationScope): Promise<mail_accounts | null> {
    const inScope = { is_active: true, scope };
    return (
      // The area's shared account, then any shared account…
      (await this.prisma.mail_accounts.findFirst({ where: { ...inScope, user_id: null, is_default: true } }))
      ?? (await this.prisma.mail_accounts.findFirst({ where: { ...inScope, user_id: null }, orderBy: { id: 'asc' } }))
      ?? (await this.prisma.mail_accounts.findFirst({ where: { is_active: true, user_id: null, is_default: true } }))
      ?? (await this.prisma.mail_accounts.findFirst({ where: { is_active: true, user_id: null }, orderBy: { id: 'asc' } }))
      // …and only then somebody's personal account in this area, because having no sender at all is
      // worse than an unexpected one and a brokerage that has connected nothing else has said, by
      // omission, that this is the address it sends from.
      ?? (await this.prisma.mail_accounts.findFirst({ where: { ...inScope, is_default: true } }))
      ?? (await this.prisma.mail_accounts.findFirst({ where: inScope, orderBy: { id: 'asc' } }))
    );
  }

  /**
   * The account a NAMED PERSON's mail should leave from, within one area.
   *
   * `defaultSender` answers "which mailbox does this area use", which is right for a brokerage-wide
   * announcement and wrong for a message one person is writing to one lead: it does not filter on
   * `user_id`, so it can return a colleague's connected account. `MailerService.resolveSender`
   * answers "which mailbox does this person use" and has the opposite gap — it never looks at
   * `scope`, so a CRM email could leave from a Transaction Desk mailbox, which is the exact
   * cross-wiring the `scope` column was added to prevent.
   *
   * This asks both questions at once: your own account in this area, then the area's shared one.
   * Added because `CrmAdvancedEmailService` was calling `sendDirect` with neither an account nor a
   * user and taking whichever active account the database yielded first — see the 2026-08-04 audit,
   * finding L10.
   */
  async senderFor(userId: number | null, scope: IntegrationScope): Promise<mail_accounts | null> {
    if (userId) {
      const own = (await this.prisma.mail_accounts.findFirst({
        where: { user_id: userId, scope, is_active: true, is_default: true },
      }))
        ?? (await this.prisma.mail_accounts.findFirst({
          where: { user_id: userId, scope, is_active: true }, orderBy: { id: 'asc' },
        }));
      if (own) return own;
    }
    return this.defaultSender(scope);
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
    // Ordered by area, then name — deliberately NOT by which one is the default.
    //
    // Sorting defaults to the top meant the list re-ordered itself the instant you chose one: the
    // row you had just clicked jumped up, another slid into the space it left, and that row's
    // button still read "Set default". The press looked like it had done nothing, when what had
    // actually happened was that the answer moved out from under the cursor. A user's accounts are
    // a handful of rows; keeping them still is worth far more than floating the default to the top.
    const areaRank = (s: string | null) => (s === 'crm' ? 0 : s === 'desk' ? 1 : 2);
    rows.sort((a, b) =>
      areaRank(a.scope) - areaRank(b.scope)
      || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      || a.id - b.id);
    return rows.map((a) => this.resource(a));
  }

  async storeForUser(userId: number, body: Record<string, unknown>, scope?: IntegrationScope): Promise<Record<string, unknown>> {
    // An agent may hold one account per area. Enforced here, on the server, because hiding the
    // Add button only stops the people who use the button.
    if (scope) await assertCanConnectEmail(this.prisma, userId, scope);

    const data = this.validate(body, false);
    if ((data.password ?? '') === '') delete data.password;
    else data.password = this.crypt.encryptString(String(data.password));

    const now = new Date();
    const account = await this.prisma.mail_accounts.create({
      // A new account belongs to the area it was added from — that is the whole point of
      // the split, so it is stamped at creation rather than left to be assigned later.
      data: { ...(data as Prisma.mail_accountsCreateInput), user_id: userId, scope: scope ?? null, created_at: now, updated_at: now },
    });
    // The first account IN THIS AREA becomes that area's primary, so each side always has a
    // sender. Counting the user's accounts across both areas left the second area without a
    // primary: the count was already 2, so nothing was promoted and sending there fell back to
    // the brokerage address.
    const count = await this.prisma.mail_accounts.count({ where: { user_id: userId, scope: account.scope } });
    if (account.is_default || count === 1) {
      await this.prisma.mail_accounts.update({ where: { id: account.id }, data: { is_default: true } });
      await this.makeSoleDefault(account.id, userId, account.scope);
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
    if (fresh.is_default) await this.makeSoleDefault(id, userId, fresh.scope);
    // An account switched off must not stay the primary: it would be chosen as the sender and
    // every send through it would fail. Hand the role to another working account in the same area.
    if (fresh.is_default && !fresh.is_active) await this.reassignPrimary(userId, fresh.scope, fresh.id);
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
    const account = await this.ownOrThrow(userId, id);
    await this.prisma.mail_accounts.delete({ where: { id } });
    // Disconnecting the primary must not leave the area without one — that is the defined
    // fallback: the oldest remaining active account in the same area takes over. Deleting a
    // non-primary account changes nothing.
    if (account.is_default) await this.reassignPrimary(userId, account.scope, id);
    return { message: 'Mail account deleted' };
  }

  async setDefaultForUser(userId: number, id: number): Promise<Record<string, unknown>> {
    const account = await this.ownOrThrow(userId, id);
    // The primary account is the one whose mail the Inbox shows, so its inbound sync is switched on
    // with it — an inbox pointed at an account nobody is polling would simply stop filling up. Only
    // when the account has an IMAP host: there is nothing to poll otherwise, and setting the flag
    // would make the Integrations screen claim a sync that cannot happen.
    const enableInbound = !!account.imap_host && !account.inbound_enabled;
    await this.prisma.mail_accounts.update({
      where: { id },
      data: { is_default: true, is_active: true, ...(enableInbound ? { inbound_enabled: true } : {}), updated_at: new Date() },
    });
    // Scoped to the account's own area, so choosing a Transaction Desk primary leaves the CRM's
    // alone. Unscoped, this cleared every other account the user had and the other area was left
    // with no primary at all.
    await this.makeSoleDefault(id, userId, account.scope);
    return this.resource((await this.find(id))!);
  }

  /**
   * Give one area a primary again after the current one went away.
   *
   * The oldest remaining active account wins — a stable, explicable rule rather than "whichever
   * the database returned first". If nothing active remains, the area is simply left without a
   * primary; sending then falls back to the brokerage account as it always did, which is better
   * than promoting an account that is switched off.
   */
  private async reassignPrimary(userId: number, scope: string | null, excludeId: number): Promise<void> {
    const already = await this.prisma.mail_accounts.findFirst({
      where: { user_id: userId, scope, is_default: true, id: { not: excludeId } },
      select: { id: true },
    });
    if (already) return;
    const next = await this.prisma.mail_accounts.findFirst({
      where: { user_id: userId, scope, is_active: true, id: { not: excludeId } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!next) return;
    await this.prisma.mail_accounts.update({ where: { id: next.id }, data: { is_default: true, updated_at: new Date() } });
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
    if (account.is_default) await this.makeSoleDefault(account.id, null, account.scope);
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
    if (fresh.is_default) await this.makeSoleDefault(id, null, fresh.scope);
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
    // `existing.user_id`, not a hardcoded null.
    //
    // `makeSoleDefault` filters on the owner, so passing null only ever cleared the brokerage's own
    // accounts. Point this endpoint at an account belonging to a USER and the previous default was
    // left standing: the area ended up with two primaries at once, and every screen that resolves
    // the primary with `find(a => a.is_default)` kept naming the old one — so pressing the button
    // appeared to do nothing at all. Brokerage accounts still carry user_id null, so the admin
    // Email Settings screen behaves exactly as before.
    await this.makeSoleDefault(id, existing.user_id, existing.scope);
    return this.resource((await this.find(id))!);
  }

  async find(id: number): Promise<mail_accounts | null> {
    return this.prisma.mail_accounts.findUnique({ where: { id } });
  }

  /**
   * Ensure exactly one row carries is_default = true within one owner AND one area.
   *
   * Both halves matter. The owner keeps a user's choice from disturbing the brokerage fallback
   * (user_id = null). The area is what makes "primary" mean what section 6 asks: the CRM and the
   * Transaction Desk each have their own primary, and picking one on either side must leave the
   * other untouched. Without the area in this filter, setting a Transaction Desk primary cleared
   * the CRM's — and since the *read* is scoped, the CRM was then left with none and quietly fell
   * back to the brokerage address.
   *
   * `scope` is passed as-is, including null: accounts that pre-date the split form their own group
   * and are not disturbed by a choice made inside an area.
   */
  private async makeSoleDefault(id: number, userId: number | null = null, scope: string | null = null): Promise<void> {
    await this.prisma.mail_accounts.updateMany({
      where: { id: { not: id }, is_default: true, user_id: userId, scope },
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
