import * as ExcelJS from 'exceljs';
import { TransactionImportService } from './transaction-import.service';
import { IMPORT_FIELDS, FINANCIAL_FIELDS, CHILD_SHEETS, forbiddenColumnsFor } from './import-template';
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
interface IssueLike { row: number; field: string; message: string; severity: string; section?: string }
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
  /*
   * The example used to be 'Lease Listing', which TD-050 has since made VALID — it is the label the
   * screens show for `Residential Lease Listing`, and refusing what the product taught the user to
   * say was that defect. The rule TD-052 pins is untouched; only a type that is genuinely not one
   * can demonstrate it.
   */
  it('reports a bad transaction type once, in the wording of the rule that owns the field', async () => {
    const [r] = await validate({ ...BASE, 'Transaction Type': 'Spaceship Sale' });
    const typeIssues = r.issues.filter((i) => i.field === 'Transaction Type');

    // Was two: the dedicated rule's message and the generic enum check's, with the same fix.
    expect(typeIssues).toHaveLength(1);
    expect(typeIssues[0].message).toBe('Not a valid transaction type.');
  });

  it('still reports a bad value on a field nothing else speaks for', async () => {
    // The de-duplication is per field, so suppressing the Transaction Type duplicate must not
    // suppress an unrelated problem on the same row.
    const [r] = await validate({ ...BASE, 'Transaction Type': 'Spaceship Sale', 'MLS Type': 'nonsense' });

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

  /*
   * THE WHOLE WORKBOOK, not the Transactions sheet on its own.
   *
   * The three assertions above read row 2 of one sheet and hand its cells to the validator as a
   * transaction with no children. That is the shape TD-098 was first written about, and it passed
   * while the file a user actually downloads still came back 0 VALID — the error was on the Team
   * Split sheet ('No active user named "Ramesh Gollu"') and the warning was raised by the
   * Conditions sheet against the Transactions sheet's own Conditional Offer cell. Neither sheet was
   * in the test, so neither could fail it.
   *
   * TD-098 records that this entry was closed twice by checks that counted the right columns
   * without reading what was inside them. So this one does the thing the entry describes: generate
   * the shipped template, put the BUFFER through the same parse the upload route uses, and validate
   * every row it yields, children and all.
   */
  const uploadUnmodified = async (buffer: Buffer): Promise<RowLike[]> => {
    const priv = service as unknown as {
      parseFile: (name: string, b: Buffer) => Promise<{ records: unknown[] }>;
      validateRows: (r: unknown[]) => Promise<RowLike[]>;
    };
    const parsed = await priv.parseFile('template.xlsx', buffer);
    return priv.validateRows(parsed.records);
  };

  it('validates clean when the file is downloaded and uploaded with nothing changed', async () => {
    const rows = await uploadUnmodified((await service.template()) as Buffer);

    // Was: 1 row detected, 0 valid, 1 invalid, 1 warning — on a file nobody had touched.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.flatMap((r) => r.issues.map((i) => `${i.section || 'Transactions'} / ${i.field}: ${i.message}`))).toEqual([]);
    expect(rows.every((r) => r.valid)).toBe(true);
  }, 30000);

  /**
   * The columns that name a USER ACCOUNT, listed here as a literal rather than derived.
   *
   * Deriving them - `fields.filter((f) => f.roster)` - is how this check quietly stops checking:
   * strip the flags and the filter yields nothing, every loop body runs zero times, and the test
   * goes green while the template ships 'Ramesh Gollu' on five sheets again. Naming them makes the
   * flags themselves the thing under test, so removing one FAILS here rather than disappearing.
   *
   * Adding a genuine sixth roster column is then a two-line change: flag it, and add it here. That
   * is the intended cost - this list is the statement of which columns a shipped workbook may not
   * fill in, and it should not be possible to change that set without saying so.
   */
  const ROSTER_COLUMNS: [string, string][] = [
    ['Transactions', 'Primary Agent'],
    ['Transactions', 'Split Agents'],
    ['Financial', 'Commission Agent'],
    ['Team Split', 'Agent'],
    ['Adjustments', 'Agent'],
  ];

  it('still marks exactly the columns that name an account', () => {
    const declared = [
      ...IMPORT_FIELDS.filter((f) => f.roster).map((f) => ['Transactions', f.column]),
      ...FINANCIAL_FIELDS.filter((f) => f.roster).map((f) => ['Financial', f.column]),
      ...CHILD_SHEETS.flatMap((c) => c.fields.filter((f) => f.roster).map((f) => [c.sheet, f.column])),
    ];
    // The guard on the guard: without this, deleting the `roster` flags would make every
    // assertion below iterate an empty list and pass.
    expect(declared.sort()).toEqual([...ROSTER_COLUMNS].sort());
  });

  it('names no agent it cannot know on any example row', async () => {
    // Blank by construction rather than by luck: the validator only refuses Team Split -> Agent
    // today, so a placeholder left in Adjustments -> Agent or Financial -> Commission Agent would
    // sit there passing until the day a check reaches it.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await service.template()) as never);

    for (const [sheet, column] of ROSTER_COLUMNS) {
      const ws = wb.getWorksheet(sheet)!;
      const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
      const values = ws.getRow(2).values as unknown[];
      expect(`${sheet} / ${column} = ${String(values[header.indexOf(column) + 1] ?? '')}`)
        .toBe(`${sheet} / ${column} = `);
    }
  }, 30000);

  it('leaves the Sample workbook clean too, which is what confined this to the Template', async () => {
    const rows = await uploadUnmodified((await service.sample()) as Buffer);
    expect(rows.every((r) => r.valid)).toBe(true);
  }, 30000);
});
