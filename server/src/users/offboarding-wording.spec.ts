import { OffboardingService } from './offboarding.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-032 (2): the offboarding checklist has to read correctly for one lead as well as for several.
 *
 * IT WAS WRITTEN ONLY IN THE PLURAL, and the singular case produced three disagreements in one
 * sentence: "1 brokerage lead LOSE THEIR assignment and GO back… hand THEM to whoever picks the
 * work up." Nothing breaks, and everybody notices — this is a confirmation screen somebody reads
 * immediately before deactivating a colleague, which is a poor moment to look careless.
 *
 * THE SENTENCE IS NOW WRITTEN OUT TWICE rather than assembled from a plural `s`. Two whole
 * sentences are longer than a clever fragment and read correctly in both cases, which is the only
 * thing the reader cares about.
 */

const ADMIN = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;

function svc(brokerage: number) {
  const prisma = {
    users: { findUnique: async () => ({ id: 7, name: 'Departing Agent', status: 'Active' }) },
    leads: { count: async () => 0 },
    meta_connections: { findFirst: async () => null },
    meta_lead_forms: { count: async () => 0 },
  } as unknown as PrismaService;

  // Three dependencies; only `prisma` is reached by the checklist, and `counts` is stubbed below.
  const s = new OffboardingService(prisma, null as never, null as never);
  // `counts` is the only thing this test needs to vary; everything else on the checklist is
  // unrelated wording that already reads correctly.
  (s as unknown as Record<string, unknown>).counts = async () => ({
    connected: false, forms: 0, personal: 0, brokerage,
  });
  return s;
}

/** The brokerage-leads line, whatever else the checklist contains. */
async function brokerageLine(count: number): Promise<string> {
  const list = await svc(count).checklist(ADMIN, 7) as unknown as { effects: { key: string; detail: string }[] };
  const row = list.effects.find((e) => e.key === 'brokerage-leads');
  expect(row).toBeTruthy();
  return row!.detail;
}

describe('the offboarding checklist agrees with itself', () => {
  it('reads correctly for exactly one lead', async () => {
    const line = await brokerageLine(1);
    // THE DEFECT: "1 brokerage lead lose their assignment and go back… hand them to…"
    expect(line).toContain('1 brokerage lead loses its assignment and goes back');
    expect(line).toContain('hand it to whoever');
    expect(line).toContain('The brokerage owns it throughout');
    expect(line).not.toMatch(/lead lose their/);
  });

  it('still reads correctly for several', async () => {
    const line = await brokerageLine(4);
    expect(line).toContain('4 brokerage leads lose their assignment and go back');
    expect(line).toContain('hand them to whoever');
  });

  it('says nothing about assignments when there are none', async () => {
    expect(await brokerageLine(0)).toMatch(/No brokerage leads assigned to them/i);
  });
});
