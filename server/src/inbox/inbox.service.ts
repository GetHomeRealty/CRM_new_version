import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reads a user's synced inbound mail. Every method is scoped to `userId`, so an inbox query can
 * only ever return that user's own messages — never another person's mailbox.
 */
@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  /** The message list, newest first, without the heavy bodies. */
  async list(userId: number, opts: { unread?: boolean; leadId?: number; page?: number } = {}): Promise<Record<string, unknown>> {
    const perPage = 30;
    const page = Math.max(1, opts.page ?? 1);
    const where = {
      user_id: userId,
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
      this.prisma.inbound_emails.count({ where: { user_id: userId, seen: false } }),
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
    };
  }

  /** One message with its full body. Reading it marks it seen. */
  async get(userId: number, id: number): Promise<Record<string, unknown>> {
    const row = await this.prisma.inbound_emails.findFirst({ where: { id, user_id: userId } });
    if (!row) throw new NotFoundException({ message: 'Message not found.' });
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

  async markSeen(userId: number, id: number, seen: boolean): Promise<{ seen: boolean }> {
    const row = await this.prisma.inbound_emails.findFirst({ where: { id, user_id: userId }, select: { id: true } });
    if (!row) throw new NotFoundException({ message: 'Message not found.' });
    await this.prisma.inbound_emails.update({ where: { id }, data: { seen } });
    return { seen };
  }
}
