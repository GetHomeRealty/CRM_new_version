import { Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportDataService, type DataScope, type EnrichedTxn, type LoanRow } from './report-data.service';
import { REPORTS, getReport, AGENT_PAYMENT_STATUSES, type ReportDef } from './report-registry';
import { baseRow } from './report-columns';
import { money, num } from './report-financials';
import { withWorkMem, workMemSetting } from '../common/work-mem';
import { TRANSACTION_TYPES } from '../reference/transaction.constants';
import {
  reportTotalsSql, reportSectionTotalsSql, isSqlTotalColumn, SQL_TOTAL_COLUMNS, TOTALS_FIELDS,
  type ReportTotalsRow, type ReportSectionTotalsRow, type SqlTotalColumn,
} from './report-totals.sql';
import {
  DOC_PREDICATES, DOC_ROW_SOURCES, DOC_SORT_COLUMNS, DOC_TOTAL_COLUMNS, docPageSql, docRowCountsSql, docRowPageSql,
  docTotalsSql, type DocTotalsRow,
} from './report-docs.sql';
import { condQualify, condRowCountsSql, condRowPageSql } from './report-conds.sql';
import { anyUncomputedSql, paymentCountsSql, paymentPageSql, paymentSectionFilteredSql, paymentStatusFilter } from './report-payments.sql';
import type { CommissionVariant } from '../dashboard/desk-commission.sql';
import type { ReportColumn, ReportFilters, ReportQuery, ReportResult, ReportRow, ReportTotals, ExportPayload } from './report.types';
import type { AuthUserRecord } from '../auth/auth.types';

/** Payment methods offered in the Transactions module (AdminActivities + Adjustment modals). */
export const PAYMENT_TYPES = ['N/A', 'TDB-EFT', 'CTA-BA Transfer', 'Cheque', 'Wire'] as const;

const PER_PAGE_DEFAULT = 25;
const PER_PAGE_MAX = 200;

/** Sort budget and time limit for the report-total statements. See `sqlTotals`. */
const REPORT_WORK_MEM = workMemSetting(process.env.DESK_REPORT_WORK_MEM, '64MB');
const REPORT_TIMEOUT_MS = 120_000;

/**
 * Sort keys the DATABASE can order by, and the column each maps to.
 *
 * Only stored columns are here, and that is the point: the fast path serves one page straight from
 * an `ORDER BY … LIMIT`, so it can only be used when the requested order is one the database can
 * produce. Every other sortable key — payment status, balance due, split ratio — is derived during
 * enrichment and has no column to order by, so those requests take the original path and get the
 * same answer they always did.
 */
const SORT_COLUMNS: Record<string, keyof Prisma.transactionsOrderByWithRelationInput> = {
  trade_no: 'trade_no',
  property: 'property',
  type: 'type',
  agent: 'agent',
  price: 'price',
  closed_price: 'price',
  listing_price: 'listing_price',
  offer_date: 'offer_date',
  closing_date: 'closing_date',
  created_at: 'created_at',
  updated_at: 'updated_at',
  lead_assigned_date: 'lead_assigned_date',
  lead_converted_date: 'lead_converted_date',
  review_email_sent_at: 'review_email_sent_at',
  review_received_at: 'review_received_at',
  gift_coupon_issued_at: 'gift_coupon_issued_at',
  gift_coupon_value: 'gift_coupon_value',
  txn_id: 'id',
};

@Injectable()
export class ReportsService {
  constructor(private readonly data: ReportDataService, private readonly prisma: PrismaService) {}

  /** Whether this user is locked to their own agent data (agents) vs. brokerage-wide (staff/admin). */
  private isAgentScoped(user: AuthUserRecord): boolean {
    return (user.role ?? 'agent') === 'agent';
  }

  /**
   * The data scope for this caller — the one place a report decides whose deals it may read.
   *
   * An agent is locked by their USER ID, with their name carried alongside so the per-agent split
   * lines inside a deal can still be picked out. Scoping on the name alone gave one of two
   * same-named agents the other's deals; see `DataScope` in `report-data.service.ts`.
   */
  private scopeFor(user: AuthUserRecord, agents?: string[]): DataScope {
    return this.isAgentScoped(user)
      ? { lockedAgent: user.name, lockedUserId: user.id }
      : { agents };
  }

  /** List all reports (dashboard cards). */
  list(): { type: string; name: string; description: string; category: string }[] {
    return REPORTS.map((r) => ({ type: r.type, name: r.name, description: r.description, category: r.category }));
  }

  /** Static column + filter + section metadata for one report (drives filters + Customize Fields). */
  meta(type: string): { type: string; name: string; description: string; category: string; columns: ReportColumn[]; filters: unknown; sections?: unknown; defaultSort: unknown; noSort: boolean; expandable: boolean; custom: string | null } {
    const def = this.require(type);
    // no-sort reports never advertise a sortable column (§7.3: no sort headers or icons)
    const columns = def.noSort ? def.columns.map((c) => (c.sortable ? { ...c, sortable: false } : c)) : def.columns;
    return { type: def.type, name: def.name, description: def.description, category: def.category, columns, filters: def.filters, sections: def.sections, defaultSort: def.defaultSort, noSort: !!def.noSort, expandable: !!def.expandable, custom: def.custom ?? null };
  }

  private require(type: string): ReportDef {
    const def = getReport(type);
    if (!def) throw new NotFoundException({ message: `Unknown report type "${type}".` });
    return def;
  }

  /**
   * Filter-option lists. Deal Type / Agent / Payment Type use the SAME canonical vocabularies
   * as the Transactions module (not just values that happen to appear in the data), so the
   * dropdowns are accurate and stable. Split ratios + closing years are data-derived.
   */
  async filterOptions(user: AuthUserRecord): Promise<Record<string, { value: string; label: string }[]>> {
    const opt = (arr: string[]) => arr.map((v) => ({ value: v, label: v }));
    const scope = this.scopeFor(user);
    /*
     * OPENING THE REPORTS SCREEN USED TO ENRICH THE WHOLE BROKERAGE.
     *
     * This called `load(scope)` — every deal, every commission breakdown — and then read
     * `split_ratios` off the enriched rows to fill one `<select>`. At 80,000 deals that is the most
     * expensive query in the module, run before the user has chosen a report.
     *
     * `splitRatioOptions` derives the same values from the stored splits. Same list, same order.
     */
    const [ratios, agentList, years] = await Promise.all([
      this.data.splitRatioOptions(scope),
      this.isAgentScoped(user) ? Promise.resolve([user.name]) : this.data.agentNames(),
      this.data.closingYears(),
    ]);
    // Split ratios: real agent/brokerage splits present in the data, ordered by the agent
    // share descending (95/5, 90/10, 85/15 …) rather than as strings.
    const splitRatios = uniq(ratios)
      .filter((r) => /^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(r))
      .sort((a, b) => Number(b.split('/')[0]) - Number(a.split('/')[0]));
    return {
      deal_type: opt([...TRANSACTION_TYPES]),
      agent: opt(agentList),
      payment_type: opt([...PAYMENT_TYPES]),
      payout_status: opt([...AGENT_PAYMENT_STATUSES]),
      split_ratio: opt(splitRatios),
      year: opt(years),
    };
  }

  /** Run a report: filter → predicate → map → totals(all) → sort → paginate. */
  async run(type: string, user: AuthUserRecord, query: ReportQuery): Promise<ReportResult> {
    const def = this.require(type);

    /*
     * THE FAST PATH: page in the database, total in the database, enrich twenty-five rows.
     *
     * The original path below has to enrich every matching deal before it can show one page, and the
     * reason is the footer — the totals describe the complete filtered set. At 80,000 deals that is
     * 8.9 s of reading and 4.4 s of enrichment to print twenty-five lines.
     *
     * When a report's predicate is fully expressible in SQL, it emits one row per transaction, it
     * sorts by a stored column and every column it totals can be computed by `reportTotalsSql`, none
     * of that is necessary: the database answers the totals over the whole set and hands back one
     * page of ids, and only those ids are enriched. `runFast` returns null the moment any of those
     * conditions fails, so a report that does not qualify is not approximated — it takes the
     * original path unchanged.
     */
    const fast = (await this.runFastDocRows(def, user, query))
      ?? (await this.runFastCondRows(def, user, query))
      ?? (await this.runFastPayments(def, user, query))
      ?? (await this.runFastDocs(def, user, query))
      ?? (await this.runFast(def, user, query));
    if (fast) return fast;

    const { rows, columns, totals, sections } = await this.compute(def, user, query);

    /*
     * EVERY REPORT PAGES, INCLUDING THE SECTION-GROUPED ONES.
     *
     * Section reports used to return every row — `page = 1`, `last_page = 1`, the whole result set —
     * on the reasoning that a section should not be split across pages.
     *
     * MEASURED at 80,000 deals / 800,000 documents:
     *
     *   pending-invalid-documents   398.8 MB in one response, 2,017 MB heap to build it
     *   transaction-payment-status   85.4 MB
     *
     * A browser asked to accept 398 MB of JSON does not render a report, it stops responding. The
     * old reasoning was sound at a few hundred rows and became the single worst payload in the
     * application at eighty thousand.
     *
     * NOTHING IS TRUNCATED AND NO FIGURE CHANGES. `compute()` still runs over the complete filtered
     * set, so `totals` and every `sections[].totals` and `sections[].count` are computed over
     * everything exactly as before — a section still reports its true size and its true subtotal.
     * What changed is only how many ROWS travel per request: the rest are on the next page, which is
     * what `last_page` now says. Exports are untouched and still contain the complete set —
     * `exportData()` does not go through this method.
     *
     * The visible consequence, stated plainly: a section may now begin on one page and continue on
     * the next, and a page can carry rows from two sections. The section headers and their counts
     * make that legible, and it is the price of the screen loading at all.
     */
    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(PER_PAGE_MAX, Math.max(1, query.per_page ?? PER_PAGE_DEFAULT));
    const total = rows.length;
    const start = (page - 1) * perPage;
    const pageRows = rows.slice(start, start + perPage);

    return {
      report: { type: def.type, name: def.name, description: def.description },
      columns,
      rows: pageRows,
      totals,
      total_count: total,
      page,
      per_page: perPage,
      last_page: Math.max(1, Math.ceil(total / perPage)),
      applied_filters: this.appliedFilters(def, user, query.filters),
      sections,
    };
  }

  /**
   * The fast path, or `null` when this report and this query do not qualify for it.
   *
   * EVERY CONDITION BELOW IS A CORRECTNESS CONDITION, not a heuristic — each one names something the
   * database cannot answer, and returning a page anyway would mean a footer that disagrees with its
   * own rows or a page in the wrong order.
   */
  private async runFast(def: ReportDef, user: AuthUserRecord, query: ReportQuery): Promise<ReportResult | null> {
    // An agent's reports already read only their own deals and are measured in tens of milliseconds;
    // their figures are also scoped to their own split lines, which `reportTotalsSql` does not model.
    if (this.isAgentScoped(user)) return null;
    // One row per transaction, no in-table sections: otherwise the page is not a page of deals.
    if (def.expand || def.section || def.custom) return null;
    // The report's own predicate must be FULLY expressed in SQL. `sqlWhere` is otherwise only
    // required to be a superset, which is safe for narrowing and useless for counting.
    if (!def.sqlExact?.(this.sanitize(query.filters ?? {}, user))) return null;

    const filters = this.sanitize(query.filters ?? {}, user);
    // These two are derived from `admin_activities` during enrichment; no SQL predicate expresses
    // them, so a filtered request has to be counted the long way.
    if (filters.payment_type?.length || filters.payout_status) return null;
    if (filters.split_ratio?.length || filters.status || filters.search) return null;

    const columns = this.resolveColumns(def, query.columns, filters);
    // Every totalled column must be one this can compute. An `average` column has no SQL here at all.
    const totalled = columns.filter((c) => c.total || c.average);
    if (totalled.some((c) => c.average || !isSqlTotalColumn(c.key))) return null;

    // The sort must be a stored column, in the same direction, or the page is the wrong twenty-five.
    const sortKey = query.sort && this.hasColumn(def, query.sort) ? query.sort : def.defaultSort.key;
    const orderBy = SORT_COLUMNS[sortKey];
    if (!orderBy || def.noSort) return null;
    const dir = (query.sort ? query.dir : def.defaultSort.dir) === 'asc' ? 'asc' : 'desc';

    const where: Prisma.transactionsWhereInput = {
      AND: [{ deleted_at: null }, this.sqlNarrow(def, filters, user) ?? {}],
    };

    /*
     * The matching ids, in report order, from Prisma — so the ownership rule and the report filters
     * keep their single definition rather than being restated as hand-written SQL.
     *
     * The full ordered list is what the totals are computed over and what `total_count` reports; the
     * page is a slice of it. Reading 80,000 ids costs about 60 ms and is bounded by the id column,
     * not by the size of a transaction.
     */
    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(PER_PAGE_MAX, Math.max(1, query.per_page ?? PER_PAGE_DEFAULT));
    const ordered = await this.prisma.transactions.findMany({
      where,
      orderBy: [{ [orderBy]: dir } as Prisma.transactionsOrderByWithRelationInput, { trade_no: 'asc' }],
      select: { id: true },
    });
    const ids = ordered.map((r) => r.id);

    const [totals, pageRows] = await Promise.all([
      this.sqlTotals(ids, totalled, def),
      this.enrichPage(def, user, filters, ids.slice((page - 1) * perPage, (page - 1) * perPage + perPage)),
    ]);

    return {
      report: { type: def.type, name: def.name, description: def.description },
      columns,
      rows: pageRows,
      totals: { ...totals, count: ids.length },
      total_count: ids.length,
      page,
      per_page: perPage,
      last_page: Math.max(1, Math.ceil(ids.length / perPage)),
      applied_filters: this.appliedFilters(def, user, query.filters),
    };
  }

  /**
   * The fast path for the Pending and Invalid Documents report — the one that emits a row per
   * DOCUMENT rather than per deal.
   *
   * WHY IT IS SEPARATE. Everything else pages over transactions. This report expands each deal into
   * one row per unvalidated document and splits them into two sections, so at 80,000 deals it built
   * 312,898 rows in memory — enriching every deal and every document in the brokerage — to show
   * twenty-five of them. Measured: 22 s.
   *
   * WHAT MAKES IT ANSWERABLE. The report TOTALS NOTHING: every column it shows is text, so the
   * footer and the two section headings need only counts. Counts and an ORDER BY are what a database
   * is for. The ROWS THEMSELVES ARE STILL BUILT BY `def.expand`, from deals loaded and enriched
   * exactly as before — this decides WHICH documents are on the page and in what order, not what
   * each row says.
   */
  /**
   * The fast path for Conditional Offers and Expiry, or `null` when the query does not qualify.
   *
   * SAME SHAPE AS `runFastDocRows`, DIFFERENT CHILD TABLE. Prisma resolves the candidate ids, SQL
   * counts and pages the rows, and `def.expand` builds every row from an enriched deal — but the
   * rows are conditions rather than documents, and two things follow from that.
   *
   * THE ROWS HAVE NO ID. `expand` puts `doc_id` on a document row, which is how the document path
   * matches a page row back to the object it built. A condition row carries nothing of the sort, so
   * the identity here is (transaction, index within that transaction's rows) — which is well
   * defined because `expand` walks `t.conditions` in load order, and the SQL orders by the same
   * `position, id`.
   *
   * A DEAL WITH NO CONDITIONS IS STILL ONE ROW. `expand` returns a single "—" line for it. That row
   * is materialised in the SQL rather than added afterwards, because it has to be counted, filtered
   * and paged alongside the rest — a page boundary that fell inside a run of them would otherwise
   * be off by however many there were.
   */
  /**
   * The fast path for Transaction Payment Status, or `null` when the query does not qualify.
   *
   * THE LAST REPORT WITH NO FAST PATH. `runFast` declined it on three counts — it defines `section`,
   * it sets `noSort`, and it filters on `agent_payment_status`, which is derived — so it enriched
   * every deal in the brokerage to show twenty-five rows. Measured at 80,000 deals: 10.3 s, and it
   * exhausted Node's default heap doing it.
   *
   * WHAT MADE IT ANSWERABLE. The three inputs its ladder reads are now columns: the agent commission
   * total, the paid-name count and the recorded tracker outcome, all maintained on write by
   * `PaymentCacheService`. So the status, the section and the filter are SQL, and only the page is
   * enriched. The ROWS are still built by `def.map` from enriched deals — this decides which
   * twenty-five and in what order, never what a row says.
   *
   * AGENT-SCOPED CALLERS ARE REFUSED, AND THAT IS A CORRECTNESS RULE RATHER THAN A PERFORMANCE ONE.
   * The cached figures are brokerage-wide; `enrich()` narrows the agent lines to the signed-in agent,
   * which is a genuinely different commission total and a different paid figure. An agent reading
   * this path would see the brokerage's answer labelled as their own.
   */
  private async runFastPayments(def: ReportDef, user: AuthUserRecord, query: ReportQuery): Promise<ReportResult | null> {
    if (def.type !== 'transaction-payment-status' || !def.sections || !def.map) return null;
    // See the note above: the cache is unscoped, so an agent must take the enrichment path.
    if (this.isAgentScoped(user)) return null;

    const filters = this.sanitize(query.filters ?? {}, user);
    if (filters.payment_type?.length || filters.payout_status) return null;
    if (filters.split_ratio?.length || filters.search) return null;

    const statusFilter = paymentStatusFilter(filters.status);
    if (statusFilter === null) return null;

    const columns = this.resolveColumns(def, query.columns, filters);
    /*
     * The footer is money, per section, over the complete filtered set — which is what kept this
     * report on the enrichment path even after the ladder became SQL. `reportSectionTotalsSql`
     * answers it in one grouped pass, so the only thing that still declines is a column it cannot
     * express: an `average` has no aggregate here, and a totalled key outside `SQL_TOTAL_COLUMNS`
     * would silently total zero.
     */
    const totalled = columns.filter((c) => c.total || c.average);
    if (totalled.some((c) => c.average || !isSqlTotalColumn(c.key))) return null;

    const wanted = filters.sections && filters.sections.length
      ? def.sections.filter((s) => filters.sections!.includes(s.key)).map((s) => s.key)
      : def.sections.map((s) => s.key);
    if (wanted.length === 0) return null;

    const ids = (await this.prisma.transactions.findMany({
      where: { AND: [{ deleted_at: null }, this.sqlNarrow(def, filters, user) ?? {}] },
      select: { id: true },
    })).map((r) => r.id);
    if (ids.length === 0) return null;

    /*
     * ONE UNCOMPUTED ROW SENDS THE WHOLE REPORT THE OTHER WAY.
     *
     * A deal whose `calc_at` is NULL has no cached figures, and a CASE over its columns would
     * classify it from zeros — silently, into 'Not Applicable'. Answering the rest from the cache
     * and that one from enrichment would need the two paths to agree about ordering and paging as
     * well as about values, so the check is all-or-nothing. It costs one existence query against a
     * partial index, and it answers false the moment the backfill has run.
     */
    const stale = await this.prisma.$queryRawUnsafe<{ stale: boolean }[]>(anyUncomputedSql(), ids);
    if (stale[0]?.stale) return null;

    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(PER_PAGE_MAX, Math.max(1, query.per_page ?? PER_PAGE_DEFAULT));

    const [counts, pageRows, sectionMoney] = await Promise.all([
      withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
        (tx) => tx.$queryRawUnsafe<{ section: string; n: number }[]>(paymentCountsSql(statusFilter), ids)),
      withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
        (tx) => tx.$queryRawUnsafe<{ id: number; section: string }[]>(
          paymentPageSql(statusFilter), ids, wanted, (page - 1) * perPage, perPage)),
      totalled.length ? this.sqlSectionTotals(ids, totalled, statusFilter) : Promise.resolve(new Map()),
    ]);

    const bySection = new Map(counts.map((c) => [c.section, Number(c.n)]));
    const total = wanted.reduce((a, k) => a + (bySection.get(k) ?? 0), 0);

    /*
     * The report footer is the sum of the section footers, which is what `compute` produces: it
     * calls `footer()` over `ordered`, and `ordered` is every visible section's rows concatenated.
     * Adding the sections here rather than running a fifth aggregate keeps the two definitions of
     * "the whole report" from being able to disagree by a cent.
     */
    const grand: ReportTotals = { count: total };
    for (const c of totalled) {
      let acc = new Decimal(0);
      for (const key of wanted) acc = acc.plus(new Decimal(String(sectionMoney.get(key)?.[c.key] ?? 0)));
      grand[c.key] = money(acc);
    }

    /*
     * The rows, built by the report itself, in the order SQL chose. `load` returns them by id, so
     * the page order is reapplied from `pageRows` — a deal that vanished between the two queries
     * simply drops out rather than shifting everything after it.
     */
    const loaded = await this.data.load(this.scopeFor(user, filters.agent), {
      where: { id: { in: pageRows.map((r) => r.id) } },
      needs: def.needs ?? {},
    });
    const byId = new Map(loaded.map((t) => [t.id, t]));
    const rows: ReportRow[] = [];
    for (const r of pageRows) {
      const t = byId.get(r.id);
      // `section` rides on the row exactly as `compute` puts it there, so a client that groups by it
      // sees what it always saw.
      if (t) rows.push({ ...def.map(t), section: r.section });
    }

    return {
      report: { type: def.type, name: def.name, description: def.description },
      columns,
      rows,
      totals: grand,
      total_count: total,
      page,
      per_page: perPage,
      last_page: Math.max(1, Math.ceil(total / perPage)),
      applied_filters: this.appliedFilters(def, user, query.filters),
      sections: def.sections
        .filter((s) => wanted.includes(s.key))
        .map((s) => {
          const count = bySection.get(s.key) ?? 0;
          if (def.sectionsWithoutTotals?.includes(s.key)) return { key: s.key, label: s.label, count, totals: undefined };
          const money_: ReportTotals = { count };
          for (const c of totalled) money_[c.key] = Number(sectionMoney.get(s.key)?.[c.key] ?? 0);
          return { key: s.key, label: s.label, count, totals: money_ };
        }),
    };
  }

  /**
   * The money footer for every section, in one grouped pass per commission variant.
   *
   * THREE STATEMENTS, NOT TWELVE. The variants partition the deals, so each is asked once for all
   * four sections and the results are added — rather than running a footer query per section per
   * variant, which is the same answer for four times the work.
   *
   * THE STATUS FILTER IS APPLIED INSIDE THE AGGREGATE. A footer describes the rows the report shows,
   * so filtering to 'Partially Paid' has to narrow the totals as well as the rows; passing the
   * filter down means the aggregate sees exactly the set the page came from.
   *
   * Added with decimal.js at two-decimal precision, exactly as `footer()` does — the three variant
   * contributions are each an exact two-decimal `numeric`, and decimal addition is associative, so
   * the order cannot move a cent.
   */
  private async sqlSectionTotals(
    ids: number[], totalled: ReportColumn[], statusFilter: string,
  ): Promise<Map<string, Record<string, number>>> {
    const rows = await Promise.all(
      (['standard', 'listing', 'precon'] as CommissionVariant[]).map((v) =>
        withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
          (tx) => tx.$queryRawUnsafe<ReportSectionTotalsRow[]>(
            reportSectionTotalsSql(v, paymentSectionFilteredSql(statusFilter)), ids)),
      ),
    );

    const acc = new Map<string, Record<string, Decimal>>();
    for (const variantRows of rows) {
      for (const r of variantRows) {
        // `null` is the section a row was filtered OUT of — see `paymentSectionFilteredSql`.
        if (r.section === null || r.section === undefined) continue;
        const bucket = acc.get(r.section) ?? {};
        for (const c of totalled) {
          const field = SQL_TOTAL_COLUMNS[c.key as SqlTotalColumn];
          bucket[c.key] = (bucket[c.key] ?? new Decimal(0)).plus(new Decimal(String(r[field as keyof ReportSectionTotalsRow] ?? 0)));
        }
        acc.set(r.section, bucket);
      }
    }

    const out = new Map<string, Record<string, number>>();
    for (const [section, bucket] of acc) {
      const o: Record<string, number> = {};
      for (const [k, v] of Object.entries(bucket)) o[k] = money(v);
      out.set(section, o);
    }
    return out;
  }

  private async runFastCondRows(def: ReportDef, user: AuthUserRecord, query: ReportQuery): Promise<ReportResult | null> {
    if (def.type !== 'conditional-offers' || !def.expand) return null;
    if (this.isAgentScoped(user)) return null;

    const filters = this.sanitize(query.filters ?? {}, user);
    if (filters.payment_type?.length || filters.payout_status) return null;
    if (filters.split_ratio?.length || filters.search) return null;

    const qualifySql = condQualify(filters.status);
    if (qualifySql === null) return null;

    // The SQL produces one order: the report's default. Anything else goes the long way.
    const askedSort = query.sort && this.hasColumn(def, query.sort) ? query.sort : def.defaultSort.key;
    const askedDir = (query.sort ? query.dir : def.defaultSort.dir) === 'asc' ? 'asc' : 'desc';
    if (askedSort !== def.defaultSort.key || askedDir !== def.defaultSort.dir) return null;

    const columns = this.resolveColumns(def, query.columns, filters);
    if (columns.some((c) => c.total || c.average)) return null;

    const ids = (await this.prisma.transactions.findMany({
      where: { AND: [{ deleted_at: null }, this.sqlNarrow(def, filters, user) ?? {}] },
      select: { id: true },
    })).map((r) => r.id);

    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(PER_PAGE_MAX, Math.max(1, query.per_page ?? PER_PAGE_DEFAULT));

    /*
     * The same `today` the enrichment path uses, computed once here and passed in — see
     * `expiryStatusSql` for why this must not be `current_date`. Inlined as a quoted literal rather
     * than bound, because it sits inside a CTE that is textually repeated and the parameter numbers
     * are already spoken for by the id list, the offset and the limit.
     */
    const today = `'${new Date().toISOString().slice(0, 10)}'`;

    const [countRows, pageRows] = await Promise.all([
      withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
        (tx) => tx.$queryRawUnsafe<{ n: number }[]>(condRowCountsSql(today, qualifySql), ids)),
      withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
        (tx) => tx.$queryRawUnsafe<{ tid: number; ord: number }[]>(
          condRowPageSql(today, qualifySql), ids, (page - 1) * perPage, perPage)),
    ]);

    const total = Number(countRows[0]?.n ?? 0);

    /*
     * Only the deals holding this page's rows are loaded, and each is expanded exactly as the
     * enrichment path expands it — so `expand(t)[ord]` IS the row that path would have produced.
     * A missing index would mean the two disagreed about a deal's row count, which is a bug rather
     * than an empty cell, so it is dropped and the parity spec is what catches it.
     */
    const txnIds = [...new Set(pageRows.map((r) => r.tid))];
    const loaded = await this.data.load(this.scopeFor(user, filters.agent), {
      where: { id: { in: txnIds } },
      needs: def.needs ?? {},
    });
    const expanded = new Map<number, ReportRow[]>();
    for (const t of loaded) expanded.set(t.id, def.expand(t));
    const rows = pageRows
      .map((r) => expanded.get(r.tid)?.[r.ord])
      .filter((r): r is ReportRow => r !== undefined);

    return {
      report: { type: def.type, name: def.name, description: def.description },
      columns,
      rows,
      totals: { count: total },
      total_count: total,
      page,
      per_page: perPage,
      last_page: Math.max(1, Math.ceil(total / perPage)),
      applied_filters: this.appliedFilters(def, user, query.filters),
    };
  }

  private async runFastDocRows(def: ReportDef, user: AuthUserRecord, query: ReportQuery): Promise<ReportResult | null> {
    const src = DOC_ROW_SOURCES[def.type];
    if (!src || !def.expand) return null;
    if (this.isAgentScoped(user)) return null;

    const filters = this.sanitize(query.filters ?? {}, user);
    if (filters.payment_type?.length || filters.payout_status) return null;
    if (filters.split_ratio?.length || filters.search) return null;

    /*
     * `status` used to be refused outright, because the one report here had no status filter and the
     * SQL had nowhere to put one. It is now the descriptor's business: `qualify` returns the
     * deal-level condition, or `null` for a value it cannot express — `Missing`, which selects deals
     * with no matching document at all and so has no document row to page over.
     */
    const qualifySql = src.qualify(filters);
    if (qualifySql === null) return null;

    /*
     * The order is fixed per report, so a request for a different one has to go the long way.
     * `sortKey: null` means the report does not offer a user sort at all; otherwise the only key
     * this path can serve is the one `src.order` encodes.
     */
    const askedSort = query.sort && this.hasColumn(def, query.sort) ? query.sort : def.defaultSort.key;
    if (src.sortKey !== null && askedSort !== src.sortKey) return null;
    if (src.sortKey !== null) {
      const askedDir = (query.sort ? query.dir : def.defaultSort.dir) === 'asc' ? 'asc' : 'desc';
      if (askedDir !== def.defaultSort.dir) return null;
    }

    const columns = this.resolveColumns(def, query.columns, filters);
    // The premise of this path. If somebody adds a totalled column, it must go the long way again.
    if (columns.some((c) => c.total || c.average)) return null;

    /*
     * A report with no `sections` still pages through the same SQL: its rows all carry the literal
     * section `'all'`, so `$2` is `['all']` and every section term below is a no-op. That is what
     * lets one pair of builders serve both shapes without a second code path.
     */
    const wanted = def.sections
      ? (filters.sections && filters.sections.length
        ? def.sections.filter((s) => filters.sections!.includes(s.key)).map((s) => s.key)
        : def.sections.map((s) => s.key))
      : ['all'];
    if (wanted.length === 0) return null;

    const ids = (await this.prisma.transactions.findMany({
      where: { AND: [{ deleted_at: null }, this.sqlNarrow(def, filters, user) ?? {}] },
      select: { id: true },
    })).map((r) => r.id);

    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(PER_PAGE_MAX, Math.max(1, query.per_page ?? PER_PAGE_DEFAULT));

    const [counts, pageRows] = await Promise.all([
      withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
        (tx) => tx.$queryRawUnsafe<{ section: string; n: number }[]>(docRowCountsSql(src, qualifySql), ids, wanted)),
      withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
        (tx) => tx.$queryRawUnsafe<{ id: number; tid: number }[]>(
          docRowPageSql(src, qualifySql), ids, wanted, (page - 1) * perPage, perPage)),
    ]);

    const bySection = new Map(counts.map((c) => [c.section, Number(c.n)]));
    const total = wanted.reduce((a, k) => a + (bySection.get(k) ?? 0), 0);

    /*
     * The rows, built by the report itself.
     *
     * Only the deals holding this page's documents are loaded, and each is expanded exactly as the
     * enrichment path expands it — so a row here is the same object it would have been. The expansion
     * produces every unvalidated document of that deal; the page order picks the ones asked for.
     */
    const txnIds = [...new Set(pageRows.map((r) => r.tid))];
    const loaded = await this.data.load(this.scopeFor(user, filters.agent), {
      where: { id: { in: txnIds } },
      needs: def.needs ?? {},
    });
    const byDocId = new Map<number, ReportRow>();
    for (const t of loaded) {
      for (const row of def.expand(t)) {
        const id = Number(row.doc_id);
        if (Number.isFinite(id)) byDocId.set(id, row);
      }
    }
    const rows = pageRows.map((r) => byDocId.get(r.id)).filter((r): r is ReportRow => r !== undefined);

    return {
      report: { type: def.type, name: def.name, description: def.description },
      columns,
      rows,
      totals: { count: total },
      total_count: total,
      page,
      per_page: perPage,
      last_page: Math.max(1, Math.ceil(total / perPage)),
      applied_filters: this.appliedFilters(def, user, query.filters),
      /*
       * A report with no sections reports none, rather than one called 'all'. The literal section is
       * a device for keeping one SQL builder — `compute` returns `sections: undefined` for these,
       * and a client that started seeing a phantom section would render a heading for it.
       */
      sections: def.sections
        ? def.sections
          .filter((s) => wanted.includes(s.key))
          .map((s) => ({
            key: s.key,
            label: s.label,
            count: bySection.get(s.key) ?? 0,
            // The report declares no totalled column, so a section footer is its count and nothing
            // else — which is what `footer()` returns for it on the other path.
            totals: def.sectionsWithoutTotals?.includes(s.key) ? undefined : { count: bySection.get(s.key) ?? 0 },
          }))
        : undefined,
    };
  }

  /**
   * The fast path for the two DOCUMENTATION reports, or `null` when the query does not qualify.
   *
   * WHY THEY NEED THEIR OWN. `runFast` below answers reports whose footer is money, from the
   * commission aggregate. These two count documents: how many are pending, invalid, valid, missing
   * and mandatory, per deal — which they also filter on and sort by. None of that is expressible in
   * Prisma, so the only way to serve a page was to load every document in the brokerage. Measured at
   * 80,000 deals and 800,000 documents: 21 s, of which 12 s was hydrating a relation that produced
   * six integers per deal.
   *
   * THE SHAPE IS THE SAME AS `runFast`, DELIBERATELY. Prisma resolves the candidate ids — so the
   * ownership rule and the global filters keep their single definition — and SQL does the counting,
   * the report's own predicate, the ordering and the paging over those ids. Only the deals on the
   * page are enriched, with their documents, and mapped by the report exactly as before.
   *
   * Every condition below is a correctness condition. `null` means "the enrichment path answers this
   * one", not "close enough".
   */
  private async runFastDocs(def: ReportDef, user: AuthUserRecord, query: ReportQuery): Promise<ReportResult | null> {
    const predicateFor = DOC_PREDICATES[def.type];
    if (!predicateFor) return null;
    // An agent's documentation reports read their own deals only — hundreds, not eighty thousand —
    // and are already measured in the low hundreds of milliseconds.
    if (this.isAgentScoped(user)) return null;

    const filters = this.sanitize(query.filters ?? {}, user);
    // These two are derived from `admin_activities` during enrichment and narrow nothing in SQL, so
    // a request carrying either has to be counted the long way.
    if (filters.payment_type?.length || filters.payout_status) return null;
    if (filters.split_ratio?.length || filters.search) return null;

    const predicate = predicateFor(filters);
    if (predicate === null) return null;

    const columns = this.resolveColumns(def, query.columns, filters);
    // Every totalled column must be one of the counts. An `average` has no expression here.
    const totalled = columns.filter((c) => c.total || c.average);
    if (totalled.some((c) => c.average || !(c.key in DOC_TOTAL_COLUMNS))) return null;

    const sortKey = query.sort && this.hasColumn(def, query.sort) ? query.sort : def.defaultSort.key;
    const orderExpr = DOC_SORT_COLUMNS[sortKey];
    if (!orderExpr || def.noSort) return null;
    const dir = (query.sort ? query.dir : def.defaultSort.dir) === 'asc' ? 'asc' : 'desc';

    /*
     * The candidate ids: the ownership rule, the global filters and the report's own `sqlWhere`,
     * evaluated by Prisma. `sqlWhere` is only a SUPERSET — the exact predicate is the SQL below, run
     * over these ids — so including it is an optimisation and excluding it would not change the
     * answer.
     */
    const ids = (await this.prisma.transactions.findMany({
      where: { AND: [{ deleted_at: null }, this.sqlNarrow(def, filters, user) ?? {}] },
      select: { id: true },
    })).map((r) => r.id);

    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(PER_PAGE_MAX, Math.max(1, query.per_page ?? PER_PAGE_DEFAULT));

    const [totalsRows, pageIds] = await Promise.all([
      withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
        (tx) => tx.$queryRawUnsafe<DocTotalsRow[]>(docTotalsSql(predicate), ids)),
      withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
        (tx) => tx.$queryRawUnsafe<{ id: number }[]>(
          docPageSql(predicate, orderExpr, dir), ids, (page - 1) * perPage, perPage)),
    ]);

    const agg = totalsRows[0] ?? { count: 0, pending_docs: 0, invalid_docs: 0, valid_docs: 0, total_docs: 0, missing_mandatory: 0 };
    const totals: ReportTotals = { count: agg.count };
    for (const c of totalled) totals[c.key] = Number(agg[DOC_TOTAL_COLUMNS[c.key] as keyof DocTotalsRow] ?? 0);

    const rows = await this.enrichPage(def, user, filters, pageIds.map((r) => r.id));

    return {
      report: { type: def.type, name: def.name, description: def.description },
      columns,
      rows,
      totals,
      total_count: agg.count,
      page,
      per_page: perPage,
      last_page: Math.max(1, Math.ceil(agg.count / perPage)),
      applied_filters: this.appliedFilters(def, user, query.filters),
    };
  }

  /**
   * The footer, added up from the three commission variants.
   *
   * They partition the deals, so each id contributes to exactly one — and every figure is an exact
   * two-decimal `numeric` by the time it gets here, so adding the three subtotals is associative and
   * cannot move a cent.
   */
  private async sqlTotals(ids: number[], totalled: ReportColumn[], def: ReportDef): Promise<ReportTotals> {
    const out: ReportTotals = { count: ids.length };
    for (const c of totalled) out[c.key] = 0;
    if (ids.length === 0) return out;

    /*
     * `work_mem` is raised for the duration of each statement, and the three run together.
     *
     * These sort the member set and then the line set. At PostgreSQL's 4 MB default both spill to
     * disk — and three of them spilling at the same moment turned the parallel run SLOWER than the
     * slowest branch alone (11.6 s against 8.5 s), which is what disk contention looks like.
     *
     * The timeout is explicit for the same reason it is on the Dashboard: Prisma closes an
     * interactive transaction after five seconds by default, and these take longer than that at
     * brokerage scale.
     */
    const rows = await Promise.all(
      (['standard', 'listing', 'precon'] as CommissionVariant[]).map((v) =>
        withWorkMem(this.prisma, REPORT_WORK_MEM, REPORT_TIMEOUT_MS,
          (tx) => tx.$queryRawUnsafe<ReportTotalsRow[]>(reportTotalsSql(v), ids)),
      ),
    );

    const sum: Record<string, Decimal> = {};
    for (const f of TOTALS_FIELDS) sum[f] = new Decimal(0);
    for (const r of rows) {
      const row = r[0];
      if (!row) continue;
      for (const f of TOTALS_FIELDS) sum[f] = sum[f].plus(new Decimal(String(row[f] ?? 0)));
    }

    for (const c of totalled) {
      // A report may mean something different by a column than the base row does — see
      // `sqlTotalOverrides` — so the override is consulted before the default mapping.
      const field = def.sqlTotalOverrides?.[c.key] ?? SQL_TOTAL_COLUMNS[c.key as SqlTotalColumn];
      out[c.key] = money(sum[field] ?? new Decimal(0));
    }
    return out;
  }

  /** Enrich only the deals on this page, and map them exactly as the slow path would. */
  private async enrichPage(def: ReportDef, user: AuthUserRecord, filters: ReportFilters, ids: number[]): Promise<ReportRow[]> {
    if (ids.length === 0) return [];
    const loaded = await this.data.load(this.scopeFor(user, filters.agent), {
      where: { id: { in: ids } },
      needs: def.needs ?? {},
    });
    // `load` returns ascending id; the page order is the report's order.
    const byId = new Map(loaded.map((t) => [t.id, t]));
    return ids
      .map((id) => byId.get(id))
      .filter((t): t is EnrichedTxn => t !== undefined)
      .map((t) => (def.map ? def.map(t) : baseRow(t)));
  }

  /**
   * Documents for one transaction — backs "expand a deal to see its individual documents".
   * Scoped exactly like a report run, so an agent can never read another agent's deal.
   */
  async documentsFor(transactionId: number, user: AuthUserRecord): Promise<{
    transaction: { id: number; trade_no: string; property: string | null; agent: string | null; clients: string[] };
    counts: Record<string, number>;
    groups: { key: string; label: string; documents: Record<string, unknown>[] }[];
  }> {
    const scope = this.scopeFor(user);
    /*
     * ONE DEAL, NOT THE WHOLE BROKERAGE.
     *
     * This loaded every transaction the caller could see and then picked one out of the array by id.
     * Narrowing the query is not a change of behaviour: the scope term is still applied and still
     * decides access, so a deal outside it produces no row and the same 404 as before — an agent
     * still cannot expand another agent's deal.
     */
    const all = await this.data.load(scope, {
      where: { id: transactionId },
      needs: { documents: true, clients: true },
    });
    const t = all.find((x) => x.id === transactionId);
    if (!t) throw new NotFoundException({ message: 'Transaction not found.' });

    const group = (status: string) => t.docs.filter((d) => d.status === status).map((d) => ({
      id: d.id, name: d.title, category: d.category, status: d.status,
      required: d.mandatory ? 'Yes' : 'No', uploaded: d.uploaded,
      uploaded_at: d.uploaded_at, reviewed_at: d.reviewed_at,
      invalid_reason: d.status === 'Invalid' ? (d.remarks ?? 'Not specified') : null,
      notes: d.remarks, reminder_status: d.reminder_sent ? 'Reminder Sent' : 'Not Sent',
    }));
    return {
      transaction: { id: t.id, trade_no: t.trade_no, property: t.property, agent: t.agent, clients: t.client_names },
      counts: { ...t.doc_counts },
      // pending and invalid are always reported separately, never as one combined list
      groups: [
        { key: 'pending', label: 'Pending Documents', documents: group('Pending') },
        { key: 'invalid', label: 'Invalid Documents', documents: group('Invalid') },
        { key: 'valid', label: 'Valid Documents', documents: group('Valid') },
      ],
    };
  }

  /** Build the export payload — identical filtering/columns/totals but the COMPLETE dataset. */
  async exportData(type: string, user: AuthUserRecord, query: ReportQuery, branding: string): Promise<ExportPayload> {
    const def = this.require(type);
    const { rows, columns, totals, sections } = await this.compute(def, user, query);
    const dealTypeHeading = (query.filters.deal_type ?? []).length === 1 ? query.filters.deal_type![0] : null;
    return {
      reportName: def.name,
      generatedAt: new Date(),
      generatedBy: user.name,
      appliedFilters: this.appliedFilters(def, user, query.filters),
      dealTypeHeading,
      columns,
      rows,
      totals,
      branding,
      sections,
    };
  }

  // ---- core compute (shared by run + export) ----
  private async compute(def: ReportDef, user: AuthUserRecord, query: ReportQuery): Promise<{ rows: ReportRow[]; columns: ReportColumn[]; totals: ReportTotals; sections?: { key: string; label: string; count: number }[] }> {
    const filters = this.sanitize(query.filters ?? {}, user);
    const columns = this.resolveColumns(def, query.columns, filters);

    if (def.custom === 'loans') {
      return this.computeLoans(def, user, filters, query, columns);
    }
    if (def.custom === 'reminders') {
      return this.computeReminders(def, user, filters, query, columns);
    }

    const scope = this.scopeFor(user, filters.agent);

    /*
     * THE FILTERS RUN TWICE, AND THAT IS THE DESIGN.
     *
     * `sqlNarrow` turns the global filters and the report's own `sqlWhere` into a database
     * predicate, so only candidate deals are read and enriched. The exact JavaScript predicates then
     * run unchanged on what comes back.
     *
     * The database predicate is deliberately a SUPERSET, never an equivalent. Several report
     * predicates are not expressible in SQL at all — "the agent has been partly paid", "this deal is
     * ready for a RECO audit" — and several global ones are only nearly expressible: the search box
     * matches against agent names that come out of the commission breakdown, not out of a column.
     * Being generous costs a little enrichment; being strict would silently drop rows from
     * somebody's report, which is why every clause below errs one way.
     *
     * The result is therefore IDENTICAL to filtering the whole brokerage in memory — same rows, same
     * order, same totals — and the totals below are still computed over the complete filtered set,
     * because the set is complete.
     */
    const all = await this.data.load(scope, {
      where: this.sqlNarrow(def, filters, user),
      // `?? {}` — an ABSENT declaration means this report reads none of the three relations, which is
      // true of every report outside the Documentation category. `load()` defaults to all three for
      // callers that say nothing at all, so passing `def.needs` straight through would have quietly
      // left every report loading 800,000 document rows it never looks at.
      needs: def.needs ?? {},
    });

    // global filters + report predicate
    let matched = all.filter((t) => this.passesGlobal(t, filters, user) && (!def.predicate || def.predicate(t, filters)));

    // section handling — only the requested sections survive
    let visibleSections: { key: string; label: string }[] | undefined;
    let wanted: string[] = [];
    if (def.section && def.sections) {
      wanted = filters.sections && filters.sections.length ? filters.sections : def.sections.map((s) => s.key);
      visibleSections = def.sections.filter((s) => wanted.includes(s.key));
    }

    // A report may emit several rows per transaction (e.g. one per split agent, or one per
    // document). A row that already carries its own `section` keeps it — that lets a single
    // transaction contribute rows to more than one section (pending AND invalid documents).
    let mapped = matched.flatMap((t) => {
      const rows = def.expand ? def.expand(t) : [def.map ? def.map(t) : baseRow(t)];
      if (def.section) { const s = def.section(t); for (const r of rows) if (r.section == null) r.section = s; }
      return rows;
    });
    // section filtering happens on ROWS, so per-row sectioning filters correctly too
    if (visibleSections) mapped = mapped.filter((r) => wanted.includes(String(r.section ?? '')));

    // Section reports render in fixed section order (sorting disabled); others sort normally.
    let sections: { key: string; label: string; count: number; totals?: ReportTotals }[] | undefined;
    let ordered: ReportRow[];
    if (visibleSections) {
      ordered = visibleSections.flatMap((s) => mapped.filter((r) => r.section === s.key));
      sections = visibleSections.map((s) => {
        const rows = mapped.filter((r) => r.section === s.key);
        return {
          key: s.key,
          label: s.label,
          count: rows.length,
          // Mutual Release (and any listed key) intentionally carries no subtotal row.
          totals: def.sectionsWithoutTotals?.includes(s.key) ? undefined : this.footer(rows, columns),
        };
      });
    } else {
      ordered = def.noSort ? mapped : this.sort(mapped, def, query);
    }

    const totals = this.footer(ordered, columns);
    return { rows: ordered, columns, totals, sections };
  }

  private async computeLoans(def: ReportDef, user: AuthUserRecord, filters: ReportFilters, query: ReportQuery, columns: ReportColumn[]): Promise<{ rows: ReportRow[]; columns: ReportColumn[]; totals: ReportTotals }> {
    const scope = this.scopeFor(user, filters.agent);
    let loans = await this.data.loadLoans(scope);
    if (filters.status) loans = loans.filter((l) => l.status === filters.status);
    if (filters.search) { const q = filters.search.toLowerCase(); loans = loans.filter((l) => l.agent.toLowerCase().includes(q)); }
    const rows: ReportRow[] = loans.map((l) => this.loanRow(l));
    const sorted = this.sort(rows, def, query);
    return { rows: sorted, columns, totals: this.footer(sorted, columns) };
  }

  /**
   * Reminder history (Documentation Reminder and Follow-Up). Reads the reminder log rather
   * than transactions; agents only ever see reminders on their own deals.
   */
  private async computeReminders(def: ReportDef, user: AuthUserRecord, filters: ReportFilters, query: ReportQuery, columns: ReportColumn[]): Promise<{ rows: ReportRow[]; columns: ReportColumn[]; totals: ReportTotals }> {
    // Reuse the report data loader for scoping so an agent can never read another agent's
    // reminder history — the visible transaction ids are the only ones we query.
    //
    // `visibleSummaries` rather than `load`: the rows below use a transaction for its trade number
    // and its address, and enriching every deal in the brokerage to read two strings off each was
    // the single most expensive thing this report did.
    const visible = await this.data.visibleSummaries(this.scopeFor(user, filters.agent));
    const byId = new Map(visible.map((t) => [t.id, t]));

    const where: Record<string, unknown> = { transaction_id: { in: [...byId.keys()] } };
    if (filters.status) where.delivery_status = filters.status;
    if (filters.reminder_type) where.reminder_type = filters.reminder_type;
    const sentFrom = (filters as Record<string, unknown>).sent_from as string | undefined;
    const sentTo = (filters as Record<string, unknown>).sent_to as string | undefined;
    if (sentFrom || sentTo) {
      where.sent_at = {
        ...(sentFrom ? { gte: new Date(sentFrom + 'T00:00:00') } : {}),
        ...(sentTo ? { lte: new Date(sentTo + 'T23:59:59') } : {}),
      };
    }

    const logs = byId.size
      ? await this.prisma.document_reminders.findMany({ where, orderBy: { id: 'desc' } })
      : [];
    let rows: ReportRow[] = logs.map((r) => {
      const t = byId.get(r.transaction_id);
      return {
        reminder_id: r.id,
        batch_id: r.batch_id,
        txn_id: r.transaction_id,
        trade_no: t?.trade_no ?? String(r.transaction_id),
        property: t?.property ?? null,
        doc_id: r.document_id,
        doc_name: r.document_name,
        doc_status: r.document_status,
        recipient: r.recipient_name ? `${r.recipient_name} <${r.recipient ?? '—'}>` : r.recipient,
        channel: r.channel,
        reminder_type: r.reminder_type,
        sent_by: r.sent_by,
        sent_at: r.sent_at ? r.sent_at.toISOString() : null,
        delivery_status: r.delivery_status,
        failure_reason: r.failure_reason,
        message: r.message,
      };
    });
    if (filters.search) {
      const q = filters.search.toLowerCase();
      rows = rows.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    const sorted = this.sort(rows, def, query);
    return { rows: sorted, columns, totals: this.footer(sorted, columns) };
  }

  private loanRow(l: LoanRow): ReportRow {
    return { agent: l.agent, loan_amount: l.loan_amount, loan_repaid: l.loan_repaid, outstanding: l.outstanding, repayment_count: l.repayment_count, last_repayment: l.last_repayment, status: l.status };
  }

  // ---- filters ----
  /** Strip anything an agent isn't allowed to set (agent selection, cross-agent access). */
  private sanitize(f: ReportFilters, user: AuthUserRecord): ReportFilters {
    const out: ReportFilters = { ...f };
    if (this.isAgentScoped(user)) { out.agent = [user.name]; } // agents can never query another agent
    out.deal_type = arrify(f.deal_type);
    out.payment_type = arrify(f.payment_type);
    out.agent = this.isAgentScoped(user) ? [user.name] : arrify(f.agent);
    out.split_ratio = arrify(f.split_ratio);
    out.sections = arrify(f.sections);
    return out;
  }

  /**
   * The global filters and the report's own `sqlWhere`, as a database predicate — a SUPERSET of what
   * `passesGlobal` and `def.predicate` will accept. See the note in `compute`.
   *
   * Only the filters that can be spelled without losing a row are here. `payment_type` and
   * `payout_status` are deliberately absent: both read values derived from `admin_activities` in the
   * enrichment, so any SQL approximation of them would be a guess about what is in a JSON blob.
   * `undefined` means "no narrowing", which is what every report did before this existed.
   */
  private sqlNarrow(def: ReportDef, f: ReportFilters, user: AuthUserRecord): Prisma.transactionsWhereInput | undefined {
    const and: Prisma.transactionsWhereInput[] = [];

    if (f.deal_type && f.deal_type.length) and.push({ type: { in: f.deal_type } });

    // Closing Year — the same rule `passesGlobal` applies: a blank closing date matches no year.
    if (f.year && /^\d{4}$/.test(String(f.year))) {
      const y = String(f.year);
      and.push({ closing_date: { gte: new Date(`${y}-01-01T00:00:00.000Z`), lte: new Date(`${y}-12-31T00:00:00.000Z`) } });
    }

    // `@db.Date` columns come back as UTC midnight and are compared as `YYYY-MM-DD` strings in
    // `passesGlobal`, so these bounds are exact rather than generous. A NULL date fails both.
    const day = (v: string): Date => new Date(`${v}T00:00:00.000Z`);
    if (f.offer_date_from) and.push({ offer_date: { gte: day(f.offer_date_from) } });
    if (f.offer_date_to) and.push({ offer_date: { lte: day(f.offer_date_to) } });
    if (f.closing_date_from) and.push({ closing_date: { gte: day(f.closing_date_from) } });
    if (f.closing_date_to) and.push({ closing_date: { lte: day(f.closing_date_to) } });

    /*
     * The Agent filter, as a superset.
     *
     * `passesGlobal` tests `t.agent_names.includes(a) || t.agent === a`, and `agent_names` comes out
     * of the commission breakdown — the team member names, or the deal's agent when there are no
     * team rows. Every name it can contain is therefore either `transactions.agent` or a
     * `team_members.name`, so matching those two columns cannot miss a deal the exact test would
     * have kept.
     *
     * Not applied to agent-scoped callers: their visibility is already the filter, and `sanitize`
     * has forced `f.agent` to their own name.
     */
    if (!this.isAgentScoped(user) && f.agent && f.agent.length) {
      and.push({ OR: [{ agent: { in: f.agent } }, { team_members: { some: { name: { in: f.agent } } } }] });
    }

    // Search, as a superset — same reasoning as the Agent filter for the name columns.
    if (f.search && f.search.trim() !== '') {
      const q = f.search.trim();
      const like = { contains: q, mode: 'insensitive' } as const;
      const or: Prisma.transactionsWhereInput[] = [{ trade_no: like }, { property: like }];
      if (!this.isAgentScoped(user)) {
        or.push({ agent: like }, { team_members: { some: { name: like } } });
      }
      and.push({ OR: or });
    }

    const own = def.sqlWhere?.(f);
    if (own) and.push(own);

    return and.length ? { AND: and } : undefined;
  }

  private passesGlobal(t: EnrichedTxn, f: ReportFilters, user: AuthUserRecord): boolean {
    if (f.deal_type && f.deal_type.length && !f.deal_type.includes(t.type)) return false;
    if (f.payment_type && f.payment_type.length && !(t.payment_type && f.payment_type.includes(t.payment_type))) return false;
    if (!this.isAgentScoped(user) && f.agent && f.agent.length && !f.agent.some((a) => t.agent_names.includes(a) || t.agent === a)) return false;
    // "Closing Year" — driven by the closing date only (blank closing date never matches a year).
    if (f.year) {
      if ((t.closing_date ?? '').slice(0, 4) !== String(f.year)) return false;
    }
    if (f.offer_date_from && (!t.offer_date || t.offer_date < f.offer_date_from)) return false;
    if (f.offer_date_to && (!t.offer_date || t.offer_date > f.offer_date_to)) return false;
    if (f.closing_date_from && (!t.closing_date || t.closing_date < f.closing_date_from)) return false;
    if (f.closing_date_to && (!t.closing_date || t.closing_date > f.closing_date_to)) return false;
    if (f.payout_status && t.agent_payment_status !== f.payout_status) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      const hay = [t.trade_no, t.property, ...(this.isAgentScoped(user) ? [] : t.agent_names), this.isAgentScoped(user) ? '' : t.agent]
        .filter(Boolean).map((s) => String(s).toLowerCase());
      if (!hay.some((h) => h.includes(q))) return false;
    }
    return true;
  }

  // ---- sorting (server-side; stable secondary by trade_no) ----
  private sort(rows: ReportRow[], def: ReportDef, query: ReportQuery): ReportRow[] {
    const key = query.sort && this.hasColumn(def, query.sort) ? query.sort : def.defaultSort.key;
    const dir = (query.sort ? query.dir : def.defaultSort.dir) === 'asc' ? 1 : -1;
    const val = (r: ReportRow): string | number | null => (key in r ? r[key] : null);
    return [...rows].sort((a, b) => {
      const c = cmp(val(a), val(b)) * dir;
      if (c !== 0) return c;
      // stable secondary: most-recent closing then trade no (per §26)
      const cc = cmp(a.closing_date ?? null, b.closing_date ?? null) * -1;
      if (cc !== 0) return cc;
      return cmp(a.trade_no ?? null, b.trade_no ?? null);
    });
  }
  private hasColumn(def: ReportDef, key: string): boolean { return def.columns.some((c) => c.key === key); }

  // ---- decimal-safe footer over the COMPLETE filtered set ----
  private footer(rows: ReportRow[], columns: ReportColumn[]): ReportTotals {
    const totals: ReportTotals = { count: rows.length };
    for (const c of columns) {
      if (c.total) {
        let acc = new Decimal(0);
        for (const r of rows) acc = acc.plus(num(r[c.key]));
        totals[c.key] = money(acc);
      } else if (c.average) {
        const vals = rows.map((r) => r[c.key]).filter((v) => v !== null && v !== undefined && v !== '') as (number | string)[];
        totals[c.key] = vals.length ? money(vals.reduce((a, v) => a.plus(num(v)), new Decimal(0)).div(vals.length)) : 0;
      }
    }
    return totals;
  }

  // ---- customize fields → resolved columns ----
  private resolveColumns(def: ReportDef, selected: string[] | undefined, filters: ReportFilters): ReportColumn[] {
    let cols = def.columns;
    // §5: hide "Type of Deal" when exactly one deal type is selected (kept in exports header instead)
    if ((filters.deal_type ?? []).length === 1) cols = cols.filter((c) => c.key !== 'type');
    // Section-grouped reports expose no sorting at all — strip it from the contract so no
    // client can render a sort control (or ask for a sort) on them.
    if (def.noSort) cols = cols.map((c) => (c.sortable ? { ...c, sortable: false } : c));
    if (selected && selected.length) {
      const set = new Set(selected);
      // keep selected order, then append mandatory columns that were unchecked (never dropped from exports)
      const ordered = selected.map((k) => cols.find((c) => c.key === k)).filter((c): c is ReportColumn => !!c);
      const mandatory = cols.filter((c) => c.mandatory && !set.has(c.key));
      return [...ordered, ...mandatory];
    }
    return cols.filter((c) => c.default);
  }

  // ---- applied-filter chips for the header + exports ----
  private appliedFilters(def: ReportDef, user: AuthUserRecord, f: ReportFilters): { label: string; value: string }[] {
    const out: { label: string; value: string }[] = [];
    const add = (label: string, value: string | undefined | null) => { if (value) out.push({ label, value }); };
    add('Search', f.search);
    add('Deal Type', (f.deal_type ?? []).join(', '));
    if (!this.isAgentScoped(user)) add('Agent', (f.agent ?? []).join(', '));
    else out.push({ label: 'Agent', value: user.name + ' (your data)' });
    add('Payment Type', (f.payment_type ?? []).join(', '));
    add('Closing Year', f.year ? String(f.year) : undefined);
    add('Offer Date', range(f.offer_date_from, f.offer_date_to));
    add('Closing Date', range(f.closing_date_from, f.closing_date_to));
    add('Payout Status', f.payout_status);
    add('Status', f.status);
    add('Split Ratio', (f.split_ratio ?? []).join(', '));
    if (def.sections && f.sections && f.sections.length) add('Sections', f.sections.map((s) => def.sections!.find((x) => x.key === s)?.label ?? s).join(', '));
    return out;
  }
}

// ---- helpers ----
const uniq = (arr: string[]): string[] => [...new Set(arr)];
const arrify = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);
const range = (a?: string, b?: string): string | undefined => (a || b ? `${a ?? '…'} → ${b ?? '…'}` : undefined);
function cmp(a: string | number | null, b: string | number | null): number {
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '' ? 0 : 1; // nulls last
  if (b === null || b === undefined || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}
