import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SCREENS } from '../auth/permission.service';
import { toDateTimeString } from '../common/serialize';

const PER_PAGE = 50;

export interface AuditLogQuery {
  category?: string;
  user_id?: string;
  from?: string;
  to?: string;
  q?: string;
  page?: string;
}

/**
 * Global, cross-module audit trail (port of AuditLogController::index). Aggregates
 * module-level activity and per-transaction changes into one filterable, paginated feed.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async index(query: AuditLogQuery): Promise<Record<string, unknown>> {
    const and: Prisma.audit_logsWhereInput[] = [
      // Agent-made transaction changes live in each transaction's own trail — exclude them.
      { OR: [{ transaction_id: null }, { source: null }, { source: { not: 'Agent' } }] },
    ];

    const cat = query.category;
    if (cat) {
      if (cat === 'Transactions') and.push({ transaction_id: { not: null } });
      else and.push({ category: cat });
    }
    const uid = query.user_id;
    if (uid) and.push({ user_id: Number(uid) });

    const from = query.from;
    if (from) and.push({ created_at: { gte: this.startOfDay(from) } });
    const to = query.to;
    if (to) and.push({ created_at: { lt: this.startOfNextDay(to) } });

    const term = String(query.q ?? '').trim();
    if (term) {
      const cols: (keyof Prisma.audit_logsWhereInput)[] = ['who', 'section', 'field', 'old_value', 'new_value', 'action', 'details'];
      // MySQL LIKE is case-insensitive (ci collation) — match that in Postgres.
      and.push({ OR: cols.map((c) => ({ [c]: { contains: term, mode: 'insensitive' } })) as Prisma.audit_logsWhereInput[] });
    }

    const where: Prisma.audit_logsWhereInput = { AND: and };
    const page = Math.max(1, Number(query.page ?? 1) || 1);

    const [total, rows] = await Promise.all([
      this.prisma.audit_logs.count({ where }),
      this.prisma.audit_logs.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * PER_PAGE,
        take: PER_PAGE,
        include: { transactions: { select: { id: true, trade_no: true, deleted_at: true } } },
      }),
    ]);

    return {
      data: rows.map((a) => {
        // belongsTo excludes soft-deleted transactions (record → null, but transaction_id stays).
        const txn = a.transactions && a.transactions.deleted_at === null ? a.transactions : null;
        return {
          id: a.id,
          category: a.category || (a.transaction_id ? 'Transactions' : 'General'),
          record: txn ? 'Trade #' + txn.trade_no : null,
          transaction_id: a.transaction_id,
          who: a.who,
          section: a.section,
          field: a.field,
          action: a.action,
          source: a.source,
          old_value: a.old_value,
          new_value: a.new_value,
          details: a.details,
          stamp: toDateTimeString(a.created_at),
        };
      }),
      meta: {
        current_page: page,
        last_page: Math.max(Math.ceil(total / PER_PAGE), 1),
        total,
      },
      categories: Object.values(SCREENS),
    };
  }

  private startOfDay(d: string): Date {
    return new Date(d.slice(0, 10) + 'T00:00:00.000Z');
  }

  private startOfNextDay(d: string): Date {
    const t = this.startOfDay(d);
    return new Date(t.getTime() + 24 * 60 * 60 * 1000);
  }
}
