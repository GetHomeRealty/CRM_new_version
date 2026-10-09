import { TransactionImportService } from './transaction-import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';

/*
 * 2026-10-09 - A LISTING NEEDS ITS EXPIRY DATE ONLY WHILE IT IS LIVE.
 *
 * The screen and the server never required a listing expiry date; only the bulk import did, for
 * every listing whatever its status. The brokerage's 2021-2024 history has 369 finished listings
 * (Sold, Leased, Mutual Release, Expired, Terminated...) recorded without one, and Sai, 2026-10-09:
 * expiry is needed when the listing is active. An expiry date only drives the live-listing work -
 * the automatic Expired status and the expiry reminders - and both skip a listing that has none.
 *
 * So the import still refuses a live listing (Active, Sold Conditional, Lease Conditional) or one
 * whose status it cannot read, and accepts a finished one without the date.
 */
const prisma = {
  users: { findMany: async () => [{ name: 'Aswini' }] },
  transactions: { findMany: async () => [] },
} as unknown as PrismaService;
const service = new TransactionImportService(prisma, {} as unknown as TransactionsWriteService);

const expiryIssues = async (type: string, status: string, expiry = ''): Promise<string[]> => {
  const main: Record<string, string> = { 'Transaction Type': type, 'Property Address': '1 ZZ-TEST Rd', 'Deal Status': status, 'Primary Agent': 'Aswini' };
  if (expiry) main['Listing Expiry Date'] = expiry;
  const [r] = await (service as unknown as { validateRows: (r: unknown[]) => Promise<{ issues: { field: string; message: string; severity: string }[] }[]> })
    .validateRows([{ row: 2, ref: 'r2', main, financial: {}, children: {} }]);
  return r.issues.filter((i) => i.field === 'Listing Expiry Date' && i.severity === 'error').map((i) => i.message);
};

describe('a listing needs its expiry date only while it is live', () => {
  it.each([
    ['Residential Sale Listing', 'Sold'],
    ['Residential Lease Listing', 'Leased'],
    ['Residential Sale Listing', 'Mutual Release'],
    ['Residential Lease Listing', 'DFT'],
    ['Residential Sale Listing', 'Expired'],
    ['Residential Sale Listing', 'Terminated'],
    ['Residential Lease Listing', 'Suspended'],
  ])('a %s that is %s imports without an expiry date', async (type, status) => {
    expect(await expiryIssues(type, status)).toEqual([]);
  });

  it.each([
    ['Residential Sale Listing', 'Active'],
    ['Residential Sale Listing', 'Sold Conditional'],
    ['Residential Lease Listing', 'Lease Conditional'],
    ['Residential Sale Listing', ''],
  ])('a %s that is "%s" still needs one', async (type, status) => {
    expect(await expiryIssues(type, status)).toEqual([`Listing Expiry Date is required for ${type}.`]);
  });

  it('a live listing with its expiry date is fine', async () => {
    expect(await expiryIssues('Residential Sale Listing', 'Active', '2026-12-31')).toEqual([]);
  });
});
