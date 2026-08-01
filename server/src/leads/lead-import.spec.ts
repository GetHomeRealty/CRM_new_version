import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { IMPORT_BATCH_SIZE, LeadImportEngine } from './lead-import.engine';

/**
 * The import engine, against the real schema, inside transactions that are rolled back.
 *
 * The rewrite changed HOW the work is done — one indexed lookup per batch instead of one sequential
 * scan per row — so the tests that matter are the ones proving the OUTCOME did not change with it,
 * plus the two behaviours that were wrong before:
 *
 *   an address already on file must be tagged, never duplicated
 *   a duplicate INSIDE the uploaded file must be caught, including across a batch boundary
 *     (campaigns.service had no in-file de-duplication at all, so the same file imported through
 *      two screens produced two different results)
 *   the lookup must be case-insensitive, since that is what the old ILIKE bought us
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const IMPORTER_ID = 999002;
const ctx = { tag: '', userName: 'Importer', userId: IMPORTER_ID };
const engineFor = (tx: PrismaService) => new LeadImportEngine(tx);

/** A CSV with a header and the given rows, in the shape a spreadsheet exports. */
const csvOf = (rows: { name?: string; email: string; phone?: string }[]) =>
  ['Name,Email,Phone', ...rows.map((r) => `${r.name ?? ''},${r.email},${r.phone ?? ''}`)].join('\n');

const uniq = () => `${Date.now()}-${++seq}`;

describe('lead import engine', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('parses a CSV regardless of how the headers are spelled', () => {
    const e = new LeadImportEngine({} as PrismaService);
    const rows = e.parseCsv('Full Name,E-Mail Address,Lead_Source\nAda,ada@x.test,Referral');
    // "Full Name" → fullname, "E-Mail Address" → emailaddress, "Lead_Source" → leadsource.
    expect(rows[0]).toEqual({ fullname: 'Ada', emailaddress: 'ada@x.test', leadsource: 'Referral' });
  });

  it('handles quoted fields containing commas', () => {
    const e = new LeadImportEngine({} as PrismaService);
    const rows = e.parseCsv('Name,Email\n"Smith, Ada",ada@x.test');
    expect(rows[0].name).toBe('Smith, Ada');
  });

  it('imports new leads and counts them', async () => {
    await inRollback(async (tx) => {
      const u = uniq();
      const rows = engineFor(tx).parseCsv(csvOf([
        { name: 'Ada', email: `ada-${u}@x.test` },
        { name: 'Grace', email: `grace-${u}@x.test` },
      ]));
      const tally = await engineFor(tx).runBatch(rows, ctx, new Set());
      expect(tally).toEqual({ imported: 2, tagged: 0, duplicate: 0, invalid: 0 });

      const created = await tx.leads.findFirst({ where: { email: `ada-${u}@x.test` } });
      expect(created?.name).toBe('Ada');
      expect(created?.created_by).toBe('Importer');
    });
  });

  it('tags an address already on file instead of duplicating it', async () => {
    await inRollback(async (tx) => {
      const u = uniq();
      const email = `existing-${u}@x.test`;
      await tx.leads.create({ data: { name: 'Existing', email, tags: '["old"]', owner_user_id: IMPORTER_ID, company_id: 1, created_at: new Date(), updated_at: new Date() } });

      const rows = engineFor(tx).parseCsv(csvOf([{ name: 'Existing Again', email }]));
      const tally = await engineFor(tx).runBatch(rows, { ...ctx, tag: 'imported-2026' }, new Set());

      expect(tally.imported).toBe(0);
      expect(tally.duplicate).toBe(1);
      expect(tally.tagged).toBe(1);

      const all = await tx.leads.findMany({ where: { email } });
      expect(all).toHaveLength(1);                          // not duplicated
      expect(JSON.parse(all[0].tags ?? '[]')).toEqual(['old', 'imported-2026']);   // existing tag kept
    });
  });

  it('matches an existing address regardless of case', async () => {
    // This is what the old ILIKE bought, and what `lower(email) IN (...)` has to preserve — the
    // whole change would be worthless if it silently started creating duplicates for "Ada@" vs "ada@".
    await inRollback(async (tx) => {
      const u = uniq();
      await tx.leads.create({ data: { name: 'Ada', email: `ADA-${u}@X.TEST`, company_id: 1, created_at: new Date(), updated_at: new Date() } });

      const rows = engineFor(tx).parseCsv(csvOf([{ name: 'ada', email: `ada-${u}@x.test` }]));
      const tally = await engineFor(tx).runBatch(rows, ctx, new Set());

      expect(tally.imported).toBe(0);
      expect(tally.duplicate).toBe(1);
    });
  });

  it('catches a duplicate appearing twice within one file', async () => {
    await inRollback(async (tx) => {
      const u = uniq();
      const email = `twice-${u}@x.test`;
      const rows = engineFor(tx).parseCsv(csvOf([{ email }, { email }]));
      const tally = await engineFor(tx).runBatch(rows, ctx, new Set());

      expect(tally.imported).toBe(1);
      expect(tally.duplicate).toBe(1);
      expect(await tx.leads.count({ where: { email } })).toBe(1);
    });
  });

  it('catches a duplicate that straddles a batch boundary', async () => {
    // The `seen` set is owned by the caller precisely so it survives between batches. Losing that
    // would mean a 1,000-row file with the same address at rows 1 and 600 creating two leads.
    await inRollback(async (tx) => {
      const u = uniq();
      const email = `straddle-${u}@x.test`;
      const seen = new Set<string>();
      const e = engineFor(tx);

      const first = await e.runBatch(e.parseCsv(csvOf([{ email }])), ctx, seen);
      const second = await e.runBatch(e.parseCsv(csvOf([{ email }])), ctx, seen);

      expect(first.imported).toBe(1);
      expect(second.imported).toBe(0);
      expect(second.duplicate).toBe(1);
      expect(await tx.leads.count({ where: { email } })).toBe(1);
    });
  });

  it('counts unusable addresses as invalid rather than importing them', async () => {
    await inRollback(async (tx) => {
      const rows = engineFor(tx).parseCsv(csvOf([
        { name: 'No address', email: '' },
        { name: 'Not an address', email: 'not-an-email' },
        { name: 'Spaces', email: 'a b@x.test' },
      ]));
      const tally = await engineFor(tx).runBatch(rows, ctx, new Set());
      expect(tally).toEqual({ imported: 0, tagged: 0, duplicate: 0, invalid: 3 });
    });
  });

  it('falls back to the address local-part when a row has no name', async () => {
    await inRollback(async (tx) => {
      const u = uniq();
      const rows = engineFor(tx).parseCsv(csvOf([{ email: `nameless-${u}@x.test` }]));
      await engineFor(tx).runBatch(rows, ctx, new Set());
      const created = await tx.leads.findFirst({ where: { email: `nameless-${u}@x.test` } });
      expect(created?.name).toBe(`nameless-${u}`);
    });
  });

  it('imports a full batch in one go', async () => {
    // The batch size is the unit of both the indexed lookup and the transaction, so a full one
    // has to behave exactly like a small one.
    await inRollback(async (tx) => {
      const u = uniq();
      const many = Array.from({ length: IMPORT_BATCH_SIZE }, (_, i) => ({ name: `Lead ${i}`, email: `bulk-${i}-${u}@x.test` }));
      const rows = engineFor(tx).parseCsv(csvOf(many));
      const tally = await engineFor(tx).runBatch(rows, ctx, new Set());

      expect(tally.imported).toBe(IMPORT_BATCH_SIZE);
      expect(await tx.leads.count({ where: { email: { endsWith: `-${u}@x.test` } } })).toBe(IMPORT_BATCH_SIZE);
    });
  });

  it('does not re-tag a lead that already carries the tag', async () => {
    await inRollback(async (tx) => {
      const u = uniq();
      const email = `tagged-${u}@x.test`;
      await tx.leads.create({ data: { name: 'Tagged', email, tags: '["spring"]', company_id: 1, created_at: new Date(), updated_at: new Date() } });

      const rows = engineFor(tx).parseCsv(csvOf([{ email }]));
      const tally = await engineFor(tx).runBatch(rows, { ...ctx, tag: 'spring' }, new Set());

      expect(tally.tagged).toBe(0);
      const after = await tx.leads.findFirst({ where: { email } });
      expect(JSON.parse(after?.tags ?? '[]')).toEqual(['spring']);
    });
  });

  it('tags a whole batch of existing leads at once', async () => {
    // The path a brokerage repeats most: re-upload a list you already hold, in order to tag it.
    // Every row is a duplicate, so nothing is created and everything is tagged — which used to be
    // one awaited UPDATE per row and ran 6× slower than importing the same file fresh.
    await inRollback(async (tx) => {
      const u = uniq();
      const emails = Array.from({ length: 120 }, (_, i) => `retag-${i}-${u}@x.test`);
      const now = new Date();
      await tx.leads.createMany({
        data: emails.map((email, i) => ({ name: `Existing ${i}`, email, tags: '[]', owner_user_id: IMPORTER_ID, company_id: 1, created_at: now, updated_at: now })),
      });

      const rows = engineFor(tx).parseCsv(csvOf(emails.map((email) => ({ email }))));
      const tally = await engineFor(tx).runBatch(rows, { ...ctx, tag: 'spring' }, new Set());

      expect(tally.imported).toBe(0);
      expect(tally.duplicate).toBe(120);
      expect(tally.tagged).toBe(120);

      const after = await tx.leads.findMany({ where: { email: { endsWith: `-${u}@x.test` } }, select: { tags: true } });
      expect(after).toHaveLength(120);
      expect(after.every((r) => JSON.parse(r.tags ?? '[]').includes('spring'))).toBe(true);
    });
  });

  it('keeps each lead\'s own prior tags when adding a new one', async () => {
    // Grouping is only safe if leads whose prior tags DIFFER end up in different groups.
    await inRollback(async (tx) => {
      const u = uniq();
      const now = new Date();
      const seed = [
        { email: `g1-${u}@x.test`, tags: '[]' },
        { email: `g2-${u}@x.test`, tags: '["vip"]' },
        { email: `g3-${u}@x.test`, tags: '["vip"]' },
        { email: `g4-${u}@x.test`, tags: '["cold","old"]' },
      ];
      await tx.leads.createMany({
        data: seed.map((r, i) => ({ name: `Lead ${i}`, email: r.email, tags: r.tags, owner_user_id: IMPORTER_ID, company_id: 1, created_at: now, updated_at: now })),
      });

      const rows = engineFor(tx).parseCsv(csvOf(seed.map((r) => ({ email: r.email }))));
      expect((await engineFor(tx).runBatch(rows, { ...ctx, tag: 'spring' }, new Set())).tagged).toBe(4);

      const tagsOf = async (email: string) =>
        JSON.parse((await tx.leads.findFirst({ where: { email }, select: { tags: true } }))?.tags ?? '[]');

      expect(await tagsOf(`g1-${u}@x.test`)).toEqual(['spring']);
      expect(await tagsOf(`g2-${u}@x.test`)).toEqual(['vip', 'spring']);
      expect(await tagsOf(`g3-${u}@x.test`)).toEqual(['vip', 'spring']);
      expect(await tagsOf(`g4-${u}@x.test`)).toEqual(['cold', 'old', 'spring']);
    });
  });

  it('does not tag a lead that belongs to somebody else', async () => {
    // An agent uploading a list that overlaps the office's used to be told "N tagged" while the
    // tag was written onto leads they cannot see, open, or put in a campaign.
    await inRollback(async (tx) => {
      const u = uniq();
      const now = new Date();
      const email = `theirs-${u}@x.test`;
      await tx.leads.create({
        data: { name: 'Someone else\'s lead', email, tags: '[]', owner_user_id: 999001, company_id: 1, created_at: now, updated_at: now },
      });

      const rows = engineFor(tx).parseCsv(csvOf([{ email }]));
      const tally = await engineFor(tx).runBatch(rows, { tag: 'my-campaign', userName: 'Agent', userId: 999002 }, new Set());

      // Still an existing address — the unique index means it cannot be created either — but the
      // other person's lead is left exactly as it was.
      expect(tally.duplicate).toBe(1);
      expect(tally.imported).toBe(0);
      expect(tally.tagged).toBe(0);

      const after = await tx.leads.findFirst({ where: { email }, select: { tags: true } });
      expect(JSON.parse(after?.tags ?? '[]')).toEqual([]);
    });
  });

  it('still tags a lead the importer owns, or has been assigned', async () => {
    await inRollback(async (tx) => {
      const u = uniq();
      const now = new Date();
      const owned = `owned-${u}@x.test`;
      const assigned = `assigned-${u}@x.test`;
      await tx.leads.createMany({
        data: [
          { name: 'Mine by ownership', email: owned, tags: '[]', owner_user_id: 999002, company_id: 1, created_at: now, updated_at: now },
          { name: 'Mine by assignment', email: assigned, tags: '[]', owner_user_id: 999001, assigned_to: 999002, company_id: 1, created_at: now, updated_at: now },
        ],
      });

      const rows = engineFor(tx).parseCsv(csvOf([{ email: owned }, { email: assigned }]));
      const tally = await engineFor(tx).runBatch(rows, { tag: 'my-campaign', userName: 'Agent', userId: 999002 }, new Set());

      expect(tally.tagged).toBe(2);
    });
  });

  it('lets a super-admin tag unattributed intake', async () => {
    // Matches the Leads module: a lead with no owner belongs to the top tier.
    await inRollback(async (tx) => {
      const u = uniq();
      const now = new Date();
      const email = `orphan-${u}@x.test`;
      await tx.leads.create({ data: { name: 'Unowned', email, tags: '[]', company_id: 1, created_at: now, updated_at: now } });

      const rows = engineFor(tx).parseCsv(csvOf([{ email }]));
      const asAgent = await engineFor(tx).runBatch(rows, { tag: 'x', userName: 'Agent', userId: 999002 }, new Set());
      expect(asAgent.tagged).toBe(0);

      const rows2 = engineFor(tx).parseCsv(csvOf([{ email }]));
      const asAdmin = await engineFor(tx).runBatch(
        rows2, { tag: 'x', userName: 'Boss', userId: 999003, userIsSuperAdmin: true }, new Set());
      expect(asAdmin.tagged).toBe(1);
    });
  });
});
