import { PrismaClient } from '@prisma/client';
import { filterClauses, OLD_TRADE_NO_PREFIX } from './transaction-filters';
import type { ListTransactionsDto } from './dto/list-transactions.dto';

/**
 * OLD TRADE NUMBERS ARE SEARCHABLE (Sai, 23 Oct 2026).
 *
 * The brokerage sheet's old numbers are kept as Admin Remarks notes in one wording, "Old trade no:
 * 200836". The search box finds a deal by them - and by nothing else in the remarks, so the same
 * digits in a payment line, a cheque number or a free note do not turn up a deal.
 *
 * Real rows in a rolled-back transaction: this is a query, so it is tested against the database.
 */
const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
afterAll(async () => { await prisma.$disconnect(); });

const notes = (...texts: string[]) => JSON.stringify({ notes: texts.map((text) => ({ text, date: '2026-10-23', author: 'System - old trade numbers', role: 'Admin' })) });

describe('search by an old trade number', () => {
  it('finds the deal by its old number, and only by the "Old trade no:" wording', async () => {
    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const mk = (trade: string, property: string, admin: string | null) =>
          tx.transactions.create({ data: { trade_no: trade, type: 'Residential Buying', property, admin_activities: admin, created_at: now, updated_at: now } as never });
        const one = await mk('ZZOT01', 'zz old trade 1 Main St', notes(`${OLD_TRADE_NO_PREFIX}709836`));
        const two = await mk('ZZOT02', 'zz old trade 2 Main St', notes(`${OLD_TRADE_NO_PREFIX}719931-1\n${OLD_TRADE_NO_PREFIX}719931-2`));
        // Same digits, but not as an old trade number: a payment line and a free note.
        const noise = await mk('ZZOT03', 'zz old trade 3 Main St', JSON.stringify({ payments: [{ cheque: '709836', amount: 709836 }], notes: [{ text: 'cheque 709836 received' }] }));
        const plain = await mk('ZZOT04', 'zz old trade 4 Main St', null);

        const ids = async (q: string) => (await tx.transactions.findMany({
          where: { AND: [{ id: { in: [one.id, two.id, noise.id, plain.id] } }, ...filterClauses({ q } as ListTransactionsDto)] },
          select: { id: true },
        })).map((r) => r.id).sort();

        expect(await ids('709836')).toEqual([one.id]);                 // the old number, not the cheque
        expect(await ids('719931-2')).toEqual([two.id]);               // the second of two old numbers
        expect(await ids('719931')).toEqual([two.id]);                 // part of it, like the trade number search
        expect(await ids('ZZOT04')).toEqual([plain.id]);               // the current number still works
        expect(await ids('zz old trade')).toEqual([one.id, two.id, noise.id, plain.id].sort()); // address search unchanged
        expect(await ids('received')).toEqual([]);                     // free remarks text is not searched
        throw new Error(ROLLBACK);
      }, { timeout: 60000 });
    } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
  });
});
