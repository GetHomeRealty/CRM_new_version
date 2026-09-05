import { parseArea, screenLabelsForArea, type Area } from '../common/domain';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SCREENS } from '../auth/permission.service';
import { toDateTimeString } from '../common/serialize';

const PER_PAGE = 50;

/*
 * TD-012 - the page size is a request, not a constant.
 *
 * PER_PAGE was a module constant and `AuditLogQuery` declared no page-size field at all, so a
 * per_page in the query string had nowhere to land: every spelling tried - per_page, perPage,
 * limit, page_size, pageSize, size, take, rows, count - returned exactly 50 rows, at 3 and at 100
 * alike. The parameter was not being ignored; there was nothing to ignore it with.
 *
 * Clamped for the same reason MAX_PAGE is: `Number(query.page)` reaching `skip` unchecked already
 * turned ?page=1e20 into a bare 500, and a raw take is the same mistake one column over. 200 is
 * four screens of trail, past anything a person reads at once and well short of a payload. The
 * default stays 50 so every existing caller sees exactly what it saw before.
 */
const MAX_PER_PAGE = 200;

/**
 * The furthest page anybody may ask for. `Number(query.page)` went straight into `skip`, so
 * `?page=Infinity` and `?page=1e20` both reached Prisma and came back as a bare 500 — measured
 * 2026-08-05 against 127 rows.
 *
 * 20,000 pages is a million records at 50 a page, which is past the end of any real trail; the point
 * is that the ceiling is a number rather than whatever the query string happened to contain.
 */
const MAX_PAGE = 20_000;

/** A search term long enough to be a payload rather than a search. 100,000 characters was accepted. */
const MAX_TERM = 200;

/**
 * Escape the wildcards Prisma's `contains` passes through to SQL `LIKE`.
 *
 * `?q=%` returned all 127 rows and `?q=_` did the same — neither is a search for a percent sign or
 * an underscore, they are `LIKE '%%%'` and `LIKE '%_%'`. Nobody escalates anything with this: the
 * caller already holds `audit: view` and reads the whole trail anyway. It is wrong in the ordinary
 * way — somebody searching for "50%" or "old_value" gets an answer that does not mean what it says.
 *
 * Prisma parameterises the value, so the backslash is a LIKE escape and not a SQL one; Postgres uses
 * backslash as the default LIKE escape character, which is why no explicit ESCAPE clause is needed.
 */
const escapeLike = (term: string): string => term.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface AuditLogQuery {
  category?: string;
  user_id?: string;
  /** TD-087 - narrow the trail to ONE deal. Declared here or the parameter never reaches buildWhere. */
  transaction_id?: string;
  from?: string;
  to?: string;
  q?: string;
  page?: string;
  /** TD-012 - rows per page. Absent means the 50 this endpoint always returned. */
  per_page?: string;
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

  /**
   * The `where` for one filtered view of the trail — the ONLY place these rules are written.
   *
   * Extracted from `index` unchanged so that the listing and the export ask the same question. The
   * brief for the export is explicit that the two must not be able to disagree, and the way to
   * guarantee that is structural: one builder, two callers. A second copy would drift the first time
   * a filter is added to one and not the other, and the symptom would be an export that quietly does
   * not match the screen it was taken from.
   */
  buildWhere(query: AuditLogQuery): { where: Prisma.audit_logsWhereInput; area: Area; scope: AuditScope } {
    const area = parseArea(query.area);
    const scope: AuditScope = isScope(query.scope) ? query.scope : 'default';

    const and: Prisma.audit_logsWhereInput[] = [
      /*
       * TD-067 - an agent's changes belong in the trail.
       *
       * This dropped every row with a transaction_id whose source was 'Agent', because those
       * changes also live in each transaction's own trail. They do, and the review queue still
       * owns approving them - but the Audit Trail is the screen a brokerage prints to show who
       * changed what, and it silently omitted a whole class of change with nothing on the page
       * to say so. buildWhere feeds the export too, so a workbook taken as evidence was missing
       * the same rows.
       *
       * They are included and labelled instead: each row already carries `source`, and `handled`
       * is now returned so the screen can say whether an agent's change is awaiting review.
       */
      ...this.domainWhere(area, scope),
    ];

    const cat = query.category;
    if (cat) {
      if (cat === 'Transactions') and.push({ transaction_id: { not: null } });
      else and.push({ category: cat });
    }
    /*
     * A FILTER THAT CANNOT BE HONOURED IS REFUSED, NOT QUIETLY DROPPED.
     *
     * `Number('abc')` is NaN, which Prisma renders as `user_id: null` — so `?user_id=abc` returned
     * the ONE row with no user attached, under a heading saying it was that user's activity.
     * Measured 2026-08-05: `total=1` against a baseline of 127, no error anywhere. `?user_id=1e999`
     * is Infinity and did the same. A trail that answers a nonsense question with somebody else's
     * rows is worse than one that answers nothing, because this is the screen people use to work out
     * who did something.
     */
    const uid = query.user_id;
    if (uid) {
      const n = Number(uid);
      if (!Number.isSafeInteger(n)) {
        throw new BadRequestException({ message: `"${uid}" is not a user id.`, errors: { user_id: ['Must be a whole number.'] } });
      }
      and.push({ user_id: n });
    }

    /*
     * `new Date('garbage')` is an Invalid Date, which Prisma refuses — so `?from=garbage` and
     * `?to=2026-99-99` were both bare 500s. Refused with the field named, like every other filter.
     */
    /*
     * TD-087 - the deal filter reached the API and was never put into the query, so asking for one
     * deal's history returned every deal's. Same treatment as user_id above: a value that cannot be
     * honoured is refused with the field named, not quietly dropped.
     */
    const tid = query.transaction_id;
    if (tid) {
      const n = Number(tid);
      if (!Number.isSafeInteger(n)) {
        throw new BadRequestException({ message: `"${tid}" is not a transaction id.`, errors: { transaction_id: ['Must be a whole number.'] } });
      }
      and.push({ transaction_id: n });
    }

    const from = query.from;
    if (from) and.push({ created_at: { gte: this.parseDay('from', from) } });
    const to = query.to;
    if (to) and.push({ created_at: { lt: new Date(this.parseDay('to', to).getTime() + 24 * 60 * 60 * 1000) } });

    const term = String(query.q ?? '').trim().slice(0, MAX_TERM);
    if (term) {
      const cols: (keyof Prisma.audit_logsWhereInput)[] = ['who', 'section', 'field', 'old_value', 'new_value', 'action', 'details'];
      const needle = escapeLike(term);
      // MySQL LIKE is case-insensitive (ci collation) — match that in Postgres.
      and.push({ OR: cols.map((c) => ({ [c]: { contains: needle, mode: 'insensitive' } })) as Prisma.audit_logsWhereInput[] });
    }

    return { where: { AND: and }, area, scope };
  }

  async index(query: AuditLogQuery): Promise<Record<string, unknown>> {
    const { where, area, scope } = this.buildWhere(query);

    // Clamped rather than refused: an out-of-range page is a stale bookmark or a fat finger, not an
    // unanswerable question, and the response already reports `last_page` for the client to correct
    // itself. `|| 1` handles NaN; `Math.min` handles Infinity, which `|| 1` does not.
    const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(query.page ?? 1)) || 1));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(Number(query.per_page ?? PER_PAGE)) || PER_PAGE));

    const [total, rows] = await Promise.all([
      this.prisma.audit_logs.count({ where }),
      this.prisma.audit_logs.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
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
          handled: a.handled,
          old_value: a.old_value,
          new_value: a.new_value,
          details: a.details,
          stamp: toDateTimeString(a.created_at),
        };
      }),
      meta: {
        current_page: page,
        last_page: Math.max(Math.ceil(total / perPage), 1),
        per_page: perPage,
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

  /**
   * Midnight UTC on the given day, or a 400 naming the field.
   *
   * The date is read as `YYYY-MM-DD` and interpreted in UTC, which is what the previous version did
   * and what the column stores; what is new is that a value which cannot be a date says so instead
   * of reaching Prisma. `2026-99-99` is caught by `Number.isNaN(getTime())` — JavaScript builds an
   * Invalid Date rather than rolling the month over, for this shape.
   */
  private parseDay(field: 'from' | 'to', d: string): Date {
    const t = new Date(`${String(d).slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(t.getTime())) {
      throw new BadRequestException({
        message: `"${d}" is not a date. Use YYYY-MM-DD.`,
        errors: { [field]: ['Use YYYY-MM-DD.'] },
      });
    }
    return t;
  }
}
