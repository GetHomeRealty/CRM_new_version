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

/**
 * TD-056 — the date rules, on the endpoint the browser is not the only caller of.
 *
 * The Add Transaction form has always stated both rules under its inputs and refused a save that
 * broke them. The API accepted anything: a closing date before the offer date returned 200 and
 * stored it. A rule enforced only in the browser is a rule any import, integration or direct call
 * walks past.
 */
describe('deal date rules are enforced by the API (TD-056)', () => {
  const base = {
    type: 'Residential Buying', property: '1 ZZ-TEST Rd', status: 'Secured Firm',
    comm_type: '%', comm_value: 2.5, price: 500000,
  };
  const day = (offsetDays: number): string =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  it('refuses an offer date in the future', async () => {
    const r = await refusal({ ...base, offer_date: day(30), closing_date: day(60) });
    expect(r.errors.offer_date?.[0]).toBe('The offer date cannot be in the future.');
  });

  it('refuses a closing date before the offer date', async () => {
    const r = await refusal({ ...base, offer_date: day(-10), closing_date: day(-40) });
    expect(r.errors.closing_date?.[0]).toBe('The closing date cannot be before the offer date.');
  });

  it('reports both broken dates at once, like every other rule on this endpoint', async () => {
    const r = await refusal({ ...base, offer_date: day(30), closing_date: day(10) });
    expect(Object.keys(r.errors).sort()).toEqual(['closing_date', 'offer_date']);
  });

  it('accepts the ordinary case — offer in the past, closing after it', async () => {
    // Passes validation and then fails on a stub, which is how we know it got past the rules.
    await expect(refusal({ ...base, offer_date: day(-10), closing_date: day(20) }))
      .rejects.toThrow();
  });

  it('says nothing about dates a listing does not carry', async () => {
    const r = await refusal({ type: 'Residential Sale Listing', status: 'Active' });
    expect(r.errors.offer_date).toBeUndefined();
    expect(r.errors.closing_date).toBeUndefined();
  });
});
