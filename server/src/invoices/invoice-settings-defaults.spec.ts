import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionInvoiceService } from './transaction-invoice.service';
import { InvoicesService } from './invoices.service';
import { InvoiceCalculator } from './invoice.calculator';
import { InvoiceNumberService } from './invoice.numbers';
import { invoiceDocDefaults } from './invoice-defaults';
import { CommissionService } from '../transactions/commission.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { OPERATIONS_FIELDS } from '../settings/company-settings.controller';

/*
 * 2026-10-23 - INVOICE SETTINGS: DEFAULT CUSTOMER NOTES, TERMS & CONDITIONS AND SIGNATURE.
 *
 * Madhu's request: a signature uploaded once in Company Settings appears on every invoice, and so do
 * default Customer Notes and Terms, while each deal can still change its own before sending. So the
 * defaults are COPIED onto the invoice when it is created, never read live: a deal's own edit sticks,
 * and changing the defaults later does not rewrite an invoice already sent.
 */
const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DEFAULTS = { thank_you_note: 'Thanks for the referral.', invoice_terms_conditions: 'Payable within 7 days of closing.', invoice_signature: SIG };

const generator = (tx: PrismaService): TransactionInvoiceService =>
  new TransactionInvoiceService(new InvoiceNumberService(), new InvoiceCalculator(), new CommissionService(new PersonResolver(tx)), new AuditService(tx));

async function dealInvoice(tx: PrismaService) {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `INVSET-${Date.now()}-${seq}`, type: 'Residential Buying', property: '9 Default Lane', agent: 'ZZ Test',
      price: 800_000, comm_type: '%', comm_value: 2.5, comm_pct: 2.5, offer_date: new Date('2026-10-01T00:00:00.000Z'),
      created_at: now, updated_at: now,
    },
  });
  const [inv] = await generator(tx).generate(tx as never, t.id, null);
  return inv;
}

describe('a deal invoice starts with the Invoice Settings defaults', () => {
  it('copies the default Customer Notes, Terms & Conditions and signature onto the new invoice', async () => {
    await inRollback(async (tx) => {
      await tx.company_settings.upsert({ where: { id: 1 }, create: { id: 1, name: 'ZZ', ...DEFAULTS }, update: DEFAULTS });
      const inv = await dealInvoice(tx);
      expect(inv).toMatchObject({ customer_notes: DEFAULTS.thank_you_note, terms_conditions: DEFAULTS.invoice_terms_conditions, signature_path: SIG });
    });
  }, 60000);

  it('keeps its own copy: changing the defaults later leaves an existing invoice alone', async () => {
    await inRollback(async (tx) => {
      await tx.company_settings.upsert({ where: { id: 1 }, create: { id: 1, name: 'ZZ', ...DEFAULTS }, update: DEFAULTS });
      const inv = await dealInvoice(tx);
      await tx.company_settings.update({ where: { id: 1 }, data: { invoice_terms_conditions: 'New wording', invoice_signature: null } });
      const after = await tx.invoices.findUniqueOrThrow({ where: { id: inv.id } });
      expect(after.terms_conditions).toBe(DEFAULTS.invoice_terms_conditions);
      expect(after.signature_path).toBe(SIG);
    });
  }, 60000);

  it('leaves the three blank when no defaults are set', async () => {
    await inRollback(async (tx) => {
      const blank = { thank_you_note: null, invoice_terms_conditions: '  ', invoice_signature: null };
      await tx.company_settings.upsert({ where: { id: 1 }, create: { id: 1, name: 'ZZ', ...blank }, update: blank });
      const inv = await dealInvoice(tx);
      expect(inv).toMatchObject({ customer_notes: null, terms_conditions: null, signature_path: null });
    });
  }, 60000);
});

describe('a manual invoice', () => {
  /** The columns a POST would create, captured from a stubbed create. */
  const create = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let written: Record<string, unknown> = {};
    const tx = {
      invoices: { create: async (a: { data: Record<string, unknown> }) => { written = a.data; return { id: 1, ...a.data }; } },
      invoice_line_items: { deleteMany: async () => ({ count: 0 }), create: async (a: { data: unknown }) => a.data },
    };
    const svc = new InvoicesService(
      { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) } as never,
      { current: async () => ({ default_tax_rate: 13, ...DEFAULTS }) } as never,
      { recalculate: async () => undefined } as never,
      { next: async () => 'INV-TEST' } as never,
      { record: async () => undefined, log: async () => undefined } as never,
      {} as never, {} as never,
    );
    try { await svc.store({ id: 1, name: 'QA' } as never, body); } catch { /* `show()` is not stubbed */ }
    return written;
  };
  const BODY = { invoice_date: '2026-10-23', terms: 'Due on Receipt', customer_name: 'ZZ Brokerage', line_items: [{ description: 'Co-op Commission', qty: 1, rate: 1000, is_taxable: true }] };

  it('takes the defaults for whatever the request left out', async () => {
    const written = await create(BODY);
    expect(written).toMatchObject({ customer_notes: DEFAULTS.thank_you_note, terms_conditions: DEFAULTS.invoice_terms_conditions, signature_path: SIG });
  });

  it('keeps what the request sent, including a deliberately cleared value', async () => {
    const written = await create({ ...BODY, customer_notes: 'Deal-specific note', terms_conditions: '', signature_path: '' });
    expect(written).toMatchObject({ customer_notes: 'Deal-specific note', terms_conditions: '', signature_path: '' });
  });
});

describe('the Invoice Settings fields on Company Settings', () => {
  const service = (stored: Record<string, unknown> = {}) => {
    const logged: Record<string, unknown>[] = [];
    let row: Record<string, unknown> = { id: 1, name: 'ZZ', next_invoice_no: 1, invoice_prefix: 'INV-', updated_at: null, ...stored };
    const svc = new CompanySettingsService(
      {
        company_settings: {
          findUnique: async () => row,
          update: async (a: { data: Record<string, unknown> }) => { row = { ...row, ...a.data }; return row; },
        },
      } as never,
      { logModule: async (_u: unknown, _m: unknown, e: Record<string, unknown>) => { logged.push(e); } } as never,
    );
    return { svc, logged, row: () => row };
  };

  it('saves a PNG signature and default terms', async () => {
    const { svc, row } = service();
    await svc.update(null, { invoice_signature: SIG, invoice_terms_conditions: 'Net 7' } as never);
    expect(row()).toMatchObject({ invoice_signature: SIG, invoice_terms_conditions: 'Net 7' });
  });

  it('refuses a signature that is not a PNG or JPEG image', async () => {
    const { svc } = service();
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://example.test/sig.png', 'data:text/html;base64,PGI+']) {
      await expect(svc.update(null, { invoice_signature: bad } as never)).rejects.toThrow('PNG or JPEG');
    }
  });

  it('lets a signature be cleared', async () => {
    const { svc, row } = service({ invoice_signature: SIG });
    await svc.update(null, { invoice_signature: '' } as never);
    expect(row().invoice_signature).toBe('');
  });

  it('bounds the default terms like the other printed notes', async () => {
    const { svc } = service();
    await expect(svc.update(null, { invoice_terms_conditions: 'x'.repeat(2001) } as never)).rejects.toThrow('limit is 2,000');
  });

  it('audits a signature change without copying the image into the trail', async () => {
    const { svc, logged } = service();
    await svc.update(null, { invoice_signature: SIG } as never);
    const entry = logged.find((e) => e.field === 'Invoice Signature');
    expect(entry).toBeDefined();
    expect(String(entry!.new)).toMatch(/^\(image [0-9a-f]{8}\)$/);
    expect(JSON.stringify(logged)).not.toContain('base64');
  });

  it('withholds both from roles that cannot read the invoicing settings', () => {
    expect(OPERATIONS_FIELDS).toEqual(expect.arrayContaining(['invoice_terms_conditions', 'invoice_signature']));
  });

  it('treats blank defaults as none', () => {
    expect(invoiceDocDefaults({ thank_you_note: ' ', invoice_terms_conditions: '', invoice_signature: null }))
      .toEqual({ customer_notes: null, terms_conditions: null, signature_path: null });
  });
});
