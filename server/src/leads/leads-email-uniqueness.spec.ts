import { PrismaClient } from '@prisma/client';

/**
 * The constraint the schema cannot declare, and the rule it encodes.
 *
 * `leads` is UNIQUE on `(COALESCE(owner_user_id, 0), lower(email))`, created by a raw statement
 * because Prisma has no syntax for a functional index. That makes it invisible to `schema.prisma` —
 * and therefore to anyone rebuilding a database from the schema rather than by replaying
 * migrations, which is what `prisma db push` and most disaster-recovery runbooks do.
 *
 * It led with `company_id` until multi-brokerage tenancy was removed on 2026-08-08
 * (migrations/20260808140000_tenant_removal_replacement_constraints). With one brokerage that
 * column held a single value, so dropping it cannot merge two keys that were previously distinct —
 * the rule below is unchanged.
 *
 * Two behaviours depend on it and both fail SILENTLY without it:
 *
 *   - `LeadImportEngine` writes with `createMany({ skipDuplicates: true })`. That compiles to
 *     `ON CONFLICT DO NOTHING`, which de-duplicates nothing at all when there is no unique
 *     constraint to conflict with. A re-imported list would quietly create a second copy of every
 *     lead, and the import would report them as newly imported because they were.
 *   - `LeadsService.create` catches the P2002 it raises and answers 422 instead of 500. Without the
 *     index the race it guards is lost, and one agent double-clicking Save gets two records.
 *
 * The SHAPE matters as much as the existence. Uniqueness is per book, not global: the same person
 * may be a lead of another brokerage, and of another agent in this one, because they can arrive
 * through anybody's ad, campaign or referral. A global index — which is what this used to be —
 * silently discarded the second arrival. Both halves are asserted by behaviour below, because an
 * index that exists but has the wrong columns would pass a definition check and fail every user.
 */
describe('leads email uniqueness', () => {
  const prisma = new PrismaClient();
  const made: number[] = [];

  const lead = (email: string, owner: number | null, name = 'Uniqueness Guard') => ({
    name, email, owner_user_id: owner, created_at: new Date(), updated_at: new Date(),
  });

  afterEach(async () => {
    if (made.length) await prisma.leads.deleteMany({ where: { id: { in: made.splice(0) } } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('is enforced by a unique index scoped to the owning book', async () => {
    const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'leads'`,
    );
    const defs = rows.map((r) => r.indexdef);
    const found = defs.find((d) => /UNIQUE/i.test(d) && /lower\(\s*\(?email/i.test(d));

    // The message is the whole value of this assertion: a bare "expected undefined to be truthy"
    // says nothing about why anyone should care.
    if (!found) {
      throw new Error(
        'No UNIQUE index on lower(email) in the connected database.\n\n'
        + '  createMany({ skipDuplicates: true }) in LeadImportEngine compiles to ON CONFLICT DO NOTHING\n'
        + '  and de-duplicates nothing without it, so re-importing a list would silently create a second\n'
        + '  copy of every lead. LeadsService.create also relies on the P2002 it raises.\n\n'
        + '  It is created by migrations/20260808140000_tenant_removal_replacement_constraints and\n'
        + '  CANNOT be expressed in schema.prisma (Prisma has no functional-index syntax), so a database\n'
        + '  built with `prisma db push` will not have it. Replay the migrations, or create it by hand:\n\n'
        + '    CREATE UNIQUE INDEX "leads_owner_email_key"\n'
        + '      ON "leads" (COALESCE("owner_user_id", 0), LOWER("email"));\n',
      );
    }
    // Per book, not global. A global index would pass the check above and reject every legitimate
    // second arrival of the same person.
    expect(found).toMatch(/owner_user_id/i);
  });

  it('refuses the same address twice in one agent’s own book, case-insensitively', async () => {
    const address = `Own.Book.${Date.now()}@example.test`;
    const first = await prisma.leads.create({ data: lead(address, 4001) });
    made.push(first.id);

    await expect(
      prisma.leads.create({ data: lead(address.toUpperCase(), 4001, 'Duplicate In Own Book') }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  /**
   * The reason this constraint was narrowed. A person who clicks two different agents' ads is two
   * relationships, not one duplicate — and refusing the second is a paid click thrown away.
   */
  it('allows another agent in the same brokerage to hold the same person', async () => {
    const address = `Two.Agents.${Date.now()}@example.test`;
    const a = await prisma.leads.create({ data: lead(address, 4001, 'Agent One Copy') });
    const b = await prisma.leads.create({ data: lead(address, 4002, 'Agent Two Copy') });
    made.push(a.id, b.id);

    expect(a.id).not.toBe(b.id);
    expect(await prisma.leads.count({ where: { email: address } })).toBe(2);
  });

  /*
   * REMOVED: 'allows another brokerage to hold the same person'.
   *
   * It seeded a second `company_settings` row and asserted the index let both brokerages hold the
   * same address. There is no second brokerage to seed any more — this deployment serves one, the
   * `company_id` column is gone from `leads`, and the rule it demonstrated has no way to be
   * exercised. It was already a no-op on a single-brokerage database, returning early whenever it
   * could not find a second company, which is every run this suite has ever made here.
   *
   * The half of the rule that still applies — two AGENTS in this brokerage may each hold the same
   * person — is covered by the test above it, which is the case that actually happens.
   */

  /**
   * Unattributed brokerage intake is the highest-volume source there is, and `owner_user_id IS
   * NULL` is what it looks like. Postgres treats NULLs as distinct in a unique index, so without
   * the COALESCE in the index definition these rows would be exempt from the constraint entirely
   * and a misbehaving Meta form could pile up unlimited copies of one address.
   */
  it('still refuses duplicates among unowned intake, where NULLs would otherwise be distinct', async () => {
    const address = `Unowned.${Date.now()}@example.test`;
    const first = await prisma.leads.create({ data: lead(address, null, 'Unattributed Intake') });
    made.push(first.id);

    await expect(
      prisma.leads.create({ data: lead(address, null, 'Unattributed Intake Again') }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  /**
   * The soft-delete interaction, pinned deliberately.
   *
   * The index counts deleted rows and the application check does not, which is the gap that used to
   * surface as a 500 when somebody re-added a lead they had just deleted. That is now caught and
   * turned into a validation error — but only because this remains true, so it is worth asserting
   * rather than assuming.
   */
  it('still holds the address of a soft-deleted lead in the same book', async () => {
    const address = `Deleted.${Date.now()}@example.test`;
    const row = await prisma.leads.create({ data: lead(address, 4001) });
    made.push(row.id);
    await prisma.leads.update({ where: { id: row.id }, data: { deleted_at: new Date() } });

    await expect(
      prisma.leads.create({ data: lead(address, 4001, 'Replacement') }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
