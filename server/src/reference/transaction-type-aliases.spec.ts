import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TransactionImportService } from '../reports/transaction-import.service';
import {
  ACCEPTED_TYPE_NAMES, TRANSACTION_TYPES, TYPE_LABELS, canonicalTransactionType,
} from './transaction.constants';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionsWriteService } from '../transactions/transactions-write.service';

/**
 * TD-050 — the names the screens show are the names a person may type.
 *
 * THE DEFECT. Three of the twelve transaction types are relabelled for display: the stored
 * `Residential Sale Listing` reads as "Sale Listing", `Residential Lease Listing` as
 * "Lease Listing", and `Preconstruction` as "Pre-construction". The dropdowns map the label back
 * to the value correctly — that half was never broken. The bulk importer and the API compared
 * against the stored value, so somebody building an import file by copying the deal type off the
 * screen had three of twelve rows refused with "Not a valid transaction type", against a list of
 * names the application had never shown them.
 *
 * THE FIX IS AN ALIAS, NOT A RELABEL. The labels are deliberate and the screens keep them; the
 * refusal was the bug. `canonicalTransactionType` resolves a label to the value behind it and is
 * applied on the way in, so nothing downstream — required-field rules, status vocabulary, the row
 * that gets written — needs to know an alias was used.
 *
 * WHAT MUST NOT SOFTEN. TD-068 refuses a type that is not one; widening the vocabulary to include
 * the labels must not widen it to include anything else, and the row must be STORED as the
 * catalogue value rather than as whatever the file said. Both are asserted below.
 *
 * The last block compares the server's label map with the CLIENT's, because the client is where
 * the labels are chosen: if a fourth type is ever relabelled there, the importer has to learn it
 * in the same change rather than start refusing a name the product shows.
 */

describe('a transaction type may be typed as the name the screens show (TD-050)', () => {
  it.each(Object.entries(TYPE_LABELS))('resolves the label of %s', (value, label) => {
    expect(canonicalTransactionType(label)).toBe(value);
  });

  it('resolves the three the defect names, exactly as reported', () => {
    expect(canonicalTransactionType('Lease Listing')).toBe('Residential Lease Listing');
    expect(canonicalTransactionType('Sale Listing')).toBe('Residential Sale Listing');
    expect(canonicalTransactionType('Pre-construction')).toBe('Preconstruction');
  });

  it.each([...TRANSACTION_TYPES])('leaves %s alone', (type) => {
    expect(canonicalTransactionType(type)).toBe(type);
  });

  it('forgives the ways a person retypes a name they read on a screen', () => {
    // Case, surrounding space, and the hyphen that is only in the label.
    expect(canonicalTransactionType('  lease listing ')).toBe('Residential Lease Listing');
    expect(canonicalTransactionType('PRE-CONSTRUCTION')).toBe('Preconstruction');
    expect(canonicalTransactionType('Pre construction')).toBe('Preconstruction');
  });

  it('still refuses what is not a type at all — this is not a loosening (TD-068)', () => {
    for (const nonsense of ['Spaceship Sale', 'zzz-not-a-type', 'Listing', 'Residential', '']) {
      expect([nonsense, canonicalTransactionType(nonsense)]).toEqual([nonsense, null]);
    }
  });
});

describe('the importer accepts the label and stores the value (TD-050)', () => {
  const prisma = {
    users: { findMany: async () => [{ name: 'Aswini' }] },
    transactions: { findMany: async () => [] },
  } as unknown as PrismaService;
  const service = new TransactionImportService(prisma, {} as unknown as TransactionsWriteService);

  interface IssueLike { field: string; message: string }
  interface RowLike { issues: IssueLike[]; data?: Record<string, unknown> }

  const validate = (main: Record<string, string>): Promise<RowLike[]> =>
    (service as unknown as { validateRows: (r: unknown[]) => Promise<RowLike[]> })
      .validateRows([{ row: 2, ref: 'r2', main, financial: {}, children: {} }]);

  const BASE = {
    'Property Address': '1 ZZ-TEST Rd',
    'Listing Contract Date': '2026-01-01',
    'Listing Expiry Date': '2026-06-01',
    'Deal Status': 'Active',
  };

  it.each(Object.entries(TYPE_LABELS))('takes %s written as its label', async (value, label) => {
    const [r] = await validate({ ...BASE, 'Transaction Type': label });
    expect(r.issues.filter((i) => i.field === 'Transaction Type')).toHaveLength(0);
    // Stored as the catalogue value: the row the import writes must not carry the display label,
    // or every rule that keys off the type would be reading a string the system does not know.
    expect(r.data?.type).toBe(value);
  });

  it('still refuses a type that is not one, quoting what was written', async () => {
    const [r] = await validate({ ...BASE, 'Transaction Type': 'Spaceship Sale' });
    const issues = r.issues.filter((i) => i.field === 'Transaction Type');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('Not a valid transaction type.');
  });
});

describe('the API accepts the label and stores the value (TD-050)', () => {
  /*
   * Stub dependencies: every rule under test runs before the service touches Prisma, the same way
   * `transaction-create-validation.spec.ts` reaches it. `store` resolves the type on the body it
   * was given, which is the object the row is written from — so asserting on that object after the
   * call is asserting what would be stored.
   */
  const service = new TransactionsWriteService(
    ...(Array.from({ length: 10 }, () => ({})) as unknown as ConstructorParameters<typeof TransactionsWriteService>),
  );
  const superAdmin = { id: 1, name: 'QA', role: 'admin' } as never;

  const attempt = async (body: Record<string, unknown>): Promise<Record<string, string[]>> => {
    try {
      await service.store(superAdmin, body);
      return {};
    } catch (e) {
      const r = (e as { getResponse?: () => { errors?: Record<string, string[]> } }).getResponse?.();
      return r?.errors ?? {};
    }
  };

  it.each(Object.entries(TYPE_LABELS))('takes %s sent as its label', async (value, label) => {
    // Deliberately incomplete, so the create is refused for its MISSING fields — the assertion is
    // that `type` is not among them, and that the body now carries the catalogue value.
    const body: Record<string, unknown> = { type: label };
    const errors = await attempt(body);

    expect(errors.type).toBeUndefined();
    expect(body.type).toBe(value);
  });

  it('still refuses a type that is not one (TD-068 is intact)', async () => {
    const errors = await attempt({ type: 'zzz-not-a-type' });
    expect(errors.type?.[0]).toContain('is not a transaction type this system offers');
  });
});

describe('the labels the server accepts are the labels the client shows (TD-050)', () => {
  /** The client has no unit runner, so its map is read off disk and compared here. */
  const clientSource = readFileSync(
    join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'format.ts'),
    'utf8',
  );

  const clientLabels = (): Record<string, string> => {
    const at = clientSource.indexOf('export const TYPE_LABELS');
    const open = clientSource.indexOf('{', at);
    const close = clientSource.indexOf('}', open);
    const out: Record<string, string> = {};
    for (const line of clientSource.slice(open + 1, close).split('\n')) {
      const parts = line.split(':');
      if (parts.length < 2) continue;
      const key = parts[0].trim().replace(/'/g, '');
      const label = parts[1].trim().replace(/,$/, '').replace(/'/g, '');
      if (key && label) out[key] = label;
    }
    return out;
  };

  it('is the same map on both sides', () => {
    // A fourth relabelled type on the client with no alias here would resurrect this defect for
    // that type alone, and nothing else in the suite would notice.
    expect(clientLabels()).toEqual(TYPE_LABELS);
  });

  it('offers both names in the list a refusal quotes', () => {
    for (const name of [...TRANSACTION_TYPES, ...Object.values(TYPE_LABELS)]) {
      expect([name, ACCEPTED_TYPE_NAMES.includes(name)]).toEqual([name, true]);
    }
  });
});
