import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsWriteService } from '../transactions/transactions-write.service';
import { TRANSACTION_TYPES, isListingType, statusOptionsFor, defaultStatusFor } from '../reference/transaction.constants';
import {
  IMPORT_FIELDS, FINANCIAL_FIELDS, CHILD_SHEETS, REQUIRED_COLUMNS, REF_COLUMN,
  requiredColumnsFor, forbiddenColumnsFor, statusReference, flatColumn, flatColumns,
  type ImportField, type ChildSheet,
} from './import-template';

import { isSuperAdmin } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/** Child column lists, resolved once, for the per-area format checks. */
const childFields = (key: ChildSheet['key']): ImportField[] =>
  CHILD_SHEETS.find((c) => c.key === key)?.fields ?? [];
const TEAM_COLS = childFields('team');
const CLIENT_COLS = childFields('clients');
const ADJUSTMENT_COLS = childFields('adjustments');
const CONDITION_COLS = childFields('conditions');

/** One problem found on one row. Mirrors the downloadable validation report columns. */
export interface RowIssue {
  row: number;             // 1-based row number as it appears in the user's file
  reference: string;       // property address / type, so the row is recognisable
  field: string;           // template column name
  value: string;           // what they typed
  message: string;         // what is wrong
  fix: string;             // suggested correction
  severity: 'error' | 'warning' | 'duplicate';
  /** Which area the problem is in — '' for the main Transactions row. */
  section?: string;
}

/** The areas written after the transaction itself exists. Order is the write order. */
export const SECTIONS = ['Financial', 'Team Split', 'Clients', 'Conditions', 'Adjustments', 'Co-Op Brokerage'] as const;
export type SectionName = typeof SECTIONS[number];

/** A transaction plus every child collection, normalised out of either upload layout. */
export interface ParsedRow {
  row: number;
  ref: string;
  reference: string;
  /** Body for TransactionsWriteService.store(). */
  data: Record<string, unknown>;
  /** Per-section bodies for the follow-up update(); only non-empty sections appear. */
  sections: Partial<Record<SectionName, Record<string, unknown>>>;
  issues: RowIssue[];
  valid: boolean;
  duplicate: boolean;
  warning: boolean;
}

export interface ImportPreview {
  batch_id: string;
  file_name: string;
  /** 'multi-sheet' or 'one-sheet' — echoed back so the user can confirm we read it as intended. */
  layout: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  warning_rows: number;
  /** How many child rows were found per area across the whole file. */
  section_counts: Record<string, number>;
  issues: RowIssue[];
  /** A sample of what will be created, so the user can eyeball it before confirming. */
  sample: Record<string, unknown>[];
}

export interface ImportResult {
  batch_id: string;
  status: string;
  total_rows: number;
  imported_rows: number;
  failed_rows: number;
  duplicate_rows: number;
  /** Sections that could not be written for an otherwise-created transaction. */
  skipped_sections: number;
  issues: RowIssue[];
  created: { row: number; trade_no: string; property: string | null; sections: string[]; skipped: string[] }[];
}

/** Hard ceiling on one upload — protects the API from an accidental enormous file. */
export const MAX_IMPORT_ROWS = 1000;
/** Ceiling on child rows, so a malformed child sheet can't blow up memory. */
const MAX_CHILD_ROWS = 20000;

/** Raw rows for one transaction, straight off the file and before any validation. */
interface RawRecord {
  row: number;
  ref: string;
  main: Record<string, string>;
  financial: Record<string, string>;
  children: Record<string, Record<string, string>[]>;
}

interface ParsedFile {
  layout: 'multi-sheet' | 'one-sheet';
  records: RawRecord[];
  /** Header names found on the main sheet, for the missing-column check. */
  headers: string[];
}

const HEADER_FILL = 'FF4F46E5';
const REQUIRED_FILL = 'FFB91C1C';
const CHILD_FILL = 'FF0F766E';

@Injectable()
export class TransactionImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly write: TransactionsWriteService,
  ) {}

  /**
   * TD-103 — bulk import is Super Admin work.
   *
   * This refused `agent` and nothing else, so every other role holding `transactions: edit` —
   * manager, accounting and documentation — passed both this and the controller's screen guard and
   * could run a real import. A billing seat could create transactions in bulk.
   *
   * Kept as well as `AdminGuard` on the controller rather than removed in favour of it. The guard
   * is what actually answers the request today, including on `template` and `sample` which take no
   * user; this is the same rule stated where the work happens, so a route added later without the
   * guard is refused rather than quietly open. Both ask `isSuperAdmin`, so there is one definition
   * of the tier and two places that consult it.
   */
  private assertCanImport(user: AuthUserRecord): void {
    if (!isSuperAdmin(user)) {
      throw new ForbiddenException({ message: 'You do not have permission to bulk import transactions.' });
    }
  }

  // ---------------------------------------------------------------- template
  /**
   * The downloadable template. It carries BOTH supported layouts so one file answers
   * "how do I fill this in?" whichever way the user prefers to work:
   *   · Transactions + Financial + one sheet per child area  → full fidelity
   *   · "One-Sheet (CSV)"                                    → single sheet, CSV-friendly
   * Plus an Instructions sheet and a per-type status Reference.
   */
  async template(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Transaction Desk';

    // --- sheet 1: the main sheet ---
    const ws = wb.addWorksheet('Transactions');
    this.writeHeader(ws, [REF_COLUMN, ...IMPORT_FIELDS.map((f) => f.column)],
      [undefined, ...IMPORT_FIELDS.map((f) => f)]);
    const example = ws.addRow(['1', ...this.mainExampleRow()]);
    example.eachCell((cell) => {
      cell.font = { italic: true, color: { argb: 'FF64748B' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    });
    /*
     * TD-098 — the note said the row is "ignored on import". It is not: the importer reads it,
     * validates it and reports it like any other row. Saying otherwise invited somebody to upload
     * the template untouched and be told their file was invalid. It says what actually happens now.
     *
     * A cell note is also only half of it — it appears on hover and lives outside the workbook's
     * shared strings, so a reader scanning the file never sees it. The Instructions sheet carries
     * the same point in plain sight; see `writeGuide`.
     */
    ws.getCell(`A${example.number}`).note = 'Row 2 is an example. Type over it or delete it before importing — it is read like any other row, not skipped.\n\nRef ties the child sheets to this transaction. Any unique value works; 1, 2, 3… is easiest.';
    ws.getColumn(1).width = 8;
    IMPORT_FIELDS.forEach((f, i) => { ws.getColumn(i + 2).width = Math.max(16, Math.min(34, f.column.length + 6)); });
    ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
    IMPORT_FIELDS.forEach((f, i) => this.applyValidation(ws, i + 2, f));

    // --- sheet 2: the 1:1 financial block ---
    const fin = wb.addWorksheet('Financial');
    this.writeHeader(fin, [REF_COLUMN, ...FINANCIAL_FIELDS.map((f) => f.column)],
      [undefined, ...FINANCIAL_FIELDS]);
    fin.addRow(['1', ...FINANCIAL_FIELDS.map((f) => f.example)]).eachCell((c) => {
      c.font = { italic: true, color: { argb: 'FF64748B' } };
    });
    fin.getColumn(1).width = 8;
    FINANCIAL_FIELDS.forEach((f, i) => { fin.getColumn(i + 2).width = Math.max(16, Math.min(30, f.column.length + 6)); });
    fin.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
    FINANCIAL_FIELDS.forEach((f, i) => this.applyValidation(fin, i + 2, f));
    fin.getCell('A2').note = 'One row per transaction, matched to the Transactions sheet by Ref. Leave a column blank to keep the system default.';

    // --- sheets 3..n: one per child area ---
    for (const child of CHILD_SHEETS) {
      const cs = wb.addWorksheet(child.sheet);
      this.writeHeader(cs, [REF_COLUMN, ...child.fields.map((f) => f.column)], [undefined, ...child.fields], CHILD_FILL);
      cs.addRow(['1', ...child.fields.map((f) => f.example)]).eachCell((c) => {
        c.font = { italic: true, color: { argb: 'FF64748B' } };
      });
      cs.getColumn(1).width = 8;
      child.fields.forEach((f, i) => { cs.getColumn(i + 2).width = Math.max(16, Math.min(30, f.column.length + 6)); });
      cs.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
      child.fields.forEach((f, i) => this.applyValidation(cs, i + 2, f));
      cs.getCell('A2').note = `${child.note}\n\nAdd as many rows per Ref as you need — there is no limit on this sheet.`;
    }

    // --- the single-sheet alternative, for CSV users ---
    const flat = wb.addWorksheet('One-Sheet (CSV)');
    const cols = flatColumns();
    this.writeHeader(flat, cols, cols.map((c) => this.fieldForFlatColumn(c)));
    flat.getRow(1).height = 30;
    cols.forEach((c, i) => { flat.getColumn(i + 1).width = Math.max(14, Math.min(30, c.length + 4)); });
    flat.views = [{ state: 'frozen', ySplit: 1 }];
    flat.addRow(this.flatExampleRow());
    flat.getCell('A2').note = 'Use this sheet INSTEAD of the others if you prefer one wide sheet, or need plain CSV.\n\n'
      + `Caps per transaction: ${CHILD_SHEETS.map((c) => `${c.flatMax} ${c.sheet.toLowerCase()}`).join(', ')}. `
      + 'Need more than that? Use the multi-sheet layout.';

    // --- how to fill it in ---
    this.writeInstructions(wb);

    // --- the valid statuses per type ---
    const ref = wb.addWorksheet('Reference');
    this.writeHeader(ref, ['Transaction Type', 'Valid Deal Statuses'], [undefined, undefined]);
    for (const { type, statuses } of statusReference()) ref.addRow([type, statuses.join(' | ')]);
    ref.getColumn(1).width = 34; ref.getColumn(2).width = 90;

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ------------------------------------------------------------------ sample
  /**
   * A WORKED example: the same sheets as the template, already filled with four deals
   * across four transaction types. Agent names are pulled from the live user list, so the
   * file validates unchanged on this installation rather than failing on placeholder names
   * the user then has to guess at.
   */
  async sample(): Promise<Buffer> {
    const users = await this.prisma.users.findMany({
      where: { status: 'Active' }, select: { name: true }, orderBy: { id: 'asc' }, take: 3,
    });
    const names = users.map((u) => u.name).filter(Boolean);
    // Falls back to obviously-fake names when the installation has no active users yet.
    const [a1 = 'Agent One', a2 = names[0] ?? 'Agent Two', a3 = names[0] ?? 'Agent Three'] = names;

    const txns: Record<string, string>[] = [
      {
        Ref: 'T1', 'Transaction Type': 'Residential Buying', 'Property Address': '212 Prosser Circle, Oshawa, ON',
        'Deal Status': 'Secured Firm', 'Primary Agent': a1, Price: '840000', Deposit: '30000',
        'Offer Date': '2026-03-14', 'Closing Date': '2026-06-30', 'Commission Type': '%', 'Commission Value': '2.5',
        'MLS Type': 'mls', 'MLS Number': 'W12467618', 'MLS Verified': 'Yes', 'Payment Type': 'Cheque',
        'Conditional Offer': 'Yes', 'Inter-Board Listing': 'No',
        'Lawyer Name': 'John Smith', 'Lawyer Email': 'john@example.com', 'Lawyer Phone': '416-000-0000',
        'Lawyer Address': '123 Main Street, Toronto, ON',
        'Co-Op Brokerage Name': 'Sample Realty Inc.', 'Co-Op Brokerage Email': 'office@samplerealty.ca',
        'Co-Op Brokerage Phone': '905-000-0000', 'Co-Op Brokerage Address': '99 King St E, Oshawa, ON',
        'Co-Op Brokerage Agents': 'Michael Brown, Sarah Lee',
      },
      {
        Ref: 'T2', 'Transaction Type': 'Residential Lease', 'Property Address': '5 Elm Avenue, Unit 402, Toronto, ON',
        'Deal Status': 'Secured Firm', 'Primary Agent': a2, Price: '3200', Deposit: '6400',
        'Offer Date': '2026-04-01', 'Closing Date': '2026-05-01', 'Commission Type': 'Fixed', 'Commission Value': '3200',
        'MLS Type': 'mls', 'MLS Number': 'C12500001', 'Conditional Offer': 'No', 'Payment Type': 'TDB-EFT',
      },
      {
        Ref: 'T3', 'Transaction Type': 'Residential Sale Listing', 'Property Address': '9 Oak Road, Whitby, ON',
        'Deal Status': 'Active', 'Primary Agent': a1,
        'Listing Contract Date': '2026-03-01', 'Listing Expiry Date': '2026-09-01',
        'MLS Type': 'mls', 'MLS Number': 'E12488990', 'MLS Verified': 'Yes',
      },
      {
        Ref: 'T4', 'Transaction Type': 'Preconstruction', 'Property Address': '77 Tower Blvd, Suite 1802, Mississauga, ON',
        'Deal Status': 'Open', 'Primary Agent': a3, Price: '695000', Deposit: '35000',
        'Offer Date': '2026-02-10', 'Closing Date': '2028-11-30', 'Commission Type': '%', 'Commission Value': '3',
        'MLS Type': 'exclusive', 'Conditional Offer': 'No',
      },
    ];
    const financial: Record<string, string>[] = [
      { Ref: 'T1', 'Listing Commission %': '2.5', 'Co-Op Commission %': '2.5', 'Trust Payable': '12000', 'Commission Status': 'Pending', 'Agent Paid Status': 'No' },
      { Ref: 'T2', 'Commission Status': 'Pending', 'Agent Paid Status': 'No' },
      { Ref: 'T3', 'Listing Commission %': '2.5', 'Co-Op Commission %': '2.5' },
      { Ref: 'T4', 'Precon Listing Type': 'exclusive', 'Precon Term Count': '2', 'Precon Commission %': '3', 'Precon Net of HST': 'No', 'Commission Agent': a3 },
    ];
    const children: Record<ChildSheet['key'], Record<string, string>[]> = {
      team: [
        { Ref: 'T1', Agent: a1, Primary: 'Yes', 'Deal Share %': '60', 'Agent %': '90', 'Brokerage %': '10', Access: 'full' },
        { Ref: 'T1', Agent: a2, Primary: 'No', 'Deal Share %': '40', 'Agent %': '80', 'Brokerage %': '20', Access: 'docs' },
        { Ref: 'T2', Agent: a2, Primary: 'Yes', 'Deal Share %': '100', 'Agent %': '85', 'Brokerage %': '15', Access: 'full' },
        { Ref: 'T3', Agent: a1, Primary: 'Yes', 'Deal Share %': '100', 'Agent %': '90', 'Brokerage %': '10', Access: 'full' },
        { Ref: 'T4', Agent: a3, Primary: 'Yes', 'Deal Share %': '100', 'Agent %': '90', 'Brokerage %': '10', Access: 'full' },
      ],
      clients: [
        { Ref: 'T1', Name: 'Jane Ng', Email: 'jane.ng@example.com', Phone: '416-555-0180' },
        { Ref: 'T1', Name: 'Robert Ng', Email: 'rob.ng@example.com', Phone: '416-555-0181' },
        { Ref: 'T2', Name: 'Priya Menon', Email: 'priya@example.com', Phone: '647-555-0112' },
        { Ref: 'T3', Name: 'Daniel Cross', Email: 'dcross@example.com', Phone: '905-555-0133' },
        { Ref: 'T4', Name: 'Wei Zhang', Email: 'wei.zhang@example.com', Phone: '437-555-0155' },
      ],
      adjustments: [
        { Ref: 'T1', Section: 'Agent Adjustment', Agent: a1, Amount: '500', 'Is Loan': 'No', Remarks: 'Marketing contribution' },
        { Ref: 'T1', Section: 'Advance Payment', Agent: a1, Amount: '1000', 'Paid Type': 'Cheque', 'Paid Date': '2026-05-02', 'Batch No': 'B-1042' },
        { Ref: 'T1', Section: 'Client Referral', 'Client Name': 'Jane Ng', Amount: '250', Remarks: 'Referred by a past client' },
        { Ref: 'T4', Section: 'Agent Adjustment', Agent: a3, Amount: '300', 'Is Loan': 'No', Term: '1', Remarks: 'Term 1 adjustment' },
      ],
      conditions: [
        { Ref: 'T1', 'Condition Type': 'Financing', Deadline: '2026-03-28', Status: 'Pending' },
        { Ref: 'T1', 'Condition Type': 'Home Inspection', Deadline: '2026-03-25', Status: 'Fulfilled' },
        { Ref: 'T1', 'Condition Type': 'Custom', 'Custom Name': 'Lender approval letter', Deadline: '2026-03-30', Status: 'Pending' },
      ],
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Transaction Desk';

    const filled = (name: string, fields: ImportField[], rows: Record<string, string>[], fill: string): void => {
      const ws = wb.addWorksheet(name);
      const columns = [REF_COLUMN, ...fields.map((f) => f.column)];
      this.writeHeader(ws, columns, [undefined, ...fields], fill);
      for (const r of rows) ws.addRow(columns.map((c) => r[c] ?? ''));
      ws.getColumn(1).width = 8;
      fields.forEach((f, i) => { ws.getColumn(i + 2).width = Math.max(16, Math.min(34, f.column.length + 6)); });
      ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
      fields.forEach((f, i) => this.applyValidation(ws, i + 2, f));
    };

    filled('Transactions', IMPORT_FIELDS, txns, HEADER_FILL);
    filled('Financial', FINANCIAL_FIELDS, financial, HEADER_FILL);
    for (const child of CHILD_SHEETS) filled(child.sheet, child.fields, children[child.key], CHILD_FILL);

    // The same four deals in the one-sheet layout, for anyone who prefers plain CSV.
    const flat = wb.addWorksheet('One-Sheet (CSV)');
    const cols = flatColumns();
    this.writeHeader(flat, cols, cols.map((c) => this.fieldForFlatColumn(c)));
    flat.getRow(1).height = 30;
    for (const t of txns) {
      const rec: Record<string, string> = { ...t };
      delete rec[REF_COLUMN];
      Object.assign(rec, Object.fromEntries(Object.entries(financial.find((f) => f.Ref === t.Ref) ?? {}).filter(([k]) => k !== REF_COLUMN)));
      for (const child of CHILD_SHEETS) {
        children[child.key].filter((r) => r.Ref === t.Ref).forEach((r, n) => {
          if (n >= child.flatMax) return;
          for (const f of child.fields) if (r[f.column]) rec[flatColumn(child, n + 1, f)] = r[f.column];
        });
      }
      flat.addRow(cols.map((c) => rec[c] ?? ''));
    }
    cols.forEach((c, i) => { flat.getColumn(i + 1).width = Math.max(14, Math.min(30, c.length + 4)); });
    flat.views = [{ state: 'frozen', ySplit: 1 }];

    // ---- how to use this file ----
    const read = wb.addWorksheet('Read Me');
    const h = (text: string): void => { read.addRow([text]).font = { bold: true, size: 12 }; };
    h('This is a filled EXAMPLE, not a blank template');
    read.addRow(['']);
    for (const line of [
      'Four transactions are already filled in, one per transaction type, so you can see exactly what a valid file looks like.',
      'Replace the example rows with your own data and upload the file. Delete any rows you do not need.',
      `Agent names come from this system's active users (${names.join(', ') || 'none found'}) — they must match exactly.`,
      'The Ref column ties a child row to its transaction. Any unique value works: T1, T2, 1, 2 …',
      'Fill EITHER the multi-sheet layout (Transactions + Financial + Team Split + Clients + Adjustments + Conditions) OR the "One-Sheet (CSV)" sheet — not both.',
      'If both are filled, the Transactions sheet wins and the One-Sheet tab is ignored. To use the one-sheet layout, clear the Transactions sheet (or save just that tab as .csv).',
      'Dates are YYYY-MM-DD. Numbers are digits only — no $ and no commas.',
      'Only Transaction Type and Property Address are required for every row. Deal types also need Price, Offer Date, Closing Date, Commission Type and Commission Value; listing types need the two listing dates instead.',
      'Deal Status must be valid for the type — see the Reference sheet of the blank template (Download Template).',
      'Legal & Documentation cannot be imported; documents are uploaded per transaction.',
    ]) read.addRow(['', line]);
    read.getColumn(1).width = 4;
    read.getColumn(2).width = 120;
    read.eachRow((r) => r.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; }));

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Bold, filled header row; required columns are visually distinct so they can't be missed. */
  private writeHeader(ws: ExcelJS.Worksheet, columns: string[], fields: (ImportField | undefined)[], fill = HEADER_FILL): void {
    const header = ws.addRow(columns);
    header.height = 26;
    header.eachCell((cell, i) => {
      const f = fields[i - 1];
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f?.required ? REQUIRED_FILL : fill } };
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      if (f) cell.note = `${f.hint}\n\nExample: ${f.example}`;
      else if (columns[i - 1] === REF_COLUMN) cell.note = 'Ties this row to a transaction on the Transactions sheet. Required on every child sheet.';
    });
  }

  private writeInstructions(wb: ExcelJS.Workbook): void {
    const guide = wb.addWorksheet('Instructions');
    const head = (text: string) => { const r = guide.addRow([text]); r.font = { bold: true, size: 12 }; return r; };

    head('How to fill this template in');
    guide.addRow(['']);
    // TD-098 — said first, and on the sheet rather than in a hover note, because a reader who
    // misses it uploads the scaffold row and is told their own file is invalid.
    guide.addRow(['', 'Row 2 of every sheet is a greyed-out EXAMPLE. Type over it or delete it before you import — it is read like any other row, not skipped, and it will be reported as invalid if left as it is.']);
    guide.addRow(['']);
    guide.addRow(['', 'Option A — multi-sheet (recommended): fill the Transactions sheet, then add rows to Financial, Team Split, Clients, Adjustments and Conditions. Tie every child row to its transaction with the Ref column. No limit on how many children a deal can have.']);
    guide.addRow(['', 'Option B — one sheet: fill the "One-Sheet (CSV)" sheet only, and save it as .csv or .xlsx. Repeating data goes in numbered columns. This is the only layout plain CSV can express.']);
    guide.addRow(['', 'Upload whichever you used — the importer detects the layout automatically. Do not mix the two in one file.']);
    guide.addRow(['', 'If both are filled the Transactions sheet wins and the "One-Sheet (CSV)" tab is ignored. To use the one-sheet layout, leave the Transactions sheet empty, or save that tab on its own as .csv.']);
    guide.addRow(['']);

    head('Columns');
    const colHead = guide.addRow(['Sheet', 'Column', 'Required', 'Format / accepted values', 'Example']);
    colHead.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    });
    const req = (f: ImportField) => f.required ? 'Always' : f.requiredForDeals ? 'Deal types only' : f.requiredForListings ? 'Listing types only' : 'Optional';
    for (const f of IMPORT_FIELDS) guide.addRow(['Transactions', f.column, req(f), f.hint, f.example]);
    for (const f of FINANCIAL_FIELDS) guide.addRow(['Financial', f.column, 'Optional', f.hint, f.example]);
    for (const child of CHILD_SHEETS) {
      for (const f of child.fields) guide.addRow([child.sheet, f.column, f.required ? 'Always' : 'Optional', f.hint, f.example]);
    }
    guide.getColumn(1).width = 18; guide.getColumn(2).width = 26; guide.getColumn(3).width = 18;
    guide.getColumn(4).width = 74; guide.getColumn(5).width = 26;
    guide.eachRow((r) => r.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; }));

    guide.addRow(['']);
    head('Notes');
    for (const note of [
      'Listing types (Sale Listing / Lease Listing) must leave Price, Deposit, Offer Date, Closing Date, Commission Type and Commission Value blank.',
      'Deal types must leave Listing Contract Date and Listing Expiry Date blank.',
      'Trade numbers are generated automatically — do not supply them.',
      'Rows that fail validation are reported and skipped; the valid rows are still imported.',
      'A row matching an existing deal (same Type, Price, Offer Date and a similar Property Address) is reported as a duplicate and skipped.',
      'If one area of a transaction fails to write (say a malformed adjustment), the transaction and every other area are still saved — the skipped area is listed in the result and in the error report.',
      'Legal & Documentation is deliberately NOT importable — documents are uploaded per deal.',
      ...CHILD_SHEETS.map((c) => `${c.sheet}: ${c.note}`),
    ]) guide.addRow(['', note]);
  }

  /**
   * TD-098 — the demonstration row, obeying the rules the same workbook states.
   *
   * `f.example` is ONE value per column and has two jobs that pull against each other: illustrating
   * the column on the Instructions sheet, where 'Listing Contract Date → 2026-03-01' is exactly
   * what a reader wants, and filling row 2 of the Transactions sheet, where the same value is wrong
   * because that row is a 'Residential Buying'. Row 2 shipped with listing dates the Instructions
   * sheet reserves for listing types, and a Deal Status of 'Open' the bound Reference sheet does not
   * list for the type. Uploaded unmodified it came back 0 VALID / 1 INVALID, with the importer
   * correctly naming faults the workbook had itself introduced — a mis-taught pattern at the exact
   * moment a firm is learning the format.
   *
   * So the Instructions sheet keeps every `example` unchanged, and the ROW is derived from them
   * through the validator's own rules:
   *
   *   - `forbiddenColumnsFor` blanks whatever the row's type may not carry, so the row can never
   *     again contradict a rule without that rule changing too;
   *   - Deal Status falls back to the type's own vocabulary when the generic example is not in it;
   *   - the two roster columns are blanked, because no workbook shipped with the product can know a
   *     brokerage's agents and a name that matches nobody is refused. They are documented optional
   *     and still illustrated on the Instructions sheet, which is where a name belongs.
   */
  private mainExampleRow(): string[] {
    const type = String(IMPORT_FIELDS.find((f) => f.column === 'Transaction Type')?.example ?? TRANSACTION_TYPES[0]);
    const forbidden = new Set(forbiddenColumnsFor(type));
    const statuses = statusOptionsFor(type);
    const roster = new Set(['Primary Agent', 'Split Agents']);
    return IMPORT_FIELDS.map((f) => {
      if (forbidden.has(f.column) || roster.has(f.column)) return '';
      if (f.column === 'Deal Status') {
        const shown = String(f.example ?? '');
        return statuses.includes(shown) ? shown : (defaultStatusFor(type) || statuses[0] || '');
      }
      return String(f.example ?? '');
    });
  }

  /** The example row for the one-sheet layout: main + financial + one filled child of each. */
  private flatExampleRow(): string[] {
    // TD-098 — the same corrected main-sheet row, so the two layouts cannot disagree.
    const out: string[] = [...this.mainExampleRow(), ...FINANCIAL_FIELDS.map((f) => f.example)];
    for (const child of CHILD_SHEETS) {
      for (let n = 1; n <= child.flatMax; n++) {
        for (const f of child.fields) out.push(n === 1 ? f.example : '');
      }
    }
    return out;
  }

  /** Reverse a flat column name back to the field it came from, for header notes. */
  private fieldForFlatColumn(column: string): ImportField | undefined {
    const direct = IMPORT_FIELDS.find((f) => f.column === column) ?? FINANCIAL_FIELDS.find((f) => f.column === column);
    if (direct) return direct;
    for (const child of CHILD_SHEETS) {
      for (let n = 1; n <= child.flatMax; n++) {
        const f = child.fields.find((x) => flatColumn(child, n, x) === column);
        if (f) return f;
      }
    }
    return undefined;
  }

  private applyValidation(ws: ExcelJS.Worksheet, col: number, f: ImportField): void {
    if (f.type === 'enum' && f.options) this.addDropdown(ws, col, f.options);
    else if (f.type === 'yesno') this.addDropdown(ws, col, ['Yes', 'No']);
  }

  private addDropdown(ws: ExcelJS.Worksheet, col: number, options: readonly string[]): void {
    // Excel caps an inline list at 255 characters; longer lists stay free-text (still validated on import).
    const joined = options.join(',');
    if (joined.length > 250) return;
    for (let r = 2; r <= 500; r++) {
      ws.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${joined}"`] };
    }
  }

  // ------------------------------------------------------------------ parse
  /** Read an uploaded XLSX or CSV, detecting which of the two layouts it uses. */
  private async parseFile(fileName: string, buffer: Buffer): Promise<ParsedFile> {
    const ext = (fileName.split('.').pop() ?? '').toLowerCase();
    if (ext === 'csv') return this.fromFlat(this.parseCsv(buffer.toString('utf8')));
    if (ext === 'xlsx') return this.parseXlsx(buffer);
    if (ext === 'xls') {
      throw new BadRequestException({
        message: 'The legacy .xls format cannot be read. Please re-save the file as .xlsx or .csv and upload it again.',
      });
    }
    throw new BadRequestException({ message: `Unsupported file type ".${ext}". Upload an .xlsx or .csv file.` });
  }

  private async parseXlsx(buffer: Buffer): Promise<ParsedFile> {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); }
    catch { throw new BadRequestException({ message: 'The file could not be read as an Excel workbook. Re-save it as .xlsx and try again.' }); }
    if (!wb.worksheets.length) throw new BadRequestException({ message: 'The workbook has no sheets.' });

    // Layout detection, in precedence order. A FILLED Transactions sheet always wins: the
    // downloadable template and sample both ship a "One-Sheet (CSV)" sheet as the
    // alternative layout, and if that sheet took priority then a user who filled the
    // multi-sheet layout would silently import the leftover example rows instead of their
    // own data. The one-sheet layout is therefore only used when there is no usable
    // Transactions sheet.
    const main = wb.getWorksheet('Transactions');
    const mainRows = main ? this.sheetRows(main) : [];
    if (!mainRows.length) {
      const flatSheet = wb.getWorksheet('One-Sheet (CSV)');
      const flatRows = flatSheet ? this.sheetRows(flatSheet) : [];
      if (flatRows.length) return this.fromFlat(flatRows);
      // Neither named sheet carries data — fall back to whatever the first sheet holds.
      return this.fromFlat(this.sheetRows(wb.worksheets[0]));
    }
    // A Transactions sheet carrying flat repeat columns means the user filled the one-sheet
    // layout under the main sheet's name — honour what they actually typed.
    const headers = Object.keys(mainRows[0] ?? {});
    const looksFlat = CHILD_SHEETS.some((c) => headers.includes(flatColumn(c, 1, c.fields[0])));
    if (looksFlat) return this.fromFlat(mainRows);

    const financialRows = this.indexByRef(wb.getWorksheet('Financial'));
    const childRows = new Map<string, Record<string, Record<string, string>[]>>();
    let childCount = 0;
    for (const child of CHILD_SHEETS) {
      const sheet = wb.getWorksheet(child.sheet);
      if (!sheet) continue;
      for (const r of this.sheetRows(sheet)) {
        const ref = String(r[REF_COLUMN] ?? '').trim();
        if (!ref) continue;
        if (++childCount > MAX_CHILD_ROWS) {
          throw new BadRequestException({ message: `The workbook has more than ${MAX_CHILD_ROWS} child rows — split it into smaller files.` });
        }
        if (!childRows.has(ref)) childRows.set(ref, {});
        const byKey = childRows.get(ref)!;
        (byKey[child.key] ??= []).push(r);
      }
    }

    const records: RawRecord[] = mainRows.map((rec, i) => {
      const ref = String(rec[REF_COLUMN] ?? '').trim() || String(i + 1);
      return {
        row: i + 2,
        ref,
        main: rec,
        financial: financialRows.get(ref) ?? {},
        children: childRows.get(ref) ?? {},
      };
    });
    return { layout: 'multi-sheet', records, headers };
  }

  /** Read a sheet into header-keyed rows, skipping fully blank rows. */
  private sheetRows(ws: ExcelJS.Worksheet | undefined): Record<string, string>[] {
    if (!ws) return [];
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell, i) => { headers[i - 1] = String(this.cellText(cell)).trim(); });
    const out: Record<string, string>[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const rec: Record<string, string> = {};
      let any = false;
      headers.forEach((h, i) => {
        if (!h) return;
        const v = this.cellText(row.getCell(i + 1));
        rec[h] = v;
        if (v !== '') any = true;
      });
      if (any) out.push(rec);
    });
    return out;
  }

  private indexByRef(ws: ExcelJS.Worksheet | undefined): Map<string, Record<string, string>> {
    const map = new Map<string, Record<string, string>>();
    for (const r of this.sheetRows(ws)) {
      const ref = String(r[REF_COLUMN] ?? '').trim();
      if (ref && !map.has(ref)) map.set(ref, r);
    }
    return map;
  }

  /** Expand the one-sheet layout's numbered repeat columns back into child collections. */
  private fromFlat(rows: Record<string, string>[]): ParsedFile {
    const headers = Object.keys(rows[0] ?? {});
    const records: RawRecord[] = rows.map((rec, i) => {
      const financial: Record<string, string> = {};
      for (const f of FINANCIAL_FIELDS) if (rec[f.column] !== undefined) financial[f.column] = rec[f.column];

      const children: Record<string, Record<string, string>[]> = {};
      for (const child of CHILD_SHEETS) {
        const list: Record<string, string>[] = [];
        for (let n = 1; n <= child.flatMax; n++) {
          const item: Record<string, string> = {};
          let any = false;
          for (const f of child.fields) {
            const v = String(rec[flatColumn(child, n, f)] ?? '').trim();
            item[f.column] = v;
            if (v !== '') any = true;
          }
          if (any) list.push(item);
        }
        if (list.length) children[child.key] = list;
      }
      return { row: i + 2, ref: String(rec[REF_COLUMN] ?? '').trim() || String(i + 1), main: rec, financial, children };
    });
    return { layout: 'one-sheet', records, headers };
  }

  /** Excel cells may hold dates, formulas or rich text — normalise everything to a string. */
  private cellText(cell: ExcelJS.Cell): string {
    const v = cell?.value as unknown;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if ('text' in o) return String(o.text ?? '');
      if ('result' in o) return String(o.result ?? '');
      if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
      return '';
    }
    return String(v).trim();
  }

  /** Minimal RFC4180 CSV reader (quoted fields, escaped quotes, CRLF). */
  private parseCsv(text: string): Record<string, string>[] {
    const rows: string[][] = [];
    let field = '', row: string[] = [], quoted = false;
    const src = text.replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const headers = rows[0].map((h) => h.trim());
    return rows.slice(1)
      .filter((r) => r.some((c) => c.trim() !== ''))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  }

  // --------------------------------------------------------------- validate
  /**
   * Validate the whole file WITHOUT writing anything, and record the batch so the user can
   * confirm it afterwards. Returns the counts and the full per-row issue list.
   */
  async validate(fileName: string, buffer: Buffer, user: AuthUserRecord): Promise<ImportPreview> {
    this.assertCanImport(user);
    const parsed = await this.parseFile(fileName, buffer);
    if (!parsed.records.length) throw new BadRequestException({ message: 'The file contains no data rows.' });
    if (parsed.records.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({ message: `The file has ${parsed.records.length} rows — the limit is ${MAX_IMPORT_ROWS} per import.` });
    }
    // a missing required column is a file-level problem, not a row-level one
    const present = new Set(parsed.headers);
    const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
    if (missing.length) {
      throw new BadRequestException({ message: `The file is missing required column(s): ${missing.join(', ')}. Download the import template and use its column headings.` });
    }

    const rows = await this.validateRows(parsed.records);
    const issues = rows.flatMap((r) => r.issues);
    const batchId = 'IMP-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 1e5).toString(36).toUpperCase();
    const now = new Date();
    const counts = {
      total_rows: rows.length,
      valid_rows: rows.filter((r) => r.valid).length,
      invalid_rows: rows.filter((r) => !r.valid && !r.duplicate).length,
      duplicate_rows: rows.filter((r) => r.duplicate).length,
      warning_rows: rows.filter((r) => r.warning).length,
    };
    const sectionCounts: Record<string, number> = {};
    for (const r of rows) {
      for (const [name, body] of Object.entries(r.sections)) {
        const list = (body as Record<string, unknown>).__count;
        sectionCounts[name] = (sectionCounts[name] ?? 0) + (typeof list === 'number' ? list : 1);
      }
    }

    await this.prisma.import_batches.create({
      data: {
        batch_id: batchId, file_name: fileName,
        uploaded_by: user.name, uploaded_by_id: user.id ?? null,
        uploaded_at: now, created_at: now, updated_at: now,
        total_rows: counts.total_rows, valid_rows: counts.valid_rows,
        failed_rows: counts.invalid_rows, duplicate_rows: counts.duplicate_rows,
        warning_rows: counts.warning_rows,
        status: 'Validated',
        // the parsed rows are stored so confirm() imports exactly what was previewed
        errors: JSON.stringify({
          issues, layout: parsed.layout, section_counts: sectionCounts,
          rows: rows.map((r) => ({ row: r.row, reference: r.reference, data: r.data, sections: r.sections, valid: r.valid })),
        }),
      },
    });

    return {
      batch_id: batchId, file_name: fileName, layout: parsed.layout, ...counts,
      section_counts: sectionCounts, issues,
      sample: rows.filter((r) => r.valid).slice(0, 10).map((r) => ({
        row: r.row, ...r.data,
        __sections: Object.keys(r.sections).join(', '),
      })),
    };
  }

  /** Per-row validation: required fields, formats, enums, relationships and duplicates. */
  private async validateRows(records: RawRecord[]): Promise<ParsedRow[]> {
    const agents = new Set((await this.prisma.users.findMany({ where: { status: 'Active' }, select: { name: true } })).map((u) => u.name));
    const existing = await this.prisma.transactions.findMany({
      where: { deleted_at: null },
      select: { trade_no: true, type: true, price: true, offer_date: true, property: true },
    });

    const out: ParsedRow[] = [];
    const seen: { type: string; price: number; offer: string; property: string; row: number }[] = [];

    for (const rec of records) {
      const rowNo = rec.row;
      const issues: RowIssue[] = [];
      const get = (col: string) => String(rec.main[col] ?? '').trim();
      const type = get('Transaction Type');
      const reference = get('Property Address') || `Row ${rowNo}`;
      const add = (field: string, value: string, message: string, fix: string, severity: RowIssue['severity'] = 'error', section = '') =>
        issues.push({ row: rowNo, reference, field, value, message, fix, severity, section });

      // ---- transaction type drives every other rule ----
      if (!type) add('Transaction Type', '', 'Transaction Type is required.', 'Enter one of: ' + TRANSACTION_TYPES.join(', '));
      else if (!(TRANSACTION_TYPES as readonly string[]).includes(type)) {
        const near = this.closest(type, TRANSACTION_TYPES);
        add('Transaction Type', type, 'Not a valid transaction type.', near ? `Did you mean "${near}"?` : 'Use one of: ' + TRANSACTION_TYPES.join(', '));
      }
      const known = (TRANSACTION_TYPES as readonly string[]).includes(type);
      const listing = known && isListingType(type);

      // ---- required / forbidden per type ----
      if (known) {
        for (const col of requiredColumnsFor(type)) {
          if (!get(col)) {
            const f = IMPORT_FIELDS.find((x) => x.column === col)!;
            add(col, '', `${col} is required for ${type}.`, `Enter a value — ${f.hint}`);
          }
        }
        /*
         * A SOLD LISTING CARRIES ITS MONEY, so the offer-side block is lifted for one.
         * Commission Type and Commission Value stay refused even then: a listing's commission
         * is worked out from Listing Commission % and Co-Op Commission %, and the calculation
         * never reads comm_value for a listing - allowing them would invite somebody to fill a
         * cell that does nothing.
         */
        const SOLD_LISTING_ALLOWS = ['Price', 'Offer Date', 'Closing Date'];
        const soldListing = listing && ['Sold', 'Leased', 'Closed'].includes(get('Deal Status'));
        for (const col of forbiddenColumnsFor(type)) {
          if (soldListing && SOLD_LISTING_ALLOWS.includes(col)) continue;
          if (!get(col)) continue;
          const why = !listing ? 'This column applies to listing types only — clear this cell.'
            : SOLD_LISTING_ALLOWS.includes(col)
              ? 'A listing carries a price and dates only once it has sold — clear this cell, or set Deal Status to Sold, Leased or Closed.'
              : 'A listing takes its commission from Listing Commission % and Co-Op Commission % — clear this cell.';
          add(col, get(col), `${col} must be empty for ${type}.`, why);
        }
      }

      /*
       * ---- formats on the main sheet ----
       *
       * TD-052 - one problem, reported once.
       *
       * A bad Transaction Type produced TWO rows in the validation table: 'Not a valid transaction
       * type.' from the dedicated rule above, and 'Not an accepted value for Transaction Type.'
       * from the generic enum check below, both carrying the identical suggested correction. The
       * INVALID counter stayed right because it counts rows, but a file with one mistake read as a
       * file with two - and on a fifty-row import that is the difference between a report somebody
       * works through and one they give up on.
       *
       * The DEDICATED RULE WINS, which is the right way round: it is worded for the field it is
       * about, it already handles the empty case, and it is where a better message would be added.
       * A generic "not an accepted value" is the fallback for fields nothing else speaks for.
       *
       * ONLY THE MAIN SHEET GETS THIS. The child-sheet calls below pass many rows through one
       * `checkFormats`, and every issue they raise carries the PARENT row number - so two Condition
       * rows with the same bad column are two genuine problems that look identical to a
       * field-level filter. Suppressing there would hide the second one.
       */
      const addMainFormat = (
        field: string, value: string, message: string, fix: string,
        severity?: RowIssue['severity'], section?: string,
      ): void => {
        if (issues.some((x) => x.field === field)) return;
        add(field, value, message, fix, severity, section);
      };
      this.checkFormats(IMPORT_FIELDS, rec.main, addMainFormat, '');
      for (const col of ['Lawyer Email', 'Co-Op Brokerage Email']) {
        const v = get(col);
        if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          add(col, v, 'Not a valid email address.', 'Use the name@domain.com format, or leave it blank.');
        }
      }

      // ---- financial block ----
      this.checkFormats(FINANCIAL_FIELDS, rec.financial, add, 'Financial');

      // ---- status must be valid for the type ----
      const status = get('Deal Status');
      if (known && status) {
        const allowed = statusOptionsFor(type);
        if (!allowed.includes(status)) {
          const near = this.closest(status, allowed);
          add('Deal Status', status, `"${status}" is not a valid status for ${type}.`, near ? `Did you mean "${near}"?` : 'Use one of: ' + allowed.join(', '));
        }
      }

      // ---- team: from the Team Split rows when present, else the flat columns ----
      const teamRows = rec.children.team ?? [];
      const primaryFromSheet = teamRows.find((t) => /^yes$/i.test(String(t.Primary ?? '').trim()));
      const primary = get('Primary Agent') || String(primaryFromSheet?.Agent ?? '').trim();
      if (get('Primary Agent') && !agents.has(get('Primary Agent'))) {
        const near = this.closest(get('Primary Agent'), [...agents]);
        add('Primary Agent', get('Primary Agent'), 'No active user with this name.', near ? `Did you mean "${near}"?` : 'Use the agent’s exact name as it appears in the Users module.');
      }
      const splits = get('Split Agents').split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of splits) if (!agents.has(s)) add('Split Agents', s, `No active user named "${s}".`, 'Use exact agent names, separated by commas.');
      if (splits.length && !primary) add('Split Agents', get('Split Agents'), 'Split agents need a primary agent.', 'Fill in Primary Agent, or clear Split Agents.');

      this.checkFormats(TEAM_COLS, teamRows, add, 'Team Split');
      for (const t of teamRows) {
        const name = String(t.Agent ?? '').trim();
        if (name && !agents.has(name)) {
          const near = this.closest(name, [...agents]);
          add('Agent', name, `No active user named "${name}".`, near ? `Did you mean "${near}"?` : 'Use the agent’s exact name from the Users module.', 'error', 'Team Split');
        }
      }
      if (teamRows.length && !primaryFromSheet && !get('Primary Agent')) {
        add('Primary', '', 'No primary agent among the Team Split rows.', 'Mark exactly one row Primary = Yes, or fill Primary Agent on the Transactions sheet.', 'error', 'Team Split');
      }
      if (teamRows.filter((t) => /^yes$/i.test(String(t.Primary ?? '').trim())).length > 1) {
        add('Primary', '', 'More than one row is marked Primary.', 'Exactly one team member may be the primary agent.', 'error', 'Team Split');
      }

      // ---- clients / conditions / adjustments ----
      const clientRows = rec.children.clients ?? [];
      this.checkFormats(CLIENT_COLS, clientRows, add, 'Clients');
      for (const c of clientRows) {
        if (!String(c.Name ?? '').trim()) add('Name', '', 'A client row needs a name.', 'Fill in the client’s name, or delete the row.', 'error', 'Clients');
        const email = String(c.Email ?? '').trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          add('Email', email, 'Not a valid email address.', 'Use the name@domain.com format, or leave it blank.', 'error', 'Clients');
        }
      }

      const conditionRows = rec.children.conditions ?? [];
      this.checkFormats(CONDITION_COLS, conditionRows, add, 'Conditions');
      for (const c of conditionRows) {
        if (String(c['Condition Type'] ?? '').trim() === 'Custom' && !String(c['Custom Name'] ?? '').trim()) {
          add('Custom Name', '', 'A Custom condition needs a name.', 'Fill in Custom Name, or pick a standard condition type.', 'error', 'Conditions');
        }
      }
      if (conditionRows.length && !/^yes$/i.test(get('Conditional Offer'))) {
        add('Conditional Offer', get('Conditional Offer'), 'Conditions were supplied but Conditional Offer is not Yes.', 'Set Conditional Offer to Yes, or remove the condition rows — they will be ignored.', 'warning', 'Conditions');
      }

      const adjRows = rec.children.adjustments ?? [];
      this.checkFormats(ADJUSTMENT_COLS, adjRows, add, 'Adjustments');

      // ---- date sanity (warning, not an error) ----
      const offer = get('Offer Date'), closing = get('Closing Date');
      if (offer && closing && /^\d{4}-\d{2}-\d{2}$/.test(offer) && /^\d{4}-\d{2}-\d{2}$/.test(closing) && closing < offer) {
        add('Closing Date', closing, 'Closing Date is before Offer Date.', 'Check the dates — this row will still import.', 'warning');
      }
      const lc = get('Listing Contract Date'), le = get('Listing Expiry Date');
      if (lc && le && le < lc) add('Listing Expiry Date', le, 'Expiry is before the contract date.', 'Check the dates — this row will still import.', 'warning');

      // ---- duplicates: within the file, and against existing deals ----
      const priceNum = Number(get('Price').replace(/[$,\s]/g, '')) || 0;
      let duplicate = false;
      if (known && !listing && offer) {
        const dupInFile = seen.find((s) => s.type === type && s.price === priceNum && s.offer === offer && this.similar(s.property, get('Property Address')));
        if (dupInFile) {
          duplicate = true;
          add('Property Address', get('Property Address'), `Duplicate of row ${dupInFile.row} in this file.`, 'Remove one of the two rows.', 'duplicate');
        } else {
          const dupInDb = existing.find((e) =>
            e.type === type
            && Number(e.price) === priceNum
            && (e.offer_date ? e.offer_date.toISOString().slice(0, 10) : '') === offer
            && this.similar(String(e.property ?? ''), get('Property Address')));
          if (dupInDb) {
            duplicate = true;
            add('Property Address', get('Property Address'), `A transaction already exists — Trade #${dupInDb.trade_no}.`, 'Remove this row, or edit the existing deal instead.', 'duplicate');
          }
        }
        seen.push({ type, price: priceNum, offer, property: get('Property Address'), row: rowNo });
      }

      // A hand-picked trade number is checked HERE, at review time, so a bad one turns its own row
      // red in the preview instead of dying half way through the import - which is the failure
      // TD-097 describes. store() checks it again when the row is actually written, so a number
      // taken between review and import is still refused.
      const tradeRaw = get('Trade Number');
      if (tradeRaw) {
        const tradeProblem = await this.write.tradeNumberProblem(type, tradeRaw);
        if (tradeProblem) add('Trade Number', tradeRaw, tradeProblem, 'Clear the cell to have a number allocated automatically, or choose a free number from this range.');
      }

      const hasError = issues.some((x) => x.severity === 'error');
      out.push({
        row: rowNo, ref: rec.ref, reference,
        data: this.toBody(rec.main, type, primary),
        sections: this.toSections(rec, type),
        issues,
        valid: !hasError && !duplicate,
        duplicate,
        warning: issues.some((x) => x.severity === 'warning'),
      });
    }
    return out;
  }

  /** Format checks shared by every sheet. Accepts one record or a list of them. */
  private checkFormats(
    fields: ImportField[],
    source: Record<string, string> | Record<string, string>[],
    add: (field: string, value: string, message: string, fix: string, severity?: RowIssue['severity'], section?: string) => void,
    section: string,
  ): void {
    const list = Array.isArray(source) ? source : [source];
    for (const rec of list) {
      for (const f of fields) {
        const v = String(rec[f.column] ?? '').trim();
        if (!v) continue;
        if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v.replace(/[$,\s]/g, ''))) {
          add(f.column, v, 'Not a valid number.', 'Use digits only, e.g. 850000 — no currency symbols or commas.', 'error', section);
        }
        if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
          add(f.column, v, 'Not a valid date.', 'Use the YYYY-MM-DD format, e.g. 2026-06-30.', 'error', section);
        }
        if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
          add(f.column, v, 'That date does not exist.', 'Check the day and month, e.g. 2026-02-30 is not a date.', 'error', section);
        }
        if (f.type === 'enum' && f.options && !f.options.includes(v)) {
          const near = this.closest(v, f.options);
          add(f.column, v, `Not an accepted value for ${f.column}.`, near ? `Did you mean "${near}"?` : 'Use one of: ' + f.options.join(', '), 'error', section);
        }
        if (f.type === 'yesno' && !['yes', 'no'].includes(v.toLowerCase())) {
          add(f.column, v, 'Must be Yes or No.', 'Enter Yes or No.', 'error', section);
        }
      }
    }
  }

  /** Map main-sheet columns onto the body TransactionsWriteService.store() expects. */
  private toBody(rec: Record<string, string>, type: string, primary: string): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const get = (col: string) => String(rec[col] ?? '').trim();
    // store() only understands the create-time subset; everything else is applied by update().
    for (const key of ['type', 'trade_no', 'property', 'price', 'deposit', 'offer_date', 'closing_date', 'listing_price',
      'listing_contract_date', 'listing_expiry_date', 'comm_type', 'comm_value']) {
      const f = IMPORT_FIELDS.find((x) => x.key === key);
      if (!f) continue;
      const v = get(f.column);
      if (!v) continue;
      body[key] = f.type === 'number' ? Number(v.replace(/[$,\s]/g, '')) : v;
    }
    const status = get('Deal Status');
    body.status = status || defaultStatusFor(type) || 'Open';
    // The primary agent may come from the Transactions sheet or from the Team Split rows.
    if (primary) body.primary_agent = primary;
    const splits = get('Split Agents').split(',').map((s) => s.trim()).filter(Boolean);
    if (splits.length) body.team_members = splits;
    return body;
  }

  /**
   * Everything store() cannot write, grouped by area. Each group is applied with its own
   * update() call if the combined write fails, so one bad area never costs the others.
   * `__count` rides along purely so the preview can report "42 client rows found".
   */
  private toSections(rec: RawRecord, type: string): Partial<Record<SectionName, Record<string, unknown>>> {
    const out: Partial<Record<SectionName, Record<string, unknown>>> = {};
    const get = (col: string) => String(rec.main[col] ?? '').trim();
    const num = (v: string) => Number(String(v).replace(/[$,\s]/g, ''));
    const yes = (v: string) => /^yes$/i.test(String(v).trim());

    // --- Financial (1:1) ---
    const fin: Record<string, unknown> = {};
    for (const f of FINANCIAL_FIELDS) {
      const v = String(rec.financial[f.column] ?? '').trim();
      if (!v) continue;
      if (f.key === 'comm_paid_status' || f.key === 'comm_status') fin[f.key] = v;
      else if (f.type === 'number') fin[f.key] = num(v);
      else if (f.type === 'yesno') fin[f.key] = yes(v);
      else fin[f.key] = v;
    }
    if (Object.keys(fin).length) out.Financial = { ...fin, __count: 1 };

    // --- Basic-info leftovers that store() ignores, folded into Financial's write ---
    const extras: Record<string, unknown> = {};
    for (const key of ['mls_type', 'mls_num', 'payment_type', 'lawyer_name', 'lawyer_email', 'lawyer_phone', 'lawyer_address']) {
      const f = IMPORT_FIELDS.find((x) => x.key === key);
      if (!f) continue;
      const v = get(f.column);
      if (v) extras[key] = v;
    }
    if (yes(get('MLS Verified'))) extras.mls_verified = true;
    if (get('Inter-Board Listing')) extras.inter_board_enabled = yes(get('Inter-Board Listing'));
    if (Object.keys(extras).length) out.Financial = { ...(out.Financial ?? { __count: 1 }), ...extras };

    // --- Team Split ---
    const teamRows = rec.children.team ?? [];
    if (teamRows.length) {
      const team = teamRows.map((t, i) => {
        const m: Record<string, unknown> = { name: String(t.Agent ?? '').trim() };
        const isPrimary = /^yes$/i.test(String(t.Primary ?? '').trim());
        m.is_primary = isPrimary || (i === 0 && !teamRows.some((x) => /^yes$/i.test(String(x.Primary ?? '').trim())));
        if (String(t['Deal Share %'] ?? '').trim()) m.split = num(String(t['Deal Share %']));
        if (String(t['Agent %'] ?? '').trim()) m.agent_pct = num(String(t['Agent %']));
        if (String(t['Brokerage %'] ?? '').trim()) m.brok_pct = num(String(t['Brokerage %']));
        if (String(t.Access ?? '').trim()) m.access = String(t.Access).trim();
        return m;
      }).filter((m) => m.name);
      // The primary must sort first — syncTeam treats position 0 as primary when unflagged.
      team.sort((a, b) => Number(!!b.is_primary) - Number(!!a.is_primary));
      if (team.length) out['Team Split'] = { team, __count: team.length };
    }

    // --- Clients ---
    const clientRows = (rec.children.clients ?? []).filter((c) => String(c.Name ?? '').trim());
    if (clientRows.length) {
      out.Clients = {
        clients: clientRows.map((c) => ({
          name: String(c.Name ?? '').trim(),
          email: String(c.Email ?? '').trim() || null,
          phone: String(c.Phone ?? '').trim() || null,
        })),
        __count: clientRows.length,
      };
    }

    // --- Conditions (only meaningful when the deal is a conditional offer) ---
    const conditionRows = (rec.children.conditions ?? []).filter((c) => String(c['Condition Type'] ?? '').trim());
    if (yes(get('Conditional Offer'))) {
      out.Conditions = {
        conditional_offer: true,
        conditions: conditionRows.map((c) => ({
          type: String(c['Condition Type'] ?? '').trim(),
          custom_name: String(c['Custom Name'] ?? '').trim() || null,
          deadline: String(c.Deadline ?? '').trim() || null,
          status: String(c.Status ?? '').trim() || 'Pending',
        })),
        __count: Math.max(1, conditionRows.length),
      };
    }

    // --- Adjustments (one JSON blob, four sub-areas keyed by the Section column) ---
    const adjRows = rec.children.adjustments ?? [];
    if (adjRows.length) {
      const adjustments: Record<string, unknown> = {
        agent_adjust: 'No', adjustment_rows: [] as Record<string, unknown>[],
        advance_payment: 'No', advance_rows: [] as Record<string, unknown>[],
        client_referral: 'No', client_rows: [] as Record<string, unknown>[],
        ext_referral: 'No',
      };
      const common = (a: Record<string, string>) => ({
        amount: String(a.Amount ?? '').trim() ? num(String(a.Amount)) : '',
        remarks: String(a.Remarks ?? '').trim() || undefined,
        paid_type: String(a['Paid Type'] ?? '').trim() || undefined,
        paid_date: String(a['Paid Date'] ?? '').trim() || undefined,
        batch_no: String(a['Batch No'] ?? '').trim() || undefined,
        paid_status: String(a['Paid Status'] ?? '').trim() || undefined,
        term: String(a.Term ?? '').trim() ? num(String(a.Term)) : undefined,
      });
      for (const a of adjRows) {
        const section = String(a.Section ?? '').trim();
        const agent = String(a.Agent ?? '').trim();
        if (section === 'Agent Adjustment') {
          adjustments.agent_adjust = 'Yes';
          (adjustments.adjustment_rows as Record<string, unknown>[]).push({
            agent, is_loan: yes(String(a['Is Loan'] ?? '')), ...common(a),
          });
        } else if (section === 'Advance Payment') {
          adjustments.advance_payment = 'Yes';
          (adjustments.advance_rows as Record<string, unknown>[]).push({ agent, ...common(a) });
        } else if (section === 'Client Referral') {
          adjustments.client_referral = 'Yes';
          (adjustments.client_rows as Record<string, unknown>[]).push({
            client_name: String(a['Client Name'] ?? '').trim(), agent, ...common(a),
          });
        } else if (section === 'External Referral') {
          adjustments.ext_referral = 'Yes';
          adjustments.ext = {
            agent_name: agent,
            brokerage: String(a.Brokerage ?? '').trim(),
            invoice_received: 'No', hst_no: '',
            ...common(a),
          };
        }
      }
      out.Adjustments = { adjustments, __count: adjRows.length };
    }

    // --- Co-Op brokerage (1:1, straight off the main sheet) ---
    const brokerage: Record<string, unknown> = {};
    for (const [key, col] of [['name', 'Co-Op Brokerage Name'], ['email', 'Co-Op Brokerage Email'],
      ['phone', 'Co-Op Brokerage Phone'], ['address', 'Co-Op Brokerage Address']] as const) {
      const v = get(col);
      if (v) brokerage[key] = v;
    }
    const brokAgents = get('Co-Op Brokerage Agents').split(',').map((s) => s.trim()).filter(Boolean);
    if (brokAgents.length) brokerage.agents = brokAgents;
    if (Object.keys(brokerage).length) out['Co-Op Brokerage'] = { brokerage, __count: 1 };

    // Preconstruction terms follow the term count set in Financial.
    if (type === 'Preconstruction' && out.Financial) {
      const tc = Number(out.Financial.precon_term_count ?? 0) || 0;
      if (tc > 0) {
        out.Financial.precon_terms = Array.from({ length: tc }, (_, i) => ({ term_no: i + 1, pct: null, closing_date: null }));
      }
    }
    return out;
  }

  /**
   * Nearest allowed value to what the user typed, so the error report can suggest a real
   * correction for a typo ("Residential Buyng" → "Residential Buying") rather than dumping
   * the whole vocabulary. Allows roughly one edit per 6 characters.
   */
  private closest(value: string, options: readonly string[]): string | null {
    const v = value.trim().toLowerCase();
    if (!v) return null;
    let best: string | null = null, bestD = Infinity;
    for (const o of options) {
      const d = this.editDistance(v, o.toLowerCase());
      if (d < bestD) { bestD = d; best = o; }
    }
    const tolerance = Math.max(2, Math.floor(v.length / 6));
    return best !== null && bestD <= tolerance ? best : null;
  }

  /** Levenshtein distance (iterative, two-row) — small inputs only. */
  private editDistance(a: string, b: string): number {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** Fuzzy property comparison — same rule the single-transaction duplicate guard uses. */
  private similar(a: string, b: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    return x === y || x.startsWith(y) || y.startsWith(x);
  }

  // ---------------------------------------------------------------- confirm
  /**
   * Import the rows that passed validation. Each row is created through the normal
   * transaction write path, so trade numbering, audit logging and the duplicate guard all
   * behave exactly as they do for a manually-created deal.
   *
   * Two levels of best-effort:
   *   · a row whose transaction cannot be created is recorded and skipped;
   *   · a transaction that IS created keeps every area that writes cleanly — the combined
   *     follow-up write is retried area by area, so one malformed adjustment costs only the
   *     adjustments, not the clients or the team split.
   */
  async confirm(batchId: string, user: AuthUserRecord): Promise<ImportResult> {
    this.assertCanImport(user);
    const batch = await this.prisma.import_batches.findUnique({ where: { batch_id: batchId } });
    if (!batch) throw new NotFoundException({ message: 'Import batch not found.' });
    if (batch.status !== 'Validated') {
      throw new BadRequestException({ message: `This import has already been processed (status: ${batch.status}).` });
    }

    const stored = JSON.parse(batch.errors ?? '{}') as {
      issues?: RowIssue[];
      rows?: { row: number; reference: string; data: Record<string, unknown>; sections?: Partial<Record<SectionName, Record<string, unknown>>>; valid: boolean }[];
    };
    const issues: RowIssue[] = [...(stored.issues ?? [])];
    const validRows = (stored.rows ?? []).filter((r) => r.valid);

    const created: ImportResult['created'] = [];
    let failed = 0;
    let skippedSections = 0;

    for (const r of validRows) {
      let txnId: number;
      let tradeNo = '';
      let property: string | null = null;
      try {
        const res = await this.write.store(user, r.data);
        const data = res.data as Record<string, unknown>;
        txnId = Number(data.id);
        tradeNo = String(data.trade_no ?? '');
        property = (data.property ?? null) as string | null;
      } catch (err) {
        failed++;
        // surface the real reason (duplicate guard, validation) against the offending row
        issues.push({
          row: r.row, reference: r.reference, field: '—', value: '',
          message: this.errorText(err), fix: 'Fix the row in your file and re-upload it.', severity: 'error', section: '',
        });
        continue;
      }

      const { applied, skipped } = await this.writeSections(user, txnId, r.sections ?? {}, (section, message) => {
        skippedSections++;
        issues.push({
          row: r.row, reference: r.reference, field: '—', value: '',
          message: `${section} could not be saved: ${message}`,
          fix: `The transaction was created (Trade #${tradeNo}). Fix the ${section} rows and re-import them, or fill that section in on the transaction.`,
          severity: 'warning', section,
        });
      });
      created.push({ row: r.row, trade_no: tradeNo, property, sections: applied, skipped });
    }

    const status = created.length === 0 ? 'Failed'
      : failed > 0 || skippedSections > 0 || batch.failed_rows > 0 || batch.duplicate_rows > 0 ? 'Partially Imported'
        : 'Imported';
    const now = new Date();
    await this.prisma.import_batches.update({
      where: { batch_id: batchId },
      data: {
        status, completed_at: now, updated_at: now,
        imported_rows: created.length,
        failed_rows: batch.failed_rows + failed,
        errors: JSON.stringify({ issues, rows: stored.rows ?? [] }),
      },
    });

    return {
      batch_id: batchId, status,
      total_rows: batch.total_rows,
      imported_rows: created.length,
      failed_rows: batch.failed_rows + failed,
      duplicate_rows: batch.duplicate_rows,
      skipped_sections: skippedSections,
      issues, created,
    };
  }

  /**
   * Apply the non-create-time areas. The happy path is a single update() carrying every
   * area; only when that fails is each area retried alone, so we can name the one at fault
   * without punishing the rest.
   */
  private async writeSections(
    user: AuthUserRecord,
    txnId: number,
    sections: Partial<Record<SectionName, Record<string, unknown>>>,
    onSkip: (section: string, message: string) => void,
  ): Promise<{ applied: string[]; skipped: string[] }> {
    const entries = (Object.entries(sections) as [SectionName, Record<string, unknown>][])
      .map(([name, body]) => [name, this.stripMeta(body)] as const)
      .filter(([, body]) => Object.keys(body).length > 0);
    if (!entries.length) return { applied: [], skipped: [] };

    const combined: Record<string, unknown> = {};
    for (const [, body] of entries) Object.assign(combined, body);
    try {
      await this.write.update(user, txnId, combined);
      return { applied: entries.map(([name]) => name), skipped: [] };
    } catch {
      // fall through to per-area writes
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const [name, body] of entries) {
      try {
        await this.write.update(user, txnId, body);
        applied.push(name);
      } catch (err) {
        skipped.push(name);
        onSkip(name, this.errorText(err));
      }
    }
    return { applied, skipped };
  }

  /** Drop the preview-only `__count` marker before the body reaches the write path. */
  private stripMeta(body: Record<string, unknown>): Record<string, unknown> {
    const { __count, ...rest } = body;
    void __count;
    return rest;
  }

  private errorText(err: unknown): string {
    const r = err as { response?: { message?: unknown }; message?: string };
    const m = r?.response?.message;
    if (Array.isArray(m)) return m.join('; ');
    if (typeof m === 'string') return m;
    return r?.message ?? 'Unknown error';
  }

  // ----------------------------------------------------------- error report
  /** Downloadable validation report for a batch (row, field, value, error, suggested fix). */
  async errorReport(batchId: string, user: AuthUserRecord): Promise<{ buffer: Buffer; fileName: string }> {
    this.assertCanImport(user);
    const batch = await this.prisma.import_batches.findUnique({ where: { batch_id: batchId } });
    if (!batch) throw new NotFoundException({ message: 'Import batch not found.' });
    const { issues = [] } = JSON.parse(batch.errors ?? '{}') as { issues?: RowIssue[] };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Validation Report');
    ws.addRow([`Import ${batch.batch_id} — ${batch.file_name ?? ''}`]).font = { bold: true, size: 13 };
    ws.addRow([`Uploaded by ${batch.uploaded_by ?? '—'} · ${batch.total_rows} row(s): `
      + `${batch.valid_rows} valid, ${batch.failed_rows} invalid, ${batch.duplicate_rows} duplicate, ${batch.warning_rows} with warnings`]).font = { italic: true, color: { argb: 'FF64748B' } };
    ws.addRow([]);
    const head = ws.addRow(['Row', 'Transaction Reference', 'Area', 'Field', 'Invalid Value', 'Error Description', 'Suggested Correction', 'Severity']);
    head.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
      c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    });
    for (const i of issues) {
      const r = ws.addRow([i.row, i.reference, i.section || 'Transaction', i.field, i.value, i.message, i.fix, i.severity]);
      r.getCell(8).font = { color: { argb: i.severity === 'error' ? 'FFB91C1C' : i.severity === 'duplicate' ? 'FFB45309' : 'FF64748B' }, bold: true };
      r.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; });
    }
    [8, 30, 16, 20, 22, 46, 46, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    if (!issues.length) ws.addRow(['', 'No validation problems were found in this file.']);

    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `import-errors-${batch.batch_id}.xlsx` };
  }

  // ------------------------------------------------------------------ history
  /** Import history (most recent first) for the Bulk Import History screen. */
  async history(user: AuthUserRecord, limit = 50): Promise<Record<string, unknown>[]> {
    this.assertCanImport(user);
    const rows = await this.prisma.import_batches.findMany({ orderBy: { id: 'desc' }, take: Math.min(200, Math.max(1, limit)) });
    return rows.map((b) => ({
      batch_id: b.batch_id,
      file_name: b.file_name,
      uploaded_by: b.uploaded_by,
      uploaded_at: b.uploaded_at ? b.uploaded_at.toISOString() : null,
      completed_at: b.completed_at ? b.completed_at.toISOString() : null,
      total_rows: b.total_rows,
      valid_rows: b.valid_rows,
      imported_rows: b.imported_rows,
      failed_rows: b.failed_rows,
      duplicate_rows: b.duplicate_rows,
      warning_rows: b.warning_rows,
      status: b.status,
    }));
  }
}
