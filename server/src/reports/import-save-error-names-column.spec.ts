import { UnprocessableEntityException } from '@nestjs/common';
import { TransactionImportService } from './transaction-import.service';

/*
 * TD-097 - when a row passes review but its save is refused, the report names the column and the
 * value instead of a dash and a blank.
 */
const svc = new TransactionImportService({} as never, {} as never) as unknown as {
  failedField: (err: unknown, data: Record<string, unknown>) => { column: string; value: string };
};

describe('a refused import row points at its column', () => {
  it('maps the refused field back to the column heading, with the value the row held', () => {
    const err = new UnprocessableEntityException({ message: 'Deposit cannot be larger than the price.', errors: { deposit: ['x'] } });
    expect(svc.failedField(err, { deposit: 900000, price: 500000 })).toEqual({ column: 'Deposit', value: '900000' });
  });
  it('understands a nested key such as clients.0.name', () => {
    const err = new UnprocessableEntityException({ message: 'x', errors: { 'closing_date': ['x'] } });
    expect(svc.failedField(err, { closing_date: '2026-01-01' }).column).toBe('Closing Date');
  });
  it('keeps the dash when the save named no field', () => {
    expect(svc.failedField(new Error('database went away'), {})).toEqual({ column: '—', value: '' });
  });
});
