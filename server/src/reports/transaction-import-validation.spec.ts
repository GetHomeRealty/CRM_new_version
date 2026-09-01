import * as ExcelJS from 'exceljs';
import { TransactionImportService } from './transaction-import.service';
import { IMPORT_FIELDS, forbiddenColumnsFor } from './import-template';
import { statusOptionsFor } from '../reference/transaction.constants';
import type { PrismaService } from '../prisma/prisma.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';

/**
 * The bulk-import validation report — what an office administrator reads before deciding whether
 * to trust bulk import at all.
 *
 * `validateRows` is private and reads two tables, so it is reached through a cast with a stub
 * Prisma rather than through the controller. That is deliberate: the rules under test are pure
 * given those two lookups, and going through `validate()` would drag in file parsing and add
 * nothing to what is being asserted.
 */
interface IssueLike { row: number; field: string; message: string; severity: string }
interface RowLike { issues: IssueLike[]; valid: boolean }

const prisma = {
  users: { findMany: async () => [{ name: 'Aswini' }] },
  transactions: { findMany: async () => [] },
} as unknown as PrismaService;

const service = new TransactionImportService(prisma, {} as unknown as TransactionsWriteService);

/** One main-sheet row, with no child sheets. */
const row = (main: Record<string, string>): unknown => ({
  row: 2, ref: 'r2', main, financial: {}, children: {},
});

const validate = (main: Record<string, string>): Promise<RowLike[]> =>
  (service as unknown as { validateRows: (r: unknown[]) => Promise<RowLike[]> }).validateRows([row(main)]);

const BASE = { 'Property Address': '1 ZZ-TEST Rd' };

describe('bulk import validation — one problem is reported once (TD-052)', () => {
  it('reports a bad transaction type once, in the wording of the rule that owns the field', async () => {
    const [r] = await validate({ ...BASE, 'Transaction Type': 'Lease Listing' });
    const typeIssues = r.issues.filter((i) => i.field === 'Transaction Type');

    // Was two: the dedicated rule's message and the generic enum check's, with the same fix.
    expect(typeIssues).toHaveLength(1);
    expect(typeIssues[0].message).toBe('Not a valid transaction type.');
  });

  it('still reports a bad value on a field nothing else speaks for', async () => {
    // The de-duplication is per field, so suppressing the Transaction Type duplicate must not
    // suppress an unrelated problem on the same row.
    const [r] = await validate({ ...BASE, 'Transaction Type': 'Lease Listing', 'MLS Type': 'nonsense' });

    expect(r.issues.map((i) => i.field)).toContain('MLS Type');
    expect(r.issues.find((i) => i.field === 'MLS Type')?.message).toBe('Not an accepted value for MLS Type.');
  });

  it('leaves a valid row alone', async () => {
    const [r] = await validate({ ...BASE, 'Transaction Type': 'Residential Sale Listing' });
    expect(r.issues.filter((i) => i.field === 'Transaction Type')).toHaveLength(0);
  });

  it('still names a missing transaction type, which is a different fault from an invalid one', async () => {
    const [r] = await validate({ ...BASE, 'Transaction Type': '' });
    const typeIssues = r.issues.filter((i) => i.field === 'Transaction Type');

    expect(typeIssues).toHaveLength(1);
    expect(typeIssues[0].message).toBe('Transaction Type is required.');
  });
});

/**
 * The downloadable Template is the first thing an office administrator opens, and its row 2 is the
 * only worked example they see. A scaffold that breaks the rules printed two sheets away teaches
 * the wrong shape at exactly the moment the firm is deciding whether to trust bulk import.
 *
 * Asserted against the workbook this code actually produces — generated, re-read, and then put
 * through the same validator an upload goes through — rather than against the constants behind it.
 */
describe('the downloadable template does not contradict itself (TD-098)', () => {
  const cellsOfRow2 = async (): Promise<{ type: string; cell: (col: string) => string }> => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await service.template()) as never);
    const ws = wb.getWorksheet('Transactions')!;
    const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    const values = ws.getRow(2).values as unknown[];
    const cell = (col: string): string => String(values[header.indexOf(col) + 1] ?? '');
    return { type: cell('Transaction Type'), cell };
  };

  it('leaves blank every column its own transaction type forbids', async () => {
    const { type, cell } = await cellsOfRow2();
    // Shipped as a Residential Buying carrying Listing Contract Date and Listing Expiry Date, which
    // the Instructions sheet in the same file reserves for listing types.
    for (const col of forbiddenColumnsFor(type)) expect(cell(col)).toBe('');
  }, 30000);

  it('carries a Deal Status the bound Reference sheet lists for that type', async () => {
    const { type, cell } = await cellsOfRow2();
    // Shipped as 'Open', which the Reference sheet lists only for Preconstruction and Referral.
    expect(statusOptionsFor(type)).toContain(cell('Deal Status'));
  }, 30000);

  it('passes the validator that judges a real upload', async () => {
    const { cell } = await cellsOfRow2();
    const main: Record<string, string> = {};
    for (const f of IMPORT_FIELDS) main[f.column] = cell(f.column);
    const [r] = await validate(main);

    // Uploaded unmodified this returned 1 DETECTED / 0 VALID / 1 INVALID / 1 WARNING.
    expect(r.issues).toHaveLength(0);
    expect(r.valid).toBe(true);
  }, 30000);
});
