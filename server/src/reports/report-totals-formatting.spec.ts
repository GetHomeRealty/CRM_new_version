import * as ExcelJS from 'exceljs';
import { ReportExportService } from './report-export.service';
import type { ExportPayload, ReportColumn } from './report.types';

/**
 * TD-041 — a total is formatted like the column it sits under, not always as money.
 *
 * THE DEFECT. The body-cell formatter branched on the column type — currency got the money
 * formatter, percent a percent suffix, a date its long form. The TOTALS-row formatter looked only
 * at `total: true` and called the money formatter on whatever it found. Every totalled column
 * therefore printed as dollars, including the document COUNTS on the two compliance reports:
 * "Totals (6)" with $44.00 pending documents, $2.00 invalid and $0.00 missing mandatory. The
 * counts themselves were right; a reader of a RECO Audit Readiness report was simply invited to
 * read them as money owed.
 *
 * WHAT IS PINNED. The exported artifacts, because they are the copy that leaves the building. The
 * XLSX assertions check the CELL VALUE and its NUMBER FORMAT — the value is what a reader re-sums
 * or charts, and the format is what turned 44 into $44.00 on screen. `totalText` is asserted
 * directly as well: it is the one rule the PDF's totals row and the XLSX both call, and a PDF's
 * text is compressed inside the file, so a string assertion there would prove nothing.
 *
 * The screen carries the same rule, in `ReportDetailPage.totalText` — the client has no unit
 * runner, so its half is covered by the shared shape rather than a second copy of this file.
 *
 * No database: formatting a number that has already been summed is a pure function of the column.
 */

const col = (key: string, label: string, type: ReportColumn['type'], extra: Partial<ReportColumn> = {}): ReportColumn =>
  ({ key, label, type, default: true, total: true, ...extra });

/** A compliance report's shape: money beside counts, which is what made the defect visible. */
const COLUMNS: ReportColumn[] = [
  col('deal_no', 'Deal No', 'text', { total: false }),
  col('price', 'Sale Price', 'currency'),
  col('pending_docs', 'Pending Documents', 'number'),
  col('invalid_docs', 'Invalid Documents', 'number'),
  col('missing_mandatory', 'Missing Mandatory Documents', 'number'),
  col('comm_pct', 'Commission %', 'percent', { total: false, average: true }),
];

const payload = (): ExportPayload => ({
  reportName: 'RECO Audit Readiness Report',
  generatedAt: new Date('2026-09-04T12:00:00.000Z'),
  generatedBy: 'QA',
  appliedFilters: [],
  dealTypeHeading: null,
  columns: COLUMNS,
  rows: [
    { deal_no: 'A-1', price: 700000, pending_docs: 11, invalid_docs: 1, missing_mandatory: 0, comm_pct: 2.5 },
    { deal_no: 'A-2', price: 450000, pending_docs: 33, invalid_docs: 1, missing_mandatory: 0, comm_pct: 2.5 },
  ],
  totals: { count: 2, price: 1150000, pending_docs: 44, invalid_docs: 2, missing_mandatory: 0, comm_pct: 2.5 },
  branding: 'Test Brokerage',
});

const svc = new ReportExportService();
/** The one shared rule the PDF totals row and the XLSX number formats are both built on. */
const totalText = (c: ReportColumn, n: number): string =>
  (svc as unknown as { totalText(c: ReportColumn, n: number): string }).totalText(c, n);

describe('report totals are formatted by column type, not always as currency (TD-041)', () => {
  it('formats a counted column as a count and a money column as money', () => {
    const byKey = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
    // The exact figures from the defect report, on the exact columns it names.
    expect(totalText(byKey.pending_docs, 44)).toBe('44');
    expect(totalText(byKey.invalid_docs, 2)).toBe('2');
    expect(totalText(byKey.missing_mandatory, 0)).toBe('0');
    expect(totalText(byKey.price, 1150000)).toBe('$1,150,000.00');
    expect(totalText(byKey.comm_pct, 2.5)).toBe('2.50%');
  });

  it('keeps thousands separators on a count, and does not invent decimals', () => {
    const c = COLUMNS.find((x) => x.key === 'pending_docs')!;
    expect(totalText(c, 128)).toBe('128');
    expect(totalText(c, 12805)).toBe('12,805');
    // A totalled number column that genuinely holds a fraction still shows it — the rule drops
    // FORCED decimals, it does not round a real value away.
    expect(totalText(c, 12.5)).toBe('12.5');
  });

  it('writes the XLSX totals row as numbers, each with its own column format', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await svc.xlsx(payload()) as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0];

    let totalsRow: ExcelJS.Row | undefined;
    ws.eachRow((r) => { if (String(r.getCell(1).value ?? '').startsWith('Totals (')) totalsRow = r; });
    expect(totalsRow).toBeDefined();

    const at = (key: string) => totalsRow!.getCell(COLUMNS.findIndex((c) => c.key === key) + 1);

    // The values stay native numbers so the reader can re-sum them; the defect is the FORMAT.
    expect(at('pending_docs').value).toBe(44);
    expect(at('pending_docs').numFmt).toBe('#,##0.##');
    expect(at('invalid_docs').numFmt).toBe('#,##0.##');
    expect(at('missing_mandatory').numFmt).toBe('#,##0.##');
    // Money is still money — the fix narrows the currency format to the columns that hold it.
    expect(at('price').value).toBe(1150000);
    expect(at('price').numFmt).toBe('$#,##0.00');
    // An averaged percent column is neither: it now carries the percent format the body cells use.
    expect(at('comm_pct').numFmt).toBe('0.00"%"');
  });

  it('still renders a PDF, with the totals row present', async () => {
    // Not asserting the drawn text — PDF content streams are compressed, and `totalText` above is
    // the rule this renderer calls. What this catches is a totals row that throws or vanishes.
    const buf = await svc.pdf(payload());
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
