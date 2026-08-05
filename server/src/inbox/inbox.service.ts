import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AREA_LABEL, type Area } from '../common/domain';

/**
 * Reads a user's synced inbound mail. Every method is scoped to `userId`, so an inbox query can
 * only ever return that user's own messages — never another person's mailbox.
 *
 * Every method is ALSO scoped to one account: the **primary** account of the area being read. An area
 * can hold several connected addresses, and the one marked primary in Integrations is the mailbox the
 * inbox shows. That keeps the two areas apart as well, because a primary is chosen per area — the CRM
 * reads the account made primary under CRM Settings and the Transaction Desk the one made primary
 * under Transaction Desk Settings.
 *
 * When an area has no primary yet it falls back to every account that area can see, so the inbox is
 * never empty just because nobody has chosen one.
 *
 * The scoping is applied on the server for every read, not just the list: `get` and `markSeen` take a
 * message id, and without the same filter one area could read or alter another's message simply by
 * asking for its id.
 */
/**
 * The furthest page anybody may ask for. See `list`.
 *
 * A deep offset is not free: Postgres still walks and discards every row before it, so `?page=999999`
 * is a full scan dressed as a page request.
 */
const MAX_PAGE = 20_000;

@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The account whose mail this area's inbox shows: the one marked primary in Integrations.
   *
   * The area's own primary first, an unassigned-scope primary only as a fallback — an account that
   * pre-dates the split must not outrank a deliberate choice made inside the area. Null when the area
   * has no primary at all.
   */
  private async primaryAccount(userId: number, area: Area) {
    const pick = { id: true, from_email: true, inbound_enabled: true, imap_host: true };
    return (await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, is_default: true, scope: area }, select: pick }))
      ?? (await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, is_default: true, scope: null }, select: pick }));
  }

  /**
   * The message filter for one area.
   *
   * One account's mail, not every connected address: pouring them all into one list makes the inbox a
   * place to search rather than a place to work, and marking one primary is how you say which mailbox
   * you are reading. Switching the primary switches the inbox immediately — the other accounts keep
   * syncing in the background, so their history is already there when you switch back.
   *
   * With no primary the area falls back to everything it can see, so the inbox is never empty merely
   * because nobody has chosen one. NOTE the relation is `mail_account`, singular — the field name, not
   * the model name; and `null` cannot go inside an `in` list in Prisma, so "this area, or not yet
   * assigned" has to be spelled as a union.
   *
   * Takes the already-resolved primary so a single request does not look it up twice.
   */
  private scopeFor(primary: { id: number } | null, area: Area): Prisma.inbound_emailsWhereInput {
    return primary ? { account_id: primary.id } : { mail_account: { is: { OR: [{ scope: area }, { scope: null }] } } };
  }

  /** The message list, newest first, without the heavy bodies. */
  async list(userId: number, area: Area, opts: { unread?: boolean; leadId?: number; page?: number } = {}): Promise<Record<string, unknown>> {
    const perPage = 30;
    /*
     * THE PAGE NUMBER IS A PAGE NUMBER.
     *
     * `Math.max(1, opts.page ?? 1)` let three shapes through, all measured 2026-08-05:
     *
     *   ?page=Infinity, ?page=1e20, ?page=1e999   → `skip: Infinity` reached Prisma → bare 500
     *   ?page=2.7                                 → accepted, reported back as `page: 2.7`, and
     *                                               `(2.7 - 1) * 30` is a fractional OFFSET
     *   ?page=999999                              → accepted, `skip: 29,999,940`
     *
     * `Math.floor` before the clamp handles the fraction; `Math.min` handles the infinities, which
     * `|| 1` does not because `Infinity` is truthy. The ceiling is a backstop against a stale
     * bookmark or a client loop, not a page size — `last_page` in the reply is what a client should
     * follow, and 20,000 pages is 600,000 messages.
     */
    const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(opts.page ?? 1)) || 1));
    // Typed as Prisma.inbound_emailsWhereInput on purpose: built as a bare object literal in
    // a variable, a wrong key slips past excess-property checking and only fails at runtime,
    // which is exactly how this filter shipped broken once.
    const primary = await this.primaryAccount(userId, area);
    const scoped: Prisma.inbound_emailsWhereInput = { user_id: userId, ...this.scopeFor(primary, area) };
    const where: Prisma.inbound_emailsWhereInput = {
      ...scoped,
      ...(opts.unread ? { seen: false } : {}),
      ...(opts.leadId ? { lead_id: opts.leadId } : {}),
    };
    const [rows, total, unread] = await Promise.all([
      this.prisma.inbound_emails.findMany({
        where, orderBy: { received_at: 'desc' }, skip: (page - 1) * perPage, take: perPage,
        select: {
          id: true, from_email: true, from_name: true, subject: true, snippet: true,
          received_at: true, seen: true, lead_id: true,
        },
      }),
      this.prisma.inbound_emails.count({ where }),
      // The unread badge counts this area's unread mail only. It used to count every unread
      // message the user had, so the CRM's badge included Transaction Desk mail the list would
      // never show — a number that could not be cleared by reading anything on screen.
      this.prisma.inbound_emails.count({ where: { ...scoped, seen: false } }),
    ]);
    // Attach the matched lead's name so the list can link to it.
    const leadIds = [...new Set(rows.map((r) => r.lead_id).filter((v): v is number => v != null))];
    const leads = leadIds.length
      ? await this.prisma.leads.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } })
      : [];
    const leadName = new Map(leads.map((l) => [l.id, l.name]));
    return {
      data: rows.map((r) => ({
        id: r.id, from_email: r.from_email, from_name: r.from_name, subject: r.subject,
        snippet: r.snippet, received_at: r.received_at.toISOString(), seen: r.seen,
        lead_id: r.lead_id, lead_name: r.lead_id ? leadName.get(r.lead_id) ?? null : null,
      })),
      meta: { page, per_page: perPage, total, last_page: Math.max(1, Math.ceil(total / perPage)) },
      unread,
      /**
       * Which mailbox this is. The screen names it, because the list is one account's mail rather
       * than everything connected — without saying so, a shorter list than yesterday reads as lost
       * mail instead of a narrower view.
       *
       * `auto_sync` is false only when the primary has no IMAP host to poll; setting an account
       * primary switches its inbound sync on.
       */
      mailbox: primary
        ? { address: primary.from_email, is_primary: true, auto_sync: primary.inbound_enabled && !!primary.imap_host }
        : null,
    };
  }

  /**
   * Explain a message that could not be found, then throw.
   *
   * The bare "Message not found." was actively misleading. `area` defaults to the Transaction Desk
   * when the query string omits it, so a caller who listed the CRM inbox and then wrote to a
   * message id without repeating `?area=crm` was told the message did not exist — about a message
   * the API had handed them moments earlier. It reads as data loss and sends people looking in the
   * wrong place entirely.
   *
   * Checking the user's OTHER areas leaks nothing: the lookup is still bounded by `user_id`, so it
   * can only ever describe a message that already belongs to the caller. If it genuinely is not
   * theirs, the message is unchanged.
   */
  private async missingError(userId: number, area: Area, id: number): Promise<NotFoundException> {
    const elsewhere = await this.prisma.inbound_emails.findFirst({
      where: { id, user_id: userId },
      select: { mail_account: { select: { scope: true } } },
    });
    const other = elsewhere?.mail_account?.scope;
    if (other && other !== area) {
      return new NotFoundException({
        message: `That message is in your ${AREA_LABEL[other === 'crm' ? 'crm' : 'desk']} inbox, `
          + `not ${AREA_LABEL[area]}. Add ?area=${other} to reach it.`,
      });
    }
    return new NotFoundException({ message: 'Message not found.' });
  }

  /** One message with its full body. Reading it marks it seen. */
  async get(userId: number, area: Area, id: number): Promise<Record<string, unknown>> {
    // Area-scoped as well as user-scoped: asking the Transaction Desk for a CRM message's id
    // must not return it.
    const row = await this.prisma.inbound_emails.findFirst({
      where: { id, user_id: userId, ...this.scopeFor(await this.primaryAccount(userId, area), area) },
    });
    if (!row) throw await this.missingError(userId, area, id);
    if (!row.seen) await this.prisma.inbound_emails.update({ where: { id }, data: { seen: true } });
    const lead = row.lead_id
      ? await this.prisma.leads.findUnique({ where: { id: row.lead_id }, select: { id: true, name: true } })
      : null;
    return {
      id: row.id, from_email: row.from_email, from_name: row.from_name, to_email: row.to_email,
      subject: row.subject, body_text: row.body_text, body_html: row.body_html,
      received_at: row.received_at.toISOString(), seen: true,
      lead_id: row.lead_id, lead_name: lead?.name ?? null,
    };
  }

  async markSeen(userId: number, area: Area, id: number, seen: boolean): Promise<{ seen: boolean }> {
    const row = await this.prisma.inbound_emails.findFirst({
      where: { id, user_id: userId, ...this.scopeFor(await this.primaryAccount(userId, area), area) },
      select: { id: true },
    });
    if (!row) throw await this.missingError(userId, area, id);
    await this.prisma.inbound_emails.update({ where: { id }, data: { seen } });
    return { seen };
  }
}
