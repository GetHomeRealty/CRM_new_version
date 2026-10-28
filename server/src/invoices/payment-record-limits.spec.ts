import { UnprocessableEntityException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';

/**
 * Recording a payment is held to the Record Payment screen's limits (Sai, 28 Oct 2026): a date, an
 * amount above zero, and no more than the outstanding balance. Prisma is stubbed, and so is show(),
 * so a call that succeeds resolves to { ok: true } only after it has run to its last line.
 */
type Pay = { amount: number };

const make = (o: { payments: Pay[]; total: number }) => {
  const writes: Array<Record<string, unknown>> = [];
  const inv = { id: 1, invoice_no: 'INV-1', status: 'Unpaid', deleted_at: null, tax_rate: 13, total: o.total, transaction_id: null };
  const prisma = {
    invoices: {
      findFirst: async () => inv,
      findUniqueOrThrow: async () => ({ ...inv, status: 'Partially Paid', commission_received_date: null }),
      update: async (a: { data: Record<string, unknown> }) => ({ ...inv, ...a.data }),
    },
    invoice_payments: {
      findMany: async () => o.payments,
      create: async (a: { data: Record<string, unknown> }) => { writes.push(a.data); return {}; },
    },
  } as never;
  const svc = new InvoicesService(
    prisma,
    { current: async () => ({ default_tax_rate: 13 }) } as never,
    { recalculate: async () => undefined } as never,
    { next: async () => 'INV-TEST' } as never,
    { logModule: async () => undefined, record: async () => undefined, log: async () => undefined } as never,
    {} as never,
    {} as never,
  );
  (svc as unknown as { show: () => Promise<unknown> }).show = async () => ({ ok: true });
  return { svc, writes };
};
const refused = async (p: Promise<unknown>): Promise<unknown> => { try { await p; return null; } catch (e) { return e; } };

describe('recording a payment', () => {
  it('records a part payment and the payment that settles the balance', async () => {
    const { svc, writes } = make({ payments: [{ amount: 1000 }], total: 22600 });
    await expect(svc.recordPayment(null, 1, { paid_on: '2026-10-28', amount: '21600', method: 'Cheque' })).resolves.toEqual({ ok: true });
    expect(writes[0]).toMatchObject({ amount: 21600, method: 'Cheque' });
  });

  it('refuses more than the outstanding balance, and writes nothing', async () => {
    const { svc, writes } = make({ payments: [{ amount: 1000 }], total: 22600 });
    expect(await refused(svc.recordPayment(null, 1, { paid_on: '2026-10-28', amount: '30000' }))).toBeInstanceOf(UnprocessableEntityException);
    expect(writes).toEqual([]);
  });

  it('refuses a zero or negative amount, and writes nothing', async () => {
    const { svc, writes } = make({ payments: [], total: 22600 });
    expect(await refused(svc.recordPayment(null, 1, { paid_on: '2026-10-28', amount: '-50' }))).toBeInstanceOf(UnprocessableEntityException);
    expect(await refused(svc.recordPayment(null, 1, { paid_on: '2026-10-28', amount: '0' }))).toBeInstanceOf(UnprocessableEntityException);
    expect(writes).toEqual([]);
  });

  it('refuses a payment with no usable date, and writes nothing', async () => {
    const { svc, writes } = make({ payments: [], total: 22600 });
    expect(await refused(svc.recordPayment(null, 1, { paid_on: 'not a date', amount: '100' }))).toBeInstanceOf(UnprocessableEntityException);
    expect(writes).toEqual([]);
  });
});
