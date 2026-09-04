import { UnprocessableEntityException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';

/**
 * TD-004 — the invoice endpoints refuse what cannot be an invoice.
 *
 * THE DEFECT. `POST /api/invoices` and `PUT /api/invoices/:id` validated PRESENCE and nothing else:
 * `invoice_date` and `terms` had to be there, and every value then went to the database as it
 * arrived. All seven probes in the defect log persisted or crashed —
 *
 *   negative rate         → 201, total −5,650
 *   negative qty          → 201, total −339
 *   discount 999,999      → 201, total −999,886
 *   terms "NOT_A_TERM"    → 201 with due_date NULL
 *   status "Hacked"       → 201
 *   invoice_date bad      → 500
 *   tax_rate 9999         → 500
 *
 * — and a negative total is not contained to the invoice: it is summed into the dashboard's billed
 * and outstanding figures and into the commission reports. A NULL due date is worse than wrong, it
 * is invisible: the overdue query is `due_date: { lt: now }`, which cannot match NULL, so the
 * invoice drops out of the overdue view AND the reminder sweep and is never chased.
 *
 * The two 500s were the database refusing what the application never looked at — `invoice_date` is
 * NOT NULL and `tax_rate` is `Decimal(5,2)`. An internal error tells the caller nothing about which
 * field was wrong, so both are asserted here to be 422s naming the field.
 *
 * NO DATABASE. Prisma is stubbed, and every refusal below is asserted to have written NOTHING —
 * the write stubs record what they were asked to create, and a refused request must not reach them.
 */

interface Written { invoice: Record<string, unknown> | null; lines: Record<string, unknown>[] }

/** The stored invoice an `update()` is applied to. Sub-total 100, so a 999,999 discount is absurd. */
const STORED = { id: 1, invoice_no: 'INV-1', deleted_at: null, status: 'Unpaid', sub_total: 100, transaction_id: null, tax_rate: 13 };

const run = async (
  call: (svc: InvoicesService) => Promise<unknown>,
): Promise<{ status: number | 'accepted'; errors: Record<string, string[]>; written: Written }> => {
  const written: Written = { invoice: null, lines: [] };
  const tx = {
    invoices: {
      create: async (a: { data: Record<string, unknown> }) => { written.invoice = a.data; return { id: 1, ...a.data }; },
      update: async (a: { data: Record<string, unknown> }) => { written.invoice = a.data; return { id: 1, ...a.data }; },
      findUnique: async () => ({ tax_rate: 13 }),
    },
    invoice_line_items: {
      deleteMany: async () => ({ count: 0 }),
      create: async (a: { data: Record<string, unknown> }) => { written.lines.push(a.data); return a.data; },
    },
  };
  const prisma = {
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    invoices: { findFirst: async () => STORED, findUniqueOrThrow: async () => ({ ...STORED }) },
  } as never;
  const settings = { current: async () => ({ default_tax_rate: 13 }) } as never;
  const calc = { recalculate: async () => undefined } as never;
  const numbers = { next: async () => 'INV-TEST' } as never;
  const audit = { record: async () => undefined, log: async () => undefined } as never;
  const svc = new InvoicesService(prisma, settings, calc, numbers, audit, {} as never, {} as never);

  try {
    await call(svc);
    return { status: 'accepted', errors: {}, written };
  } catch (e) {
    if (e instanceof UnprocessableEntityException) {
      const r = e.getResponse() as { errors: Record<string, string[]> };
      return { status: 422, errors: r.errors, written };
    }
    // Anything else means the request got PAST validation and fell over further down the save, on
    // something this spec does not stub (`show()` reads the record back). That is an acceptance.
    return { status: written.invoice ? 'accepted' : 500, errors: {}, written };
  }
};

const BASE = { invoice_date: '2026-09-03', terms: 'Net 30', customer_name: 'QA' };
const post = (body: Record<string, unknown>) => run((s) => s.store({ id: 1, name: 'QA' } as never, body));
const put = (body: Record<string, unknown>) => run((s) => s.update({ id: 1, name: 'QA' } as never, 1, body));

describe('invoice endpoints refuse impossible invoices (TD-004)', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['a negative rate', { ...BASE, line_items: [{ description: 'x', qty: 1, rate: -5000 }] }, 'line_items.0.rate'],
    ['a negative quantity', { ...BASE, line_items: [{ description: 'x', qty: -3, rate: 100 }] }, 'line_items.0.qty'],
    ['a discount larger than the invoice', { ...BASE, discount: 999999, line_items: [{ description: 'x', qty: 1, rate: 100 }] }, 'discount'],
    ['a payment term that does not exist', { ...BASE, terms: 'NOT_A_TERM' }, 'terms'],
    ['a status that is not a status', { ...BASE, status: 'Hacked' }, 'status'],
    ['an invoice date that is not a date', { ...BASE, invoice_date: 'not-a-date' }, 'invoice_date'],
    ['a tax rate over 100%', { ...BASE, tax_rate: 9999 }, 'tax_rate'],
  ];

  it.each(cases)('refuses %s with a 422 naming the field', async (_name, body, field) => {
    const r = await post(body);
    expect(r.status).toBe(422);
    expect(Object.keys(r.errors)).toContain(field);
    expect(r.errors[field][0]).toBeTruthy();
  });

  it.each(cases)('writes nothing when refusing %s', async (_name, body) => {
    const r = await post(body);
    expect(r.written.invoice).toBeNull();
    expect(r.written.lines).toHaveLength(0);
  });

  it('answers every fault at once rather than one per round trip', async () => {
    const r = await post({
      invoice_date: 'not-a-date', terms: 'NOT_A_TERM', status: 'Hacked', tax_rate: 9999,
      discount: 999999, line_items: [{ description: 'x', qty: -3, rate: -5000 }],
    });
    expect(r.status).toBe(422);
    expect(Object.keys(r.errors).sort()).toEqual(
      ['discount', 'invoice_date', 'line_items.0.qty', 'line_items.0.rate', 'status', 'tax_rate', 'terms'],
    );
  });

  it('still requires an invoice date and terms, as it always did', async () => {
    const r = await post({ customer_name: 'QA' });
    expect(r.status).toBe(422);
    expect(r.errors.invoice_date[0]).toContain('required');
    expect(r.errors.terms[0]).toContain('required');
  });

  it('accepts an ordinary invoice', async () => {
    const r = await post({ ...BASE, discount: 10, tax_rate: 13, line_items: [{ description: 'Commission', qty: 1, rate: 5000 }] });
    expect(r.status).toBe('accepted');
    expect(r.written.lines).toEqual([expect.objectContaining({ qty: 1, rate: 5000, amount: 5000 })]);
  });

  it('accepts a discount equal to the sub-total — a fully discounted invoice is not impossible', async () => {
    const r = await post({ ...BASE, discount: 5000, line_items: [{ description: 'x', qty: 1, rate: 5000 }] });
    expect(r.status).toBe('accepted');
  });

  it('does not invent a due date requirement for the terms that legitimately lack one', async () => {
    // 'Due on Closing' has no due date until the closing date is known. Only an UNKNOWN term is
    // refused — that was the case that stored a NULL due date silently and hid the invoice.
    for (const terms of ['Custom', 'Due on Closing']) {
      const r = await post({ ...BASE, terms });
      expect(r.status).toBe('accepted');
    }
  });

  it('judges an edit that changes only the discount against the invoice already stored', async () => {
    // The smallest possible request, and the one a check that only looked at submitted lines would
    // have missed: no `line_items`, so the sub-total has to come from the record (100).
    const tooBig = await put({ ...BASE, discount: 999999 });
    expect(tooBig.status).toBe(422);
    expect(tooBig.errors.discount[0]).toContain('sub-total');

    const fine = await put({ ...BASE, discount: 50 });
    expect(fine.status).toBe('accepted');
  });

  it('refuses the same values on update as on create', async () => {
    for (const [, body, field] of cases) {
      const r = await put(body);
      expect(r.status).toBe(422);
      expect(Object.keys(r.errors)).toContain(field);
    }
  });
});
