import { PrismaClient } from '@prisma/client';
import { payoutWhere } from './payout-filter';

/**
 * THE PAYOUT STATUS FILTER READS THE AGENT PAYMENTS (Sai, 26 Oct 2026), through the same ladder as
 * the Transaction Payment Status report. Real rows in a rolled-back transaction, with the payment
 * cache set the way PaymentCacheService leaves it.
 */
const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
afterAll(async () => { await prisma.$disconnect(); });

describe('Payout status filter', () => {
  jest.setTimeout(60_000);
  it('Paid = every agent paid; Pending = not yet or partly; N/A = nothing payable', async () => {
    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const stamp = `ZZPAY${Date.now()}`;
        const mk = async (label: string, cache: Record<string, unknown>, closed = false) => {
          const t = await tx.transactions.create({
            data: { trade_no: `${stamp}-${label}`, type: 'Residential Buying', property: `${stamp} ${label}`, created_at: now, updated_at: now, calc_at: now, ...cache } as never,
          });
          if (closed) await tx.transaction_statuses.create({ data: { transaction_id: t.id, status: 'Closed', created_at: now, updated_at: now } });
          return t.id;
        };
        const paid = await mk('paid', { calc_agent_comm_total: 1000, calc_agent_name_count: 1, calc_paid_name_count: 1 }, true);
        const paidByReadiness = await mk('faq', { calc_agent_comm_total: 1000, calc_agent_name_count: 2, calc_paid_name_count: 0, calc_faq_paid_status: 'Yes' }, true);
        const partly = await mk('partly', { calc_agent_comm_total: 1000, calc_agent_name_count: 2, calc_paid_name_count: 1 }, true);
        const notYet = await mk('pending', { calc_agent_comm_total: 1000, calc_agent_name_count: 1, calc_paid_name_count: 0 }, true);
        const open = await mk('upcoming', { calc_agent_comm_total: 1000, calc_agent_name_count: 1, calc_paid_name_count: 0 });
        const nothing = await mk('na', { calc_agent_comm_total: 0, calc_agent_name_count: 1, calc_paid_name_count: 0 }, true);
        const mine = [paid, paidByReadiness, partly, notYet, open, nothing];

        const ids = async (p: string) => {
          const w = await payoutWhere(tx, p);
          return (await tx.transactions.findMany({ where: { AND: [{ id: { in: mine } }, w!] }, select: { id: true } })).map((r) => r.id).sort((a, b) => a - b);
        };
        expect(await ids('Paid')).toEqual([paid, paidByReadiness].sort((a, b) => a - b));
        expect(await ids('Pending')).toEqual([partly, notYet, open].sort((a, b) => a - b));
        expect(await ids('N/A')).toEqual([nothing]);
        expect(await payoutWhere(tx, '')).toBeNull();
        expect(await payoutWhere(tx, 'Something else')).toBeNull();
        throw new Error(ROLLBACK);
      }, { timeout: 60000 });
    } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
  });
});
