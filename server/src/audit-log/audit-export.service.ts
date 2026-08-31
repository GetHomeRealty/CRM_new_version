import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { toDateTimeString } from '../common/serialize';
import { AuditLogService, type AuditLogQuery } from './audit-log.service';

export type ExportFormat = 'csv' | 'xlsx';

export interface AuditExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
  /** Rows actually written, so the caller can log and the UI can report it. */
  rows: number;
  /** True when the result hit the ceiling and was cut short. */
  truncated: boolean;
}

/**
 * Exporting the CRM audit trail as CSV or Excel.
 *
 * THE FILTERS ARE NOT RE-IMPLEMENTED HERE. `AuditLogService.buildWhere` is the single source of the
 * filtering rules, and this calls it. That is a deliberate structural choice rather than tidiness:
 * an export that quietly disagrees with the screen it was taken from is worse than no export at all,
 * because the person reading it has no way to notice. One builder, two callers.
 *
 * DOMAIN ISOLATION COMES FOR FREE, and is not re-stated:
 *   - the CRM/Desk split is part of `buildWhere` (via `domainWhere`), so a CRM export can only ever
 *     contain CRM-domain rows;
 *   - the brokerage filter is applied by the Prisma client extension to every query in the
 *     application, so a company id from the browser is not consulted and could not help anybody.
 */
@Injectable()
export class AuditExportService {
  private readonly log = new Logger(AuditExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogService,
  ) {}

  /**
   * The most rows one export may contain.
   *
   * A bound rather than a stream, because the honest shape of this data is small: an audit trail for
   * one brokerage over a filtered period. 50,000 rows is far past any realistic filtered export and
   * still generates in memory in about a second. Beyond it the export is TRUNCATED AND SAYS SO —
   * silently returning the first 50,000 rows of a larger set would be a file that looks complete
   * and is not.
   */
  static readonly MAX_ROWS = 50_000;

  /** Read in pages so a large export never holds one enormous Prisma result set. */
  private static readonly PAGE = 2_000;

  /**
   * Columns, in the order they appear in the file.
   *
   * Every one of these is already visible on the Audit Trail screen to anybody who can open it.
   * Nothing is added that the screen does not show — an export is a different shape of the same
   * information, not a wider view of it.
   */
  private static readonly COLUMNS: Array<{ key: string; header: string; width: number }> = [
    { key: 'date', header: 'Date', width: 12 },
    { key: 'time', header: 'Time', width: 10 },
    { key: 'who', header: 'User', width: 24 },
    { key: 'role', header: 'User Role', width: 14 },
    { key: 'action', header: 'Action', width: 18 },
    { key: 'category', header: 'Category', width: 18 },
    { key: 'section', header: 'Module / Section', width: 22 },
    { key: 'record', header: 'Record', width: 20 },
    { key: 'record_id', header: 'Record ID', width: 12 },
    { key: 'field', header: 'Field', width: 22 },
    { key: 'old_value', header: 'Previous Value', width: 30 },
    { key: 'new_value', header: 'New Value', width: 30 },
    { key: 'details', header: 'Description', width: 40 },
    { key: 'source', header: 'Source', width: 14 },
    { key: 'domain', header: 'Domain', width: 10 },
    /*
     * "Recorded At", not "Created".
     *
     * The header read as "created BY" and the column holds a timestamp, so it was taken for a
     * person's name — the name is two columns to the left, under `User`. The value is the full
     * `YYYY-MM-DD HH:MM:SS`, which is `Date` and `Time` joined; it is kept rather than dropped
     * because one sortable column is what a spreadsheet filter actually wants, and only the label
     * was wrong.
     */
    { key: 'created_at', header: 'Recorded At', width: 20 },
  ];

  /**
   * Values that must never leave the building, however they got into the trail.
   *
   * The audit trail stores `old_value`/`new_value` for whatever changed, and a future writer could
   * record a field whose value is a credential. This is a REDACTION AT THE EXPORT BOUNDARY, checked
   * against the field name rather than the value, so it does not depend on guessing what a secret
   * looks like. The screen already shows these values to the same people; the difference is that a
   * file leaves the application and gets emailed, so it is worth a second gate.
   */
  private static readonly SENSITIVE = [
    'password', 'passwd', 'secret', 'token', 'access_token', 'refresh_token',
    'api_key', 'apikey', 'session', 'cookie', 'authorization', 'auth',
    'mfa', 'totp', 'recovery_code', 'private_key', 'encryption', 'app_key',
    'client_secret', 'credential', 'signature',
  ];

  private static readonly REDACTED = '[redacted]';

  /** Whether a field name looks like it holds a credential. */
  private isSensitive(field: string | null | undefined): boolean {
    const name = String(field ?? '').toLowerCase();
    if (!name) return false;
    return AuditExportService.SENSITIVE.some((needle) => name.includes(needle));
  }

  // ========================================================================== generation

  async export(query: AuditLogQuery, format: ExportFormat): Promise<AuditExportFile> {
    if (format !== 'csv' && format !== 'xlsx') {
      throw new BadRequestException({
        message: `"${format}" is not an export format.`,
        errors: { format: ['Use csv or xlsx.'] },
      });
    }

    // The SAME where the screen used. Invalid filters throw here exactly as they do for the
    // listing, so a bad date or user id is refused rather than silently exporting everything.
    const { where, area } = this.auditLogs.buildWhere(query);

    const { rows, truncated } = await this.rows(where);
    const filename = this.filename(query, format);

    this.log.log(`Audit export: ${rows.length} row(s) as ${format}${truncated ? ' (truncated)' : ''} for area "${area}".`);

    const body = format === 'csv' ? this.toCsv(rows) : await this.toXlsx(rows);
    return {
      filename,
      contentType: format === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body,
      rows: rows.length,
      truncated,
    };
  }

  /** Read the matching rows, in pages, up to the ceiling. */
  private async rows(where: Parameters<PrismaService['audit_logs']['findMany']>[0] extends never ? never : object): Promise<{ rows: Record<string, string>[]; truncated: boolean }> {
    const out: Record<string, string>[] = [];
    let skip = 0;
    let truncated = false;

    // Roles are resolved once, not per row: the trail stores `who` (a name) and `user_id`, not a
    // role, and a lookup per row would be an N+1 on the one path that reads thousands of them.
    const roles = new Map<number, string>();
    const users = await this.prisma.users.findMany({ select: { id: true, role: true } });
    for (const u of users) roles.set(u.id, u.role);

    for (;;) {
      const take = Math.min(AuditExportService.PAGE, AuditExportService.MAX_ROWS - out.length + 1);
      if (take <= 0) break;

      const page = await this.prisma.audit_logs.findMany({
        where: where as never,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip,
        take,
        include: { transactions: { select: { id: true, trade_no: true, deleted_at: true } } },
      });
      if (page.length === 0) break;

      for (const a of page) {
        if (out.length >= AuditExportService.MAX_ROWS) { truncated = true; break; }
        out.push(this.toRow(a, roles));
      }
      if (truncated || page.length < take) break;
      skip += page.length;
    }

    return { rows: out, truncated };
  }

  /** One audit row, flattened and redacted. */
  private toRow(
    a: {
      id: number; category: string | null; transaction_id: number | null; who: string | null;
      user_id: number | null; section: string | null; field: string | null; action: string | null;
      source: string | null; old_value: string | null; new_value: string | null;
      details: string | null; domain: string | null; created_at: Date | null;
      transactions?: { id: number; trade_no: string | null; deleted_at: Date | null } | null;
    },
    roles: Map<number, string>,
  ): Record<string, string> {
    const stamp = toDateTimeString(a.created_at) ?? '';
    // A soft-deleted transaction is not shown as a record, matching the listing exactly.
    const txn = a.transactions && a.transactions.deleted_at === null ? a.transactions : null;
    const redact = this.isSensitive(a.field) || this.isSensitive(a.section);

    return {
      date: stamp.slice(0, 10),
      time: stamp.slice(11, 19),
      who: a.who ?? '',
      role: a.user_id !== null ? (roles.get(a.user_id) ?? '') : '',
      action: a.action ?? '',
      category: a.category || (a.transaction_id ? 'Transactions' : 'General'),
      section: a.section ?? '',
      record: txn ? `Trade #${txn.trade_no ?? ''}` : '',
      record_id: a.transaction_id !== null ? String(a.transaction_id) : '',
      field: a.field ?? '',
      old_value: redact ? AuditExportService.REDACTED : (a.old_value ?? ''),
      new_value: redact ? AuditExportService.REDACTED : (a.new_value ?? ''),
      details: redact ? AuditExportService.REDACTED : (a.details ?? ''),
      source: a.source ?? '',
      domain: a.domain ?? '',
      created_at: stamp,
    };
  }

  // ========================================================================== CSV

  /**
   * RFC 4180 CSV.
   *
   * A BOM is written first so Excel opens a UTF-8 file as UTF-8 — without it, a French or accented
   * name in the `who` column renders as mojibake, which looks like corrupted data rather than a
   * missing byte-order mark.
   */
  private toCsv(rows: Record<string, string>[]): Buffer {
    const lines: string[] = [];
    lines.push(AuditExportService.COLUMNS.map((c) => this.csvCell(c.header)).join(','));
    for (const row of rows) {
      lines.push(AuditExportService.COLUMNS.map((c) => this.csvCell(row[c.key] ?? '')).join(','));
    }
    return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(lines.join('\r\n'), 'utf8')]);
  }

  /**
   * One CSV cell.
   *
   * Quoted when it contains a comma, quote, or newline; internal quotes doubled — RFC 4180.
   *
   * THE LEADING APOSTROPHE IS A SECURITY MEASURE, not formatting. A cell beginning `=`, `+`, `-` or
   * `@` is executed as a FORMULA by Excel and Sheets when the file is opened. An audit trail records
   * text somebody typed, so a lead named `=cmd|'/c calc'!A0` would run on the machine of whoever
   * opened the export. Prefixing with an apostrophe makes the spreadsheet treat it as text, which is
   * what it is.
   */
  private csvCell(value: string): string {
    let v = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }

  // ========================================================================== Excel

  /** Excel, via the `exceljs` dependency the reports module already uses. */
  private async toXlsx(rows: Record<string, string>[]): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    book.created = new Date();
    const sheet = book.addWorksheet('Audit Trail', {
      views: [{ state: 'frozen', ySplit: 1 }],   // the header stays put while scrolling
    });

    sheet.columns = AuditExportService.COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    sheet.getRow(1).font = { bold: true };

    for (const row of rows) {
      const values: Record<string, string> = {};
      for (const c of AuditExportService.COLUMNS) {
        // The same formula guard as CSV: Excel executes a leading `=` wherever it comes from.
        const raw = row[c.key] ?? '';
        values[c.key] = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
      }
      sheet.addRow(values);
    }

    // `autoFilter` gives the reader the same filtering the screen had, inside the file.
    if (rows.length) sheet.autoFilter = { from: 'A1', to: { row: 1, column: AuditExportService.COLUMNS.length } };

    return Buffer.from(await book.xlsx.writeBuffer());
  }

  // ========================================================================== naming

  /**
   * A filename that says what the file is.
   *
   * Deliberately carries NO database or deployment identifier: the file is emailed and stored, and a
   * company id in the name tells a recipient something about the deployment for no benefit. The date
   * range is included when one was filtered on, because that is what distinguishes two exports.
   */
  private filename(query: AuditLogQuery, format: ExportFormat): string {
    const area = String(query.area ?? 'crm').toLowerCase() === 'desk' ? 'desk' : 'crm';
    const day = (d?: string) => String(d ?? '').slice(0, 10);
    const from = day(query.from);
    const to = day(query.to);

    const span = from && to ? `${from}-to-${to}`
      : from ? `from-${from}`
        : to ? `to-${to}`
          : new Date().toISOString().slice(0, 10);

    return `${area}-audit-${span}.${format}`;
  }
}
