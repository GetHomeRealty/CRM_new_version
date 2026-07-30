import { parseArea, screenLabelsForArea, type Area } from '../common/domain';
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
  /** Which area's trail this is. */
  area?: string;
  /** How wide to read within it — see `SCOPES`. */
  scope?: string;
}

/**
 * How much of an area's trail to show.
 *
 *   area   — this area's own records only, the strictest reading of section 12
 *   shared — only the records belonging to neither area (Users, Company Settings, Inventory)
 *   all    — everything, for someone reconciling the two
 *
 * The default is `area` PLUS shared, because the alternative loses records. Users and Company
 * Settings are common modules by section 3; if their entries appeared in neither trail, 17 of the
 * existing 108 rows in this database would become unreachable from the UI, which contradicts
 * section 12's own requirement to preserve historical audit data. A CRM record still never appears
 * in the Transaction trail, which is what the separation is for.
 */
export const AUDIT_SCOPES = ['default', 'area', 'shared', 'all'] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];
const isScope = (v: unknown): v is AuditScope => AUDIT_SCOPES.includes(String(v) as AuditScope);

/**
 * Global, cross-module audit trail (port of AuditLogController::index). Aggregates
 * module-level activity and per-transaction changes into one filterable, paginated feed.
 *
 * Split by area: the CRM trail shows CRM activity and the Transaction Desk trail shows transaction
 * activity, decided by the `domain` column that the 20260729140000 migration backfilled from a
 * deterministic mapping. Filters, search, pagination and the category list all operate inside the
 * chosen area rather than across both.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /** The `domain` restriction for one area at one scope. */
  private domainWhere(area: Area, scope: AuditScope): Prisma.audit_logsWhereInput[] {
    if (scope === 'all') return [];
    if (scope === 'area') return [{ domain: area }];
    if (scope === 'shared') return [{ domain: 'common' }];
    // Default: this area, the shared records, and anything a future write leaves unclassified.
    return [{ OR: [{ domain: area }, { domain: 'common' }, { domain: null }] }];
  }

  async index(query: AuditLogQuery): Promise<Record<string, unknown>> {
    const area = parseArea(query.area);
    const scope: AuditScope = isScope(query.scope) ? query.scope : 'default';

    const and: Prisma.audit_logsWhereInput[] = [
      // Agent-made transaction changes live in each transaction's own trail — exclude them.
      { OR: [{ transaction_id: null }, { source: null }, { source: { not: 'Agent' } }] },
      ...this.domainWhere(area, scope),
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
      // The category list is the area's own modules plus the shared ones — the CRM's trail does not
      // offer "Transactions" to filter by, and the Desk's does not offer "Lead".
      categories: screenLabelsForArea(SCREENS, area),
      area,
      scope,
      scopes: [...AUDIT_SCOPES],
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
