/*
 * India desk fixes from the full local test of 19 Oct 2026:
 *  - the Audit Trail (and the Recycle Bin's deletion history) show each country only its own rows;
 *  - an India invoice email is from Get Home Realty Private Limited, in rupees.
 */
import { PrismaClient } from '@prisma/client';
import { auditMarketWhere } from '../common/market';
import { InvoicesService } from '../invoices/invoices.service';

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });

describe('history rows by country', () => {
  it('a deal row follows its deal; a row with its own country follows that; a row with none shows in both', async () => {
    const ROLLBACK = '__rollback__';
    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const deal = (market: string) => tx.transactions.create({ data: { type: 'Preconstruction', trade_no: `ZZ-AUD-${market}`, property: `zz audit ${market}`, market, created_at: now, updated_at: now } as never });
        const ca = await deal('CA');
        const ind = await deal('IN');
        const row = (data: Record<string, unknown>) => tx.audit_logs.create({ data: { action: 'zz-audit-market', created_at: now, updated_at: now, ...data } as never });
        await row({ transaction_id: ca.id, field: 'ca deal' });
        await row({ transaction_id: ind.id, field: 'in deal' });
        await row({ category: 'Invoice', market: 'CA', field: 'ca invoice' });
        await row({ category: 'Invoice', market: 'IN', field: 'in invoice' });
        await row({ category: 'Users', field: 'shared' });
        const seen = async (m: string) => (await tx.audit_logs.findMany({ where: { AND: [{ action: 'zz-audit-market' }, auditMarketWhere(m)] }, select: { field: true } }))
          .map((r) => r.field).sort();
        expect(await seen('CA')).toEqual(['ca deal', 'ca invoice', 'shared']);
        expect(await seen('IN')).toEqual(['in deal', 'in invoice', 'shared']);
        throw new Error(ROLLBACK);
      });
    } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
  });
});

describe('invoice email by country', () => {
  const build = (market: string | null) => {
    const sent: Record<string, unknown>[] = [];
    const svc = new InvoicesService(
      { transactions: { findFirst: async () => (market ? { market } : null) } } as never,
      { current: async () => ({ name: 'Canada Company' }) } as never,
      {} as never, {} as never, {} as never, {} as never,
      { send: async (_e: string, vars: Record<string, unknown>) => { sent.push(vars); } } as never,
      { get: async () => ({ company_name: 'GET HOME REALTY PRIVATE LIMITED' }) } as never,
    );
    return { svc, sent };
  };
  const invoice = { invoice_no: 'X-1', total: 118000, due_date: null, customer_name: 'Builder', customer_email: 'builder@local.test', trade_number: 'T', transaction_id: 1 };
  const deliver = (svc: InvoicesService) => (svc as unknown as { deliver: (...a: unknown[]) => Promise<string> }).deliver('invoice.send', invoice, 'invoice', null);

  it('an India invoice is from the India company, in rupees with Indian grouping', async () => {
    const { svc, sent } = build('IN');
    await deliver(svc);
    expect(sent[0].company_name).toBe('GET HOME REALTY PRIVATE LIMITED');
    expect(sent[0].invoice_total).toBe('₹1,18,000.00');
  });

  it('a Canada invoice reads exactly as before', async () => {
    const { svc, sent } = build('CA');
    await deliver(svc);
    expect(sent[0].company_name).toBe('Canada Company');
    expect(sent[0].invoice_total).toBe('118,000.00');
  });
});
