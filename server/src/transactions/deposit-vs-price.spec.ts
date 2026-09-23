import { UnprocessableEntityException } from '@nestjs/common';
import { TransactionsWriteService } from './transactions-write.service';

/**
 * TD-202 - a rule written for a purchase was applied to every type.
 *
 * `price` holds the RENT on a lease, so a deposit of first-and-last month is twice it by design.
 * 150 residential and 2 commercial leases in production are stored at exactly 2x, and because every
 * save sends price and deposit together, NONE OF THEM COULD BE SAVED AT ALL - changing a phone
 * number on one was refused with "The deposit cannot be larger than the purchase price."
 *
 * The screen always knew: it labels the field "Total lease price". commission.service.ts knew too -
 * it lets a lease deposit exceed the commission and go negative. Only this rule did not.
 *
 * The NEGATIVE checks deliberately still apply to every type: nothing is ever less than nothing.
 */

const makeService = (type: string) => {
  const txn = {
    id: 1, trade_no: '400900', type, deleted_at: null,
    price: 2000, deposit: 4000, agent: 'QA', agent_user_id: 1,
    offer_date: new Date('2026-01-01T00:00:00.000Z'),
    closing_date: new Date('2026-06-01T00:00:00.000Z'),
  };
  const prisma = {
    transactions: { findFirst: async () => txn },
    transaction_statuses: { findMany: async () => [{ status: 'Closed' }] },
    team_members: { findFirst: async () => null },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
  } as never;
  const deps = [prisma, ...Array.from({ length: 9 }, () => ({}))] as unknown as ConstructorParameters<typeof TransactionsWriteService>;
  return new TransactionsWriteService(...deps);
};

/** '422' with the message, or 'allowed' for anything that got past the money rules. */
const put = async (type: string, body: Record<string, unknown>): Promise<{ outcome: string; message: string }> => {
  const svc = makeService(type);
  try {
    await (svc as unknown as { update: (u: unknown, i: number, b: unknown) => Promise<unknown> })
      .update({ id: 1, name: 'QA', role: 'admin' }, 1, body);
    return { outcome: 'allowed', message: '' };
  } catch (e) {
    if (e instanceof UnprocessableEntityException) {
      const r = e.getResponse() as { message: string };
      return { outcome: '422', message: r.message };
    }
    return { outcome: 'allowed', message: '' };
  }
};

describe('a lease deposit may be larger than the rent (TD-202)', () => {
  it('accepts first and last month on a residential lease', async () => {
    expect((await put('Residential Lease', { price: 2000, deposit: 4000 })).outcome).toBe('allowed');
  });

  it('accepts it on a commercial lease', async () => {
    expect((await put('Commercial Property Lease', { price: 5000, deposit: 10000 })).outcome).toBe('allowed');
  });

  it('accepts it on a lease listing, where price is also the rent', async () => {
    expect((await put('Residential Lease Listing', { price: 2000, deposit: 4000 })).outcome).toBe('allowed');
  });

  it('STILL refuses a deposit larger than the price on a purchase', async () => {
    expect(await put('Residential Buying', { price: 500000, deposit: 600000 }))
      .toEqual({ outcome: '422', message: 'The deposit cannot be larger than the purchase price.' });
  });

  it('STILL refuses it on a sale listing, and calls it the sale price', async () => {
    expect(await put('Residential Sale Listing', { price: 900000, deposit: 950000 }))
      .toEqual({ outcome: '422', message: 'The deposit cannot be larger than the sale price.' });
  });

  it('allows a purchase where the deposit is exactly the price', async () => {
    expect((await put('Residential Buying', { price: 500000, deposit: 500000 })).outcome).toBe('allowed');
  });

  it('refuses a negative deposit on a lease, because nothing is less than nothing', async () => {
    expect(await put('Residential Lease', { price: 2000, deposit: -1 }))
      .toEqual({ outcome: '422', message: 'The deposit cannot be negative.' });
  });

  it('names the lease price when a lease price is negative', async () => {
    expect(await put('Residential Lease', { price: -1, deposit: 4000 }))
      .toEqual({ outcome: '422', message: 'The lease price cannot be negative.' });
  });
});
