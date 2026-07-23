import { Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';
import { ReportDataService, type EnrichedTxn, type LoanRow } from './report-data.service';
import { REPORTS, getReport, AGENT_PAYMENT_STATUSES, type ReportDef } from './report-registry';
import { baseRow } from './report-columns';
import { money, num } from './report-financials';
import { TRANSACTION_TYPES } from '../reference/transaction.constants';
import type { ReportColumn, ReportFilters, ReportQuery, ReportResult, ReportRow, ReportTotals, ExportPayload } from './report.types';
import type { AuthUserRecord } from '../auth/auth.types';

/** Payment methods offered in the Transactions module (AdminActivities + Adjustment modals). */
export const PAYMENT_TYPES = ['N/A', 'TDB-EFT', 'CTA-BA Transfer', 'Cheque', 'Wire'] as const;

const PER_PAGE_DEFAULT = 25;
const PER_PAGE_MAX = 200;

@Injectable()
export class ReportsService {
  constructor(private readonly data: ReportDataService, private readonly prisma: PrismaService) {}

  /** Whether this user is locked to their own agent data (agents) vs. brokerage-wide (staff/admin). */
  private isAgentScoped(user: AuthUserRecord): boolean {
    return (user.role ?? 'agent') === 'agent';
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
    const scope = this.isAgentScoped(user) ? { lockedAgent: user.name } : {};
    const [txns, agentList, years] = await Promise.all([
      this.data.load(scope),
      this.isAgentScoped(user) ? Promise.resolve([user.name]) : this.data.agentNames(),
      this.data.closingYears(),
    ]);
    // Split ratios: real agent/brokerage splits present in the data, ordered by the agent
    // share descending (95/5, 90/10, 85/15 …) rather than as strings.
    const splitRatios = uniq(txns.flatMap((t) => t.split_ratios))
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
    const { rows, columns, totals, sections } = await this.compute(def, user, query);

    // Section-grouped reports render every section in full (no pagination splitting sections).
    const sectioned = !!def.section;
    const page = sectioned ? 1 : Math.max(1, query.page ?? 1);
    const perPage = Math.min(PER_PAGE_MAX, Math.max(1, query.per_page ?? PER_PAGE_DEFAULT));
    const total = rows.length;
    const start = sectioned ? 0 : (page - 1) * perPage;
    const pageRows = sectioned ? rows : rows.slice(start, start + perPage);

    return {
      report: { type: def.type, name: def.name, description: def.description },
      columns,
      rows: pageRows,
      totals,
      total_count: total,
      page,
      per_page: perPage,
      last_page: sectioned ? 1 : Math.max(1, Math.ceil(total / perPage)),
      applied_filters: this.appliedFilters(def, user, query.filters),
      sections,
    };
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
    const scope = this.isAgentScoped(user) ? { lockedAgent: user.name } : {};
    const all = await this.data.load(scope);
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

    const scope = this.isAgentScoped(user)
      ? { lockedAgent: user.name }
      : { agents: filters.agent };
    const all = await this.data.load(scope);

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
    const scope = this.isAgentScoped(user) ? { lockedAgent: user.name } : { agents: filters.agent };
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
    const visible = await this.data.load(this.isAgentScoped(user) ? { lockedAgent: user.name } : { agents: filters.agent });
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
