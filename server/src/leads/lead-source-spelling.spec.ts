import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import { LEAD_SOURCE, isLeadSource, canonicalLeadSource, leadSourceMatches } from './lead.constants';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-019: 'referral' is spelt correctly, and the leads already stored under the typo still work.
 *
 * THE TYPO WAS THE STORED VALUE, which is what made this more than a spelling mistake. The Source
 * dropdown offered 'refferal', that string was written to `leads.lead_source`, and a filter for
 * 'referral' therefore matched nothing - the brokerage's referral business was filed under a
 * misspelling and could not be found by anybody who spelt it correctly. A comment in the constants
 * claimed "the UI labels it Referral"; it did not, because the only transformation applied is
 * title-casing, which turns a typo into a capitalised typo.
 *
 * WHY THE LEGACY VALUE IS STILL HONOURED. Correcting the list alone would have stranded every lead
 * already stored - unfindable, and rejected by its own edit form as an unrecognised source. So the
 * old spelling still validates, still matches a filter and still displays correctly, and the data
 * migration that normalises the rows can run whenever it suits rather than being a prerequisite.
 * These tests assert that both halves hold AT ONCE, because a fix that only works after the
 * migration is not the fix that was needed.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const AGENT = { id: 765432, name: 'ZZ Referral Agent', role: 'agent' } as unknown as AuthUserRecord;

function leadsFor(tx: PrismaService) {
  return new LeadsService(tx, new LeadAuditService(tx), new LeadNotificationService(tx, null as never));
}

async function makeLead(tx: PrismaService, source: string) {
  const t = tag();
  const now = new Date();
  return tx.leads.create({
    data: {
      name: `ZZ Ref ${t}`, email: `zz-ref-${t}@probe.test`, phone: '4165550000',
      lead_status: 'warm', lead_source: source,
      owner_user_id: AGENT.id, assigned_to: AGENT.id, created_at: now, updated_at: now,
    },
  });
}

type Listed = { data: { id: number }[]; meta: { total: number }; stats: { bySource: Record<string, number> } };

describe('the referral source is spelt correctly', () => {
  it('offers the correct spelling and no longer offers the typo', () => {
    expect(LEAD_SOURCE).toContain('referral');
    expect(LEAD_SOURCE).not.toContain('refferal');
  });

  it('still accepts the legacy value, so old leads remain editable', () => {
    // A lead stored as 'refferal' is loaded into its own edit form and saved again. If the typo
    // stopped validating, that save would fail on a value the agent never chose.
    expect(isLeadSource('refferal')).toBe(true);
    expect(canonicalLeadSource('refferal')).toBe('referral');
  });

  it('writes the correct spelling even when the typo is submitted', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, 'website');
      const updated = await leadsFor(tx).update(lead.id, { lead_source: 'refferal' }, AGENT) as { lead_source: string };
      // An old tab, a CSV or an integration sending the legacy value must not reintroduce it.
      expect(updated.lead_source).toBe('referral');
    });
  });

  it('finds BOTH spellings when filtering for referral', async () => {
    await inRollback(async (tx) => {
      const legacy = await makeLead(tx, 'refferal');
      const modern = await makeLead(tx, 'referral');
      await makeLead(tx, 'website');

      const res = await leadsFor(tx).list(AGENT, { limit: '200', leadSource: 'referral' } as never) as Listed;

      // THE DEFECT: this returned nothing at all.
      const ids = res.data.map((r) => r.id);
      expect(ids).toContain(legacy.id);
      expect(ids).toContain(modern.id);
      expect(res.meta.total).toBe(2);
    });
  });

  it('counts both spellings into one referral bucket', async () => {
    await inRollback(async (tx) => {
      await makeLead(tx, 'refferal');
      await makeLead(tx, 'referral');

      const res = await leadsFor(tx).list(AGENT, { limit: '200' } as never) as Listed;
      expect(res.stats.bySource.referral).toBe(2);
      // And they must not also fall into "other", which would double-count the total.
      expect(res.stats.bySource.other).toBe(0);
    });
  });

  it('does not sweep unrelated sources together', () => {
    // `leadSourceMatches` widens exactly one value and leaves the rest alone.
    // 'refe' sorts before 'reff', which is not the order intuition offers.
    expect(leadSourceMatches('referral').sort()).toEqual(['referral', 'refferal']);
    expect(leadSourceMatches('website')).toEqual(['website']);
    expect(leadSourceMatches('meta')).toEqual(['meta']);
  });
});
