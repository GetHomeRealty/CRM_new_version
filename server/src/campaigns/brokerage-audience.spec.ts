import { CampaignAudienceService } from './campaign-audience.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-CAMP-H01 — the marketing roles select across the brokerage; everyone else stays capped.
 *
 * The point of these tests is the SECOND half of the change: widening the candidate pool must not
 * loosen anything that narrows it. So each one asserts both the scope AND that every downstream
 * control is still in the query.
 */

const as = (role: string, id = 7): AuthUserRecord => ({ id, role, name: role } as unknown as AuthUserRecord);

/** No database is needed — `buildAudienceWhere` is pure. */
const svc = new CampaignAudienceService({} as unknown as PrismaService);

/** The owner clause, or null when the audience is brokerage-wide. */
function ownerClause(where: Record<string, unknown>): unknown {
  const and = where.AND as Record<string, unknown>[] | undefined;
  return and ? and[1] : null;
}
/** The always-on part of the filter, wherever it ended up. */
function base(where: Record<string, unknown>): Record<string, unknown> {
  const and = where.AND as Record<string, unknown>[] | undefined;
  return (and ? and[0] : where) as Record<string, unknown>;
}

describe('who may select the brokerage’s leads', () => {
  /**
   * WHAT THESE EXPECTATIONS USED TO BE, AND WHY THEY CHANGED.
   *
   * This block asserted `ownerClause(...)` was **null** for the three marketing roles — meaning the
   * audience query carried NO owner clause at all. That is `{}`, and `{}` is every lead in the
   * database, including every agent's private book. Measured on the running application: a Manager
   * whose Leads screen showed 0 leads could build a campaign against 81, of which 14 were agents'
   * private clients.
   *
   * "Select across the brokerage" was the right intent and the wrong implementation: it widened to
   * EVERYTHING rather than to the brokerage's OWN leads, which this database distinguishes by
   * `owner_user_id IS NULL`. The audience now resolves through `leadScopeWhere`, so the clause is
   * present for every role — what differs is whether the brokerage's leads are inside it.
   */
  it.each(['admin', 'manager', 'crm', 'accounting', 'documentation'])(
    '%s selects the brokerage’s own leads as well as their own', (role) => {
      const clause = ownerClause(svc.buildAudienceWhere({}, as(role, 7))) as { OR?: unknown[] };
      expect(clause?.OR).toEqual([{ assigned_to: 7 }, { owner_user_id: 7 }, { owner_user_id: null }]);
    });

  it('an agent is capped to their own leads — the one role with a private book', () => {
    const clause = ownerClause(svc.buildAudienceWhere({}, as('agent', 7))) as { OR?: unknown[] };
    expect(clause?.OR).toEqual([{ assigned_to: 7 }, { owner_user_id: 7 }]);
  });

  it('no role gets an empty owner clause — that would be every agent’s book', () => {
    // The property, stated directly, because losing it is the specific regression this file exists
    // for. An absent clause is not "brokerage-wide"; it is unscoped.
    for (const role of ['admin', 'manager', 'crm', 'agent', 'accounting', 'documentation']) {
      expect(ownerClause(svc.buildAudienceWhere({}, as(role, 7)))).not.toBeNull();
    }
  });

  it('a brokerage-scoped role still cannot select a NAMED agent’s leads', () => {
    // `owner_user_id: null` is the brokerage's leads. There is no clause admitting owner_user_id 42.
    const clause = ownerClause(svc.buildAudienceWhere({}, as('manager', 7))) as { OR?: Record<string, unknown>[] };
    expect(clause.OR!.some((c) => c.owner_user_id === 42 || c.assigned_to === 42)).toBe(false);
  });

  it('fails closed with no user at all', () => {
    // Not reachable from a request, and it must not open the book if it ever is.
    const clause = ownerClause(svc.buildAudienceWhere({}, null)) as { OR?: unknown[] };
    expect(clause?.OR).toEqual([{ assigned_to: -1 }, { owner_user_id: -1 }]);
  });
});

describe('widening the pool does not loosen the controls', () => {
  it.each(['crm', 'admin', 'manager', 'agent'])('%s still excludes deleted and unsubscribed leads', (role) => {
    const w = base(svc.buildAudienceWhere({}, as(role)));
    expect(w.deleted_at).toBeNull();
    expect(w.unsubscribed).toBe(false);
  });

  it('the campaign filters still apply to a brokerage-wide audience', () => {
    // A brokerage-wide pool that ignored the segment would mail everybody — the thing the owner
    // explicitly said this must not become.
    const w = base(svc.buildAudienceWhere(
      { leadStatus: 'Active', leadType: 'Buyer', leadSource: 'Meta', clientType: 'Individual', tag: 'VIP' },
      as('crm'),
    ));
    expect(w.lead_status).toEqual({ equals: 'Active', mode: 'insensitive' });
    expect(w.lead_type).toBe('Buyer');
    expect(w.lead_source).toBe('Meta');
    expect(w.client_type).toBe('Individual');
    expect(w.tags).toEqual({ contains: '"VIP"' });
  });

  it('a filtered brokerage audience keeps BOTH the filter and the exclusions', () => {
    const w = base(svc.buildAudienceWhere({ leadStatus: 'Active' }, as('crm')));
    expect(w).toMatchObject({ deleted_at: null, unsubscribed: false, lead_status: { equals: 'Active', mode: 'insensitive' } });
  });
});
