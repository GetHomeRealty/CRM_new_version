import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsWriteService } from '../transactions/transactions-write.service';
import { TRANSACTION_TYPES, isListingType, statusOptionsFor, defaultStatusFor } from '../reference/transaction.constants';
import { IMPORT_FIELDS, REQUIRED_COLUMNS, requiredColumnsFor, forbiddenColumnsFor, statusReference } from './import-template';
import type { AuthUserRecord } from '../auth/auth.types';

/** One problem found on one row. Mirrors the downloadable validation report columns. */
export interface RowIssue {
  row: number;             // 1-based row number as it appears in the user's file
  reference: string;       // property address / type, so the row is recognisable
  field: string;           // template column name
  value: string;           // what they typed
  message: string;         // what is wrong
  fix: string;             // suggested correction
  severity: 'error' | 'warning' | 'duplicate';
}

export interface ParsedRow {
  row: number;
  reference: string;
  data: Record<string, unknown>;
  issues: RowIssue[];
  valid: boolean;
  duplicate: boolean;
  warning: boolean;
}

export interface ImportPreview {
  batch_id: string;
  file_name: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  warning_rows: number;
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
  issues: RowIssue[];
  created: { row: number; trade_no: string; property: string | null }[];
}

/** Hard ceiling on one upload — protects the API from an accidental enormous file. */
export const MAX_IMPORT_ROWS = 1000;

@Injectable()
export class TransactionImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly write: TransactionsWriteService,
  ) {}

  /** Importing creates transactions, so it needs the same authority as creating one. */
  private assertCanImport(user: AuthUserRecord): void {
    if ((user.role ?? 'agent') === 'agent') {
      throw new ForbiddenException({ message: 'You do not have permission to bulk import transactions.' });
    }
  }

  // ---------------------------------------------------------------- template
  /** The downloadable import template: a data sheet, a guide sheet and a reference sheet. */
  async template(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Transaction Desk';

    // --- sheet 1: the sheet the user fills in ---
    const ws = wb.addWorksheet('Transactions');
    const header = ws.addRow(IMPORT_FIELDS.map((f) => f.column));
    header.height = 26;
    header.eachCell((cell, i) => {
      const f = IMPORT_FIELDS[i - 1];
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      // required columns are visually distinct so they can't be missed
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f.required ? 'FFB91C1C' : 'FF4F46E5' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      cell.note = `${f.hint}\n\nExample: ${f.example}`;
    });
    const example = ws.addRow(IMPORT_FIELDS.map((f) => f.example));
    example.eachCell((cell) => {
      cell.font = { italic: true, color: { argb: 'FF64748B' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    });
    ws.getCell(`A${example.number}`).note = 'This example row is ignored on import — overwrite it or delete it.';
    IMPORT_FIELDS.forEach((f, i) => { ws.getColumn(i + 1).width = Math.max(16, Math.min(34, f.column.length + 6)); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // enum columns get real dropdowns so the file is hard to fill in wrongly
    IMPORT_FIELDS.forEach((f, i) => {
      if (f.type === 'enum' && f.options) this.addDropdown(ws, i + 1, f.options);
      if (f.type === 'yesno') this.addDropdown(ws, i + 1, ['Yes', 'No']);
    });

    // --- sheet 2: how to fill it in ---
    const guide = wb.addWorksheet('Instructions');
    guide.addRow(['Column', 'Required', 'Format / accepted values', 'Example']).eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
    });
    for (const f of IMPORT_FIELDS) {
      const req = f.required ? 'Always' : f.requiredForDeals ? 'Deal types only' : f.requiredForListings ? 'Listing types only' : 'Optional';
      guide.addRow([f.column, req, f.hint, f.example]);
    }
    guide.getColumn(1).width = 26; guide.getColumn(2).width = 18; guide.getColumn(3).width = 82; guide.getColumn(4).width = 26;
    guide.eachRow((r) => r.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; }));
    guide.addRow([]);
    guide.addRow(['Notes']).font = { bold: true };
    for (const note of [
      'Listing types (Sale Listing / Lease Listing) must leave Price, Deposit, Offer Date, Closing Date, Commission Type and Commission Value blank.',
      'Deal types must leave Listing Contract Date and Listing Expiry Date blank.',
      'Trade numbers are generated automatically — do not supply them.',
      'Rows that fail validation are reported and skipped; the valid rows are still imported.',
      'A row matching an existing deal (same Type, Price, Offer Date and a similar Property Address) is reported as a duplicate and skipped.',
    ]) guide.addRow(['', note]);

    // --- sheet 3: the valid statuses per type ---
    const ref = wb.addWorksheet('Reference');
    ref.addRow(['Transaction Type', 'Valid Deal Statuses']).eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
    });
    for (const { type, statuses } of statusReference()) ref.addRow([type, statuses.join(' | ')]);
    ref.getColumn(1).width = 34; ref.getColumn(2).width = 90;

    return Buffer.from(await wb.xlsx.writeBuffer());
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
  /** Read an uploaded XLSX or CSV into raw header-keyed rows. */
  private async parseFile(fileName: string, buffer: Buffer): Promise<Record<string, string>[]> {
    const ext = (fileName.split('.').pop() ?? '').toLowerCase();
    if (ext === 'csv') return this.parseCsv(buffer.toString('utf8'));
    if (ext === 'xlsx') return this.parseXlsx(buffer);
    if (ext === 'xls') {
      throw new BadRequestException({
        message: 'The legacy .xls format cannot be read. Please re-save the file as .xlsx or .csv and upload it again.',
      });
    }
    throw new BadRequestException({ message: `Unsupported file type ".${ext}". Upload an .xlsx or .csv file.` });
  }

  private async parseXlsx(buffer: Buffer): Promise<Record<string, string>[]> {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); }
    catch { throw new BadRequestException({ message: 'The file could not be read as an Excel workbook. Re-save it as .xlsx and try again.' }); }
    const ws = wb.getWorksheet('Transactions') ?? wb.worksheets[0];
    if (!ws) throw new BadRequestException({ message: 'The workbook has no sheets.' });

    const headers: string[] = [];
    ws.getRow(1).eachCell((cell, i) => { headers[i - 1] = String(this.cellText(cell)).trim(); });
    const out: Record<string, string>[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const rec: Record<string, string> = {};
      headers.forEach((h, i) => { if (h) rec[h] = this.cellText(row.getCell(i + 1)); });
      out.push(rec);
    });
    return out;
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
    const raw = await this.parseFile(fileName, buffer);
    if (!raw.length) throw new BadRequestException({ message: 'The file contains no data rows.' });
    if (raw.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({ message: `The file has ${raw.length} rows — the limit is ${MAX_IMPORT_ROWS} per import.` });
    }
    // a missing required column is a file-level problem, not a row-level one
    const present = new Set(Object.keys(raw[0] ?? {}));
    const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
    if (missing.length) {
      throw new BadRequestException({ message: `The file is missing required column(s): ${missing.join(', ')}. Download the import template and use its column headings.` });
    }

    const rows = await this.validateRows(raw);
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
        errors: JSON.stringify({ issues, rows: rows.map((r) => ({ row: r.row, reference: r.reference, data: r.data, valid: r.valid })) }),
      },
    });

    return {
      batch_id: batchId, file_name: fileName, ...counts, issues,
      sample: rows.filter((r) => r.valid).slice(0, 10).map((r) => ({ row: r.row, ...r.data })),
    };
  }

  /** Per-row validation: required fields, formats, enums, relationships and duplicates. */
  private async validateRows(raw: Record<string, string>[]): Promise<ParsedRow[]> {
    const agents = new Set((await this.prisma.users.findMany({ where: { status: 'Active' }, select: { name: true } })).map((u) => u.name));
    const existing = await this.prisma.transactions.findMany({
      where: { deleted_at: null },
      select: { trade_no: true, type: true, price: true, offer_date: true, property: true },
    });

    const out: ParsedRow[] = [];
    const seen: { type: string; price: number; offer: string; property: string; row: number }[] = [];

    raw.forEach((rec, i) => {
      const rowNo = i + 2; // +1 for the header, +1 for 1-based numbering
      const issues: RowIssue[] = [];
      const get = (col: string) => String(rec[col] ?? '').trim();
      const type = get('Transaction Type');
      const reference = get('Property Address') || `Row ${rowNo}`;
      const add = (field: string, value: string, message: string, fix: string, severity: RowIssue['severity'] = 'error') =>
        issues.push({ row: rowNo, reference, field, value, message, fix, severity });

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
        for (const col of forbiddenColumnsFor(type)) {
          if (get(col)) add(col, get(col), `${col} must be empty for ${type}.`, listing ? 'Listing types carry no offer/commission terms — clear this cell.' : 'This column applies to listing types only — clear this cell.');
        }
      }

      // ---- formats ----
      for (const f of IMPORT_FIELDS) {
        const v = get(f.column);
        if (!v) continue;
        if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v.replace(/[$,\s]/g, ''))) {
          add(f.column, v, 'Not a valid number.', 'Use digits only, e.g. 850000 — no currency symbols or commas.');
        }
        if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
          add(f.column, v, 'Not a valid date.', 'Use the YYYY-MM-DD format, e.g. 2026-06-30.');
        }
        if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
          add(f.column, v, 'That date does not exist.', 'Check the day and month, e.g. 2026-02-30 is not a date.');
        }
        if (f.type === 'enum' && f.options && !f.options.includes(v)) {
          const near = this.closest(v, f.options);
          add(f.column, v, `Not an accepted value for ${f.column}.`, near ? `Did you mean "${near}"?` : 'Use one of: ' + f.options.join(', '));
        }
        if (f.type === 'yesno' && !['yes', 'no'].includes(v.toLowerCase())) {
          add(f.column, v, 'Must be Yes or No.', 'Enter Yes or No.');
        }
        if (f.column === 'Lawyer Email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          add(f.column, v, 'Not a valid email address.', 'Use the name@domain.com format, or leave it blank.');
        }
      }

      // ---- status must be valid for the type ----
      const status = get('Deal Status');
      if (known && status) {
        const allowed = statusOptionsFor(type);
        if (!allowed.includes(status)) {
          const near = this.closest(status, allowed);
          add('Deal Status', status, `"${status}" is not a valid status for ${type}.`, near ? `Did you mean "${near}"?` : 'Use one of: ' + allowed.join(', '));
        }
      }

      // ---- relationships: agents must exist ----
      const primary = get('Primary Agent');
      if (primary && !agents.has(primary)) {
        const near = this.closest(primary, [...agents]);
        add('Primary Agent', primary, 'No active user with this name.', near ? `Did you mean "${near}"?` : 'Use the agent’s exact name as it appears in the Users module.');
      }
      const splits = get('Split Agents').split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of splits) if (!agents.has(s)) add('Split Agents', s, `No active user named "${s}".`, 'Use exact agent names, separated by commas.');
      if (splits.length && !primary) add('Split Agents', get('Split Agents'), 'Split agents need a primary agent.', 'Fill in Primary Agent, or clear Split Agents.');

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

      const hasError = issues.some((x) => x.severity === 'error');
      out.push({
        row: rowNo, reference,
        data: this.toBody(rec, type),
        issues,
        valid: !hasError && !duplicate,
        duplicate,
        warning: issues.some((x) => x.severity === 'warning'),
      });
    });
    return out;
  }

  /** Map template columns onto the body TransactionsWriteService.store() expects. */
  private toBody(rec: Record<string, string>, type: string): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const get = (col: string) => String(rec[col] ?? '').trim();
    for (const f of IMPORT_FIELDS) {
      const v = get(f.column);
      if (!v) continue;
      if (f.type === 'number') body[f.key] = Number(v.replace(/[$,\s]/g, ''));
      else if (f.type === 'list') body[f.key] = v.split(',').map((s) => s.trim()).filter(Boolean);
      else if (f.type === 'yesno') body[f.key] = /^yes$/i.test(v) ? 'Yes' : 'No';
      else body[f.key] = v;
    }
    // store() requires a status; fall back to the type's default exactly as the UI does
    if (!body.status) body.status = defaultStatusFor(type) || 'Open';
    return body;
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
   * behave exactly as they do for a manually-created deal. A row that fails is recorded and
   * skipped — a partial import always completes.
   */
  async confirm(batchId: string, user: AuthUserRecord): Promise<ImportResult> {
    this.assertCanImport(user);
    const batch = await this.prisma.import_batches.findUnique({ where: { batch_id: batchId } });
    if (!batch) throw new NotFoundException({ message: 'Import batch not found.' });
    if (batch.status !== 'Validated') {
      throw new BadRequestException({ message: `This import has already been processed (status: ${batch.status}).` });
    }

    const stored = JSON.parse(batch.errors ?? '{}') as { issues?: RowIssue[]; rows?: { row: number; reference: string; data: Record<string, unknown>; valid: boolean }[] };
    const issues: RowIssue[] = [...(stored.issues ?? [])];
    const validRows = (stored.rows ?? []).filter((r) => r.valid);

    const created: ImportResult['created'] = [];
    let failed = 0;
    for (const r of validRows) {
      try {
        const res = await this.write.store(user, r.data);
        const data = res.data as Record<string, unknown>;
        created.push({ row: r.row, trade_no: String(data.trade_no ?? ''), property: (data.property ?? null) as string | null });
      } catch (err) {
        failed++;
        // surface the real reason (duplicate guard, validation) against the offending row
        const message = this.errorText(err);
        issues.push({
          row: r.row, reference: r.reference, field: '—', value: '',
          message, fix: 'Fix the row in your file and re-upload it.', severity: 'error',
        });
      }
    }

    const status = created.length === 0 ? 'Failed'
      : failed > 0 || batch.failed_rows > 0 || batch.duplicate_rows > 0 ? 'Partially Imported'
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
      issues, created,
    };
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
    const head = ws.addRow(['Row', 'Transaction Reference', 'Field', 'Invalid Value', 'Error Description', 'Suggested Correction', 'Severity']);
    head.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
      c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    });
    for (const i of issues) {
      const r = ws.addRow([i.row, i.reference, i.field, i.value, i.message, i.fix, i.severity]);
      r.getCell(7).font = { color: { argb: i.severity === 'error' ? 'FFB91C1C' : i.severity === 'duplicate' ? 'FFB45309' : 'FF64748B' }, bold: true };
      r.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; });
    }
    [8, 30, 20, 22, 46, 46, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
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
