import { UnprocessableEntityException } from '@nestjs/common';
import { TransactionsWriteService } from './transactions-write.service';

/**
 * TD-071 — a type change answers for the status it carries.
 *
 * THE DEFECT. The status vocabulary was enforced only against statuses arriving in the same
 * request. A PUT carrying nothing but a new type never looked at what the deal already held, so a
 * Residential Buying deal marked "Secured Firm" became a Residential Sale Listing still marked
 * "Secured Firm" — the exact combination the same API refuses on a direct write with "Allowed:
 * Open, Closed, Mutual Release, DFT, Void". The deal was not accepted into an impossible state, it
 * was carried into one.
 *
 * WHY IT MATTERS BEYOND TIDINESS. Status decides the edit-lock, the commission layout and every
 * status filter in the reports. A deal holding a status its type does not define behaves
 * unpredictably in all three, and nothing on screen says why.
 *
 * REFUSED, NOT CLEARED — see the last two cases. TD-015 was the opposite defect (a type change
 * that wiped the status silently), so clearing here would be that bug again. And a deal ALREADY in
 * the impossible state must stay editable: refusing an unrelated save on a stored status nobody is
 * touching would lock people out of the very deals this defect created.
 *
 * Prisma is stubbed: every rule under test runs before the write.
 */

interface Stored { type: string; statuses: string[] }

const put = async (stored: Stored, body: Record<string, unknown>): Promise<{ status: 'accepted' | 422; message: string }> => {
  const txn = {
    id: 1838, trade_no: '201838', type: stored.type, deleted_at: null,
    price: 500_000, deposit: 0, agent: 'QA', agent_user_id: 1, property: '1 Old Address', version: 1,
    offer_date: null, closing_date: null, admin_activities: null, adjustments: null,
    updated_at: new Date('2026-09-01T10:00:00.000Z'),
  };
  const tx = {
    transactions: {
      updateMany: async () => ({ count: 1 }),
      update: async () => txn,
      findUnique: async () => txn,
    },
  };
  const prisma = {
    transactions: { findFirst: async () => txn, findUnique: async () => ({ ...txn, closing_date: null, listing_expiry_date: null }) },
    transaction_statuses: { findMany: async () => stored.statuses.map((status) => ({ status })) },
    team_members: { findFirst: async () => null },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as never;
  const audit = { snapshot: async () => ({}), record: async () => undefined, recordChanges: async () => [] } as never;
  const svc = new TransactionsWriteService(
    ...([prisma, {}, audit, ...Array.from({ length: 7 }, () => ({}))] as unknown as ConstructorParameters<typeof TransactionsWriteService>),
  );

  try {
    await svc.update({ id: 1, name: 'QA', role: 'admin' } as never, 1838, body);
    return { status: 'accepted', message: '' };
  } catch (e) {
    if (e instanceof UnprocessableEntityException) {
      return { status: 422, message: String((e.getResponse() as { message?: string }).message ?? '') };
    }
    // Past every rule and into the write, where the stubs give out: the request was accepted.
    return { status: 'accepted', message: '' };
  }
};

const BUYING_FIRM: Stored = { type: 'Residential Buying', statuses: ['Secured Firm'] };

describe('changing a deal\'s type re-judges the status it carries (TD-071)', () => {
  it('refuses the reported change — a listing cannot hold "Secured Firm"', async () => {
    const r = await put(BUYING_FIRM, { type: 'Residential Sale Listing' });
    expect(r.status).toBe(422);
    expect(r.message).toContain('Secured Firm');
    expect(r.message).toContain('Residential Sale Listing');
    // The caller is told what to do next, not merely that something is wrong.
    expect(r.message).toContain('Allowed:');
  });

  it('accepts the same change when a status the new type allows comes with it', async () => {
    expect((await put(BUYING_FIRM, { type: 'Residential Sale Listing', statuses: ['Active'] })).status).toBe('accepted');
  });

  it('still refuses an impossible status written directly, as it always did', async () => {
    const r = await put(BUYING_FIRM, { type: 'Residential Sale Listing', statuses: ['Secured Firm'] });
    expect(r.status).toBe(422);
  });

  it('closes the re-sent-unchanged hole: the same statuses beside a new type are still judged', async () => {
    // The status block treats a set equal to the stored one as "not changed" and skips its check,
    // so this used to slip through on the same path as sending no statuses at all.
    const r = await put(BUYING_FIRM, { type: 'Residential Sale Listing', statuses: ['Secured Firm'] });
    expect(r.status).toBe(422);
  });

  it('says nothing when the type is not changing', async () => {
    expect((await put(BUYING_FIRM, { type: 'Residential Buying', property: '2 New Address' })).status).toBe('accepted');
    expect((await put(BUYING_FIRM, { property: '2 New Address' })).status).toBe('accepted');
  });

  it('does not lock anybody out of a deal this defect already broke', async () => {
    // A listing left holding 'Secured Firm' by the old behaviour. Editing anything else must work,
    // or the people who have to clean these up cannot.
    const broken: Stored = { type: 'Residential Sale Listing', statuses: ['Secured Firm'] };
    expect((await put(broken, { property: '2 New Address' })).status).toBe('accepted');
    // And the fix for it — setting an allowed status — is accepted.
    expect((await put(broken, { statuses: ['Active'] })).status).toBe('accepted');
  });
});
