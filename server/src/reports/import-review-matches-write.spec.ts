import { TransactionImportService } from './transaction-import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';

/**
 * TD-194 - THE REVIEW MUST REFUSE WHAT THE IMPORT WOULD REFUSE.
 *
 * On 2026-09-17 a file of seven deals reviewed as "7 valid, 0 invalid". The import then created one
 * and rejected six, every one of them for an offer date in the future - a rule the write path
 * enforces and the review did not repeat. Nothing was half-written; the review simply promised
 * something it could not keep, and the person had to find the rejections afterwards.
 *
 * These tests are written against the MESSAGE the write path produces, not a copy of it, because
 * the review now calls that same function. A rule added there and not asked here would fail on the
 * last test in this file.
 */
interface IssueLike { row: number; field: string; message: string; severity: string }
interface RowLike { issues: IssueLike[]; valid: boolean }

const prisma = {
  users: { findMany: async () => [{ name: 'Aswini' }] },
  transactions: { findMany: async () => [] },
} as unknown as PrismaService;

const service = new TransactionImportService(prisma, {} as unknown as TransactionsWriteService);

const validate = (main: Record<string, string>): Promise<RowLike[]> =>
  (service as unknown as { validateRows: (r: unknown[]) => Promise<RowLike[]> })
    .validateRows([{ row: 2, ref: 'r2', main, financial: {}, children: {} }]);

const text = (r: RowLike): string => r.issues.map((i) => i.message).join(' | ');

/** Relative to today, so these tests do not rot the way a hard-coded date would. */
const day = (offset: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const BUYING = (over: Record<string, string> = {}): Record<string, string> => ({
  'Transaction Type': 'Residential Buying', 'Property Address': '3 ZZ-TEST Rd',
  Price: '500000', Deposit: '25000', Agent: 'Aswini',
  'Offer Date': day(-30), 'Closing Date': day(30), ...over,
});

describe('the review asks the write path\u2019s date questions', () => {
  it('refuses an offer date in the future - the six rejected rows of 2026-09-17', async () => {
    const [r] = await validate(BUYING({ 'Offer Date': day(7) }));
    expect(text(r)).toMatch(/offer date cannot be in the future/i);
    expect(r.valid).toBe(false);
  });

  it('accepts one dated today, which is the boundary', async () => {
    const [r] = await validate(BUYING({ 'Offer Date': day(0), 'Closing Date': day(60) }));
    expect(text(r)).not.toMatch(/future/i);
  });

  it('refuses a closing date before the offer date', async () => {
    const [r] = await validate(BUYING({ 'Offer Date': day(-10), 'Closing Date': day(-20) }));
    expect(text(r)).toMatch(/closing date cannot be before the offer date/i);
    expect(r.valid).toBe(false);
  });

  it('accepts an ordinary pair', async () => {
    const [r] = await validate(BUYING());
    expect(text(r)).not.toMatch(/future|before the offer date/i);
  });

  it('reports a malformed date as malformed, and invents no second complaint', async () => {
    // Comparing "14/03/2026" as text would read as "before the offer date" and send somebody
    // looking for an ordering problem the row does not have. Only a well-formed date is compared.
    const [r] = await validate(BUYING({ 'Offer Date': '14/03/2026' }));
    expect(text(r)).toMatch(/not a valid date/i);
    expect(text(r)).not.toMatch(/before the offer date|in the future/i);
  });
});
