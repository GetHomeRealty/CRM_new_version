import { DocumentDefaultsService, seedDocumentDefaults, governingStatus, documentKind } from './document-defaults.service';
import { checklistFor } from './checklist-definitions';

/**
 * TD-159 - seeding a deal's checklist from its type AND status.
 *
 * The lists themselves are covered by checklist-definitions.spec.ts. What is covered here is the
 * behaviour around them: that the right list is written, in order, and - the part that matters most
 * - that a deal the brokerage has no list for is left with NO ROWS rather than a partial checklist
 * it can never recover from.
 */

type Written = { transaction_id: number; title: string; mandatory: boolean; position: number };

const fakeDb = () => {
  const written: Written[] = [];
  let calls = 0;
  const db = {
    documents: {
      createMany: async (a: { data: Written[] }) => {
        calls += 1;
        written.push(...a.data);
        return { count: a.data.length };
      },
    },
  };
  return { db: db as never, written, calls: () => calls };
};

describe('seeding a deal checklist', () => {
  it('writes the brokerage list for that type and status, in their order', async () => {
    const { db, written } = fakeDb();
    const n = await seedDocumentDefaults(db, 42, 'Residential Buying', 'Secured Firm');

    const expected = checklistFor('Residential Buying', 'Secured Firm');
    expect(n).toBe(expected.length);
    expect(written).toHaveLength(expected.length);
    expect(written.map((r) => r.title)).toEqual(expected.map((r) => r.title));
    expect(written.map((r) => r.mandatory)).toEqual(expected.map((r) => r.mandatory));
    expect(written.map((r) => r.position)).toEqual(expected.map((_, i) => i));
    expect(written.every((r) => r.transaction_id === 42)).toBe(true);
  });

  it('gives the same type a different list at a different status', async () => {
    const firm = fakeDb();
    const closed = fakeDb();
    await seedDocumentDefaults(firm.db, 1, 'Residential Buying', 'Secured Firm');
    await seedDocumentDefaults(closed.db, 2, 'Residential Buying', 'Closed');

    // This is the whole point of TD-159: before it, both of these were the same twelve rows.
    expect(closed.written.length).toBeGreaterThan(firm.written.length);
    expect(closed.written.map((r) => r.title)).toContain('Notice of Sale (NOS)');
    expect(firm.written.map((r) => r.title)).not.toContain('Notice of Sale (NOS)');
  });

  describe('when the brokerage has no list for the deal', () => {
    // Each of these must write NOTHING. One row would make documents.count() non-zero for ever, so
    // DocumentsService.index()'s `count === 0` guard could never fire again and fixing the type or
    // setting the status afterwards would no longer repair the checklist.
    it('writes nothing, and does not call the database at all, for a blank status', async () => {
      const { db, written, calls } = fakeDb();
      expect(await seedDocumentDefaults(db, 7, 'Residential Buying', '')).toBe(0);
      expect(written).toEqual([]);
      expect(calls()).toBe(0);
    });

    it('writes nothing for Business Sale, which the brokerage set aside', async () => {
      const { db, calls } = fakeDb();
      expect(await seedDocumentDefaults(db, 8, 'Business Sale', 'Sold')).toBe(0);
      expect(calls()).toBe(0);
    });

    it('writes nothing for a status that type never reaches', async () => {
      const { db, calls } = fakeDb();
      expect(await seedDocumentDefaults(db, 9, 'Residential Buying', 'Expired')).toBe(0);
      expect(calls()).toBe(0);
    });
  });

  it('is reachable through the injectable service too, with the same answer', () => {
    const svc = new DocumentDefaultsService();
    const viaService = svc.defaultsFor('Referral', 'Open');
    const viaTable = checklistFor('Referral', 'Open');
    expect(viaService.map((r) => r.title)).toEqual(viaTable.map((r) => r.title));
    expect(viaService.length).toBeGreaterThan(0);
  });
});

describe('which status governs the checklist', () => {
  it('uses the only status when a deal holds one, which is every live deal today', () => {
    expect(governingStatus('Residential Sale Listing', ['Active'])).toBe('Active');
  });

  it('answers blank when a deal holds none', () => {
    expect(governingStatus('Residential Buying', [])).toBe('');
    expect(governingStatus('Residential Buying', ['', '  '])).toBe('');
  });

  it('lets an ending win, wherever it sits in the list', () => {
    // statusSetProblem already refuses two endings at once, so this can never be ambiguous.
    expect(governingStatus('Residential Sale Listing', ['Sold', 'Closed'])).toBe('Closed');
    expect(governingStatus('Residential Sale Listing', ['Void', 'Active'])).toBe('Void');
    expect(governingStatus('Residential Buying', ['Secured Conditional', 'Mutual Release'])).toBe('Mutual Release');
  });

  it('otherwise takes whichever status is furthest along the brokerage order', () => {
    expect(governingStatus('Residential Sale Listing', ['Active', 'Sold Conditional'])).toBe('Sold Conditional');
    expect(governingStatus('Residential Sale Listing', ['Sold Conditional', 'Active'])).toBe('Sold Conditional');
    expect(governingStatus('Residential Lease Listing', ['Active', 'Lease Conditional', 'Leased'])).toBe('Leased');
  });

  it('does not fall over on a status or type it does not know', () => {
    expect(governingStatus('Timeshare', ['Whatever', 'Something'])).toBe('Something');
    expect(governingStatus('Residential Buying', ['Nonsense'])).toBe('Nonsense');
  });
});

describe('how many files a checklist row accepts', () => {
  const row = (title: string, is_condition = false) => documentKind({ is_condition, title });

  it('still treats the deposit rows as multi-file under the new name', () => {
    // The 2026-09-23 rename took 184 pre-construction rows from Deposit Slip to Deposit Cheque, and
    // this function decides expandability by reading the title. Without the new spelling those rows
    // quietly became single-file.
    expect(row('Deposit Cheque')).toBe('multi');
    expect(row('Deposit Slip')).toBe('multi');
    expect(row('Deposit Receipt')).toBe('multi');
  });

  it('still treats identity and Fintrac rows as per-client', () => {
    expect(row("Client Photo ID's")).toBe('per_client');
    expect(row('Fintrac')).toBe('per_client');
    expect(row('FINTRACK')).toBe('per_client');
  });

  it('treats an ordinary row as single, and a condition as a condition', () => {
    expect(row('Agreement of Purchase and Sale (APS)')).toBe('single');
    expect(row('Deposit Cheque', true)).toBe('condition');
  });
});
