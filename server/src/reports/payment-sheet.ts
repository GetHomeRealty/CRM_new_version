import { BadRequestException, ForbiddenException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { AuthUserRecord } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import type { ReportColumn, ReportFilters, ReportRow, ReportSectionOut } from './report.types';

/**
 * THE PAYMENT SHEET, SHOWN AS WRITTEN (brokerage request, 2026-10-19).
 *
 * Pending Payments computes its rows from the deals. The brokerage keeps its own Payment Sheet and
 * asked for the report to show that sheet instead — the same rows, the same words, in the same
 * sections and order (its "Other Payments" block excepted). This holds it:
 *
 *   - an upload (an .xlsx in the template below) REPLACES the whole sheet, in one transaction;
 *   - while the sheet has rows, Pending Payments shows them and nothing computed (agents excepted —
 *     they keep the computed view of their own deals, since the sheet names everybody's payments);
 *   - removing the sheet returns the report to the computed rows.
 *
 * Nothing here reads or changes a deal. The sheet is text: a row names a deal by its trade number
 * only, and no amount, status or date on any deal moves because of it.
 */

/** Who may upload or remove the sheet — the same people who write Accounting Remarks on this report. */
export const SHEET_WRITERS: readonly string[] = ['admin', 'manager', 'accounting'];

export const SHEET_SECTIONS = [
  { key: 'client', label: 'Client Payments', description: 'Must make payments within 1 day (max 1-5 days)' },
  { key: 'coop', label: 'Co-op Payments', description: 'Must make payments within 7 Calender days' },
] as const;
export const SHEET_AGENT_GROUPS = ['Listing', 'Buying', 'Lease', 'Pre-Construction', 'National Bank'] as const;
const AGENT_NOTE = 'Must Review the Figures before final payment with Sai SIr for any Adjustments made if...';

/** The sheet's own columns, titled as the sheet titles them. Read-only: the sheet is changed by uploading it. */
export const SHEET_COLUMNS: ReportColumn[] = [
  { key: 'sl_no', label: 'Sl No.', type: 'number', default: true, width: 22 },
  { key: 'trade_no', label: 'Trade No.', type: 'text', default: true, width: 40 },
  { key: 'closing_date', label: 'Closing Date', type: 'date', default: true, width: 62 },
  { key: 'property', label: 'Property Name', type: 'text', default: true, width: 120 },
  { key: 'agent', label: 'Agent Name', type: 'text', default: true, width: 90 },
  { key: 'docs_status', label: 'Docs Status', type: 'text', default: true, width: 30 },
  { key: 'final_validation', label: 'Validation Status', type: 'text', default: true, width: 34 },
  { key: 'final_validation_remarks', label: 'Validation Comments', type: 'text', default: true, width: 80 },
  { key: 'payment_schedule', label: 'Payment Schedule', type: 'text', default: true, width: 100 },
  { key: 'sheet_remarks', label: 'Karishma Remarks', type: 'text', default: true, width: 110 },
];

/** The upload template's columns. Matched by title (case and spacing ignored), so their order is free. */
const TEMPLATE = [
  { key: 'section', header: 'Section', width: 18 },
  { key: 'agent_group', header: 'Group', width: 16 },
  { key: 'trade_no', header: 'Trade No', width: 12 },
  { key: 'closing_date', header: 'Closing Date', width: 18 },
  { key: 'property', header: 'Property Name', width: 40 },
  { key: 'agent_name', header: 'Agent Name', width: 30 },
  { key: 'docs_status', header: 'Docs Status', width: 10 },
  { key: 'validation_status', header: 'Validation Status', width: 12 },
  { key: 'validation_comments', header: 'Validation Comments', width: 36 },
  { key: 'payment_schedule', header: 'Payment Schedule', width: 40 },
  { key: 'remarks', header: 'Karishma Remarks', width: 44 },
] as const;
type TemplateKey = (typeof TEMPLATE)[number]['key'];

const MAX_ROWS = 2000;
const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** "Client Payments", "client", "Co-op" … → the section key; null when it names none. */
function sectionKey(v: string): 'client' | 'coop' | 'agent' | null {
  const n = norm(v);
  if (n.startsWith('client')) return 'client';
  if (n.startsWith('coop')) return 'coop';
  if (n.startsWith('agent')) return 'agent';
  return null;
}
function groupName(v: string): string | null {
  const n = norm(v);
  return SHEET_AGENT_GROUPS.find((g) => norm(g) === n) ?? null;
}

/** A cell as plain text — ExcelJS hands back rich text, formulas and hyperlinks as objects. */
function text(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('result' in o) return text(o.result as ExcelJS.CellValue);
    if ('text' in o) return String(o.text);
  }
  return String(v).trim();
}
/** A real date cell, an ISO date, or the sheet's "October 1, 2026" — anything else is refused by row. */
function parseDate(v: ExcelJS.CellValue): Date | null | 'bad' {
  if (v == null || v === '') return null;
  if (v instanceof Date) return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  const s = text(v);
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  const t = Date.parse(`${s} 00:00 UTC`);
  return Number.isFinite(t) ? new Date(t) : 'bad';
}

export interface SheetRowInput {
  section: string; agent_group: string | null; trade_no: string | null; closing_date: Date | null;
  property: string | null; agent_name: string | null; docs_status: string | null; validation_status: string | null;
  validation_comments: string | null; payment_schedule: string | null; remarks: string | null;
}

/** Read an uploaded template into rows, refusing the whole file — with the row named — on anything unclear. */
export async function parseSheetXlsx(buffer: Buffer): Promise<SheetRowInput[]> {
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(buffer as unknown as ArrayBuffer); } catch {
    throw new BadRequestException({ message: 'That file could not be read as an .xlsx workbook.' });
  }
  const ws = book.worksheets[0];
  if (!ws) throw new BadRequestException({ message: 'The workbook has no sheet.' });

  const headers = new Map<TemplateKey, number>();
  ws.getRow(1).eachCell((cell, col) => {
    const t = TEMPLATE.find((c) => norm(c.header) === norm(text(cell.value)) || (c.key === 'remarks' && norm(text(cell.value)) === 'remarks'));
    if (t) headers.set(t.key, col);
  });
  const missing = TEMPLATE.filter((c) => !headers.has(c.key)).map((c) => c.header);
  if (missing.length) throw new BadRequestException({ message: `The first row must hold the template's titles. Missing: ${missing.join(', ')}.` });

  const out: SheetRowInput[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k: TemplateKey) => row.getCell(headers.get(k)!).value;
    const s = (k: TemplateKey): string | null => text(get(k)) || null;
    if (TEMPLATE.every((c) => !text(get(c.key)))) continue;   // blank line
    const section = sectionKey(text(get('section')));
    if (!section) throw new BadRequestException({ message: `Row ${r}: Section must be Client Payments, Co-op Payments or Agent Payments.` });
    let group: string | null = null;
    if (section === 'agent') {
      group = groupName(text(get('agent_group')));
      if (!group) throw new BadRequestException({ message: `Row ${r}: Group must be one of ${SHEET_AGENT_GROUPS.join(', ')}.` });
    }
    const date = parseDate(get('closing_date'));
    if (date === 'bad') throw new BadRequestException({ message: `Row ${r}: Closing Date "${text(get('closing_date'))}" is not a date.` });
    out.push({
      section, agent_group: group, trade_no: s('trade_no'), closing_date: date,
      property: s('property'), agent_name: s('agent_name'), docs_status: s('docs_status'),
      validation_status: s('validation_status'), validation_comments: s('validation_comments'),
      payment_schedule: s('payment_schedule'), remarks: s('remarks'),
    });
    if (out.length > MAX_ROWS) throw new BadRequestException({ message: `A sheet holds at most ${MAX_ROWS} rows.` });
  }
  if (!out.length) throw new BadRequestException({ message: 'The sheet has no rows. To go back to the computed report, use Remove Pay Sheet instead.' });
  return out;
}

export function assertSheetWriter(user: AuthUserRecord): void {
  if (!SHEET_WRITERS.includes(user.role ?? '')) throw new ForbiddenException({ message: 'Only Super Admin, Admin or Accounting can change the Pay Sheet.' });
}

type StoredRow = Awaited<ReturnType<PrismaService['payment_sheet_rows']['findMany']>>[number];

export function loadSheet(prisma: PrismaService): Promise<StoredRow[]> {
  return prisma.payment_sheet_rows.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] });
}

/** Replace the whole sheet. One transaction, so a failed upload leaves the previous sheet in place. */
export async function replaceSheet(prisma: PrismaService, user: AuthUserRecord, rows: SheetRowInput[]): Promise<{ count: number }> {
  assertSheetWriter(user);
  const now = new Date();
  const write = async (tx: Pick<PrismaService, 'payment_sheet_rows'>) => {
    await tx.payment_sheet_rows.deleteMany({});
    await tx.payment_sheet_rows.createMany({
      data: rows.map((r, i) => ({ ...r, position: i + 1, uploaded_by: user.name ?? null, uploaded_at: now })),
    });
  };
  // Already inside a transaction (a caller's, or a test's), it joins that one instead of opening another.
  if (typeof (prisma as { $transaction?: unknown }).$transaction === 'function') await prisma.$transaction((tx) => write(tx));
  else await write(prisma);
  return { count: rows.length };
}

export async function clearSheet(prisma: PrismaService, user: AuthUserRecord): Promise<{ count: number }> {
  assertSheetWriter(user);
  const { count } = await prisma.payment_sheet_rows.deleteMany({});
  return { count };
}

export async function sheetInfo(prisma: PrismaService): Promise<{ count: number; uploaded_at: string | null; uploaded_by: string | null }> {
  const [count, first] = await Promise.all([
    prisma.payment_sheet_rows.count(),
    prisma.payment_sheet_rows.findFirst({ orderBy: { id: 'desc' }, select: { uploaded_at: true, uploaded_by: true } }),
  ]);
  return { count, uploaded_at: first?.uploaded_at.toISOString() ?? null, uploaded_by: first?.uploaded_by ?? null };
}

/** The template, filled with the sheet as it stands (empty when there is none) — download, edit, upload. */
export async function sheetTemplateXlsx(prisma: PrismaService): Promise<Buffer> {
  const rows = await loadSheet(prisma);
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('Pay Sheet', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = TEMPLATE.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  const label = (k: string) => (k === 'client' ? 'Client Payments' : k === 'coop' ? 'Co-op Payments' : 'Agent Payments');
  for (const r of rows) {
    const row = ws.addRow({
      section: label(r.section), agent_group: r.agent_group ?? '', trade_no: r.trade_no ?? '', closing_date: r.closing_date ?? '',
      property: r.property ?? '', agent_name: r.agent_name ?? '', docs_status: r.docs_status ?? '', validation_status: r.validation_status ?? '',
      validation_comments: r.validation_comments ?? '', payment_schedule: r.payment_schedule ?? '', remarks: r.remarks ?? '',
    });
    row.getCell('closing_date').numFmt = 'mmmm d, yyyy';
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

/**
 * The stored sheet as Pending Payments rows and sections, in the sheet's order. Search, Payment Head
 * and Agent narrow it as they narrow the computed report; filters that describe deal figures do not
 * apply to text and are ignored.
 */
export function sheetReport(rows: StoredRow[], f: ReportFilters): { rows: ReportRow[]; sections: ReportSectionOut[] } {
  const q = (f.search ?? '').trim().toLowerCase();
  const head = f.payment_head || '';
  const agents = (f.agent ?? []).map((a) => a.toLowerCase());
  const kept = rows.filter((r) => {
    if (head && r.section !== head) return false;
    if (agents.length && !agents.some((a) => (r.agent_name ?? '').toLowerCase().includes(a))) return false;
    if (q && ![r.trade_no, r.property, r.agent_name, r.validation_comments, r.payment_schedule, r.remarks]
      .some((v) => (v ?? '').toLowerCase().includes(q))) return false;
    return true;
  });

  const defs = [
    ...SHEET_SECTIONS.map((s) => ({ key: s.key, label: s.label, description: s.description as string | undefined, group: undefined as string | undefined, match: (r: StoredRow) => r.section === s.key })),
    ...SHEET_AGENT_GROUPS.map((g, i) => ({
      key: `agent_${norm(g)}`, label: g, group: 'Agent Payments', description: i === 0 ? AGENT_NOTE : undefined,
      match: (r: StoredRow) => r.section === 'agent' && r.agent_group === g,
    })),
  ];
  const out: ReportRow[] = [];
  const sections: ReportSectionOut[] = [];
  for (const d of defs) {
    const mine = kept.filter(d.match);
    if (!mine.length) continue;
    sections.push({ key: d.key, label: d.label, count: mine.length, ...(d.group ? { group: d.group } : {}), ...(d.description ? { description: d.description } : {}) });
    mine.forEach((r, i) => out.push({
      section: d.key, sl_no: i + 1, trade_no: r.trade_no, closing_date: r.closing_date ? r.closing_date.toISOString().slice(0, 10) : null,
      property: r.property, agent: r.agent_name, docs_status: r.docs_status, final_validation: r.validation_status,
      final_validation_remarks: r.validation_comments, payment_schedule: r.payment_schedule, sheet_remarks: r.remarks,
    }));
  }
  return { rows: out, sections };
}
