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

describe('who may select the whole brokerage', () => {
  it.each(['admin', 'manager', 'crm'])('%s selects across the brokerage', (role) => {
    expect(ownerClause(svc.buildAudienceWhere({}, as(role)))).toBeNull();
  });

  it.each(['agent', 'accounting', 'documentation'])('%s is capped to their own leads', (role) => {
    const clause = ownerClause(svc.buildAudienceWhere({}, as(role, 7))) as { OR?: unknown[] };
    expect(clause?.OR).toEqual([{ assigned_to: 7 }, { owner_user_id: 7 }]);
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
