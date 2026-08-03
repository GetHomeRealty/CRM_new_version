import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphService, type GraphPage } from './meta-graph.service';
import { decryptToken, encryptToken } from './meta-crypto';
import { META_RECONNECT_NOTICE_MS } from './meta.constants';

export interface ConnectionWithPages {
  id: number;
  user_id: number;
  facebook_user_id: string | null;
  facebook_user_name: string | null;
  facebook_user_email: string | null;
  last_sync: Date | null;
  connected_at: Date | null;
  /** Decrypted — never send this to the browser. */
  token: string;
  pages: { page_id: string; name: string; token: string }[];
}

/**
 * Stores and reads a user's Meta connection. Tokens are encrypted going in and decrypted coming
 * out, so no caller outside this file handles ciphertext.
 */
@Injectable()
export class MetaConnectionService {
  constructor(private readonly prisma: PrismaService, private readonly graph: MetaGraphService) {}

  async find(userId: number): Promise<ConnectionWithPages | null> {
    const row = await this.prisma.meta_connections.findFirst({
      where: { user_id: userId, is_active: true },
      include: { pages: { orderBy: { id: 'asc' } } },
    });
    if (!row) return null;
    return {
      id: row.id,
      user_id: row.user_id,
      facebook_user_id: row.facebook_user_id,
      facebook_user_name: row.facebook_user_name,
      facebook_user_email: row.facebook_user_email,
      last_sync: row.last_sync,
      connected_at: row.connected_at,
      token: decryptToken(row.access_token),
      pages: row.pages.map((p) => ({ page_id: p.page_id, name: p.name, token: decryptToken(p.access_token) })),
    };
  }

  /**
   * Save (or refresh) a connection and its Pages. Pages are replaced wholesale rather than
   * merged — a Page the user no longer administers must disappear, not linger with a dead token.
   */
  async save(userId: number, token: string, profile: { id: string; name?: string; email?: string }, pages: GraphPage[]): Promise<void> {
    const now = new Date();
    const existing = await this.prisma.meta_connections.findUnique({ where: { user_id: userId }, select: { id: true, connected_at: true } });

    const connection = await this.prisma.meta_connections.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        access_token: encryptToken(token),
        facebook_user_id: profile.id,
        facebook_user_name: profile.name ?? null,
        facebook_user_email: profile.email ?? null,
        is_active: true,
        connected_at: now,
        created_at: now,
        updated_at: now,
      },
      update: {
        access_token: encryptToken(token),
        facebook_user_id: profile.id,
        facebook_user_name: profile.name ?? null,
        facebook_user_email: profile.email ?? null,
        is_active: true,
        disconnected_at: null,
        // A reconnect keeps the original connection date.
        connected_at: existing?.connected_at ?? now,
        updated_at: now,
      },
    });

    await this.prisma.meta_pages.deleteMany({ where: { connection_id: connection.id } });
    if (pages.length) {
      await this.prisma.meta_pages.createMany({
        data: pages.map((p) => ({
          connection_id: connection.id,
          page_id: p.id,
          name: p.name,
          access_token: encryptToken(p.access_token),
          created_at: now,
          updated_at: now,
        })),
      });
    }
  }

  /**
   * Disconnect. The row is deactivated rather than deleted so the audit trail keeps a record,
   * but the tokens are wiped immediately — a disconnected integration must not keep a working
   * credential on disk.
   *
   * THE FORMS HAVE TO BE RELEASED TOO, and this is the part that was missing. `meta_lead_forms`
   * does not hang off `meta_pages` by a foreign key — `page_id` is a plain column — so deleting the
   * pages leaves every form row still `is_active`, still holding its claim under
   * `meta_lead_forms_page_form_key`. The account looked disconnected on screen while the forms
   * stayed locked to it.
   *
   * What that cost: a form is claimed by one agent, and the claim is released by deactivation —
   * that is the whole reason the unique index is partial (`WHERE is_active`). With the claim never
   * released, an agent who left took their forms with them permanently. Their successor connecting
   * the same form was refused, naming a colleague who no longer works here, and the only remedies
   * were a database edit or building a new form in Meta and losing the ad attached to it.
   *
   * Deactivating rather than deleting, for the same reason as the connection row: `syncUser` and
   * the scheduler both filter on `is_active`, so this stops the polling, and if the same agent
   * reconnects later the upsert in `meta.controller.ts` flips their own rows back on and their
   * sync history survives.
   */
  async disconnect(userId: number): Promise<{ disconnected: boolean }> {
    const row = await this.prisma.meta_connections.findUnique({ where: { user_id: userId }, select: { id: true } });
    if (!row) return { disconnected: false };
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.meta_pages.deleteMany({ where: { connection_id: row.id } }),
      this.prisma.meta_lead_forms.updateMany({
        where: { user_id: userId, is_active: true },
        data: { is_active: false, updated_at: now },
      }),
      this.prisma.meta_connections.update({
        where: { id: row.id },
        data: { is_active: false, disconnected_at: now, access_token: '', updated_at: now },
      }),
    ]);
    return { disconnected: true };
  }

  /**
   * Record that the stored token is no longer usable. Returns whether the agent is due an email.
   *
   * `token_expires_at` is set to now rather than a new "dead" flag being invented: that is exactly
   * what Meta has just told us, and `status()` already derives `needs_reconnect` from it, so the
   * screen becomes correct without another field to keep in step. The case that made this necessary
   * is a REVOKED token — somebody removes the app from their Facebook account — where the stored
   * expiry is still weeks away and so nothing looked wrong while nothing worked.
   *
   * The connection stays `is_active`. It is not disconnected: the forms remain claimed by this
   * agent, and reconnecting restores service without anybody re-choosing pages and forms. Deleting
   * their setup because a token aged out would be a far worse answer than pausing.
   */
  async markTokenDead(userId: number): Promise<boolean> {
    const row = await this.prisma.meta_connections.findUnique({
      where: { user_id: userId },
      select: { id: true, reconnect_notified_at: true },
    });
    if (!row) return false;

    const now = new Date();
    const last = row.reconnect_notified_at?.getTime() ?? 0;
    const due = now.getTime() - last >= META_RECONNECT_NOTICE_MS;

    /*
     * Stamped a couple of seconds in the PAST, not at `now`.
     *
     * `token_expires_at` is `Timestamp(0)`, which ROUNDS to the nearest second rather than
     * truncating — so writing 12:00:00.700 stores 12:00:01, a moment in the future. Everything that
     * asks "has this expired?" with `> now` then answered no, and the scheduler went on polling the
     * very token this call exists to retire. Two seconds is comfortably past the ±0.5 s rounding
     * and still an honest statement: Meta rejected it, so it was already dead when we asked.
     */
    const deadAt = new Date(now.getTime() - 2000);

    await this.prisma.meta_connections.update({
      where: { id: row.id },
      data: {
        token_expires_at: deadAt,
        updated_at: now,
        ...(due ? { reconnect_notified_at: now } : {}),
      },
    });
    return due;
  }

  async touchSync(userId: number): Promise<void> {
    await this.prisma.meta_connections.updateMany({
      where: { user_id: userId },
      data: { last_sync: new Date(), updated_at: new Date() },
    });
  }

  async touchWebhook(userId: number): Promise<void> {
    await this.prisma.meta_connections.updateMany({
      where: { user_id: userId },
      data: { last_webhook_at: new Date(), updated_at: new Date() },
    });
  }

  /** Remember the last Graph failure so the UI can explain a silent stall. */
  async recordError(userId: number, message: string): Promise<void> {
    await this.prisma.meta_connections.updateMany({
      where: { user_id: userId },
      data: { last_error: message.slice(0, 2000), last_error_at: new Date(), updated_at: new Date() },
    });
  }

  async clearError(userId: number): Promise<void> {
    await this.prisma.meta_connections.updateMany({
      where: { user_id: userId },
      data: { last_error: null, last_error_at: null, updated_at: new Date() },
    });
  }

  /** Store the token lifetime and the permissions Meta actually granted. */
  async recordTokenState(userId: number, expiresAt: Date | null, scopes: string[]): Promise<void> {
    await this.prisma.meta_connections.updateMany({
      where: { user_id: userId },
      data: { token_expires_at: expiresAt, granted_scopes: scopes.join(','), updated_at: new Date() },
    });
  }

  async setAdAccount(userId: number, id: string | null, name: string | null): Promise<void> {
    await this.prisma.meta_connections.updateMany({
      where: { user_id: userId },
      data: { ad_account_id: id, ad_account_name: name, updated_at: new Date() },
    });
  }

  /** Raw row, for the fields `find()` deliberately omits (token state, errors). */
  async meta(userId: number): Promise<{
    token_expires_at: Date | null; granted_scopes: string | null;
    ad_account_id: string | null; ad_account_name: string | null;
    last_error: string | null; last_error_at: Date | null; last_webhook_at: Date | null;
  } | null> {
    return this.prisma.meta_connections.findFirst({
      where: { user_id: userId, is_active: true },
      select: {
        token_expires_at: true, granted_scopes: true, ad_account_id: true, ad_account_name: true,
        last_error: true, last_error_at: true, last_webhook_at: true,
      },
    });
  }

  /** Refresh the Page list from Meta using the stored user token. */
  async refreshPages(userId: number): Promise<number> {
    const conn = await this.find(userId);
    if (!conn?.token) return 0;
    const pages = await this.graph.pages(conn.token);
    await this.save(userId, conn.token, {
      id: conn.facebook_user_id ?? '',
      name: conn.facebook_user_name ?? undefined,
      email: conn.facebook_user_email ?? undefined,
    }, pages);
    return pages.length;
  }

  /** Locate a connection by the Facebook user id — used by the data-deletion callback. */
  async findByFacebookUserId(facebookUserId: string): Promise<{ user_id: number } | null> {
    return this.prisma.meta_connections.findFirst({
      where: { facebook_user_id: facebookUserId, is_active: true },
      select: { user_id: true },
    });
  }

  /** Every active connection, for the scheduled sync across all users. */
  async allActive(): Promise<number[]> {
    const rows = await this.prisma.meta_connections.findMany({ where: { is_active: true }, select: { user_id: true } });
    return rows.map((r) => r.user_id);
  }
}
