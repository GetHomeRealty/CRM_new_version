import { TransactionImportService } from './transaction-import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';

/**
 * THE THREE THINGS THE 2026-09-13 MIGRATION WORKED AROUND IN THE SPREADSHEET INSTEAD OF FIXING.
 *
 * None of them harmed that migration, because the file was reshaped to avoid all three. They are
 * here because bulk import is now a feature the brokerage has, and the next person to upload an
 * ordinary file walks straight into them.
 */
interface IssueLike { row: number; field: string; message: string; severity: string }
interface RowLike { issues: IssueLike[]; valid: boolean }

const prisma = {
  users: { findMany: async () => [{ name: 'Aswini' }] },
  transactions: { findMany: async () => [] },
} as unknown as PrismaService;

const service = new TransactionImportService(prisma, {} as unknown as TransactionsWriteService);

const validate = (main: Record<string, string>, financial: Record<string, string> = {},
                  children: Record<string, unknown[]> = {}): Promise<RowLike[]> =>
  (service as unknown as { validateRows: (r: unknown[]) => Promise<RowLike[]> })
    .validateRows([{ row: 2, ref: 'r2', main, financial, children }]);

const text = (r: RowLike): string => r.issues.map((i) => i.message).join(' | ');

const LISTING = {
  'Transaction Type': 'Residential Sale Listing', 'Property Address': '1 ZZ-TEST Rd',
  'Listing Contract Date': '2026-03-01', 'Listing Expiry Date': '2026-09-01', 'List Price': '800000',
};
const PRECON = { 'Transaction Type': 'Preconstruction', 'Property Address': '2 ZZ-TEST Rd', Price: '100000' };

describe('a listing whose commission is a percentage (trap 1)', () => {
  it('is refused rather than imported as a silent zero', async () => {
    const [r] = await validate(LISTING, { 'Co-Op Commission %': '2.5' });
    expect(r.valid).toBe(false);
    expect(text(r)).toMatch(/zero/i);
  });

  it('is accepted when the amount is given instead', async () => {
    const [r] = await validate(LISTING, { 'Co-Op Commission Flat': '20000' });
    expect(text(r)).not.toMatch(/zero/i);
  });

  it('says nothing about a listing that claims no commission at all', async () => {
    const [r] = await validate(LISTING, {});
    expect(text(r)).not.toMatch(/zero/i);
  });
});

describe('a preconstruction deal whose fee is missing (trap 2)', () => {
  it('is warned about, not refused, when it carries terms but no fee of its own', async () => {
    const [r] = await validate(PRECON, {}, { preconTerms: [{ Ref: 'r2', 'Commission %': '1' }] });
    const warn = r.issues.filter((i) => /no commission of its own/i.test(i.message));
    expect(warn.length).toBe(1);
    expect(warn[0].severity).toBe('warning');
  });

  it('says nothing when the deal states its own fee', async () => {
    const [r] = await validate(PRECON, { 'Precon Commission %': '3' },
      { preconTerms: [{ Ref: 'r2', 'Commission %': '1' }] });
    expect(text(r)).not.toMatch(/no commission of its own/i);
  });
});

describe('instalments that round (trap 3)', () => {
  it('accepts terms that overshoot by a penny, which is rounding', async () => {
    const [r] = await validate(PRECON, { 'Precon Commission %': '3' }, {
      preconTerms: [{ Ref: 'r2', 'Commission Amount': '1500.00' },
                    { Ref: 'r2', 'Commission Amount': '1500.01' }],
    });
    expect(text(r)).not.toMatch(/more than the deal/i);
  });

  it('still refuses terms that genuinely exceed the deal', async () => {
    const [r] = await validate(PRECON, { 'Precon Commission %': '3' }, {
      preconTerms: [{ Ref: 'r2', 'Commission Amount': '1500' },
                    { Ref: 'r2', 'Commission Amount': '1600' }],
    });
    expect(text(r)).toMatch(/more than the deal/i);
  });
});
