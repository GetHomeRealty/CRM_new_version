import { Prisma } from '@prisma/client';
import { invoiceFieldChanges } from './invoices.service';

/*
 * TD-150 - editing an invoice writes WHAT changed to the history, old and new, instead of a bare
 * "Invoice updated".
 */
const base = {
  customer_name: 'Lawyer LLP', due_date: new Date('2026-10-31T00:00:00Z'), total: new Prisma.Decimal('11300.00'),
  discount: new Prisma.Decimal('0.00'), terms: 'Net 30', customer_notes: null,
};

describe('the history names what moved on an invoice', () => {
  it('lists each changed field with its old and new value', () => {
    const after = { ...base, due_date: new Date('2026-11-15T00:00:00Z'), total: new Prisma.Decimal('10170.00'), discount: new Prisma.Decimal('1000.00') };
    expect(invoiceFieldChanges(base, after)).toEqual([
      { label: 'Due Date', old: '2026-10-31', new: '2026-11-15' },
      { label: 'Discount', old: '0.00', new: '1000.00' },
      { label: 'Total', old: '11300.00', new: '10170.00' },
    ]);
  });
  it('lists nothing when nothing moved, so the plain "Invoice updated" row is kept', () => {
    expect(invoiceFieldChanges(base, { ...base, total: new Prisma.Decimal('11300') })).toEqual([]);
  });
  it('treats blank and missing alike', () => {
    expect(invoiceFieldChanges({ ...base, customer_notes: null }, { ...base, customer_notes: undefined })).toEqual([]);
    expect(invoiceFieldChanges(base, { ...base, customer_notes: 'Please pay by EFT' })).toEqual([{ label: 'Customer Notes', old: '', new: 'Please pay by EFT' }]);
  });
});
