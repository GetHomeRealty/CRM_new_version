import { readFileSync } from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionInvoiceService } from './transaction-invoice.service';

/*
 * 2026-10-08 - A DEAL INVOICE WITH NO CUSTOMER TAKES THE DEAL'S BROKERAGE.
 *
 * The bulk import creates a deal (and so its invoice) before it saves the brokerage section, so
 * every imported invoice was born with an empty Bill To - 494 on the live system, 491 of whose deals
 * had a brokerage by then. Real rows in a rolled-back transaction.
 */
const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (String((e as Error).message).includes(ROLLBACK) === false) throw e;
  }
}

const audits: unknown[] = [];
const svc = new TransactionInvoiceService({} as never, {} as never, {} as never, { record: async (...a: unknown[]) => { audits.push(a); } } as never);

async function deal(tx: PrismaService, brokerage: Record<string, unknown> | null) {
  const n = ++seq;
  const now = new Date();
  const t = await tx.transactions.create({ data: { trade_no: `CUST-${Date.now()}-${n}`, type: 'Residential Buying', price: 500000, created_at: now, updated_at: now } });
  if (brokerage) await tx.brokerages.create({ data: { transaction_id: t.id, ...brokerage, created_at: now, updated_at: now } as never });
  return t;
}
const FIXED = new Date('2026-09-13T10:00:00.000Z');
const invoice = (tx: PrismaService, txnId: number, over: Record<string, unknown> = {}) => tx.invoices.create({ data: {
  transaction_id: txnId, invoice_no: `ZZ-CUST-${Date.now()}-${++seq}`, source: 'transaction', status: 'Paid', invoice_date: FIXED,
  total: 11300, balance_due: 0, amount_paid: 11300, created_at: FIXED, updated_at: FIXED, ...over,
} as never });

describe('a blank invoice customer is filled from the deal\'s brokerage', () => {
  it('fills name, phone, invoice email and address, and touches nothing else', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx, { name: 'Royal LePage Signature', phone: '416-555-0100', invoice_email: 'ar@rlp.test', address: '1 King St W' });
      const inv = await invoice(tx, t.id);
      expect(await svc.fillMissingCustomer(tx as never, t.id, null)).toBe(1);
      const after = await tx.invoices.findUniqueOrThrow({ where: { id: inv.id } });
      expect(after).toMatchObject({ customer_name: 'Royal LePage Signature', customer_phone: '416-555-0100', customer_email: 'ar@rlp.test', customer_address: '1 King St W', status: 'Paid' });
      expect(Number(after.total)).toBe(11300);
      expect(Number(after.balance_due)).toBe(0);
      expect(after.invoice_no).toBe(inv.invoice_no);
      expect(after.updated_at?.toISOString()).toBe(FIXED.toISOString());
    });
  });

  it('never overwrites a customer that is already there, or a sent invoice', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx, { name: 'New Brokerage' });
      const named = await invoice(tx, t.id, { customer_name: 'Existing Customer' });
      const sent = await invoice(tx, t.id, { sent_at: new Date() });
      expect(await svc.fillMissingCustomer(tx as never, t.id, null)).toBe(0);
      expect((await tx.invoices.findUniqueOrThrow({ where: { id: named.id } })).customer_name).toBe('Existing Customer');
      expect((await tx.invoices.findUniqueOrThrow({ where: { id: sent.id } })).customer_name ?? null).toBeNull();
    });
  });

  it('leaves the invoice blank when the deal has no brokerage name, and ignores hand-made invoices', async () => {
    await inRollback(async (tx) => {
      const none = await deal(tx, null);
      const unnamed = await deal(tx, { name: '' });
      await invoice(tx, none.id);
      await invoice(tx, unnamed.id);
      expect(await svc.fillMissingCustomer(tx as never, none.id, null)).toBe(0);
      expect(await svc.fillMissingCustomer(tx as never, unnamed.id, null)).toBe(0);
      const t = await deal(tx, { name: 'Brokerage' });
      const manual = await invoice(tx, t.id, { source: 'manual' });
      expect(await svc.fillMissingCustomer(tx as never, t.id, null)).toBe(0);
      expect((await tx.invoices.findUniqueOrThrow({ where: { id: manual.id } })).customer_name ?? null).toBeNull();
    });
  });

  it('writes each fill to the deal\'s history', async () => {
    await inRollback(async (tx) => {
      audits.length = 0;
      const t = await deal(tx, { name: 'Brokerage X' });
      await invoice(tx, t.id);
      await svc.fillMissingCustomer(tx as never, t.id, null);
      expect(JSON.stringify(audits)).toContain('Brokerage X');
    });
  });
});

describe('the deal save runs it right after the brokerage is stored', () => {
  it('is called after syncBrokerage in update()', () => {
    const src = readFileSync(path.join(__dirname, '../transactions/transactions-write.service.ts'), 'utf8');
    const sync = src.indexOf("await this.syncBrokerage(tx, txnId, data.brokerage === null");
    const fill = src.indexOf('await this.txnInvoices.fillMissingCustomer(tx, txnId, actor)');
    expect(sync).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(sync);
  });
});
