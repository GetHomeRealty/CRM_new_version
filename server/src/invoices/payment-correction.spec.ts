import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';

/**
 * TD-172 - editing and removing a recorded payment. Prisma is stubbed, and so is show(), so a call that
 * succeeds resolves to { ok: true } only after it has run to its last line. The questions are what gets
 * written, what is refused, and what the history records.
 */
type Pay = { id: number; amount: number; method: string | null; reference: string | null; paid_on: Date };
type Received = { date: Date; via: string | null } | null;

const make = (o: { payments: Pay[]; total?: number; statusBefore?: string; statusAfter: string; received?: Received }) => {
  const writes: Array<{ table: string; data: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const inv = { id: 1, invoice_no: 'INV-1', status: o.statusBefore, deleted_at: null, tax_rate: 13, total: o.total ?? 1130, transaction_id: null };
  const prisma = {
    invoices: {
      findFirst: async () => inv,
      findUniqueOrThrow: async () => ({
        ...inv, status: o.statusAfter,
        commission_received_date: o.received ? o.received.date : null,
        commission_received_via: o.received ? o.received.via : null,
      }),
      update: async (a: { data: Record<string, unknown> }) => { writes.push({ table: 'invoices', data: a.data }); return { ...inv, status: o.statusAfter, ...a.data }; },
    },
    invoice_payments: {
      findFirst: async (a: { where: { id: number } }) => o.payments.find((p) => p.id === a.where.id) ?? null,
      findMany: async (a: { where: { NOT: { id: number } } }) => o.payments.filter((p) => p.id !== a.where.NOT.id),
      update: async (a: { data: Record<string, unknown> }) => { writes.push({ table: 'invoice_payments', data: a.data }); return {}; },
      deleteMany: async () => { writes.push({ table: 'invoice_payments', data: { removed: true } }); return { count: 1 }; },
    },
  } as never;
  const svc = new InvoicesService(
    prisma,
    { current: async () => ({ default_tax_rate: 13 }) } as never,
    { recalculate: async () => undefined } as never,
    { next: async () => 'INV-TEST' } as never,
    { logModule: async (_a: unknown, _m: string, e: Record<string, unknown>) => { audits.push(e); }, record: async () => undefined, log: async () => undefined } as never,
    {} as never,
    {} as never,
  );
  (svc as unknown as { show: () => Promise<unknown> }).show = async () => ({ ok: true });
  return { svc, writes, audits };
};
const refused = async (p: Promise<unknown>): Promise<unknown> => { try { await p; return null; } catch (e) { return e; } };
const CASH: Pay = { id: 15, amount: 1000, method: 'Cash', reference: null, paid_on: new Date('2026-09-08') };
const invoicesWrite = (w: Array<{ table: string; data: Record<string, unknown> }>) => w.find((x) => x.table === 'invoices');

describe('editing a recorded payment (TD-172)', () => {
  it('writes the new date, amount, method and reference, and records both versions', async () => {
    const { svc, writes, audits } = make({ payments: [CASH], total: 5000, statusAfter: 'Partially Paid' });
    await expect(svc.updatePayment({ id: 1, name: 'QA' } as never, 1, 15, { paid_on: '2026-09-09', amount: '1200', method: 'Cheque', reference: 'CHQ-9' })).resolves.toEqual({ ok: true });
    const w = writes.find((x) => x.table === 'invoice_payments')?.data ?? {};
    expect(w).toMatchObject({ amount: 1200, method: 'Cheque', reference: 'CHQ-9' });
    expect(w.paid_on).toBeInstanceOf(Date);
    expect(String(w.paid_on)).not.toBe(String(CASH.paid_on));
    expect(audits[0]).toMatchObject({ action: 'Payment edited' });
    expect(String(audits[0]?.old)).toContain('1,000.00 (Cash)');
    expect(String(audits[0]?.new)).toContain('1,200.00 (Cheque)');
    expect(String(audits[0]?.new)).toContain('ref CHQ-9');
    expect(invoicesWrite(writes)).toBeUndefined();
  });

  it('refuses a zero amount and writes nothing', async () => {
    const { svc, writes } = make({ payments: [CASH], statusAfter: 'Partially Paid' });
    expect(await refused(svc.updatePayment(null, 1, 15, { paid_on: '2026-09-09', amount: '0' }))).toBeInstanceOf(UnprocessableEntityException);
    expect(writes).toEqual([]);
  });

  it('refuses RAISING a payment past the invoice total, and writes nothing', async () => {
    const other: Pay = { ...CASH, id: 16, amount: 1000 };
    const { svc, writes } = make({ payments: [CASH, other], total: 2130, statusAfter: 'Paid' });
    expect(await refused(svc.updatePayment(null, 1, 15, { paid_on: '2026-09-08', amount: '1200' }))).toBeInstanceOf(UnprocessableEntityException);
    expect(writes).toEqual([]);
  });

  it('allows a correction that lowers the amount even on an over-recorded invoice', async () => {
    const other: Pay = { ...CASH, id: 16, amount: 1500 };
    const { svc, writes } = make({ payments: [CASH, other], total: 2130, statusAfter: 'Paid' });
    await expect(svc.updatePayment(null, 1, 15, { paid_on: '2026-09-08', amount: '900' })).resolves.toEqual({ ok: true });
    expect(writes.find((x) => x.table === 'invoice_payments')?.data).toMatchObject({ amount: 900 });
  });

  it('says so when the payment is not on the invoice, and writes nothing', async () => {
    const { svc, writes } = make({ payments: [CASH], statusAfter: 'Partially Paid' });
    expect(await refused(svc.updatePayment(null, 1, 99, { paid_on: '2026-09-09', amount: '10' }))).toBeInstanceOf(NotFoundException);
    expect(writes).toEqual([]);
  });

  it('clears the commission-received date when the invoice is no longer Paid, and says so', async () => {
    const { svc, writes, audits } = make({ payments: [CASH], statusAfter: 'Partially Paid', received: { date: new Date('2026-09-01'), via: 'Cheque' } });
    await expect(svc.updatePayment(null, 1, 15, { paid_on: '2026-09-09', amount: '900' })).resolves.toEqual({ ok: true });
    expect(invoicesWrite(writes)?.data).toMatchObject({ commission_received_date: null, commission_received_via: null });
    expect(String(audits[0]?.details)).toContain('cleared');
  });

  it('sets the received date from the edited payment when the edit is what makes the invoice Paid', async () => {
    const { svc, writes, audits } = make({ payments: [CASH], total: 1200, statusAfter: 'Paid', received: null });
    await expect(svc.updatePayment(null, 1, 15, { paid_on: '2026-09-09', amount: '1200', method: 'Cheque' })).resolves.toEqual({ ok: true });
    const w = invoicesWrite(writes)?.data ?? {};
    expect(w.commission_received_date).toBeInstanceOf(Date);
    expect(w.commission_received_via).toBe('Cheque');
    expect(String(audits[0]?.details)).toContain('set');
  });

  it('moves the received date when the edit corrects the payment it came from', async () => {
    const { svc, writes } = make({ payments: [CASH], total: 1000, statusAfter: 'Paid', received: { date: CASH.paid_on, via: 'Cash' } });
    await expect(svc.updatePayment(null, 1, 15, { paid_on: '2026-09-09', amount: '1000', method: 'Cheque' })).resolves.toEqual({ ok: true });
    expect(invoicesWrite(writes)?.data).toMatchObject({ commission_received_via: 'Cheque' });
  });

  it('leaves a received date that came from somewhere else alone', async () => {
    const { svc, writes, audits } = make({ payments: [CASH], total: 1000, statusAfter: 'Paid', received: { date: new Date('2026-09-01'), via: 'Cheque' } });
    await expect(svc.updatePayment(null, 1, 15, { paid_on: '2026-09-09', amount: '1000' })).resolves.toEqual({ ok: true });
    expect(invoicesWrite(writes)).toBeUndefined();
    expect(writes.find((x) => x.table === 'invoice_payments')).toBeDefined();
    expect(audits[0]).toMatchObject({ action: 'Payment edited' });
  });
  it('does not take the received date from an earlier payment of an invoice that was already Paid', async () => {
    const other: Pay = { ...CASH, id: 16, amount: 1000, paid_on: new Date('2026-09-20') };
    const { svc, writes } = make({ payments: [CASH, other], total: 2000, statusBefore: 'Paid', statusAfter: 'Paid', received: null });
    await expect(svc.updatePayment(null, 1, 15, { paid_on: '2026-09-08', amount: '1000', method: 'Cash', reference: 'FIX' })).resolves.toEqual({ ok: true });
    expect(writes.find((x) => x.table === 'invoice_payments')).toBeDefined();
    expect(invoicesWrite(writes)).toBeUndefined();
  });

  it('writes and records nothing when nothing was changed', async () => {
    const same: Pay = { ...CASH };
    const { svc, writes, audits } = make({ payments: [same], statusAfter: 'Partially Paid' });
    // the stored date comes from the service's own parser, so the comparison holds in any time zone
    same.paid_on = (svc as unknown as { toDate: (v: unknown) => Date }).toDate('2026-09-08');
    await expect(svc.updatePayment(null, 1, 15, { paid_on: '2026-09-08', amount: '1000', method: 'Cash' })).resolves.toEqual({ ok: true });
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('removing a recorded payment (TD-172)', () => {
  it('removes it, clears the received date once the invoice is due again, and records what went', async () => {
    const { svc, writes, audits } = make({ payments: [CASH], statusAfter: 'Unpaid', received: { date: CASH.paid_on, via: 'Cash' } });
    await expect(svc.deletePayment(null, 1, 15)).resolves.toEqual({ ok: true });
    expect(writes.map((x) => x.table)).toEqual(['invoice_payments', 'invoices']);
    expect(audits[0]).toMatchObject({ action: 'Payment removed' });
    expect(String(audits[0]?.old)).toContain('1,000.00 (Cash) on');
    expect(String(audits[0]?.details)).toContain('cleared');
  });

  it('says so when the payment is already gone, and records nothing', async () => {
    const { svc, writes, audits } = make({ payments: [CASH], statusAfter: 'Unpaid' });
    expect(await refused(svc.deletePayment(null, 1, 99))).toBeInstanceOf(NotFoundException);
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('keeps the received date when the invoice is still Paid after the removal', async () => {
    const other: Pay = { ...CASH, id: 16, amount: 1200 };
    const { svc, writes, audits } = make({ payments: [CASH, other], total: 1130, statusAfter: 'Paid', received: { date: other.paid_on, via: 'Cash' } });
    await expect(svc.deletePayment(null, 1, 15)).resolves.toEqual({ ok: true });
    expect(writes.map((x) => x.table)).toEqual(['invoice_payments']);
    expect(audits[0]?.details).toBeUndefined();
  });
});
