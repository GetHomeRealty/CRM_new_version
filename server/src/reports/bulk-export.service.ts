import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { createZip } from '../common/archive';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ReportDataService, type EnrichedTxn } from './report-data.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { longDate, longStamp } from './report-export.service';
import { IMPORT_FIELDS, FINANCIAL_FIELDS, CHILD_SHEETS, flatColumn } from './import-template';
import { buildDownloadAllWorkbook, type ExportRow, type RawTxnRow } from './download-all-export';
import type { AuthUserRecord } from '../auth/auth.types';
import { isMyMemberRow } from '../transactions/transaction.resource';
import type { ReportFilters } from './report.types';
import type { DocRow } from './report-documents';
import { STORAGE_ROOT } from '../config/storage';

/**
 * Ceiling on one bulk operation — protects the API from an accidental "select everything".
 * This is the limit for the EXPENSIVE actions: a PDF per transaction, or a ZIP that reads
 * every uploaded file off disk. Those costs scale with document count, not row count.
 */
export const MAX_BULK_TRANSACTIONS = 500;
/**
 * Row-based exports (the complete sheet, the data workbook, CSV) cost one spreadsheet row
 * per deal and touch no files, so they get a far higher ceiling — "download everything"
 * should not start refusing the day the brokerage passes 500 deals.
 */
export const MAX_BULK_DATA_TRANSACTIONS = 20_000;
/** Ids per database round trip, so a large export never builds one enormous IN (…) list. */
const QUERY_BATCH = 400;

/** Which documents a ZIP download should contain. */
export type DocFilter = 'all' | 'pending' | 'invalid' | 'valid' | 'mandatory';

export interface BulkSelection {
  /** Explicit transaction ids. Empty + all_matching = everything the filters return. */
  transaction_ids: number[];
  /** Use the report filters instead of an explicit id list. */
  all_matching?: boolean;
  filters?: ReportFilters;
  /** ZIP options. */
  documents?: DocFilter;
  categories?: string[];
  uploaded_from?: string;
  uploaded_to?: string;
}

export interface BulkSummary {
  transactions: number;
  documents_available: number;
  documents_unavailable: number;
  documents_selected: number;
  categories: { name: string; count: number }[];
  transactions_without_documents: number;
  estimated_files: number;
  filters: { label: string; value: string }[];
}

/** A file resolved for the ZIP, with the path it will occupy inside the archive. */
interface ZipEntry {
  abs: string;
  zipPath: string;
  txn: EnrichedTxn;
  doc: DocRow;
  originalName: string;
}

@Injectable()
export class BulkExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: ReportDataService,
    private readonly settings: CompanySettingsService,
  ) {}

  // ------------------------------------------------------------- selection
  /**
   * Resolve a selection to the transactions the user is actually allowed to see. An agent is
   * locked to their own deals, so an id outside their scope simply never resolves.
   */
  async resolve(sel: BulkSelection, user: AuthUserRecord, limit = MAX_BULK_TRANSACTIONS): Promise<EnrichedTxn[]> {
    // Guard the REQUESTED size before doing any work — scoping would otherwise shrink an
    // accidental "select everything" down to a passing number and hide the mistake.
    if (!sel.all_matching && (sel.transaction_ids?.length ?? 0) > limit) {
      throw new BadRequestException({ message: `${sel.transaction_ids.length} transactions selected — the limit is ${limit} per export.` });
    }

    const agentScoped = (user.role ?? 'agent') === 'agent';
    // Locked by user id: this is the boundary a queued export used to cross. See DataScope.
    const scope = agentScoped ? { lockedAgent: user.name, lockedUserId: user.id } : { agents: sel.filters?.agent };
    const all = await this.data.load(scope);

    let chosen: EnrichedTxn[];
    if (sel.all_matching) {
      chosen = this.applyFilters(all, sel.filters ?? {});
    } else {
      const ids = new Set(sel.transaction_ids ?? []);
      if (!ids.size) throw new BadRequestException({ message: 'Select at least one transaction.' });
      chosen = all.filter((t) => ids.has(t.id));
    }
    if (!chosen.length) throw new NotFoundException({ message: 'No matching transactions are available to you.' });
    if (chosen.length > limit) {
      throw new BadRequestException({ message: `${chosen.length} transactions selected — the limit is ${limit} per export.` });
    }
    return chosen;
  }

  /**
   * Fetch raw transaction rows in batches. Prisma turns `id: { in: [...] }` into a literal
   * IN list, which Postgres will accept but which gets unwieldy — and the joined include
   * makes one huge result set. Chunking keeps both bounded however many deals are exported.
   */
  private async rawInBatches<T>(
    ids: number[],
    include: Record<string, unknown>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += QUERY_BATCH) {
      const slice = ids.slice(i, i + QUERY_BATCH);
      const rows = await this.prisma.transactions.findMany({
        where: { id: { in: slice } },
        include: include as never,
      });
      out.push(...(rows as unknown as T[]));
    }
    return out;
  }

  /** The subset of report filters that make sense for a bulk selection. */
  private applyFilters(all: EnrichedTxn[], f: ReportFilters): EnrichedTxn[] {
    return all.filter((t) => {
      if (f.deal_type?.length && !f.deal_type.includes(t.type)) return false;
      if (f.agent?.length && !f.agent.some((a) => t.agent === a || t.agent_names.includes(a))) return false;
      if (f.payment_type?.length && !(t.payment_type && f.payment_type.includes(t.payment_type))) return false;
      if (f.year && (!t.closing_date || Number(t.closing_date.slice(0, 4)) !== Number(f.year))) return false;
      if (f.closing_date_from && (!t.closing_date || t.closing_date < f.closing_date_from)) return false;
      if (f.closing_date_to && (!t.closing_date || t.closing_date > f.closing_date_to)) return false;
      if (f.offer_date_from && (!t.offer_date || t.offer_date < f.offer_date_from)) return false;
      if (f.offer_date_to && (!t.offer_date || t.offer_date > f.offer_date_to)) return false;
      if (f.search) {
        const q = f.search.toLowerCase();
        const hay = `${t.trade_no} ${t.property ?? ''} ${t.agent ?? ''} ${t.type}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /** Documents selected for a ZIP, after status / category / date filtering. */
  private docsFor(t: EnrichedTxn, sel: BulkSelection): DocRow[] {
    let docs = t.docs;
    const want = sel.documents ?? 'all';
    if (want === 'mandatory') docs = docs.filter((d) => d.mandatory);
    else if (want !== 'all') docs = docs.filter((d) => d.status.toLowerCase() === want);
    if (sel.categories?.length) docs = docs.filter((d) => sel.categories!.includes(d.category));
    if (sel.uploaded_from) docs = docs.filter((d) => (d.uploaded_at ?? '') >= sel.uploaded_from!);
    if (sel.uploaded_to) docs = docs.filter((d) => (d.uploaded_at ?? '') <= sel.uploaded_to!);
    return docs;
  }

  // --------------------------------------------------------------- summary
  /** Confirmation summary shown BEFORE a bulk export runs. */
  async summary(sel: BulkSelection, user: AuthUserRecord): Promise<BulkSummary> {
    const txns = await this.resolve(sel, user);
    const rows = await this.prisma.documents.findMany({
      where: { transaction_id: { in: txns.map((t) => t.id) }, deleted_at: null, pending_delete: false },
      select: { id: true, file_path: true },
    });
    const pathById = new Map(rows.map((r) => [r.id, r.file_path]));

    let available = 0, unavailable = 0, selected = 0, emptyTxns = 0;
    const categories = new Map<string, number>();
    for (const t of txns) {
      const docs = this.docsFor(t, sel);
      selected += docs.length;
      let any = false;
      for (const d of docs) {
        const rel = pathById.get(d.id);
        if (rel && await this.exists(path.join(STORAGE_ROOT, rel))) { available++; any = true; }
        else unavailable++;
        categories.set(d.category, (categories.get(d.category) ?? 0) + 1);
      }
      if (!any) emptyTxns++;
    }

    return {
      transactions: txns.length,
      documents_available: available,
      documents_unavailable: unavailable,
      documents_selected: selected,
      categories: [...categories.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      transactions_without_documents: emptyTxns,
      // available files + the manifest + a placeholder note per empty transaction folder
      estimated_files: available + 1 + emptyTxns,
      filters: this.filterChips(sel),
    };
  }

  private filterChips(sel: BulkSelection): { label: string; value: string }[] {
    const out: { label: string; value: string }[] = [];
    const f = sel.filters ?? {};
    const add = (label: string, v: unknown) => { if (v && String(v).length) out.push({ label, value: Array.isArray(v) ? v.join(', ') : String(v) }); };
    add('Selection', sel.all_matching ? 'All transactions matching the filters' : `${sel.transaction_ids.length} selected`);
    add('Deal Type', f.deal_type); add('Agent', f.agent); add('Payment Type', f.payment_type);
    add('Closing Year', f.year); add('Search', f.search);
    add('Documents', sel.documents && sel.documents !== 'all' ? sel.documents : null);
    add('Categories', sel.categories);
    if (sel.uploaded_from || sel.uploaded_to) add('Uploaded', `${sel.uploaded_from ?? '…'} → ${sel.uploaded_to ?? '…'}`);
    return out;
  }

  private async exists(abs: string): Promise<boolean> {
    try { await fs.access(abs); return true; } catch { return false; }
  }

  // ------------------------------------------------------- data export XLSX
  /**
   * Complete structured transaction data. One sheet per entity so nothing is squeezed into a
   * single row: the deal itself, its agents, clients, conditions and document status. The
   * uploaded FILES are never embedded — only their metadata.
   */
  async dataXlsx(sel: BulkSelection, user: AuthUserRecord): Promise<Buffer> {
    const wb = await this.dataWorkbook(sel, user);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /**
   * The same data as the XLSX export, flattened to CSV. CSV is a single table by
   * definition, so this is the `Transactions` sheet — one row per deal, every headline
   * column. The per-agent, per-client, per-condition and per-document breakdowns only
   * exist as separate sheets, so they are XLSX-only; the UI says so where CSV is offered.
   */
  async dataCsv(sel: BulkSelection, user: AuthUserRecord): Promise<Buffer> {
    const wb = await this.dataWorkbook(sel, user);
    return Buffer.from(await wb.csv.writeBuffer({ sheetName: 'Transactions' }));
  }

  private async dataWorkbook(sel: BulkSelection, user: AuthUserRecord): Promise<ExcelJS.Workbook> {
    // Row export like the complete sheet — high ceiling, batched reads.
    const txns = await this.resolve(sel, user, MAX_BULK_DATA_TRANSACTIONS);
    const raw = await this.rawInBatches<RawTxnRow>(txns.map((t) => t.id), {
      brokerages: true, team_members: true, clients: true,
    });
    const rawById = new Map(raw.map((r) => [r.id, r]));
    const company = (await this.settings.current()).name;

    const wb = new ExcelJS.Workbook();
    wb.creator = company;
    wb.created = new Date();

    const sheet = (name: string, headers: string[]) => {
      const ws = wb.addWorksheet(name);
      const h = ws.addRow(headers);
      h.height = 26;
      h.eachCell((c) => {
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
        c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      });
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      return ws;
    };
    const autoWidth = (ws: ExcelJS.Worksheet) => {
      ws.columns.forEach((c) => {
        let max = 12;
        c.eachCell?.({ includeEmpty: false }, (cell) => { max = Math.max(max, String(cell.value ?? '').length + 2); });
        c.width = Math.min(46, max);
      });
    };

    // ---- Transactions ----
    const ws = sheet('Transactions', [
      'Transaction ID', 'Deal Number', 'Transaction Type', 'Property Address', 'Deal Status',
      'Primary Agent', 'All Agents', 'Split Ratios', 'Client Names',
      'Offer Date', 'Closing Date', 'Listing Contract Date', 'Listing Expiry Date',
      'Price', 'Deposit', 'Listing Price', 'MLS Number',
      'Commission % / Amount', 'Commission Type', 'Commission Value',
      'Total Commission Without HST', 'Total Commission HST', 'Total Commission With HST',
      'Agent Commission Without HST', 'Agent Commission HST', 'Agent Commission With HST',
      'Brokerage Commission Without HST', 'Brokerage Commission HST', 'Brokerage Commission With HST',
      'Adjustments', 'Cashback', 'Referral Fee', 'Advance Paid', 'Agent Paid', 'Agent Balance',
      'Agent Payment Status', 'Payment Type', 'CTA to BA',
      'Conditional Offer', 'Conditions', 'Waiver Documentation', 'Amendment Documentation',
      'Documentation Status', 'Pending Documents', 'Invalid Documents', 'Valid Documents',
      'Total Documents', 'Missing Mandatory Documents', 'Last Document Update',
      'RECO Audit Ready', 'RECO Remarks', 'Last Review Date',
      'Cooperating Brokerage', 'Brokerage Address', 'Brokerage Email',
      'Lawyer Name', 'Lawyer Email', 'Lawyer Phone',
      'Lead Source', 'Reminders Sent', 'Created', 'Last Updated',
    ]);
    for (const t of txns) {
      const r = rawById.get(t.id);
      const rec = (r ?? {}) as unknown as Record<string, unknown>;
      ws.addRow([
        t.id, t.trade_no, t.type, t.property, t.statuses.join(', '),
        t.agent, t.agent_names.join(', '), t.split_ratios.join(', '), t.client_names.join(', '),
        this.d(t.offer_date), this.d(t.closing_date), this.d(rec.listing_contract_date), this.d(rec.listing_expiry_date),
        t.price, Number(rec.deposit ?? 0), t.listing_price, rec.mls_num ?? '',
        t.comm_display, t.comm_type, t.comm_value,
        t.total.commission, t.total.hst, t.total.total,
        t.agentComm.commission, t.agentComm.hst, t.agentComm.total,
        t.brokerageComm.commission, t.brokerageComm.hst, t.brokerageComm.total,
        t.adjustments_total, t.cashback.total, t.referral?.total ?? 0, t.advance, t.agent_paid, t.agent_balance,
        t.agent_payment_status, t.payment_type, t.cta_to_ba,
        t.conditional_offer, t.conditions.map((c) => `${c.type} (${c.expiry_status})`).join('; '),
        t.waiver_status, t.amendment_status,
        t.documentation_status, t.doc_counts.pending, t.doc_counts.invalid, t.doc_counts.valid,
        t.doc_counts.total, t.doc_counts.missing_mandatory, this.d(t.last_doc_update),
        t.reco_audit_ready, t.reco_audit_remarks ?? '', this.d(t.reco_review_at),
        r?.brokerages?.name ?? '', r?.brokerages?.address ?? '', r?.brokerages?.email ?? '',
        rec.lawyer_name ?? '', rec.lawyer_email ?? '', rec.lawyer_phone ?? '',
        t.lead_source ?? '', t.doc_counts.reminders_sent, this.d(t.created_at), this.d(t.updated_at),
      ]);
    }
    this.moneyFormat(ws, [14, 15, 16, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
    autoWidth(ws);

    // ---- Agents (split detail) ----
    const wa = sheet('Agents', ['Deal Number', 'Property Address', 'Agent', 'Split Ratio', 'Agent Commission', 'Agent HST', 'Agent Total', 'Brokerage Commission', 'Brokerage HST', 'Brokerage Total']);
    for (const t of txns) {
      for (const s of t.splits) {
        wa.addRow([t.trade_no, t.property, s.name, s.ratio, s.agent.commission, s.agent.hst, s.agent.total, s.brokerage.commission, s.brokerage.hst, s.brokerage.total]);
      }
    }
    this.moneyFormat(wa, [5, 6, 7, 8, 9, 10]);
    autoWidth(wa);

    // ---- Clients ----
    const wc = sheet('Clients', ['Deal Number', 'Property Address', 'Client Name', 'Email', 'Phone']);
    for (const t of txns) {
      const r = rawById.get(t.id);
      for (const c of r?.clients ?? []) wc.addRow([t.trade_no, t.property, c.name, c.email ?? '', c.phone ?? '']);
    }
    autoWidth(wc);

    // ---- Conditions ----
    const wcd = sheet('Conditions', ['Deal Number', 'Property Address', 'Condition Type', 'Deadline', 'Condition Status', 'Expiry Status']);
    for (const t of txns) {
      for (const c of t.conditions) wcd.addRow([t.trade_no, t.property, c.type, this.d(c.deadline), c.status, c.expiry_status]);
    }
    autoWidth(wcd);

    // ---- Documents (metadata only — never the files themselves) ----
    const wd = sheet('Documents', ['Deal Number', 'Property Address', 'Document Name', 'Category', 'Status', 'Required', 'File Uploaded', 'Upload Date', 'Review Date', 'Invalid Reason', 'Validation Notes', 'Reminder Status']);
    for (const t of txns) {
      for (const d of t.docs) {
        wd.addRow([
          t.trade_no, t.property, d.title, d.category, d.status, d.mandatory ? 'Yes' : 'No',
          d.uploaded ? 'Yes' : 'No', this.d(d.uploaded_at), this.d(d.reviewed_at),
          d.status === 'Invalid' ? (d.remarks ?? 'Not specified') : '', d.remarks ?? '',
          d.reminder_sent ? 'Reminder Sent' : 'Not Sent',
        ]);
      }
    }
    autoWidth(wd);

    // ---- Export info ----
    const wi = sheet('Export Info', ['Field', 'Value']);
    wi.addRow(['Report', 'Bulk Transaction Data Export']);
    wi.addRow(['Generated', longStamp(new Date())]);
    wi.addRow(['Generated By', user.name]);
    wi.addRow(['Brokerage', company]);
    wi.addRow(['Transactions', txns.length]);
    for (const c of this.filterChips(sel)) wi.addRow([c.label, c.value]);
    wi.addRow(['Note', 'Uploaded document files are not included in this export — only their metadata. Use the ZIP download for the files.']);
    autoWidth(wi);

    return wb;
  }

  private d(v: unknown): string { return v ? longDate(String(v).slice(0, 10)) : ''; }
  private moneyFormat(ws: ExcelJS.Worksheet, cols: number[]): void {
    for (const c of cols) ws.getColumn(c).numFmt = '$#,##0.00';
  }

  // -------------------------------------------------- complete flat export
  /**
   * ISO date — the flat table round-trips back through Bulk Import, so no prose dates.
   * Prisma hands back Date objects for date columns while the enriched view hands back
   * YYYY-MM-DD strings; stringifying a Date here would emit "Wed Nov 13" and fail import.
   */
  private iso(v: unknown): string {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
    return v ? String(v).slice(0, 10) : '';
  }
  private yn(v: unknown): string { return v === true || v === 'Yes' || v === 1 ? 'Yes' : v === false || v === 'No' || v === 0 ? 'No' : ''; }
  private num(v: unknown): number | string { return v === null || v === undefined || v === '' ? '' : Number(v); }

  /**
   * EVERYTHING about a transaction on ONE row: Basic Info, team split, clients, lawyer,
   * co-op brokerage, the full financial block, adjustments and conditions, plus the
   * calculated commission/documentation columns that only exist server-side.
   *
   * Column names deliberately match the Bulk Import contract, so this file can be edited
   * and fed straight back into the importer. Repeat groups (Team 1..n, Client 1..n …) are
   * sized to the widest transaction in the selection rather than a fixed cap, so nothing is
   * ever silently truncated — a deal with nine team members gets nine groups.
   */
  private async completeTable(sel: BulkSelection, user: AuthUserRecord): Promise<{ headers: string[]; rows: (string | number)[][]; txns: EnrichedTxn[] }> {
    // Row export: no files are read, so it uses the high ceiling rather than the ZIP/PDF one.
    const txns = await this.resolve(sel, user, MAX_BULK_DATA_TRANSACTIONS);
    const raw = await this.rawInBatches<RawTxnRow>(txns.map((t) => t.id), {
      brokerages: { include: { brokerage_agents: { orderBy: { position: 'asc' } } } },
      team_members: { orderBy: { position: 'asc' } },
      clients: { orderBy: { position: 'asc' } },
      conditions: { orderBy: { position: 'asc' } },
    });
    const byId = new Map(raw.map((r) => [r.id, r]));

    /** Adjustment rows for a deal, flattened out of the JSON blob into import-shaped rows. */
    const adjRowsFor = (rec: Record<string, unknown>): Record<string, unknown>[] => {
      let a = rec.adjustments as unknown;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
      const blob = (a ?? {}) as Record<string, unknown>;
      const list: Record<string, unknown>[] = [];
      const take = (rows: unknown, section: string) => {
        for (const r of (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]) {
          list.push({ ...r, Section: section });
        }
      };
      take(blob.adjustment_rows, 'Agent Adjustment');
      take(blob.advance_rows, 'Advance Payment');
      take(blob.client_rows, 'Client Referral');
      if (blob.ext && typeof blob.ext === 'object') {
        const e = blob.ext as Record<string, unknown>;
        if (Object.values(e).some((v) => v !== '' && v !== null && v !== undefined && v !== 'No')) {
          list.push({ ...e, agent: e.agent_name, Section: 'External Referral' });
        }
      }
      return list;
    };

    // Widest transaction in the selection decides how many repeat groups the sheet carries.
    const widest = { team: 1, clients: 1, adjustments: 1, conditions: 1 };
    for (const t of txns) {
      const r = byId.get(t.id);
      widest.team = Math.max(widest.team, r?.team_members.length ?? 0);
      widest.clients = Math.max(widest.clients, r?.clients.length ?? 0);
      widest.conditions = Math.max(widest.conditions, r?.conditions.length ?? 0);
      widest.adjustments = Math.max(widest.adjustments, adjRowsFor((r ?? {}) as unknown as Record<string, unknown>).length);
    }

    // ---- headers ----
    const CALC = [
      'Total Commission (Excl HST)', 'Total Commission HST', 'Total Commission (Incl HST)',
      'Agent Commission (Excl HST)', 'Agent Commission HST', 'Agent Commission (Incl HST)',
      'Brokerage Commission (Excl HST)', 'Brokerage Commission HST', 'Brokerage Commission (Incl HST)',
      'Adjustments Total', 'Cashback', 'Referral Fee', 'Advance Paid', 'Agent Paid', 'Agent Balance',
      'Agent Payment Status', 'Commission Received', 'CTA to BA',
      'Documentation Status', 'Pending Documents', 'Invalid Documents', 'Valid Documents',
      'Total Documents', 'Missing Mandatory Documents', 'Last Document Update', 'RECO Audit Ready',
      'Lead Source', 'Created', 'Last Updated',
    ];
    const headers = [
      'Transaction ID', 'Deal Number',
      ...IMPORT_FIELDS.map((f) => f.column),
      ...FINANCIAL_FIELDS.map((f) => f.column),
      ...CALC,
    ];
    for (const child of CHILD_SHEETS) {
      const n = widest[child.key];
      for (let i = 1; i <= n; i++) for (const f of child.fields) headers.push(flatColumn(child, i, f));
    }

    // ---- rows ----
    const rows: (string | number)[][] = [];
    for (const t of txns) {
      const r = byId.get(t.id);
      const rec = (r ?? {}) as unknown as Record<string, unknown>;
      const brok = r?.brokerages ?? null;

      const mainVal: Record<string, string | number> = {
        type: t.type,
        property: t.property ?? '',
        status: t.statuses.join(', '),
        primary_agent: t.agent ?? '',
        // Split agents excludes the primary — the Team columns carry the full picture.
        team_members: t.agent_names.filter((n) => n !== t.agent).join(', '),
        price: this.num(rec.price),
        deposit: this.num(rec.deposit),
        offer_date: this.iso(t.offer_date),
        closing_date: this.iso(t.closing_date),
        listing_contract_date: this.iso(rec.listing_contract_date),
        listing_expiry_date: this.iso(rec.listing_expiry_date),
        comm_type: (rec.comm_type as string) ?? '',
        comm_value: this.num(rec.comm_value),
        mls_type: (rec.mls_type as string) ?? '',
        mls_num: (rec.mls_num as string) ?? '',
        mls_verified: this.yn(rec.mls_verified),
        payment_type: (rec.payment_type as string) ?? '',
        conditional_offer: this.yn(rec.conditional_offer),
        inter_board_enabled: this.yn(rec.inter_board_enabled),
        lawyer_name: (rec.lawyer_name as string) ?? '',
        lawyer_email: (rec.lawyer_email as string) ?? '',
        lawyer_phone: (rec.lawyer_phone as string) ?? '',
        lawyer_address: (rec.lawyer_address as string) ?? '',
        brokerage_name: brok?.name ?? '',
        brokerage_email: brok?.email ?? '',
        brokerage_phone: brok?.phone ?? '',
        brokerage_address: brok?.address ?? '',
        brokerage_agents: (brok?.brokerage_agents ?? []).map((a) => a.name).join(', '),
      };

      const row: (string | number)[] = [t.id, t.trade_no];
      for (const f of IMPORT_FIELDS) row.push(mainVal[f.key] ?? '');
      for (const f of FINANCIAL_FIELDS) {
        const v = rec[f.key];
        row.push(f.type === 'yesno' ? this.yn(v) : f.type === 'number' ? this.num(v) : ((v as string) ?? ''));
      }
      row.push(
        t.total.commission, t.total.hst, t.total.total,
        t.agentComm.commission, t.agentComm.hst, t.agentComm.total,
        t.brokerageComm.commission, t.brokerageComm.hst, t.brokerageComm.total,
        t.adjustments_total, t.cashback.total, t.referral?.total ?? 0, t.advance, t.agent_paid, t.agent_balance,
        t.agent_payment_status, t.commission_received ? 'Yes' : 'No', t.cta_to_ba,
        t.documentation_status, t.doc_counts.pending, t.doc_counts.invalid, t.doc_counts.valid,
        t.doc_counts.total, t.doc_counts.missing_mandatory, this.iso(t.last_doc_update), t.reco_audit_ready,
        t.lead_source ?? '', this.iso(t.created_at), this.iso(t.updated_at),
      );

      // ---- repeat groups, in the importer's own column order ----
      const members = r?.team_members ?? [];
      for (let i = 0; i < widest.team; i++) {
        const m = members[i];
        row.push(m?.name ?? '', m ? this.yn(m.is_primary) : '', m ? Number(m.split) : '',
          m ? Number(m.agent_pct) : '', m ? Number(m.brok_pct) : '', m?.access ?? '');
      }
      const clients = r?.clients ?? [];
      for (let i = 0; i < widest.clients; i++) {
        const c = clients[i];
        row.push(c?.name ?? '', c?.email ?? '', c?.phone ?? '');
      }
      const adjs = adjRowsFor(rec);
      for (let i = 0; i < widest.adjustments; i++) {
        const a = (adjs[i] ?? {}) as Record<string, unknown>;
        row.push(
          (a.Section as string) ?? '', (a.agent as string) ?? '', (a.client_name as string) ?? '',
          (a.brokerage as string) ?? '', this.num(a.amount), this.yn(a.is_loan), this.num(a.term),
          (a.paid_type as string) ?? '', this.iso(a.paid_date), (a.batch_no as string) ?? '',
          (a.paid_status as string) ?? '', (a.remarks as string) ?? '',
        );
      }
      const conds = r?.conditions ?? [];
      for (let i = 0; i < widest.conditions; i++) {
        const c = conds[i];
        row.push(c?.type ?? '', c?.custom_name ?? '', this.iso(c?.deadline), c?.status ?? '');
      }
      rows.push(row);
    }
    /*
     * TD-054 - the export obeys the same access level the screen does.
     *
     * Row scoping was already enforced here (an agent gets only their own deals); FIELD scoping
     * was not, so a docs-only member could download the rates and the deal totals in a file.
     * Applied as a post-pass over the finished table so it depends on the column NAMES rather
     * than on the order the row was assembled in.
     *
     * The member is matched with isMyMemberRow, the same rule the transaction resource uses -
     * id first, name only for legacy rows. A second spelling of that rule is how a namesake ends
     * up reading somebody else's money.
     */
    const MONEY = new Set([
      'Commission % / Amount', 'Commission Type', 'Commission Value',
      'Listing Commission %', 'Co-Op Commission %', 'Listing Commission Flat', 'Co-Op Commission Flat',
      'Trust Payable', 'Total Commission (Excl HST)', 'Total Commission HST', 'Total Commission (Incl HST)',
      'Agent Commission (Excl HST)', 'Agent Commission HST', 'Agent Commission (Incl HST)',
      'Brokerage Commission (Excl HST)', 'Brokerage Commission HST', 'Brokerage Commission (Incl HST)',
      'Adjustments Total', 'Cashback', 'Referral Fee', 'Advance Paid', 'Agent Paid', 'Agent Balance',
      'Commission Adjust Before', 'Commission Adjust After',
      'Listing Adjust Before', 'Listing Adjust After',
      'Co-Op Adjust Before', 'Co-Op Adjust After',
      'Precon Commission %', 'Precon Net of HST',
    ]);
    const hide = headers.map((h) => MONEY.has(h) || /^Team \d+ (Deal Share %|Agent %|Brokerage %)$/.test(h) || /^Adjustment \d+ Amount$/.test(h));
    if ((user.role ?? 'agent') === 'agent' && hide.some(Boolean)) {
      // The access level is read straight from team_members - the enriched row does not carry it.
      // One query for the whole selection, matched with the same isMyMemberRow rule the screen uses.
      const memberRows = await this.prisma.team_members.findMany({
        where: { transaction_id: { in: txns.map((x) => x.id) } },
        select: { transaction_id: true, user_id: true, name: true, access: true },
      });
      const docsOnly = new Set<number>();
      for (const t of txns) {
        const mine = memberRows.filter((m) => m.transaction_id === t.id).find((m) => isMyMemberRow(m, user));
        if (mine && mine.access === 'docs') docsOnly.add(t.id);
      }
      if (docsOnly.size) {
        for (const row of rows) {
          if (!docsOnly.has(Number(row[0]))) continue;
          for (let i = 0; i < row.length; i++) if (hide[i]) row[i] = '';
        }
      }
    }

    return { headers, rows, txns };
  }

  /**
   * "Download All Transactions" — one worksheet per transaction type, each carrying only
   * the fields that apply to that type, under merged group headings. The layout is defined
   * by the export specification; see download-all-export.ts.
   */
  async completeXlsx(sel: BulkSelection, user: AuthUserRecord): Promise<Buffer> {
    const txns = await this.resolve(sel, user, MAX_BULK_DATA_TRANSACTIONS);
    const raw = await this.rawInBatches<RawTxnRow>(txns.map((t) => t.id), {
      brokerages: { include: { brokerage_agents: { orderBy: { position: 'asc' } } } },
      team_members: { orderBy: { position: 'asc' } },
      clients: { orderBy: { position: 'asc' } },
      conditions: { orderBy: { position: 'asc' } },
    });
    const byId = new Map(raw.map((r) => [r.id, r]));
    const empty: RawTxnRow = { id: 0, brokerages: null, team_members: [], clients: [], conditions: [] };
    const rows: ExportRow[] = txns.map((t) => ({ t, raw: byId.get(t.id) ?? { ...empty, id: t.id } }));

    const wb = buildDownloadAllWorkbook(rows, {
      company: (await this.settings.current()).name,
      generatedBy: user.name,
      generatedAt: new Date(),
      filters: this.filterChips(sel),
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** The same complete table as CSV. */
  async completeCsv(sel: BulkSelection, user: AuthUserRecord): Promise<Buffer> {
    const { headers, rows } = await this.completeTable(sel, user);
    const cell = (v: string | number): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
    // BOM so Excel opens UTF-8 accented names correctly on a double-click.
    return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
  }

  // -------------------------------------------------------- data export PDF
  /** One consolidated PDF; every transaction starts on its own page. */
  async dataPdf(sel: BulkSelection, user: AuthUserRecord): Promise<Buffer> {
    const txns = await this.resolve(sel, user);
    const company = (await this.settings.current()).name;
    return this.renderPdf(txns, company, user.name);
  }

  /** Separate PDFs, one per transaction, packaged into a ZIP. */
  async dataPdfZip(sel: BulkSelection, user: AuthUserRecord, res: Response): Promise<void> {
    const txns = await this.resolve(sel, user);
    const company = (await this.settings.current()).name;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Transaction_PDFs_${this.stamp()}.zip"`);
    const zip = createZip({ zlib: { level: 6 } });
    zip.pipe(res);
    const used = new Set<string>();
    for (const t of txns) {
      const buf = await this.renderPdf([t], company, user.name);
      zip.append(buf, { name: this.unique(used, `${this.safe(`Deal-${t.trade_no}_${t.property ?? ''}`)}.pdf`) });
    }
    await zip.finalize();
  }

  /** Render a transaction dossier: reference, parties, financials, conditions, documents. */
  private async renderPdf(txns: EnrichedTxn[], company: string, by: string): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 44, left: 40, right: 40 }, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const money = (n: number) => '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    txns.forEach((t, i) => {
      if (i > 0) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#4f46e5').text(company, left, doc.page.margins.top, { width, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#0f172a').text(`Transaction ${t.trade_no}`, left, doc.y + 2, { width, align: 'center' });
      doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(t.property ?? '—', left, doc.y + 1, { width, align: 'center' });
      doc.moveDown(0.8);

      const section = (title: string, pairs: [string, string][]) => {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#312e81').text(title.toUpperCase(), left, doc.y, { width });
        doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor('#c7d2fe').lineWidth(1).stroke();
        doc.moveDown(0.4);
        const colW = width / 2;
        pairs.forEach(([k, v], n) => {
          const x = left + (n % 2) * colW;
          if (n % 2 === 0 && n > 0) doc.moveDown(0.05);
          const y = doc.y;
          doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text(k, x, y, { width: colW - 8 });
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a').text(v || '—', x, y + 9, { width: colW - 8 });
          if (n % 2 === 1 || n === pairs.length - 1) doc.y = y + 22; else doc.y = y;
        });
        doc.moveDown(0.6);
      };

      section('Transaction Reference', [
        ['Transaction ID', String(t.id)], ['Deal Number', t.trade_no],
        ['Transaction Type', t.type], ['Deal Status', t.statuses.join(', ') || '—'],
        ['Offer Date', this.d(t.offer_date) || '—'], ['Closing Date', this.d(t.closing_date) || '—'],
      ]);
      section('Agent Details', [
        ['Primary Agent', t.agent ?? '—'], ['All Agents', t.agent_names.join(', ') || '—'],
        ['Split Ratios', t.split_ratios.join(', ') || '—'], ['Agent Payment Status', t.agent_payment_status],
      ]);
      section('Client Details', [
        ['Clients', t.client_names.join(', ') || '—'], ['Conditional Offer', t.conditional_offer],
      ]);
      section('Financial Details', [
        ['Price', money(t.price)], ['Commission % / Amount', t.comm_display],
        ['Total Commission (excl. HST)', money(t.total.commission)], ['Total HST', money(t.total.hst)],
        ['Total Commission (incl. HST)', money(t.total.total)], ['Payment Type', t.payment_type ?? '—'],
      ]);
      section('Commission Details', [
        ['Agent Commission (excl. HST)', money(t.agentComm.commission)], ['Agent Commission (incl. HST)', money(t.agentComm.total)],
        ['Brokerage Commission (excl. HST)', money(t.brokerageComm.commission)], ['Brokerage Commission (incl. HST)', money(t.brokerageComm.total)],
        ['Agent Paid', money(t.agent_paid)], ['Agent Balance', money(t.agent_balance)],
      ]);
      section('Condition Details', t.conditions.length
        ? t.conditions.slice(0, 6).map((c) => [c.type, `${c.expiry_status}${c.deadline ? ' — ' + this.d(c.deadline) : ''}`] as [string, string])
        : [['Conditions', 'None recorded']]);
      section('Documentation Status', [
        ['Documentation Status', t.documentation_status], ['Total Documents', String(t.doc_counts.total)],
        ['Pending Documents', String(t.doc_counts.pending)], ['Invalid Documents', String(t.doc_counts.invalid)],
        ['Valid Documents', String(t.doc_counts.valid)], ['Missing Mandatory', String(t.doc_counts.missing_mandatory)],
        ['Waiver Documentation', t.waiver_status], ['Amendment Documentation', t.amendment_status],
      ]);
      section('RECO Audit & Internal Review', [
        ['RECO Audit Ready', t.reco_audit_ready], ['Last Review Date', this.d(t.reco_review_at) || '—'],
        ['RECO Remarks', t.reco_audit_remarks ?? '—'], ['CTA to BA', t.cta_to_ba],
      ]);
    });

    // footer on every page
    const range = doc.bufferedPageRange();
    const stamp = `Generated: ${longStamp(new Date())}  ·  by ${by}`;
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - 28;
      doc.font('Helvetica').fontSize(7).fillColor('#64748b');
      doc.text(stamp, left, y, { width: width / 2, align: 'left', lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = saved;
    }
    doc.end();
    return done;
  }

  // ------------------------------------------------------------- document ZIP
  /**
   * Stream a ZIP of the actual uploaded documents: one folder per transaction, category
   * subfolders inside it, and a manifest listing every file — including the ones that were
   * skipped and why. Files are streamed from disk, never buffered in memory.
   */
  async documentsZip(sel: BulkSelection, user: AuthUserRecord, res: Response): Promise<void> {
    const txns = await this.resolve(sel, user);
    const rows = await this.prisma.documents.findMany({
      where: { transaction_id: { in: txns.map((t) => t.id) }, deleted_at: null, pending_delete: false },
      select: { id: true, file_path: true, file_name: true, files: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    const entries: ZipEntry[] = [];
    const skipped: { txn: EnrichedTxn; doc: DocRow; reason: string }[] = [];
    const emptyFolders: { txn: EnrichedTxn; folder: string }[] = [];
    const usedPaths = new Set<string>();

    for (const t of txns) {
      const folder = this.safe(`Deal-${t.trade_no}_${t.property ?? 'no-address'}`);
      const docs = this.docsFor(t, sel);
      let any = false;
      for (const d of docs) {
        const rec = byId.get(d.id);
        const rel = rec?.file_path;
        if (!rel) { skipped.push({ txn: t, doc: d, reason: 'No file has been uploaded for this document.' }); continue; }
        const abs = path.join(STORAGE_ROOT, rel);
        if (!await this.exists(abs)) {
          skipped.push({ txn: t, doc: d, reason: 'The stored file is missing or inaccessible on disk.' });
          continue;
        }
        const original = rec.file_name || path.basename(rel);
        const ext = path.extname(original) || path.extname(rel) || '';
        // [DealNumber]_[Category]_[DocumentName]_[UploadDate].[ext]
        const base = this.safe(`${t.trade_no}_${d.category}_${d.title}_${(d.uploaded_at ?? '').slice(0, 10)}`);
        const zipPath = this.unique(usedPaths, `${folder}/${this.safe(d.category)}/${base}${ext}`);
        entries.push({ abs, zipPath, txn: t, doc: d, originalName: original });
        any = true;
      }
      if (!any) emptyFolders.push({ txn: t, folder });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Bulk_Transaction_Documents_${this.stamp()}.zip"`);
    const zip = createZip({ zlib: { level: 6 } });
    // One unreadable file must not abort the whole download.
    zip.on('warning', () => { /* ENOENT on a vanished file — already recorded in the manifest */ });
    zip.pipe(res);

    for (const e of entries) zip.file(e.abs, { name: e.zipPath });
    // a transaction with nothing to include still gets its folder, with an explanation
    for (const { folder } of emptyFolders) {
      zip.append('No documentation files are currently available for this transaction.\n', { name: `${folder}/README.txt` });
    }
    zip.append(await this.manifest(entries, skipped, txns, user, sel), { name: 'manifest.xlsx' });
    await zip.finalize();
  }

  /** The manifest: every included file, plus every skipped one with its reason. */
  private async manifest(entries: ZipEntry[], skipped: { txn: EnrichedTxn; doc: DocRow; reason: string }[], txns: EnrichedTxn[], user: AuthUserRecord, sel: BulkSelection): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Manifest');
    const head = ws.addRow([
      'Transaction ID', 'Deal Number', 'Property Address', 'Document ID', 'Document Name',
      'Document Category', 'Document Status', 'Required', 'Upload Date', 'Review Date',
      'Invalid Reason', 'Original Filename', 'Downloaded Filename', 'Folder Path in ZIP', 'Included', 'Exclusion Reason',
    ]);
    head.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
      c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    });

    const row = (t: EnrichedTxn, d: DocRow, original: string, zipPath: string | null, reason: string | null) => ws.addRow([
      t.id, t.trade_no, t.property, d.id, d.title, d.category, d.status, d.mandatory ? 'Yes' : 'No',
      this.d(d.uploaded_at), this.d(d.reviewed_at),
      d.status === 'Invalid' ? (d.remarks ?? 'Not specified') : '',
      original, zipPath ? path.basename(zipPath) : '', zipPath ? path.dirname(zipPath) : '',
      zipPath ? 'Yes' : 'No', reason ?? '',
    ]);
    for (const e of entries) row(e.txn, e.doc, e.originalName, e.zipPath, null);
    for (const s of skipped) row(s.txn, s.doc, '', null, s.reason);

    ws.columns.forEach((c) => {
      let max = 12;
      c.eachCell?.({ includeEmpty: false }, (cell) => { max = Math.max(max, String(cell.value ?? '').length + 2); });
      c.width = Math.min(48, max);
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const info = wb.addWorksheet('Download Info');
    info.addRow(['Field', 'Value']).font = { bold: true };
    info.addRow(['Generated', longStamp(new Date())]);
    info.addRow(['Generated By', user.name]);
    info.addRow(['Transactions', txns.length]);
    info.addRow(['Files included', entries.length]);
    info.addRow(['Files skipped', skipped.length]);
    for (const c of this.filterChips(sel)) info.addRow([c.label, c.value]);
    info.getColumn(1).width = 24; info.getColumn(2).width = 60;

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ------------------------------------------------------------------ utils
  /** Strip characters that are invalid in file names on any common platform. */
  private safe(s: string): string {
    return String(s)
      .replace(/[\\/:*?"<>| -]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/\.+$/, '')
      .trim()
      .slice(0, 120) || 'untitled';
  }

  /** Ensure a path is unique inside the archive, adding _01, _02 … when it isn't. */
  private unique(used: Set<string>, candidate: string): string {
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
    const dot = candidate.lastIndexOf('.');
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
    const ext = dot > 0 ? candidate.slice(dot) : '';
    for (let n = 1; n < 1000; n++) {
      const next = `${stem}_${String(n).padStart(2, '0')}${ext}`;
      if (!used.has(next)) { used.add(next); return next; }
    }
    const fallback = `${stem}_${Date.now()}${ext}`;
    used.add(fallback);
    return fallback;
  }

  private stamp(): string { return new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-'); }
}
