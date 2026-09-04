import { InvoicesService } from './invoices.service';

/**
 * TD-006 — a PUT leaves alone the fields it did not mention.
 *
 * THE DEFECT. `PUT /api/invoices/:id` wrote every column on every save, with `?? null` /
 * `?? 'Canada'` / `?? 'Draft'` supplying a value wherever the body had none. Sending the three
 * fields the endpoint demands — `invoice_date`, `terms`, `line_items` — therefore blanked
 * `customer_name`, `customer_email`, `subject`, `trade_number` and `listing_agent`, reset the
 * discount to 0, forced the country back to 'Canada', and forced `status` to 'Draft'.
 *
 * THE LAST ONE IS THE DANGEROUS ONE: 'Draft' over 'Void' silently un-voids a cancelled invoice,
 * which then reappears in the ledger and in the reminder sweep as money someone owes.
 *
 * Latent through the UI, which spreads the whole form on every save, so it was reachable only by an
 * API consumer, an integration, or a future partial save on the screen.
 *
 * WHAT THESE TESTS ASSERT is the SHAPE OF THE UPDATE — which columns Prisma is asked to write, not
 * what a database would then hold. A column absent from the update statement is the whole fix: it
 * is what leaves the stored value alone. So `toHaveProperty` / `not.toHaveProperty` is the
 * assertion, deliberately, rather than a round trip through a stub that would only echo back what
 * this same code put in.
 */

/** The stored invoice being edited: fully populated, and VOID. */
const STORED = {
  id: 1, invoice_no: 'INV-1', deleted_at: null, status: 'Void', sub_total: 100,
  transaction_id: null, tax_rate: 13,
};

const capture = async (
  call: (svc: InvoicesService) => Promise<unknown>,
): Promise<Record<string, unknown>> => {
  let written: Record<string, unknown> = {};
  const tx = {
    invoices: {
      create: async (a: { data: Record<string, unknown> }) => { written = a.data; return { id: 1, ...a.data }; },
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
  try { await call(svc); } catch { /* `show()` runs after the write and is not stubbed */ }
  return written;
};

const put = (body: Record<string, unknown>) => capture((s) => s.update({ id: 1, name: 'QA' } as never, 1, body));
const post = (body: Record<string, unknown>) => capture((s) => s.store({ id: 1, name: 'QA' } as never, body));

/** The reported payload: the three fields the endpoint requires, and nothing else. */
const MINIMAL = { invoice_date: '2026-09-03', terms: 'Net 30', line_items: [{ description: 'x', qty: 1, rate: 100 }] };

describe('a partial invoice update leaves absent fields alone (TD-006)', () => {
  const BLANKED = [
    'customer_name', 'customer_email', 'subject', 'trade_number', 'listing_agent',
    'customer_address', 'customer_city', 'customer_province', 'customer_postal_code',
    'customer_phone', 'customer_notes', 'terms_conditions', 'broker_name',
  ];

  it.each(BLANKED)('does not write %s when the body never mentioned it', async (field) => {
    const written = await put(MINIMAL);
    expect(written).not.toHaveProperty(field);
  });

  it('does not reset the discount, the country or the status', async () => {
    const written = await put(MINIMAL);
    expect(written).not.toHaveProperty('discount');
    expect(written).not.toHaveProperty('customer_country');
    expect(written).not.toHaveProperty('status');
  });

  it('cannot un-void a voided invoice by saving something else', async () => {
    // The reported consequence, stated as its own case: 'Draft' over 'Void' put a cancelled
    // invoice back into the ledger and the reminder sweep as money owed.
    const written = await put(MINIMAL);
    expect(written.status).toBeUndefined();
  });

  it('still writes what the body DID mention', async () => {
    const written = await put({ ...MINIMAL, customer_name: 'AUDIT TEST 2', discount: 25, status: 'Paid' });
    expect(written.customer_name).toBe('AUDIT TEST 2');
    expect(written.discount).toBe(25);
    expect(written.status).toBe('Paid');
  });

  it('treats an explicit null as a request to clear, which is a different request from silence', async () => {
    const written = await put({ ...MINIMAL, subject: null, customer_name: null });
    expect(written).toHaveProperty('subject', null);
    expect(written).toHaveProperty('customer_name', null);
  });

  it('recomputes the due date when the terms compute one', async () => {
    const written = await put({ ...MINIMAL, terms: 'Net 30' });
    expect(written.due_date).toEqual(new Date('2026-10-03T00:00:00.000Z'));
  });

  it('leaves the due date alone for terms that cannot compute one and no date supplied', async () => {
    // 'Custom' and 'Due on Closing' take their date from the body. With none sent there is nothing
    // to recompute from, and writing the null would erase a date that is still correct.
    for (const terms of ['Custom', 'Due on Closing']) {
      const written = await put({ ...MINIMAL, terms });
      expect(written).not.toHaveProperty('due_date');
    }
  });

  it('writes the due date for those terms when one IS supplied', async () => {
    const written = await put({ ...MINIMAL, terms: 'Custom', due_date: '2026-12-01' });
    expect(written.due_date).toEqual(new Date('2026-12-01T00:00:00.000Z'));
  });

  it('leaves the tax rate alone when unmentioned, as TD-093 established', async () => {
    const written = await put(MINIMAL);
    expect(written).not.toHaveProperty('tax_rate');
  });
});

describe('creating an invoice still establishes the whole row (TD-006)', () => {
  it('applies the defaults a new invoice needs', async () => {
    // The `?? null` / `?? 'Canada'` / `?? 'Draft'` behaviour is correct on a create — the row is
    // being established, and an unmentioned column genuinely has no value yet.
    const written = await post(MINIMAL);
    expect(written.customer_country).toBe('Canada');
    expect(written.status).toBe('Draft');
    expect(written.discount).toBe(0);
    expect(written).toHaveProperty('customer_name', null);
    expect(written).toHaveProperty('subject', null);
  });
});
