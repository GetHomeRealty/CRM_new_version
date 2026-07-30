import { PrismaClient } from '@prisma/client';
import { auditDomain, screenLabelsForArea, SCREEN_DOMAIN } from './domain';
import { SCREENS } from '../auth/permission.service';

/**
 * Section 12: the audit trail split.
 *
 * The interesting property is not that `auditDomain` returns sensible values — it is that it returns
 * the SAME values the backfill migration wrote. History was classified once, by SQL, and everything
 * from now on is classified by this function. If the two disagree, the trail silently becomes a mix
 * of two schemes with no way to tell from a row which produced it.
 *
 * So the second describe re-derives every existing row's domain from its own columns and compares it
 * to what is stored. Read-only.
 */

describe('§12 auditDomain rules', () => {
  it('treats a transaction link as decisive', () => {
    expect(auditDomain({ transactionId: 7 })).toBe('desk');
    // Even when the category says otherwise — the link is the stronger fact.
    expect(auditDomain({ transactionId: 7, category: 'Lead' })).toBe('desk');
  });

  it('places the CRM modules in the CRM', () => {
    // Client Reviews joined them when it was removed from the Transaction Desk — and it must stay in
    // step with SCREEN_DOMAIN, or its entries would land in a trail whose filter cannot select them.
    for (const c of ['Lead', 'Leads', 'Campaigns', 'Meta', 'Client Reviews']) expect(auditDomain({ category: c })).toBe('crm');
  });

  it('places the transaction modules in the Transaction Desk', () => {
    for (const c of ['Transactions', 'Invoice', 'Invoices', 'Reports', 'Analytics']) {
      expect(auditDomain({ category: c })).toBe('desk');
    }
  });

  it('splits Settings by its section, which is the only thing that distinguishes them', () => {
    expect(auditDomain({ category: 'Settings', section: 'CRM Settings' })).toBe('crm');
    expect(auditDomain({ category: 'Settings', section: 'Transaction Desk Settings' })).toBe('desk');
    expect(auditDomain({ category: 'Settings', section: 'Company Settings' })).toBe('common');
    // An unrecognised settings section is shared rather than guessed into one area.
    expect(auditDomain({ category: 'Settings', section: 'Something New' })).toBe('common');
    expect(auditDomain({ category: 'Settings' })).toBe('common');
  });

  it('marks the shared modules common, so they appear in both trails', () => {
    for (const c of ['Users', 'Marketing Inventory', 'Inventory', 'MLS']) {
      expect(auditDomain({ category: c })).toBe('common');
    }
  });

  it('leaves the unknown unclassified rather than guessing', () => {
    // Null is visible from BOTH areas. Guessing an area would hide the row from the other one.
    expect(auditDomain({ category: 'Something Nobody Has Written Yet' })).toBeNull();
    expect(auditDomain({})).toBeNull();
  });
});

describe('the classifier and the screen map agree', () => {
  it('classifies each screen the same way SCREEN_DOMAIN places it', () => {
    // Divergence here is the bug this file exists to prevent: a category the filter does not offer,
    // holding records the trail still shows.
    const byLabel: Record<string, string> = {
      Lead: 'lead', Campaigns: 'campaigns', Meta: 'meta', 'Client Reviews': 'reviews',
      Transactions: 'transactions', Invoice: 'invoice', Reports: 'reports', Analytics: 'analytics',
      Users: 'users', Inventory: 'inventory', MLS: 'mls', Favorites: 'favorites',
    };
    for (const [label, key] of Object.entries(byLabel)) {
      expect({ label, domain: auditDomain({ category: label }) }).toEqual({ label, domain: SCREEN_DOMAIN[key] });
    }
  });
});

describe('§12 area category lists', () => {
  it("offers the CRM its own modules and not the Desk's", () => {
    const crm = screenLabelsForArea(SCREENS, 'crm');
    expect(crm).toContain('Lead');
    expect(crm).toContain('Campaigns');
    expect(crm).toContain('Meta');
    expect(crm).not.toContain('Transactions');
    expect(crm).not.toContain('Invoice');
    expect(crm).not.toContain('Analytics');
  });

  it("offers the Desk its own modules and not the CRM's", () => {
    const desk = screenLabelsForArea(SCREENS, 'desk');
    expect(desk).toContain('Transactions');
    expect(desk).toContain('Invoice');
    expect(desk).toContain('Analytics');
    expect(desk).not.toContain('Lead');
    expect(desk).not.toContain('Campaigns');
    expect(desk).not.toContain('Meta');
  });

  it('offers the shared modules to both', () => {
    for (const area of ['crm', 'desk'] as const) {
      const labels = screenLabelsForArea(SCREENS, area);
      expect(labels).toContain('Users');
      expect(labels).toContain('Inventory');
      expect(labels).toContain('MLS');
    }
  });
});

describe('§12 the runtime rules agree with the backfill', () => {
  const prisma = new PrismaClient();
  afterAll(async () => { await prisma.$disconnect(); });

  it('re-derives every stored domain from the row it was derived from', async () => {
    const rows = await prisma.audit_logs.findMany({
      select: { id: true, category: true, section: true, transaction_id: true, domain: true },
    });
    expect(rows.length).toBeGreaterThan(0);

    const disagreements = rows
      .map((r) => ({ row: r, derived: auditDomain({ category: r.category, section: r.section, transactionId: r.transaction_id }) }))
      .filter(({ row, derived }) => derived !== null && derived !== row.domain)
      .map(({ row, derived }) => `#${row.id} ${row.category}/${row.section}: stored ${row.domain}, derived ${derived}`);

    expect(disagreements).toEqual([]);
  });

  it('leaves no audit record invisible to both trails', async () => {
    // The property section 12's data requirements rest on: an entry may be visible twice, never zero
    // times. A domain that is neither area nor 'common' nor null would vanish from both.
    const stray = await prisma.audit_logs.count({
      where: { AND: [{ domain: { not: null } }, { domain: { notIn: ['crm', 'desk', 'common'] } }] },
    });
    expect(stray).toBe(0);
  });

  it('accounts for every row across the two default views plus shared', async () => {
    const total = await prisma.audit_logs.count();
    const crmOwn = await prisma.audit_logs.count({ where: { domain: 'crm' } });
    const deskOwn = await prisma.audit_logs.count({ where: { domain: 'desk' } });
    const shared = await prisma.audit_logs.count({ where: { domain: 'common' } });
    const unset = await prisma.audit_logs.count({ where: { domain: null } });
    expect(crmOwn + deskOwn + shared + unset).toBe(total);
  });
});
