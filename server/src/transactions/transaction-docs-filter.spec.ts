import { PrismaClient, type Prisma } from '@prisma/client';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { filterClauses } from './transaction-filters';
import { transactionScopeWhere } from '../common/transaction-scope';
import { ListTransactionsDto } from './dto/list-transactions.dto';
import { DOCUMENTATION_EDITABLE } from './transactions-write.service';

/**
 * "MISSING UPLOADS" AND "NEEDS REVIEW" — the Transactions list's required-documents filters, run as
 * the list runs them (visibility scope AND filters), against myapp_test in a rolled-back transaction.
 *
 * Required = mandatory, not deleted, not Valid. Missing uploads = such an item with no file;
 * Needs review = such an item with a file (Received, Pending-with-file, or Invalid). A deal may match
 * both through different items.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
}

type Doc = { title: string; mandatory?: boolean; status?: string; validation?: string; file_path?: string | null; files?: string | null; deleted?: boolean };

async function seed(tx: Prisma.TransactionClient, tag: string) {
  const now = new Date();
  let n = 0;
  const deal = async (key: string, closing: string, docs: Doc[], agent = 'ZZ Docf Agent') => {
    n += 1;
    const t = await tx.transactions.create({
      data: {
        trade_no: `ZZDF${tag}${n}`, type: 'Residential Buying', property: `ZZ DOCF ${tag} ${key}`, agent,
        price: 500000, offer_date: new Date('2026-09-01'), closing_date: new Date(closing), created_at: now, updated_at: now,
      },
    });
    for (const d of docs) {
      await tx.documents.create({
        data: {
          transaction_id: t.id, title: d.title, mandatory: d.mandatory ?? true, status: d.status ?? 'Pending',
          validation: d.validation ?? 'Pending', file_path: d.file_path ?? null, files: d.files ?? null,
          deleted_at: d.deleted ? now : null, created_at: now, updated_at: now,
        },
      });
    }
    return t.id;
  };
  const ids = {
    missing: await deal('missing', '2026-10-10', [{ title: 'APS' }]),
    review: await deal('review', '2026-10-12', [{ title: 'APS', status: 'Received', file_path: 'documents/x/a.pdf' }]),
    both: await deal('both', '2026-12-01', [
      { title: 'APS', status: 'Received', validation: 'Invalid', files: '[{"path":"documents/x/b.pdf","name":"b.pdf"}]' },
      { title: 'Deposit', status: 'Pending' },
    ]),
    pendingWithFile: await deal('pendingfile', '2026-10-15', [{ title: 'APS', status: 'Pending', file_path: 'documents/x/c.pdf' }]),
    done: await deal('done', '2026-10-11', [
      { title: 'APS', status: 'Received', validation: 'Valid', file_path: 'documents/x/d.pdf' },
      { title: 'Optional', mandatory: false },
    ]),
    deletedOnly: await deal('deleted', '2026-10-11', [{ title: 'APS', deleted: true }]),
    validNoFile: await deal('validnofile', '2026-10-11', [{ title: 'APS', validation: 'Valid' }]),
    emptyFiles: await deal('emptyfiles', '2026-10-11', [{ title: 'APS', files: '[]', file_path: '' }]),
    otherAgent: await deal('other', '2026-10-10', [{ title: 'APS' }], 'ZZ Docf Someone Else'),
  };
  return ids;
}

/** The list's own where: visibility AND filters, scoped to this test's deals. */
const where = (tag: string, q: ListTransactionsDto, user: Parameters<typeof transactionScopeWhere>[0] = null): Prisma.transactionsWhereInput => {
  const and: Prisma.transactionsWhereInput[] = [{ property: { startsWith: `ZZ DOCF ${tag} ` } }];
  const visible = transactionScopeWhere(user);
  if (Object.keys(visible).length) and.push(visible);
  and.push(...filterClauses(q));
  return { deleted_at: null, AND: and };
};
const idsOf = async (tx: Prisma.TransactionClient, w: Prisma.transactionsWhereInput) =>
  (await tx.transactions.findMany({ where: w, select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id).sort((a, b) => a - b);

describe('required-documents filters', () => {
  it('Missing uploads: a mandatory, not-Valid item with no file (deleted and optional items ignored)', async () => {
    await inRollback(async (tx) => {
      const tag = `${Date.now()}`;
      const ids = await seed(tx, tag);
      expect(await idsOf(tx, where(tag, { docs: 'missing_uploads' }))).toEqual([ids.missing, ids.both, ids.emptyFiles, ids.otherAgent].sort((a, b) => a - b));
    });
  });

  it('Needs review: a mandatory, not-Valid item with a file — Received, Pending-with-file or Invalid', async () => {
    await inRollback(async (tx) => {
      const tag = `${Date.now()}`;
      const ids = await seed(tx, tag);
      expect(await idsOf(tx, where(tag, { docs: 'needs_review' }))).toEqual([ids.review, ids.both, ids.pendingWithFile].sort((a, b) => a - b));
    });
  });

  it('a deal can match both; a finished deal matches neither', async () => {
    await inRollback(async (tx) => {
      const tag = `${Date.now()}`;
      const ids = await seed(tx, tag);
      const m = await idsOf(tx, where(tag, { docs: 'missing_uploads' }));
      const r = await idsOf(tx, where(tag, { docs: 'needs_review' }));
      expect(m).toContain(ids.both);
      expect(r).toContain(ids.both);
      for (const id of [ids.done, ids.deletedOnly, ids.validNoFile]) { expect(m).not.toContain(id); expect(r).not.toContain(id); }
    });
  });

  it('works with the closing-date range, and the count and paging agree', async () => {
    await inRollback(async (tx) => {
      const tag = `${Date.now()}`;
      const ids = await seed(tx, tag);
      const w = where(tag, { docs: 'missing_uploads', closing_from: '2026-10-01', closing_to: '2026-10-31' });
      expect(await idsOf(tx, w)).toEqual([ids.missing, ids.emptyFiles, ids.otherAgent].sort((a, b) => a - b));
      expect(await tx.transactions.count({ where: w })).toBe(3);
      const page1 = await tx.transactions.findMany({ where: w, orderBy: { id: 'asc' }, take: 2, skip: 0, select: { id: true } });
      const page2 = await tx.transactions.findMany({ where: w, orderBy: { id: 'asc' }, take: 2, skip: 2, select: { id: true } });
      expect([...page1, ...page2].map((x) => x.id)).toHaveLength(3);
    });
  });

  it('keeps the viewer\'s visibility: an agent sees only their own matching deals', async () => {
    await inRollback(async (tx) => {
      const tag = `${Date.now()}`;
      const ids = await seed(tx, tag);
      const agent = { id: 999_998_001, name: 'ZZ Docf Agent', role: 'agent' } as Parameters<typeof transactionScopeWhere>[0];
      const seen = await idsOf(tx, where(tag, { docs: 'missing_uploads' }, agent));
      expect(seen).not.toContain(ids.otherAgent);
      expect(seen).toEqual([ids.missing, ids.both, ids.emptyFiles].sort((a, b) => a - b));
    });
  });

  it('an unknown value is refused by the request validation', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    await expect(pipe.transform({ docs: 'everything' }, { type: 'query', metatype: ListTransactionsDto })).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ docs: 'needs_review' }, { type: 'query', metatype: ListTransactionsDto })).resolves.toMatchObject({ docs: 'needs_review' });
    // empty means "any", as with every other list filter
    await expect(pipe.transform({ docs: '' }, { type: 'query', metatype: ListTransactionsDto })).resolves.toMatchObject({ docs: '' });
  });
});

describe('what a Documentation user may change on a deal', () => {
  it('basic details, offer and status, clients and brokerage — never money, team, admin, lawyer or validation', () => {
    for (const k of ['property', 'price', 'deposit', 'offer_date', 'closing_date', 'statuses', 'clients', 'brokerage', 'conditions', 'type', 'agent']) {
      expect(DOCUMENTATION_EDITABLE.has(k)).toBe(true);
    }
    for (const k of ['comm_type', 'comm_value', 'team', 'admin_activities', 'adjustments', 'lawyer_name', 'valid_status', 'comm_status',
      'comm_paid_status', 'precon_terms', 'commercial_lease', 'commission_agent', 'activity_tracker', 'payment_type']) {
      expect(DOCUMENTATION_EDITABLE.has(k)).toBe(false);
    }
  });
});
