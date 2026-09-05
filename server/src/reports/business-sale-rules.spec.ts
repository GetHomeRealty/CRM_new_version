import { TransactionImportService } from './transaction-import.service';
import {
  TRANSACTION_TYPES, splitClassificationNote, statusOptionsFor, statusSetProblem,
} from '../reference/transaction.constants';
import type { PrismaService } from '../prisma/prisma.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';

/**
 * TD-051 — Business Sale takes offer dates AND listing statuses, and now says so.
 *
 * WHAT WAS REPORTED, AND WHAT IT ACTUALLY IS. A Business Sale row with listing dates is told that
 * Price, Offer Date and Closing Date are required and that the listing dates must be empty — it is
 * being judged offer-side. Corrected to offer dates and "Secured Firm", it is then told that
 * "Secured Firm" is not a valid status for Business Sale — judged listing-side. It reads as a
 * contradiction, and it was the only one of the twelve types that failed a corrected second
 * attempt.
 *
 * IT IS NOT A CONTRADICTION. A business sale is transacted on an offer and sold like a listing, so
 * `requiredColumnsFor` (offer-side) and `statusOptionsFor` (listing-side) are both right, and a
 * valid combination exists: offer dates with a listing status. THE RULE WAS SIMPLY UNDOCUMENTED,
 * and the two refusals arrive one at a time, so meeting the first guarantees meeting the second by
 * surprise.
 *
 * SO NO VALIDATION CHANGED. Aligning the two classifications would forbid Business Sale the offer
 * dates it genuinely needs. What changed is that every message that could send somebody down that
 * path now carries the whole rule, and the template states it where a file is being prepared.
 *
 * The note is DERIVED from the two classifiers rather than naming the type, so a second type that
 * ever sits across them explains itself the same way instead of silently reopening this.
 */

describe('the split classification is stated, not left to be discovered (TD-051)', () => {
  it('speaks for Business Sale', () => {
    const note = splitClassificationNote('Business Sale');
    expect(note).toContain('offer');
    expect(note).toContain('listing');
  });

  it.each(TRANSACTION_TYPES.filter((t) => t !== 'Business Sale'))('says nothing about %s', (type) => {
    // Every other type is one thing or the other, and a note on a type that does not need one is
    // noise on a message somebody is trying to act on.
    expect(splitClassificationNote(type)).toBeNull();
  });

  it('rides along with the API refusal, not only the importer', () => {
    const problem = statusSetProblem('Business Sale', ['Secured Firm']);
    expect(problem).toContain('is not a status a Business Sale transaction can have');
    expect(problem).toContain('transacted on an offer but sold like a listing');

    // A listing type refuses the same status without the note — nothing about it is surprising.
    const listing = statusSetProblem('Residential Sale Listing', ['Secured Firm']);
    expect(listing).toContain('is not a status');
    expect(listing).not.toContain('transacted on an offer');
  });
});

describe('the bulk importer explains Business Sale on the FIRST refusal (TD-051)', () => {
  const prisma = {
    users: { findMany: async () => [{ name: 'Aswini' }] },
    transactions: { findMany: async () => [] },
  } as unknown as PrismaService;
  const service = new TransactionImportService(prisma, {} as unknown as TransactionsWriteService);

  interface IssueLike { field: string; message: string; fix: string }
  interface RowLike { issues: IssueLike[]; valid: boolean }

  const validate = (main: Record<string, string>): Promise<RowLike[]> =>
    (service as unknown as { validateRows: (r: unknown[]) => Promise<RowLike[]> })
      .validateRows([{ row: 2, ref: 'r2', main, financial: {}, children: {} }]);

  const ADDRESS = { 'Property Address': '1 ZZ-TEST Rd' };
  const OFFER_SIDE = {
    Price: '250000', 'Offer Date': '2026-03-01', 'Closing Date': '2026-06-01',
    'Commission Type': '%', 'Commission Value': '2.5',
  };

  it('carries the rule on the DATE refusals — QA\'s first upload', async () => {
    const [r] = await validate({
      ...ADDRESS, 'Transaction Type': 'Business Sale',
      'Listing Contract Date': '2026-01-01', 'Listing Expiry Date': '2026-06-01', 'Deal Status': 'Active',
    });

    const required = r.issues.find((i) => i.field === 'Offer Date');
    const forbidden = r.issues.find((i) => i.field === 'Listing Contract Date');
    expect(required?.message).toBe('Offer Date is required for Business Sale.');
    expect(forbidden?.message).toBe('Listing Contract Date must be empty for Business Sale.');
    // The whole rule on the first pass, so the status set is not a second surprise.
    for (const issue of [required, forbidden]) {
      expect([issue?.field, issue?.fix.includes('sold like a listing')]).toEqual([issue?.field, true]);
    }
  });

  it('carries it on the STATUS refusal — QA\'s corrected second upload', async () => {
    const [r] = await validate({
      ...ADDRESS, ...OFFER_SIDE, 'Transaction Type': 'Business Sale', 'Deal Status': 'Secured Firm',
    });

    const status = r.issues.find((i) => i.field === 'Deal Status');
    expect(status?.message).toBe('"Secured Firm" is not a valid status for Business Sale.');
    expect(status?.fix).toContain('sold like a listing');
  });

  it('validates the combination that was always valid, with no issues at all', async () => {
    // The control from the re-test: offer dates AND a listing status. If this ever fails, somebody
    // has "aligned" the two rules and taken away the dates a business sale needs.
    for (const status of ['Active', 'Sold']) {
      const [r] = await validate({
        ...ADDRESS, ...OFFER_SIDE, 'Transaction Type': 'Business Sale', 'Deal Status': status,
      });
      expect([status, r.issues.map((i) => i.field)]).toEqual([status, []]);
      expect([status, r.valid]).toEqual([status, true]);
    }
  });

  it('still offers Business Sale exactly the listing statuses', () => {
    // The rule itself is unchanged — this is what the note describes, and what the Reference sheet
    // of the template prints beside it.
    expect(statusOptionsFor('Business Sale')).toEqual(statusOptionsFor('Residential Sale Listing'));
  });
});
