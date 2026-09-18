import { UnprocessableEntityException } from '@nestjs/common';
import { RecycleBinService } from './recycle-bin.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * WHAT A RESTORE MUST NOT DO: hide the record, or enter it twice.
 *
 * Three rules, all about the state the restored row lands in rather than the row itself:
 *
 *  1. A DOCUMENT whose transaction is also in the bin cannot be restored alone. It used to succeed
 *     and vanish from both places — no longer deleted, so off this screen; its deal still deleted,
 *     so nowhere to open it. Restoring the DEAL brings its documents with it.
 *  2. A PAYMENT whose invoice is in the bin cannot be restored alone, for the same reason plus one
 *     of its own: the totals are recalculated on a LIVE invoice, so the money would come back
 *     without the invoice it belongs to agreeing.
 *  3. A COMMISSION or ADJUSTMENT row already on the transaction is not appended a second time. The
 *     restore pushed blindly, so a row re-entered by hand and then restored here was on the deal
 *     twice, and each copy is money in a total.
 *
 * Prisma is stubbed: what is under test is the decision, not the query.
 */

// `isSuperAdmin` is a rank test — 'admin' is the top of the ladder in core/authz.
const SUPER = { id: 1, name: 'A Super Admin', role: 'admin' } as unknown as AuthUserRecord;

const service = (prisma: unknown): RecycleBinService => new RecycleBinService(
  prisma as never,
  { record: async () => undefined, logModule: async () => undefined } as never,
  { recalculate: async () => undefined } as never,
  { current: async () => ({ default_tax_rate: 13 }) } as never,
);

const refused = async (p: Promise<unknown>): Promise<unknown> => { try { await p; return null; } catch (e) { return e; } };

describe('a document is not restored onto a deleted deal', () => {
  const make = (txnDeletedAt: Date | null) => {
    const updates: unknown[] = [];
    const prisma = {
      documents: {
        findFirst: async () => ({ id: 7, title: 'Deposit Receipt', transaction_id: 4, deleted_at: new Date() }),
        update: async (a: unknown) => { updates.push(a); return {}; },
      },
      transactions: { findUnique: async () => ({ id: 4, trade_no: '2026-0042', deleted_at: txnDeletedAt }) },
      audit_logs: { create: async () => ({}) },
    };
    return { svc: service(prisma), updates };
  };

  it('refuses, naming the transaction, and writes nothing', async () => {
    const { svc, updates } = make(new Date());
    const err = await refused(svc.restoreDocument(SUPER, 7));
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(String(((err as UnprocessableEntityException).getResponse() as { message: string }).message)).toContain('2026-0042');
    expect(updates).toEqual([]);
  });

  it('restores it when the transaction is live', async () => {
    const { svc, updates } = make(null);
    await expect(svc.restoreDocument(SUPER, 7)).resolves.toEqual({ message: 'Document restored' });
    expect(updates).toHaveLength(1);
  });
});

describe('a payment is not restored onto a deleted invoice', () => {
  const make = (invoiceDeletedAt: Date | null) => {
    const updates: unknown[] = [];
    const prisma = {
      invoice_payments: {
        findFirst: async () => ({ id: 3, invoice_id: 9, deleted_at: new Date() }),
        update: async (a: unknown) => { updates.push(a); return {}; },
      },
      invoices: {
        findUnique: async () => ({ id: 9, invoice_no: 'INV-9', deleted_at: invoiceDeletedAt }),
        findFirst: async () => (invoiceDeletedAt ? null : { id: 9, invoice_no: 'INV-9', tax_rate: 13, deleted_at: null }),
      },
      audit_logs: { create: async () => ({}) },
    };
    return { svc: service(prisma), updates };
  };

  it('refuses, naming the invoice, and writes nothing', async () => {
    const { svc, updates } = make(new Date());
    const err = await refused(svc.restorePayment(SUPER, 3));
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(String(((err as UnprocessableEntityException).getResponse() as { message: string }).message)).toContain('INV-9');
    expect(updates).toEqual([]);
  });

  it('restores it when the invoice is live', async () => {
    const { svc, updates } = make(null);
    await expect(svc.restorePayment(SUPER, 3)).resolves.toEqual({ message: 'Payment restored' });
    expect(updates).toHaveLength(1);
  });
});

describe('a commission row already on the deal is not restored twice', () => {
  const ROW = { paid_type: 'Cheque', paid_date: '2026-09-01', amount: '500.00' };

  const make = (existing: unknown[]) => {
    const writes: Record<string, unknown>[] = [];
    const prisma = {
      trashed_row_items: {
        findUnique: async () => ({
          id: 11, kind: 'agent_payment', module: 'admin_activities', term: null,
          agent: 'Aahana Nayar', label: 'Agent Commission Paid', data: JSON.stringify(ROW),
        }),
        delete: async () => ({}),
      },
      transactions: {
        findUnique: async () => ({
          id: 4, trade_no: '2026-0042', deleted_at: null,
          admin_activities: JSON.stringify({ agents: { 'Aahana Nayar': { payments: existing } } }),
        }),
        update: async (a: { data: Record<string, unknown> }) => { writes.push(a.data); return {}; },
      },
      audit_logs: { create: async () => ({}) },
    };
    return { svc: service(prisma), writes };
  };

  it('refuses when an identical row is already there, and writes nothing', async () => {
    const { svc, writes } = make([ROW]);
    const err = await refused(svc.restoreRowItem(SUPER, 11));
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(String(((err as UnprocessableEntityException).getResponse() as { message: string }).message)).toContain('Agent Commission Paid');
    expect(writes).toEqual([]);
  });

  it('restores it when the deal does not have it, keeping the rows already there', async () => {
    const other = { paid_type: 'Cash', paid_date: '2026-08-01', amount: '250.00' };
    const { svc, writes } = make([other]);
    await expect(svc.restoreRowItem(SUPER, 11)).resolves.toEqual({ message: 'Restored' });
    const saved = JSON.parse(String(writes[0].admin_activities)) as { agents: Record<string, { payments: unknown[] }> };
    expect(saved.agents['Aahana Nayar'].payments).toEqual([other, ROW]);
  });
});
