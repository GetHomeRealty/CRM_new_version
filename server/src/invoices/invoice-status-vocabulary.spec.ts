import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnprocessableEntityException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import {
  DERIVED_STATUSES, INVOICE_STATUSES, SETTABLE_STATUSES, invoiceDisplayStatus,
} from '../reference/invoice.constants';

/**
 * TD-048 — one invoice, one word for what it is.
 *
 * THE DEFECT. Four different words described the same unpaid invoice at the same moment: the list
 * badge said "Overdue", the editor said "Unpaid", the transaction's Admin Activities panel said
 * "Draft", and the API returned `status: Unpaid` with `display_status: Overdue`. All four are
 * members of the status set the filter offers, so this was genuine disagreement, not a placeholder.
 *
 * IT WAS TWO PROBLEMS WEARING ONE LABEL.
 *
 *   THE DERIVATION EXISTED TWICE. `Overdue` is not stored — it is what an unpaid invoice becomes
 *   past its due date with money outstanding. The invoice list derived it; the Admin Activities
 *   panel, reading the invoice through `transaction.resource.ts`, did not. One derivation now lives
 *   in `reference/invoice.constants` and both call it.
 *
 *   AND THE VOCABULARY EXISTED THREE TIMES. The editor offered five statuses, its own colour map
 *   knew seven, and the list filter built a fourth list from the editor's five plus two extras — so
 *   the client could paint two states it gave nobody a way to choose. The last block reads the
 *   CLIENT's list off disk and requires it to match the server's, because the client has no unit
 *   runner and a copy that merely happens to agree today is how this drifted the first time.
 *
 * The refusals are the other half of the finding: `Draft` and `Partially Paid` are written by the
 * system, and were nonetheless accepted from a request — `Unpaid` over an invoice with money
 * against it was taken, stored, and quietly put back by `recalculate`. A silent correction and a
 * refusal look identical from the outside until one of them is wrong.
 *
 * NO DATABASE for the refusals: Prisma is stubbed, and a refused request must write nothing.
 */

interface Written { invoice: Record<string, unknown> | null }

const put = async (
  stored: { status: string; amount_paid?: number; sent_at?: Date | null },
  body: Record<string, unknown>,
): Promise<{ status: number | 'accepted'; errors: Record<string, string[]>; written: Written }> => {
  const STORED = {
    id: 1, invoice_no: 'INV-1', deleted_at: null, sub_total: 100, transaction_id: null, tax_rate: 13,
    amount_paid: 0, sent_at: null, ...stored,
  };
  const written: Written = { invoice: null };
  const tx = {
    invoices: {
      update: async (a: { data: Record<string, unknown> }) => { written.invoice = a.data; return { id: 1, ...a.data }; },
      findUnique: async () => ({ tax_rate: 13 }),
    },
    invoice_line_items: { deleteMany: async () => ({ count: 0 }), create: async () => ({}) },
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
    {} as never,
    {} as never,
  );

  try {
    await svc.update({ id: 1, name: 'QA' } as never, 1, body);
    return { status: 'accepted', errors: {}, written };
  } catch (e) {
    if (e instanceof UnprocessableEntityException) {
      const r = e.getResponse() as { errors: Record<string, string[]> };
      return { status: 422, errors: r.errors, written };
    }
    // Past validation, and fell over on something this spec does not stub (`show()` reads back).
    return { status: written.invoice ? 'accepted' : 500, errors: {}, written };
  }
};

const BASE = { invoice_date: '2026-09-03', terms: 'Net 30' };

describe('an invoice status the payments decide cannot be set by hand (TD-048)', () => {
  it('refuses "Partially Paid" as a choice — it follows the payments', async () => {
    const r = await put({ status: 'Unpaid' }, { ...BASE, status: 'Partially Paid' });
    expect(r.status).toBe(422);
    expect(r.errors.status[0]).toContain('set by the invoice itself');
    expect(r.written.invoice).toBeNull();
  });

  it('refuses "Draft" on an invoice that has left draft — the word that misled QA', async () => {
    const r = await put({ status: 'Unpaid', sent_at: new Date('2026-08-01') }, { ...BASE, status: 'Draft' });
    expect(r.status).toBe(422);
    expect(r.written.invoice).toBeNull();
  });

  it('refuses winding a part-paid invoice back to Unpaid, naming the money', async () => {
    const r = await put({ status: 'Partially Paid', amount_paid: 10000 }, { ...BASE, status: 'Unpaid' });
    expect(r.status).toBe(422);
    expect(r.errors.status[0]).toContain('10000.00');
    expect(r.written.invoice).toBeNull();
  });

  it('still saves an ordinary edit to a part-paid invoice', async () => {
    // THE CASE A NAIVE REFUSAL BREAKS. The editor spreads the whole form on every save, so a
    // Partially Paid invoice re-sends that status on any edit. Only a CHANGE is refused.
    const r = await put(
      { status: 'Partially Paid', amount_paid: 10000 },
      { ...BASE, status: 'Partially Paid', customer_name: 'Edited' },
    );
    expect(r.status).toBe('accepted');
  });

  it.each(SETTABLE_STATUSES.filter((s) => s !== 'Unpaid'))('still accepts %s, which is a choice', async (want) => {
    const r = await put({ status: 'Unpaid' }, { ...BASE, status: want });
    expect(r.status).toBe('accepted');
  });
});

describe('Overdue is derived in one place (TD-048)', () => {
  const past = new Date('2026-01-01');
  const future = new Date('2099-01-01');

  it('is what an unpaid or part-paid invoice becomes past its due date', () => {
    expect(invoiceDisplayStatus({ status: 'Unpaid', due_date: past, balance_due: 100 })).toBe('Overdue');
    expect(invoiceDisplayStatus({ status: 'Partially Paid', due_date: past, balance_due: 50 })).toBe('Overdue');
  });

  it('leaves every other case saying exactly what is stored', () => {
    expect(invoiceDisplayStatus({ status: 'Unpaid', due_date: future, balance_due: 100 })).toBe('Unpaid');
    // No due date is not late: a Due on Closing invoice with no closing date yet is waiting.
    expect(invoiceDisplayStatus({ status: 'Unpaid', due_date: null, balance_due: 100 })).toBe('Unpaid');
    // Nothing outstanding cannot be overdue, whatever the date says.
    expect(invoiceDisplayStatus({ status: 'Unpaid', due_date: past, balance_due: 0 })).toBe('Unpaid');
    expect(invoiceDisplayStatus({ status: 'Paid', due_date: past, balance_due: 0 })).toBe('Paid');
    expect(invoiceDisplayStatus({ status: 'Void', due_date: past, balance_due: 100 })).toBe('Void');
    expect(invoiceDisplayStatus({ status: 'Draft', due_date: past, balance_due: 100 })).toBe('Draft');
  });
});

describe('the client offers exactly the server vocabulary (TD-048)', () => {
  /** The client has no unit runner, so its list is read off disk and compared here. */
  const clientSource = readFileSync(
    join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'invoiceStatus.ts'),
    'utf8',
  );
  const arrayAfter = (marker: string): string[] => {
    const at = clientSource.indexOf(marker);
    if (at < 0) return [];
    // From the ASSIGNMENT, not the first bracket: `readonly InvoiceStatus[]` is a type annotation,
    // and reading its empty brackets as the list would silently pass an empty comparison.
    const open = clientSource.indexOf('= [', at) + 2;
    const close = clientSource.indexOf(']', open);
    return clientSource.slice(open + 1, close)
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
      .filter((s) => s.length > 0);
  };

  it('lists the same statuses, in the same order', () => {
    // Order too: these render as a dropdown, and two screens listing the same options in a
    // different order is its own small confusion.
    expect(arrayAfter('export const INVOICE_STATUSES')).toEqual([...INVOICE_STATUSES]);
  });

  it('marks the same two as derived, so neither is offered as a button that answers 422', () => {
    expect(arrayAfter('export const DERIVED_STATUSES')).toEqual([...DERIVED_STATUSES]);
  });

  it('gives every status a colour and a pill, so no state falls back to a wrong one', () => {
    const colours = clientSource.slice(clientSource.indexOf('STATUS_COLOR'));
    const pills = clientSource.slice(clientSource.indexOf('STATUS_PILL'), clientSource.indexOf('STATUS_COLOR'));
    for (const s of INVOICE_STATUSES) {
      const key = s.includes(' ') ? `'${s}':` : `${s}:`;
      expect([s, 'pill', pills.includes(key)]).toEqual([s, 'pill', true]);
      expect([s, 'colour', colours.includes(key)]).toEqual([s, 'colour', true]);
    }
  });
});

/**
 * TD-048 — the SECOND field on the Admin Activities panel, which the first closure never read.
 *
 * The panel carries two fields two lines apart. With the status wording settled, one invoice at one
 * moment still read:
 *
 *     Invoice Status:  Overdue
 *     Invoice Sent:    Draft
 *
 * 'Draft' is a member of INVOICE_STATUSES, so a reader was still shown two status-words for one
 * invoice — the entry's original complaint ("the Admin Activities panel says Draft") surviving in a
 * relabelled field rather than being resolved.
 *
 * FIXED AS A DISPLAY MAPPING, not a rename. `invoice_sent_status` is also a STORED field on
 * `admin_activities` that the modal reads back, so historical rows hold the old word; renaming the
 * enum would create a fresh mismatch of exactly the shape this entry is about.
 */
describe('the "Invoice Sent" field speaks its own vocabulary (TD-048)', () => {
  const clientDir = join(__dirname, '..', '..', '..', 'client', 'src', 'desk');
  const read = (f: string): string => readFileSync(join(clientDir, f), 'utf8');
  const vocabulary = read('invoiceStatus.ts');

  /** The mapping as it runs, with the note explaining the fault stripped out. */
  const mapping = ((): Record<string, string> => {
    const body = vocabulary.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = body.indexOf('SENT_STATUS_WORDS');
    const slice = body.slice(body.indexOf('{', at) + 1, body.indexOf('}', at));
    const out: Record<string, string> = {};
    for (const pair of slice.split(',')) {
      const m = /^\s*'?([^':]+)'?\s*:\s*'([^']+)'/.exec(pair);
      if (m) out[m[1].trim()] = m[2];
    }
    return out;
  })();

  it('maps exactly the two words that need it', () => {
    // Stated so the assertions below cannot pass over an empty map: if the parser above stopped
    // finding entries, every "no collision" check would be vacuously true.
    expect(Object.keys(mapping).sort()).toEqual(['Draft', 'Pending to Raise']);
  });

  it('maps Draft to a word that is not an invoice status', () => {
    // The collision itself. 'Not sent' cannot be read as a payment state.
    expect(mapping.Draft).toBe('Not sent');
    expect(INVOICE_STATUSES).not.toContain(mapping.Draft as never);
  });

  it('leaves no mapped word colliding with the status vocabulary', () => {
    for (const shown of Object.values(mapping)) {
      expect([shown, (INVOICE_STATUSES as readonly string[]).includes(shown)]).toEqual([shown, false]);
    }
  });

  it('does not rewrite Sent, Paid or Void', () => {
    /*
     * Each appears only when the status field says the same thing, so the two lines agree rather
     * than contradict — and rewriting them would assert something the payload does not carry. An
     * invoice marked Paid says nothing about whether it was ever emailed, and this field must not
     * claim it was.
     */
    for (const kept of ['Sent', 'Paid', 'Void']) expect(mapping[kept]).toBeUndefined();
  });

  it('is used by every screen that shows the field', () => {
    // Three render sites, and a mapping applied at two of them would be the same defect narrowed.
    for (const f of ['AdminActivitiesModal.tsx', 'AgentFaqModal.tsx']) {
      const src = read(f);
      expect([f, src.includes('sentStatusLabel')]).toEqual([f, true]);
      // No raw render left behind beside the mapped one.
      expect([f, /invoice_sent_status \|\| '—'/.test(src)]).toEqual([f, false]);
    }
  });

  it('leaves the stored value alone, which is why this is a mapping at all', () => {
    // If the enum were renamed instead, `admin_activities.invoice_sent_status` rows written before
    // the change would hold a word nothing maps — the mismatch this entry is about.
    expect(read('AdminActivitiesModal.tsx')).toContain('invoice_sent_status: a.invoice_sent_status');
  });
});

