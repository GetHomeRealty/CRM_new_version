import { PrismaClient } from '@prisma/client';
import { AREA_LABEL, AREAS, DOMAINS, domainFilter, domainWhere, isArea, isDomain, parseArea, strictDomainFilter } from './domain';

/**
 * The domain filter is the one piece of the CRM / Transaction Management separation that every
 * later phase builds on: if it is wrong, one area silently shows the other's records, or a whole
 * table's history disappears from view.
 *
 * The first `describe` is pure logic. The second sends the filters to Postgres, because the shape
 * that matters is the one Prisma accepts — the obvious spelling of "one of these, or not set",
 * `{ domain: { in: ['desk', 'common', null] } }`, type-checks perfectly and throws at runtime.
 * Only a real query catches that.
 */

describe('domain vocabulary', () => {
  it('has three domains but only two areas', () => {
    expect([...DOMAINS]).toEqual(['crm', 'desk', 'common']);
    // `common` is a marking on a record, not somewhere a user can be.
    expect([...AREAS]).toEqual(['crm', 'desk']);
    expect(Object.keys(AREA_LABEL).sort()).toEqual(['crm', 'desk']);
  });

  it('recognises its own values and rejects everything else', () => {
    expect(isDomain('common')).toBe(true);
    expect(isArea('common')).toBe(false);
    for (const bad of ['CRM', 'transaction_management', '', null, undefined, 0]) {
      expect(isDomain(bad)).toBe(false);
      expect(isArea(bad)).toBe(false);
    }
  });

  it('reads an area from a route segment, and falls back rather than throwing', () => {
    expect(parseArea('crm')).toBe('crm');
    expect(parseArea('CRM')).toBe('crm');
    expect(parseArea(' Desk ')).toBe('desk');
    // The frontend route is /transactions/*, so both spellings have to land on 'desk'.
    expect(parseArea('transaction')).toBe('desk');
    expect(parseArea('transactions')).toBe('desk');
    // An unreadable value must not silently become CRM and widen what a desk user sees.
    expect(parseArea(undefined)).toBe('desk');
    expect(parseArea('nonsense')).toBe('desk');
    expect(parseArea('nonsense', 'crm')).toBe('crm');
  });
});

describe('domainFilter composition', () => {
  it('admits the area, common, and the unclassified — and nothing else', () => {
    expect(domainFilter('crm')).toEqual({ OR: [{ domain: { in: ['crm', 'common'] } }, { domain: null }] });
    expect(domainFilter('desk')).toEqual({ OR: [{ domain: { in: ['desk', 'common'] } }, { domain: null }] });
    // No `null` inside `in` — that spelling is what Prisma rejects.
    expect(domainFilter('desk').OR[0].domain.in).not.toContain(null);
  });

  it('keeps common out of the strict filter, which the audit trail needs', () => {
    expect(strictDomainFilter('crm')).toEqual({ domain: 'crm' });
    expect(strictDomainFilter('desk')).toEqual({ domain: 'desk' });
  });

  it("does not overwrite a caller's own OR", () => {
    // A search across two columns is an OR. Spreading the domain filter over it would replace it
    // and quietly return every row instead of the matching ones.
    const search = { OR: [{ title: { contains: 'x' } }, { description: { contains: 'x' } }] };
    const composed = domainWhere('desk', search) as { AND: [object, typeof search] };
    expect(composed.AND).toHaveLength(2);
    expect(composed.AND[1]).toBe(search);
    expect(composed.AND[0]).toEqual(domainFilter('desk'));
  });

  it('stays flat when there is nothing to compose with', () => {
    expect(domainWhere('crm')).toEqual(domainFilter('crm'));
    expect(domainWhere('crm', {})).toEqual(domainFilter('crm'));
  });
});

/**
 * Against the real database. Read-only — counts only, no writes — so it is safe to run anywhere
 * the app's own DATABASE_URL points.
 */
describe('domainFilter against Postgres', () => {
  const prisma = new PrismaClient();
  afterAll(async () => { await prisma.$disconnect(); });

  it('is a shape Prisma actually accepts on every domain table', async () => {
    for (const area of AREAS) {
      await expect(prisma.calendar_events.count({ where: domainFilter(area) })).resolves.toBeGreaterThanOrEqual(0);
      await expect(prisma.audit_logs.count({ where: domainFilter(area) })).resolves.toBeGreaterThanOrEqual(0);
      await expect(prisma.todos.count({ where: domainFilter(area) })).resolves.toBeGreaterThanOrEqual(0);
      await expect(prisma.audit_logs.count({ where: strictDomainFilter(area) })).resolves.toBeGreaterThanOrEqual(0);
    }
  });

  it('shows unclassified rows to BOTH areas, so the split hides nothing', async () => {
    const unassigned = await prisma.calendar_events.count({ where: { domain: null } });
    const crm = await prisma.calendar_events.count({ where: domainFilter('crm') });
    const desk = await prisma.calendar_events.count({ where: domainFilter('desk') });
    // Every unassigned row is counted on both sides.
    expect(crm).toBeGreaterThanOrEqual(unassigned);
    expect(desk).toBeGreaterThanOrEqual(unassigned);
  });

  it('leaves no row invisible to both areas', async () => {
    // The property the whole design rests on: a record may be visible twice, but never zero times.
    for (const table of ['calendar_events', 'audit_logs', 'todos'] as const) {
      const total = await (prisma[table] as { count: (a?: object) => Promise<number> }).count();
      const crm = await (prisma[table] as { count: (a: object) => Promise<number> }).count({ where: domainFilter('crm') });
      const desk = await (prisma[table] as { count: (a: object) => Promise<number> }).count({ where: domainFilter('desk') });
      expect(crm + desk).toBeGreaterThanOrEqual(total);
      const orphaned = await (prisma[table] as { count: (a: object) => Promise<number> }).count({
        where: { AND: [{ NOT: domainFilter('crm') }, { NOT: domainFilter('desk') }] },
      });
      expect(orphaned).toBe(0);
    }
  });

  it('composes with a real query without losing either condition', async () => {
    const search = { OR: [{ title: { contains: 'Projection' } }, { title: { contains: 'Creditors' } }] };
    const both = await prisma.calendar_events.count({ where: domainWhere('desk', search) });
    const searchOnly = await prisma.calendar_events.count({ where: search });
    const domainOnly = await prisma.calendar_events.count({ where: domainFilter('desk') });
    expect(both).toBeLessThanOrEqual(Math.min(searchOnly, domainOnly));
  });
});
