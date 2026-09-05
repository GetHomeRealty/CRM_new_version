import { InvoicesService } from './invoices.service';

/**
 * TD-069 — saving an invoice must not detach it from its deal.
 *
 * THE DEFECT. `PUT /api/invoices/{id}` wrote the whole model from the request body, so a caller
 * that echoed back the fields the validator demands — but not `transaction_id` — got a 200 and an
 * ORPHANED invoice: `transaction_id` 45 → null, `trade_number` '006' → null. The invoice kept its
 * number and its balance, so it still counted in the outstanding total, while the deal it belonged
 * to reported no invoice at all: the Admin panel, captioned "Auto-filled from the linked invoice",
 * showed an em dash for the number and "Pending to Raise" for the status. Anyone reconciling
 * commission from the deal side concluded it had never been billed. Reproduced twice on 2026-09-01,
 * including on a save that only set the commission-received fields.
 *
 * WHY THERE IS NO NEW RULE HERE. The same body-writes-everything behaviour is what TD-006 fixed:
 * on an update, a column is written only when the caller actually mentioned it. `transaction_id`
 * travels in that same loop, so the link now survives a save that says nothing about it. This file
 * exists because the LINK is not just another column — it is what the deal reads its invoice
 * through, and it deserves a test under its own name rather than being one entry in a list of
 * fields that must not be blanked.
 *
 * TD-106 IS UNBLOCKED BY THIS. The only save that can set the commission-received date and method
 * is the save that used to sever the link the deal reads them through, so the last case below is
 * that exact payload.
 *
 * Prisma is stubbed: the assertion is about which columns the UPDATE names, which is where the
 * defect lived.
 */

const STORED = {
  id: 1, invoice_no: 'GHR-006', deleted_at: null, status: 'Unpaid', sub_total: 100,
  transaction_id: 45, trade_number: '006', tax_rate: 13, amount_paid: 0, sent_at: null,
};

/** The columns a PUT would write, captured from the stubbed update. */
const put = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
  let written: Record<string, unknown> = {};
  const tx = {
    invoices: {
      update: async (a: { data: Record<string, unknown> }) => { written = a.data; return { id: 1, ...a.data }; },
      findUnique: async () => ({ tax_rate: 13 }),
    },
    invoice_line_items: { deleteMany: async () => ({ count: 0 }), create: async (a: { data: unknown }) => a.data },
  };
  const prisma = {
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    invoices: { findFirst: async () => STORED, findUniqueOrThrow: async () => ({ ...STORED }) },
  } as never;
  const svc = new InvoicesService(
    prisma,
    { current: async () => ({ default_tax_rate: 13 }) } as never,
    { recalculate: async () => undefined } as never,
    { next: async () => 'INV-TEST' } as never,
    { record: async () => undefined, log: async () => undefined } as never,
    {} as never, {} as never,
  );
  try { await svc.update({ id: 1, name: 'QA' } as never, 1, body); } catch { /* `show()` is not stubbed */ }
  return written;
};

/** What the validator requires on every update, and nothing more. */
const REQUIRED = { invoice_date: '2026-09-03', terms: 'Net 30' };

describe('an invoice keeps its deal across a save (TD-069)', () => {
  it('does not touch the link when the body never mentions it', async () => {
    const written = await put(REQUIRED);
    expect(written).not.toHaveProperty('transaction_id');
    expect(written).not.toHaveProperty('trade_number');
  });

  it('does not touch it on the reported save — a status change and nothing else', async () => {
    const written = await put({ ...REQUIRED, status: 'Paid' });
    expect(written.status).toBe('Paid');
    expect(written).not.toHaveProperty('transaction_id');
  });

  it('does not touch it on the save TD-106 needs — commission received date and method', async () => {
    const written = await put({
      ...REQUIRED,
      commission_received_date: '2026-09-01',
      commission_received_via: 'Bank Transfer',
    });
    expect(written.commission_received_via).toBe('Bank Transfer');
    expect(written).not.toHaveProperty('transaction_id');
  });

  it('still moves the invoice when a caller genuinely asks for a different deal', async () => {
    const written = await put({ ...REQUIRED, transaction_id: 77 });
    expect(written.transaction_id).toBe(77);
  });

  it('still detaches when a caller explicitly asks for null — silence and null are different requests', async () => {
    const written = await put({ ...REQUIRED, transaction_id: null });
    expect(written).toHaveProperty('transaction_id', null);
  });
});
