import { CampaignsService } from './campaigns.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-027: undoing an opt-out is not an ordinary campaign edit.
 *
 * WHAT WAS TRUE, AND HAD NOT BEEN TESTED. The report established the rule from the permission map
 * and the on-screen copy but recorded "server behaviour NOT tested", noting that an earlier version
 * had wrongly claimed it. It was verified at the HTTP boundary before this fix: the agent seat sent
 * `DELETE /api/campaigns/suppressions/...` and received `200 {"removed":true}`. The suppression was
 * gone and the matching leads un-flagged.
 *
 * WHAT WAS NOT TRUE was the premise that nothing narrower could be expressed - "there is no
 * verb-level or record-level granularity anywhere in it". That describes the CLIENT bundle's flat
 * module map. The server has a capability layer of a dozen such rules, and one of them,
 * `campaigns.brokerage-audience`, is documented as covering the brokerage's marketing audience "and
 * see the whole opt-out list". So this needed no new concept: the vocabulary already existed and the
 * removal path simply was not asking it.
 *
 * WHY THE CAPABILITY RATHER THAN A RANK. Marketing responsibility does not run along the seniority
 * ladder: `crm` sits below `accounting` and `documentation` and needs this, while they do not. A
 * threshold that admitted crm would admit both of them and hand a brokerage-wide opt-out list to
 * roles with no reason to hold one.
 */

const as = (role: string): AuthUserRecord => ({ id: 5, name: 'Someone', role } as unknown as AuthUserRecord);

function svc(rows: Record<string, unknown>[] = []) {
  const prisma = {
    email_suppressions: {
      findUnique: async () => rows[0] ?? null,
      findMany: async () => rows,
      count: async () => rows.length,
      delete: async () => rows[0],
    },
    leads: { findMany: async () => [] },
    $executeRaw: async () => 1,
  } as unknown as PrismaService;
  return new CampaignsService(prisma, null as never, null as never, null as never, null as never);
}

const ROW = { id: 1, email: 'someone@probe.invalid', reason: 'unsubscribed', campaign_id: null, created_at: new Date(), updated_at: new Date() };

describe('who may take an address off the suppression list', () => {
  it('refuses an ordinary agent', async () => {
    // THE DEFECT: this returned { removed: true } and mail resumed.
    await expect(svc([ROW]).removeSuppression(ROW.email, as('agent'))).rejects.toThrow(/marketing and administrative/i);
  });

  it('allows the roles accountable for marketing', async () => {
    for (const role of ['admin', 'manager', 'crm']) {
      await expect(svc([ROW]).removeSuppression(ROW.email, as(role))).resolves.toEqual({ removed: true });
    }
  });

  it('refuses the roles that outrank crm but do not run campaigns', async () => {
    for (const role of ['accounting', 'documentation']) {
      await expect(svc([ROW]).removeSuppression(ROW.email, as(role))).rejects.toThrow(/marketing and administrative/i);
    }
  });

  it('refuses BEFORE looking the address up, so it cannot be used to probe the list', async () => {
    /*
     * Order matters here. Checking permission after the lookup would answer "that address is not on
     * the suppression list" to somebody not allowed to know either way - a small disclosure, on a
     * list of people who asked to be left alone.
     */
    let looked = false;
    const prisma = {
      email_suppressions: { findUnique: async () => { looked = true; return ROW; } },
    } as unknown as PrismaService;
    const s = new CampaignsService(prisma, null as never, null as never, null as never, null as never);

    await expect(s.removeSuppression(ROW.email, as('agent'))).rejects.toThrow();
    expect(looked).toBe(false);
  });

  it('tells the screen whether the control should be offered at all', async () => {
    // The panel showed Remove on `campaigns:edit`, which an agent holds. Without this it would now
    // offer a button the server refuses — the exact shape of CRM-012.
    const agentView = await svc([ROW]).listSuppressions(as('agent'), {}) as { meta: { can_remove: boolean } };
    const adminView = await svc([ROW]).listSuppressions(as('admin'), {}) as { meta: { can_remove: boolean } };

    expect(agentView.meta.can_remove).toBe(false);
    expect(adminView.meta.can_remove).toBe(true);
  });
});
