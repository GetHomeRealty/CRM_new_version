import { UnprocessableEntityException } from '@nestjs/common';
import { TransactionsWriteService } from './transactions-write.service';

const day = (o: number): string => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);

/** A stored deal whose own dates are sane unless a test says otherwise. */
const makeService = (stored: { offer_date: string; closing_date: string }) => {
  const txn = {
    id: 1, trade_no: '200900', type: 'Residential Buying', deleted_at: null,
    price: 500000, deposit: 25000, agent: 'QA', agent_user_id: 1,
    offer_date: new Date(`${stored.offer_date}T00:00:00.000Z`),
    closing_date: new Date(`${stored.closing_date}T00:00:00.000Z`),
  };
  const prisma = {
    transactions: { findFirst: async () => txn },
    transaction_statuses: { findMany: async () => [{ status: 'Secured Firm' }] },
    team_members: { findFirst: async () => null },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
  } as never;
  const deps = [prisma, ...Array.from({ length: 9 }, () => ({}))] as unknown as ConstructorParameters<typeof TransactionsWriteService>;
  return new TransactionsWriteService(...deps);
};

const put = async (
  stored: { offer_date: string; closing_date: string },
  body: Record<string, unknown>,
): Promise<{ outcome: string; field: string; message: string }> => {
  const svc = makeService(stored);
  try {
    await (svc as unknown as { update: (u: unknown, i: number, b: unknown) => Promise<unknown> })
      .update({ id: 1, name: 'QA', role: 'admin' }, 1, body);
    return { outcome: 'accepted', field: '', message: '' };
  } catch (e) {
    if (e instanceof UnprocessableEntityException) {
      const r = e.getResponse() as { message: string; errors: Record<string, string[]> };
      return { outcome: '422', field: Object.keys(r.errors)[0], message: r.message };
    }
    return { outcome: 'passed validation', field: '', message: '' };
  }
};

const SANE = { offer_date: day(-30), closing_date: day(30) };

/**
 * TD-056 — the deal date rules on `update`, which is the endpoint the defect measured.
 *
 * The rules were stated under the Add Transaction inputs and enforced only there, so a PUT with a
 * closing date before its offer date returned 200 and stored it. Reached with the two reads
 * `update` performs before validating stubbed, so nothing is written by any case here.
 *
 * The last two cases are the ones worth keeping: deals holding a broken pair already exist, and a
 * rule that refused to let anyone correct them would be worse than the gap it closed.
 */
describe('deal date rules are enforced on update (TD-056)', () => {
  it('refuses a closing date before the stored offer date', async () => {
    const r = await put(SANE, { closing_date: day(-60) });
    expect(r.outcome).toBe('422');
    expect(r.field).toBe('closing_date');
  });

  it('refuses an offer date in the future', async () => {
    const r = await put(SANE, { offer_date: day(45) });
    expect(r.outcome).toBe('422');
    expect(r.field).toBe('offer_date');
  });

  it('accepts a valid pair', async () => {
    const r = await put(SANE, { offer_date: day(-5), closing_date: day(60) });
    expect(r.outcome).toBe('passed validation');
  });

  it('does NOT lock a user out of fixing a deal whose stored dates are already broken', async () => {
    // The stored offer date is in the future - one of the pairs the API previously accepted.
    const broken = { offer_date: day(90), closing_date: day(120) };
    const r = await put(broken, { closing_date: day(100) });
    expect(r.outcome).toBe('passed validation');
  });

  it('says nothing about dates when no date is submitted', async () => {
    const broken = { offer_date: day(90), closing_date: day(-90) };
    const r = await put(broken, { property: 'Renamed' });
    expect(r.outcome).toBe('passed validation');
  });
});
