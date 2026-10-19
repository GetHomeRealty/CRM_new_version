/*
 * India invoice (19 Oct 2026): numbering by Indian financial year, and the India settings defaults.
 */
import { PrismaClient } from '@prisma/client';
import { InvoiceNumberService } from '../invoices/invoice.numbers';
import { INDIA_DEFAULTS, IndiaSettingsService } from './india-settings.service';

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('India invoice numbers', () => {
  it('belong to the Indian financial year, April to March', () => {
    expect(InvoiceNumberService.indiaFinancialYear(d('2026-10-19'))).toBe('2026-27');
    expect(InvoiceNumberService.indiaFinancialYear(d('2027-03-31'))).toBe('2026-27');
    expect(InvoiceNumberService.indiaFinancialYear(d('2027-04-01'))).toBe('2027-28');
    expect(InvoiceNumberService.indiaFinancialYear(d('2099-12-31'))).toBe('2099-00');
  });

  it('count up within a year and restart in the next', async () => {
    const ROLLBACK = '__rollback__';
    try {
      await prisma.$transaction(async (tx) => {
        const n = new InvoiceNumberService();
        const first = await n.nextIndia(tx, d('2031-06-01'));
        expect(first).toBe('GHR/2031-32/0001');
        const now = new Date();
        await tx.invoices.create({ data: { invoice_no: first, invoice_date: now, created_at: now, updated_at: now } as never });
        expect(await n.nextIndia(tx, d('2032-02-01'))).toBe('GHR/2031-32/0002');
        expect(await n.nextIndia(tx, d('2032-04-01'))).toBe('GHR/2032-33/0001');
        throw new Error(ROLLBACK);
      });
    } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
  });
});

describe('India settings', () => {
  it('start from the brokerage\'s two templates, Hyderabad first, with no bank account typed in', () => {
    expect(INDIA_DEFAULTS.offices.map((o) => [o.key, o.state])).toEqual([['HYD', 'Telangana'], ['VZM', 'Andhra Pradesh']]);
    expect(INDIA_DEFAULTS.bank.account_number).toBe('');
    const svc = new IndiaSettingsService({} as never);
    expect(svc.office(INDIA_DEFAULTS, 'VZM').name).toBe('Vizianagaram');
    expect(svc.office(INDIA_DEFAULTS, null).name).toBe('Hyderabad');
  });
});
