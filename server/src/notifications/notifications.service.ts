import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toDateTimeString } from '../common/serialize';
import type { ResourceUser } from '../transactions/transaction.resource';


import { isAdminOrAbove, isAgent } from '../core/authz';
interface Feed {
  count: number;
  items: Record<string, unknown>[];
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Admin bell: transactions with pending/handled agent changes, newest first. */
  async agentChangeNotifications(user: ResourceUser | null): Promise<Feed> {
    if (!isAdminOrAbove(user)) return { count: 0, items: [] };

    const txns = await this.prisma.transactions.findMany({
      where: { deleted_at: null, audit_logs: { some: { source: 'Agent' } } },
      orderBy: { id: 'asc' },
      include: { audit_logs: { where: { source: 'Agent' }, orderBy: [{ created_at: 'desc' }, { id: 'asc' }] } },
    });

    const items: (Record<string, unknown> & { _sort: number })[] = [];
    for (const t of txns) {
      const changes = t.audit_logs.filter(
        (a) => !(a.field ?? '').toLowerCase().includes('team member') && !(a.field ?? '').toLowerCase().includes('lawyer'),
      );
      if (changes.length === 0) continue;
      const latest = changes[0];
      items.push({
        id: t.id,
        trade_no: t.trade_no,
        property: t.property,
        agent: t.agent,
        count: changes.length,
        unread: changes.some((c) => !c.handled),
        at: toDateTimeString(latest.created_at),
        _sort: latest.created_at ? Math.floor(latest.created_at.getTime() / 1000) : 0,
      });
    }
    return this.finalize(items);
  }

  /** Agent bell: transactions where an admin reviewed the agent's documents. */
  async docNotifications(user: ResourceUser | null): Promise<Feed> {
    if (!user || user.role !== 'agent') return { count: 0, items: [] };
    const name = user.name;

    const txns = await this.prisma.transactions.findMany({
      where: {
        deleted_at: null,
        OR: [{ agent: name }, { team_members: { some: { name } } }],
        audit_logs: { some: { source: 'DocReview' } },
      },
      orderBy: { id: 'asc' },
      include: { audit_logs: { where: { source: 'DocReview' }, orderBy: [{ created_at: 'desc' }, { id: 'asc' }] } },
    });

    const items: (Record<string, unknown> & { _sort: number })[] = [];
    for (const t of txns) {
      const logs = t.audit_logs;
      if (logs.length === 0) continue;
      const latest = logs[0];
      items.push({
        id: t.id,
        trade_no: t.trade_no,
        property: t.property,
        summary: latest.details,
        unread: logs.some((l) => !l.handled),
        at: toDateTimeString(latest.created_at),
        _sort: latest.created_at ? Math.floor(latest.created_at.getTime() / 1000) : 0,
      });
    }
    return this.finalize(items);
  }

  /** Agent clears the document-review notifications for one transaction. */
  async markDocNotificationsSeen(user: ResourceUser | null, txnId: number): Promise<{ ok: boolean }> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });
    if (user && isAgent(user)) {
      const allowed =
        t.agent === user.name ||
        (await this.prisma.team_members.findFirst({ where: { transaction_id: txnId, name: user.name } })) !== null;
      if (!allowed) throw new ForbiddenException({ message: 'You do not have access to this transaction.' });
    }
    await this.prisma.audit_logs.updateMany({
      where: { transaction_id: txnId, source: 'DocReview', handled: false },
      data: { handled: true, updated_at: new Date() },
    });
    return { ok: true };
  }

  private finalize(items: (Record<string, unknown> & { _sort: number })[]): Feed {
    items.sort((a, b) => b._sort - a._sort);
    const sliced = items.slice(0, 40);
    const badge = sliced.filter((i) => i.unread).length;
    return { count: badge, items: sliced.map(({ _sort, ...rest }) => rest) };
  }
}
