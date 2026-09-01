import { UnprocessableEntityException } from '@nestjs/common';
import { TransactionsWriteService } from './transactions-write.service';

/**
 * What `POST /api/transactions` says when it refuses.
 *
 * Reached directly with stub dependencies: every rule under test runs before the service touches
 * Prisma or any collaborator, so a create that is going to be refused never gets that far. That is
 * the point of the test as much as a convenience — validation that needed a database would be
 * validation running after work had already begun.
 */
const service = new TransactionsWriteService(
  ...(Array.from({ length: 10 }, () => ({})) as unknown as ConstructorParameters<typeof TransactionsWriteService>),
);
const superAdmin = { id: 1, name: 'QA', role: 'admin' } as never;

interface Refusal { message: string; errors: Record<string, string[]> }

const refusal = async (body: Record<string, unknown>): Promise<Refusal> => {
  try {
    await service.store(superAdmin, body);
    throw new Error('expected the create to be refused');
  } catch (e) {
    if (!(e instanceof UnprocessableEntityException)) throw e;
    return e.getResponse() as Refusal;
  }
};

describe('a refused create reports every problem at once (TD-113)', () => {
  it('names all seven missing fields on a deal type, not just the first', async () => {
    const r = await refusal({ type: 'Residential Buying' });

    // Measured as ONE key ('The property field is required.') while six others were also missing.
    expect(Object.keys(r.errors).sort()).toEqual(
      ['closing_date', 'comm_type', 'comm_value', 'offer_date', 'price', 'property', 'status'],
    );
    // `message` says as much as `errors`, so a caller that only displays it need not ask twice.
    expect(r.message).toContain('commission type');
    expect(r.message).toContain('closing date');
  });

  it('asks a listing only for what a listing needs', async () => {
    const r = await refusal({ type: 'Residential Sale Listing' });
    expect(Object.keys(r.errors).sort()).toEqual(['property', 'status']);
    for (const dealOnly of ['price', 'offer_date', 'closing_date', 'comm_type', 'comm_value']) {
      expect(r.errors[dealOnly]).toBeUndefined();
    }
  });

  it('invents no requirements when the type is unknown', async () => {
    // Which fields are required depends on the type, so an unknown type reports only the three
    // every deal needs — listing deal-side fields beside a type error would be guessing.
    const r = await refusal({});
    expect(Object.keys(r.errors).sort()).toEqual(['property', 'status', 'type']);
  });

  it('keeps the single-failure wording it always had', async () => {
    const r = await refusal({ type: 'Residential Sale Listing', status: 'Active' });
    expect(Object.keys(r.errors)).toEqual(['property']);
    expect(r.message).toBe('The property field is required.');
  });

  it('reports a bad status in the same reply as a missing field', async () => {
    const r = await refusal({ type: 'Residential Sale Listing', status: 'Open' });
    expect(Object.keys(r.errors).sort()).toEqual(['property', 'status']);
    expect(r.errors.status[0]).toContain('is not a status a Residential Sale Listing transaction can have');
  });
});
