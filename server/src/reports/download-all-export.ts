import * as ExcelJS from 'exceljs';
import { isListingType } from '../reference/transaction.constants';
import type { EnrichedTxn } from './report-data.service';

/**
 * "Download All Transactions" — the Excel export defined by the Transaction Desk export
 * specification.
 *
 * The shape is deliberately NOT the flat one-sheet table the bulk importer round-trips:
 *   · one worksheet per transaction type, never mixed;
 *   · each sheet carries only the fields that apply to that type, so there are no columns
 *     that exist purely to force a common structure;
 *   · a merged group-header row (Data · Agents & Percentages · Documents and Status ·
 *     Financials · Advances & Adjustments · Payments) above the column-header row;
 *   · Trade Number, Offer Date, Closing Date, Property Address, MLS Number always first,
 *     in that order, on every sheet;
 *   · multi-valued data is concatenated into a single readable cell rather than spread
 *     across dynamic columns — never raw JSON, never internal ids.
 *
 * This is a reporting artifact. The importable file is the Bulk Import template.
 */

export const GROUPS = ['Data', 'Agents & Percentages', 'Documents and Status', 'Financials', 'Advances & Adjustments', 'Payments'] as const;
export type Group = typeof GROUPS[number];

/** How a cell is written and formatted. */
type Kind = 'text' | 'plain' | 'date' | 'money' | 'percent' | 'count';

/** The raw transaction row (with relations) the export flattens alongside the enriched one. */
export interface RawTxnRow {
  id: number;
  brokerages: {
    name: string | null; address: string | null; email: string | null; phone: string | null;
    agent_email?: string | null;
    brokerage_agents?: { name: string }[];
  } | null;
  team_members: { name: string; is_primary: boolean; split: unknown; agent_pct: unknown; brok_pct: unknown; access: string }[];
  clients: { name: string; email: string | null; phone: string | null }[];
  conditions: { type: string; custom_name: string | null; deadline: Date | null; status: string }[];
  [column: string]: unknown;
}

export interface ExportRow { t: EnrichedTxn; raw: RawTxnRow }

interface Col {
  header: string;
  group: Group;
  kind: Kind;
  /** Never dropped, even when every value is blank (the five required starting columns). */
  required?: boolean;
  wrap?: boolean;
  /** Column applies to this transaction type at all. */
  applies?: (type: string) => boolean;
  /** '' / null means "leave the cell blank"; 0 is a real value and is preserved. */
  value: (r: ExportRow) => string | number | Date | null;
}

// ---------------------------------------------------------------- type helpers
const isLease = (t: string): boolean => /lease/i.test(t);
const isPrecon = (t: string): boolean => t === 'Preconstruction';
const isReferral = (t: string): boolean => t === 'Referral';
/** Lawyer Details is hidden for lease / preconstruction / referral, as in the desk UI. */
const hasLawyer = (t: string): boolean => !isPrecon(t) && !isLease(t) && !isReferral(t);
/** Listing-side commission percentages only make sense where there are two sides. */
const hasSides = (t: string): boolean => !isReferral(t) && !isPrecon(t);

/** Excel forbids : \ / ? * [ ] in sheet names and caps them at 31 characters. */
export function sheetNameFor(type: string): string {
  const short = type
    .replace(/^Commercial Property /, 'Commercial ')
    .replace(/^Residential /, 'Residential ');
  return short.replace(/[:\\/?*[\]]/g, '-').slice(0, 31) || 'Transactions';
}

/** Price column label follows the deal shape, so a lease sheet never says "Sale Price". */
function priceHeader(type: string): string {
  if (isListingType(type)) return 'Listing Price';
  if (isLease(type)) return 'Lease Price';
  return 'Sale Price';
}

// ------------------------------------------------------------------ formatting
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const yn = (v: unknown): string => (v === true || v === 'Yes' || v === 1 ? 'Yes' : v === false || v === 'No' || v === 0 ? 'No' : '');
/** null when there is nothing to show; a real number (including 0) otherwise. */
const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Percentages are stored as 90 meaning 90% — Excel's percent format wants the fraction. */
const pct = (v: unknown): number | null => {
  const n = money(v);
  return n === null ? null : n / 100;
};
const asDate = (v: unknown): Date | null => {
  // Prisma hands back Date objects for date columns; the enriched view hands back
  // YYYY-MM-DD strings. Both reach this export, so both are accepted.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = str(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : d;
};
/** MM/DD/YYYY for values that live inside a concatenated text cell. */
const usDate = (v: unknown): string => {
  const d = asDate(v);
  return d ? `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}` : '';
};
const money2 = (v: unknown): string => {
  const n = money(v);
  return n === null ? '' : n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
/** Join labelled parts, dropping the ones with no value, so no "Email: undefined" ever ships. */
const parts = (pairs: [string, unknown][]): string =>
  pairs.map(([k, v]) => [k, str(v)] as const).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join(' | ');

// ------------------------------------------------------- concatenated cells
/** Lawyer details in ONE cell: name, email, phone, address. */
function lawyerCell(raw: RawTxnRow): string {
  return parts([
    ['Name', raw.lawyer_name], ['Email', raw.lawyer_email],
    ['Phone', raw.lawyer_phone], ['Address', raw.lawyer_address],
  ]);
}

/**
 * Every co-op agent in ONE cell, one per line. The data model holds a single
 * brokerage-level agent email, so it is attached to the first agent only rather than
 * repeated against names it may not belong to.
 */
function coopAgentsCell(raw: RawTxnRow): string {
  const agents = raw.brokerages?.brokerage_agents ?? [];
  const email = str(raw.brokerages?.agent_email);
  const phone = str(raw.brokerages?.phone);
  if (!agents.length) return '';
  return agents.map((a, i) => parts([
    [`Agent ${i + 1}`, a.name],
    ['Email', i === 0 ? email : ''],
    ['Phone', i === 0 ? phone : ''],
  ])).filter(Boolean).join('\n');
}

/** Internal team members other than the primary, one per line, with their percentages. */
function additionalAgentsCell(raw: RawTxnRow): string {
  const others = raw.team_members.filter((m) => !m.is_primary);
  if (!others.length) return '';
  return others.map((m, i) => parts([
    [`Agent ${i + 2}`, m.name],
    ['Role', m.access === 'full' ? 'Full access' : 'Documents only'],
    ['Deal Share', money(m.split) === null ? '' : `${money2(m.split)}%`],
    ['Agent', money(m.agent_pct) === null ? '' : `${money2(m.agent_pct)}%`],
    ['Brokerage', money(m.brok_pct) === null ? '' : `${money2(m.brok_pct)}%`],
  ])).filter(Boolean).join('\n');
}

/** Conditions as readable lines rather than a nested structure. */
function conditionsCell(raw: RawTxnRow): string {
  return raw.conditions.map((c) => {
    const name = str(c.custom_name) || str(c.type);
    const due = usDate(c.deadline);
    return [name, due ? `due ${due}` : '', str(c.status)].filter(Boolean).join(' — ');
  }).filter(Boolean).join('\n');
}

/** The adjustments JSON, rendered as readable lines. The blob itself is never exported. */
function adjustmentsCell(raw: RawTxnRow): string {
  let a: unknown = raw.adjustments;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  const blob = (a ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const rows = (k: string): Record<string, unknown>[] => (Array.isArray(blob[k]) ? blob[k] as Record<string, unknown>[] : []);

  for (const r of rows('adjustment_rows')) {
    const who = str(r.agent);
    const detail = parts([['Paid', r.paid_type], ['On', usDate(r.paid_date)], ['Batch', r.batch_no], ['Note', r.remarks]]);
    lines.push(`Agent Adjustment${r.is_loan ? ' (loan repayment)' : ''} — ${who || '—'}: ${money2(r.amount)}${detail ? ` | ${detail}` : ''}`);
  }
  for (const r of rows('advance_rows')) {
    const detail = parts([['Paid', r.paid_type], ['On', usDate(r.paid_date)], ['Batch', r.batch_no], ['Note', r.remarks]]);
    lines.push(`Advance Payment — ${str(r.agent) || '—'}: ${money2(r.amount)}${detail ? ` | ${detail}` : ''}`);
  }
  for (const r of rows('client_rows')) {
    const detail = parts([['Agent', r.agent], ['Paid', r.paid_type], ['On', usDate(r.paid_date)], ['Note', r.remarks]]);
    lines.push(`Client Referral — ${str(r.client_name) || '—'}: ${money2(r.amount)}${detail ? ` | ${detail}` : ''}`);
  }
  const ext = (blob.ext ?? {}) as Record<string, unknown>;
  if (Object.values(ext).some((v) => str(v) !== '' && v !== 'No')) {
    const detail = parts([['Agent', ext.agent_name], ['HST No', ext.hst_no], ['Paid', ext.paid_type], ['On', usDate(ext.paid_date)]]);
    lines.push(`External Referral — ${str(ext.brokerage) || '—'}: ${money2(ext.amount)}${detail ? ` | ${detail}` : ''}`);
  }
  return lines.join('\n');
}

/** The external referral percentage, when one was recorded. */
function referralPct(raw: RawTxnRow): number | null {
  let a: unknown = raw.adjustments;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  const ext = (((a ?? {}) as Record<string, unknown>).ext ?? {}) as Record<string, unknown>;
  return pct(ext.pct);
}

const primaryOf = (raw: RawTxnRow) => raw.team_members.find((m) => m.is_primary) ?? raw.team_members[0];

// ------------------------------------------------------------------- columns
/**
 * The full column catalogue. A sheet takes the columns whose `applies` accepts its type,
 * then drops any non-required column that is blank for every row on that sheet — that is
 * what keeps a Lease sheet free of listing-only fields and vice versa.
 */
function catalogue(type: string): Col[] {
  const cols: Col[] = [
    // ---- Data · the five required starting columns, in this exact order ----
    { header: 'Trade Number', group: 'Data', kind: 'text', required: true, value: ({ t }) => str(t.trade_no) },
    { header: 'Offer Date', group: 'Data', kind: 'date', required: true, value: ({ t }) => asDate(t.offer_date) },
    { header: 'Closing Date', group: 'Data', kind: 'date', required: true, value: ({ t }) => asDate(t.closing_date) },
    { header: 'Property Address', group: 'Data', kind: 'plain', required: true, value: ({ t }) => str(t.property) },
    { header: 'MLS Number', group: 'Data', kind: 'text', required: true, value: ({ raw }) => str(raw.mls_num) },

    // ---- Data · the rest ----
    { header: 'Transaction Type', group: 'Data', kind: 'plain', value: ({ t }) => t.type },
    {
      header: 'Listing Contract Date', group: 'Data', kind: 'date',
      applies: isListingType, value: ({ raw }) => asDate(raw.listing_contract_date),
    },
    {
      header: 'Listing Expiry Date', group: 'Data', kind: 'date',
      applies: isListingType, value: ({ raw }) => asDate(raw.listing_expiry_date),
    },
    {
      header: 'Listing Type', group: 'Data', kind: 'plain',
      applies: (t) => !isReferral(t),
      value: ({ raw }) => (str(raw.mls_type) === 'exclusive' ? 'Exclusive' : str(raw.mls_type) ? 'MLS' : ''),
    },
    { header: 'Clients', group: 'Data', kind: 'text', wrap: true, value: ({ raw }) => raw.clients.map((c) => parts([['Name', c.name], ['Email', c.email], ['Phone', c.phone]])).filter(Boolean).join('\n') },
    { header: 'Lawyer Details', group: 'Data', kind: 'text', wrap: true, applies: hasLawyer, value: ({ raw }) => lawyerCell(raw) },
    // Co-Op brokerage keeps discrete columns; only its AGENTS are concatenated.
    { header: 'Co-Op Brokerage Name', group: 'Data', kind: 'plain', applies: hasSides, value: ({ raw }) => str(raw.brokerages?.name) },
    { header: 'Co-Op Brokerage Email', group: 'Data', kind: 'plain', applies: hasSides, value: ({ raw }) => str(raw.brokerages?.email) },
    { header: 'Co-Op Brokerage Phone', group: 'Data', kind: 'text', applies: hasSides, value: ({ raw }) => str(raw.brokerages?.phone) },
    { header: 'Co-Op Brokerage Address', group: 'Data', kind: 'plain', applies: hasSides, value: ({ raw }) => str(raw.brokerages?.address) },
    { header: 'Co-Op Agents', group: 'Data', kind: 'text', wrap: true, applies: hasSides, value: ({ raw }) => coopAgentsCell(raw) },
    { header: 'Builder / Project', group: 'Data', kind: 'plain', applies: isPrecon, value: ({ raw }) => parts([['Builder', raw.builder_name], ['Project', raw.builder_project]]) },

    // ---- Agents & Percentages ----
    { header: 'Primary Agent', group: 'Agents & Percentages', kind: 'plain', value: ({ t }) => str(t.agent) },
    { header: 'Agent %', group: 'Agents & Percentages', kind: 'percent', value: ({ raw }) => pct(primaryOf(raw)?.agent_pct) },
    { header: 'Brokerage %', group: 'Agents & Percentages', kind: 'percent', value: ({ raw }) => pct(primaryOf(raw)?.brok_pct) },
    { header: 'Deal Share %', group: 'Agents & Percentages', kind: 'percent', value: ({ raw }) => pct(primaryOf(raw)?.split) },
    { header: 'Additional Agents', group: 'Agents & Percentages', kind: 'text', wrap: true, value: ({ raw }) => additionalAgentsCell(raw) },
    { header: 'Referral %', group: 'Agents & Percentages', kind: 'percent', value: ({ raw }) => referralPct(raw) },
    { header: 'Commission Agent', group: 'Agents & Percentages', kind: 'plain', applies: isPrecon, value: ({ raw }) => str(raw.commission_agent) },

    // ---- Documents and Status ----
    { header: 'Status', group: 'Documents and Status', kind: 'plain', value: ({ t }) => t.statuses.join(', ') },
    { header: 'Documentation Status', group: 'Documents and Status', kind: 'plain', value: ({ t }) => str(t.documentation_status) },
    { header: 'Conditional Offer', group: 'Documents and Status', kind: 'plain', applies: (t) => !isListingType(t), value: ({ raw }) => yn(raw.conditional_offer) },
    { header: 'Conditions', group: 'Documents and Status', kind: 'text', wrap: true, applies: (t) => !isListingType(t), value: ({ raw }) => conditionsCell(raw) },
    { header: 'Total Documents', group: 'Documents and Status', kind: 'count', value: ({ t }) => t.doc_counts.total },
    { header: 'Pending Documents', group: 'Documents and Status', kind: 'count', value: ({ t }) => t.doc_counts.pending },
    { header: 'Valid Documents', group: 'Documents and Status', kind: 'count', value: ({ t }) => t.doc_counts.valid },
    { header: 'Invalid Documents', group: 'Documents and Status', kind: 'count', value: ({ t }) => t.doc_counts.invalid },
    { header: 'Missing Mandatory Documents', group: 'Documents and Status', kind: 'count', value: ({ t }) => t.doc_counts.missing_mandatory },
    { header: 'RECO Audit Ready', group: 'Documents and Status', kind: 'plain', value: ({ t }) => str(t.reco_audit_ready) },
    { header: 'Last Document Update', group: 'Documents and Status', kind: 'date', value: ({ t }) => asDate(t.last_doc_update) },

    // ---- Financials ----
    { header: priceHeader(type), group: 'Financials', kind: 'money', value: ({ t }) => money(t.price) },
    { header: 'Deposit', group: 'Financials', kind: 'money', applies: (t) => !isReferral(t), value: ({ raw }) => money(raw.deposit) },
    { header: 'Commission %', group: 'Financials', kind: 'percent', value: ({ raw }) => pct(raw.comm_pct) },
    { header: 'Commission Amount', group: 'Financials', kind: 'money', value: ({ raw }) => money(raw.comm_amt) },
    { header: 'Listing Commission %', group: 'Financials', kind: 'percent', applies: hasSides, value: ({ raw }) => pct(raw.listing_comm_pct) },
    { header: 'Co-Op Commission %', group: 'Financials', kind: 'percent', applies: hasSides, value: ({ raw }) => pct(raw.coop_comm_pct) },
    { header: 'Total Commission (Excl HST)', group: 'Financials', kind: 'money', value: ({ t }) => money(t.total.commission) },
    { header: 'Total Commission HST', group: 'Financials', kind: 'money', value: ({ t }) => money(t.total.hst) },
    { header: 'Total Commission (Incl HST)', group: 'Financials', kind: 'money', value: ({ t }) => money(t.total.total) },
    { header: 'Agent Commission (Excl HST)', group: 'Financials', kind: 'money', value: ({ t }) => money(t.agentComm.commission) },
    { header: 'Agent Commission HST', group: 'Financials', kind: 'money', value: ({ t }) => money(t.agentComm.hst) },
    { header: 'Agent Commission (Incl HST)', group: 'Financials', kind: 'money', value: ({ t }) => money(t.agentComm.total) },
    { header: 'Brokerage Commission (Excl HST)', group: 'Financials', kind: 'money', value: ({ t }) => money(t.brokerageComm.commission) },
    { header: 'Brokerage Commission HST', group: 'Financials', kind: 'money', value: ({ t }) => money(t.brokerageComm.hst) },
    { header: 'Brokerage Commission (Incl HST)', group: 'Financials', kind: 'money', value: ({ t }) => money(t.brokerageComm.total) },
    { header: 'Trust Payable', group: 'Financials', kind: 'money', applies: hasSides, value: ({ raw }) => money(raw.trust_payable) },

    // ---- Advances & Adjustments ----
    { header: 'Advances', group: 'Advances & Adjustments', kind: 'money', value: ({ t }) => money(t.advance) },
    { header: 'Adjustments', group: 'Advances & Adjustments', kind: 'money', value: ({ t }) => money(t.adjustments_total) },
    { header: 'Cashback', group: 'Advances & Adjustments', kind: 'money', value: ({ t }) => money(t.cashback?.total) },
    { header: 'Referral Fee', group: 'Advances & Adjustments', kind: 'money', value: ({ t }) => money(t.referral?.total ?? null) },
    { header: 'Adjustment Details', group: 'Advances & Adjustments', kind: 'text', wrap: true, value: ({ raw }) => adjustmentsCell(raw) },

    // ---- Payments ----
    { header: 'Payments Received', group: 'Payments', kind: 'money', value: ({ t }) => money(t.agent_paid) },
    { header: 'Agent Balance', group: 'Payments', kind: 'money', value: ({ t }) => money(t.agent_balance) },
    { header: 'Agent Payment Status', group: 'Payments', kind: 'plain', value: ({ t }) => (t.agent_payment_status === 'Yes' ? 'Paid' : t.agent_payment_status === 'No' ? 'Not paid' : str(t.agent_payment_status)) },
    { header: 'Commission Received', group: 'Payments', kind: 'plain', value: ({ t }) => (t.commission_received ? 'Received' : 'Not received') },
    { header: 'Payment Type', group: 'Payments', kind: 'plain', value: ({ t }) => str(t.payment_type) },
    { header: 'Paid Date', group: 'Payments', kind: 'date', value: ({ t }) => asDate(t.agent_paid_date) },
    { header: 'CTA to BA', group: 'Payments', kind: 'plain', value: ({ t }) => str(t.cta_to_ba) },
  ];
  return cols.filter((c) => !c.applies || c.applies(type));
}

/** A cell that carries nothing. Zero is a value, not a blank — the spec is explicit. */
const isBlank = (v: string | number | Date | null): boolean => v === null || v === undefined || v === '';

// ------------------------------------------------------------------ workbook
const NUM_FMT: Record<Kind, string | undefined> = {
  text: '@',
  plain: undefined,
  date: 'mm/dd/yyyy',
  money: '#,##0.00',
  percent: '0.00%',
  count: '0',
};

const GROUP_FILL: Record<Group, string> = {
  'Data': 'FF7F1D1D',
  'Agents & Percentages': 'FF9A3412',
  'Documents and Status': 'FF854D0E',
  'Financials': 'FF166534',
  'Advances & Adjustments': 'FF1E40AF',
  'Payments': 'FF5B21B6',
};

/**
 * Build the workbook: one sheet per transaction type present in the data, in the order the
 * types are declared, each with its own applicable columns.
 */
export function buildDownloadAllWorkbook(rows: ExportRow[], meta: { company: string; generatedBy: string; generatedAt: Date; filters: { label: string; value: string }[] }): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.company;
  wb.created = meta.generatedAt;

  // Group by transaction type — never mix two types on one sheet.
  const byType = new Map<string, ExportRow[]>();
  for (const r of rows) {
    const list = byType.get(r.t.type);
    if (list) list.push(r); else byType.set(r.t.type, [r]);
  }

  const usedNames = new Set<string>();
  for (const [type, typeRows] of byType) {
    const all = catalogue(type);
    // Drop optional columns that are blank for every row on THIS sheet, so a type never
    // carries a column that exists only to match another type's layout.
    const cols = all.filter((c) => c.required || typeRows.some((r) => !isBlank(c.value(r))));

    let name = sheetNameFor(type);
    let n = 2;
    while (usedNames.has(name)) name = `${sheetNameFor(type).slice(0, 28)}-${n++}`;
    usedNames.add(name);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2, xSplit: 1 }] });

    // ---- row 1: merged group headings over each contiguous run of columns ----
    const groupRow = ws.getRow(1);
    let start = 1;
    for (let i = 0; i < cols.length; i++) {
      const last = i === cols.length - 1 || cols[i + 1].group !== cols[i].group;
      if (!last) continue;
      const from = start, to = i + 1;
      const cell = groupRow.getCell(from);
      cell.value = cols[i].group;
      if (to > from) ws.mergeCells(1, from, 1, to);
      for (let c = from; c <= to; c++) {
        const g = groupRow.getCell(c);
        g.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_FILL[cols[i].group] } };
        g.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        g.alignment = { vertical: 'middle', horizontal: 'center' };
        g.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
      }
      start = to + 1;
    }
    groupRow.height = 22;

    // ---- row 2: column headers ----
    const headRow = ws.getRow(2);
    cols.forEach((c, i) => {
      const cell = headRow.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: 'FF111827' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7E9' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF7F1D1D' } } };
    });
    headRow.height = 30;

    // ---- data ----
    typeRows.forEach((r, ri) => {
      const row = ws.getRow(ri + 3);
      cols.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        const v = c.value(r);
        // Blank stays blank; 0 is written.
        if (isBlank(v)) { cell.value = null; }
        else if (c.kind === 'text') { cell.value = String(v); }
        else { cell.value = v as string | number | Date; }
        const fmt = NUM_FMT[c.kind];
        if (fmt) cell.numFmt = fmt;
        cell.alignment = c.wrap
          ? { wrapText: true, vertical: 'top' }
          : { vertical: 'top', horizontal: c.kind === 'money' || c.kind === 'percent' || c.kind === 'count' ? 'right' : 'left' };
      });
    });

    // ---- filters over the column-header row, and column widths ----
    ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: cols.length } };
    cols.forEach((c, i) => {
      let width = c.header.length + 4;
      for (const r of typeRows) {
        const v = c.value(r);
        if (isBlank(v)) continue;
        const text = v instanceof Date ? '00/00/0000' : String(v);
        // A wrapped cell is sized for its longest LINE, not its whole contents.
        const longest = Math.max(...text.split('\n').map((s) => s.length));
        width = Math.max(width, longest + 2);
      }
      // Reasonable max width: wrapped concatenations get more room, everything else less.
      ws.getColumn(i + 1).width = Math.min(c.wrap ? 52 : 28, Math.max(10, width));
    });
  }

  // ---- provenance (kept off the transaction sheets so no type is ever mixed) ----
  const info = wb.addWorksheet('Export Info');
  const ih = info.addRow(['Field', 'Value']);
  ih.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7F1D1D' } };
  });
  info.addRow(['Report', 'Download All Transactions']);
  info.addRow(['Generated', meta.generatedAt.toISOString().slice(0, 19).replace('T', ' ')]);
  info.addRow(['Generated By', meta.generatedBy]);
  info.addRow(['Brokerage', meta.company]);
  info.addRow(['Transactions', rows.length]);
  info.addRow(['Sheets', [...byType.keys()].map((t) => `${sheetNameFor(t)} (${byType.get(t)!.length})`).join(', ')]);
  for (const f of meta.filters) info.addRow([f.label, f.value]);
  info.addRow(['Note', 'One worksheet per transaction type; each carries only the fields that apply to that type. Uploaded document files are not included — use “Download Documents” for those.']);
  info.getColumn(1).width = 18;
  info.getColumn(2).width = 110;
  info.eachRow((r) => r.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; }));

  return wb;
}
