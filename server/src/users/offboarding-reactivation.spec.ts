import { OffboardingService } from './offboarding.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-044: the offboarding preview says what switching the account back on does NOT restore.
 *
 * WHAT WAS MISSING. The preview described three consequences — Meta disconnected, brokerage leads
 * returned to the pool, personal leads untouched — each with a count and plain-English detail, and
 * said nothing about reversing any of them. That omission sits exactly where a reader forms an
 * expectation about reversibility: a broker deactivating somebody for a month's leave would
 * reasonably assume the action reverses, and the panel's whole purpose is to say what they are
 * about to cause.
 *
 * AND THE ANSWER IS NOT THE REASSURING ONE. The preview's own words are that brokerage leads "lose
 * their assignment and go back to the unassigned pool". An assignment that has been lost is not
 * restored by switching the account on again — somebody has to hand those leads out by hand, from
 * Lead books — and any already handed to another agent stay with that person.
 *
 * THE SCREEN CARRIED HALF OF IT, which the report did not see because it read the API. A fixed
 * sentence under the list said "Reactivating them later restores their own leads, but not their
 * Meta connection." True as far as it went, and it went past the one consequence that lands on an
 * agent's book. It is built by the service now, from the same counts as the effects it qualifies,
 * so there is ONE statement of the rule rather than two that can drift — and so the payload says it
 * too, since a screen is not the only reader.
 */

const ADMIN = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;

function svc(counts: { connected: boolean; forms: number; personal: number; brokerage: number }) {
  const prisma = {
    users: { findUnique: async () => ({ id: 7, name: 'Departing Agent', status: 'Active' }) },
    leads: { count: async () => 0 },
    meta_connections: { findFirst: async () => null },
    meta_lead_forms: { count: async () => 0 },
  } as unknown as PrismaService;

  const s = new OffboardingService(prisma, null as never, null as never);
  (s as unknown as Record<string, unknown>).counts = async () => counts;
  return s;
}

async function reactivation(counts: Partial<{ connected: boolean; forms: number; personal: number; brokerage: number }>) {
  const full = { connected: false, forms: 0, personal: 0, brokerage: 0, ...counts };
  const list = await svc(full).checklist(ADMIN, 7) as unknown as { effects: { key: string; label: string; detail: string; count: number | null }[] };
  return list.effects.find((e) => e.key === 'reactivation');
}

describe('the offboarding preview covers reactivation', () => {
  it('says so at all', async () => {
    // THE DEFECT: no effect, label or detail mentioned reactivation in any form.
    const row = await reactivation({ brokerage: 3, connected: true, forms: 2 });
    expect(row).toBeDefined();
    expect(row!.label).toMatch(/back on/i);
  });

  it('says the brokerage leads do not come back', async () => {
    /*
     * The half the screen's old sentence left out, and the half that costs somebody work.
     */
    const row = await reactivation({ brokerage: 4 });
    expect(row!.detail).toContain('4 brokerage leads');
    expect(row!.detail).toMatch(/do NOT return to them/);
    expect(row!.detail).toMatch(/Lead books/);
  });

  it('reads correctly for exactly one brokerage lead', async () => {
    // The sibling defect CRM-032 was this same panel disagreeing with itself in the singular.
    const row = await reactivation({ brokerage: 1 });
    expect(row!.detail).toContain('The brokerage lead that loses its assignment');
    expect(row!.detail).not.toContain('1 brokerage leads');
    expect(row!.detail).not.toMatch(/leads that lose their assignment do NOT/);
  });

  it('says their own leads do come back', async () => {
    // The reassuring half is true and worth stating, or the rest reads as a warning about everything.
    const row = await reactivation({ personal: 5 });
    expect(row!.detail).toMatch(/own leads come back with them/i);
  });

  it('mentions Meta only when there is a connection to lose', async () => {
    const connected = await reactivation({ connected: true, forms: 2 });
    expect(connected!.detail).toMatch(/Meta is NOT reconnected/);

    // Telling somebody their Meta will not reconnect when they have none is noise, and noise is
    // what stops the rest being read.
    const not = await reactivation({ connected: false });
    expect(not!.detail).not.toMatch(/Meta/);
  });

  it('says nothing about brokerage leads when there are none', async () => {
    const row = await reactivation({ brokerage: 0, personal: 2 });
    expect(row!.detail).not.toMatch(/brokerage lead/);
    // Still says the thing that is always true, so the effect is never empty.
    expect(row!.detail).toMatch(/own leads come back/i);
  });

  it('carries no count, because it is not about a number of records', async () => {
    const row = await reactivation({ brokerage: 3 });
    expect(row!.count).toBeNull();
  });

  it('comes after the effects it qualifies', async () => {
    // It explains what the other three do not undo, so it reads last or it reads as a non-sequitur.
    const list = await svc({ connected: true, forms: 1, personal: 2, brokerage: 3 })
      .checklist(ADMIN, 7) as unknown as { effects: { key: string }[] };
    expect(list.effects.map((e) => e.key)).toEqual(['meta', 'brokerage-leads', 'personal-leads', 'reactivation']);
  });
});
