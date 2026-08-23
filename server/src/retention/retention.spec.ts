import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RetentionService, RETENTION_MONTHS } from './retention.service';

/**
 * Six months of Transaction Desk, and not a row of the CRM's.
 *
 * A retention job is the one piece of this system that destroys data on a timer with nobody
 * watching, so the tests that matter are the ones about what it REFUSES to remove. Every case below
 * seeds a CRM row and a shared row alongside the Desk rows and asserts they survive.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 30000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const svc = (tx: PrismaService) => new RetentionService(tx, new AuditService(tx));

/** A date comfortably outside the window, and one comfortably inside it. */
const OLD = new Date(Date.now() - (RETENTION_MONTHS + 2) * 30 * 86400000);
const RECENT = new Date(Date.now() - 5 * 86400000);

/** One audit row per domain, old enough to be eligible, plus a recent Desk row. */
async function auditRows(tx: PrismaService) {
  const mk = (domain: string | null, created_at: Date) =>
    tx.audit_logs.create({ data: { domain, category: 'Probe', who: `probe ${++seq}`, action: 'Updated', created_at, updated_at: created_at } });
  return {
    deskOld: await mk('desk', OLD),
    deskRecent: await mk('desk', RECENT),
    crmOld: await mk('crm', OLD),
    commonOld: await mk('common', OLD),
    nullOld: await mk(null, OLD),
  };
}

describe('retention is a dry run until somebody says otherwise', () => {
  afterAll(async () => { await prisma.$disconnect(); });
  const was = process.env.DESK_RETENTION_ENABLED;
  afterEach(() => { if (was === undefined) delete process.env.DESK_RETENTION_ENABLED; else process.env.DESK_RETENTION_ENABLED = was; });

  it('deletes nothing when DESK_RETENTION_ENABLED is unset', async () => {
    delete process.env.DESK_RETENTION_ENABLED;
    await inRollback(async (tx) => {
      const { deskOld } = await auditRows(tx);
      const r = await svc(tx).sweep();

      expect(r.enabled).toBe(false);
      expect(r.counts.audit_logs_desk).toBeGreaterThan(0);   // it SAW the row
      expect(r.deleted.audit_logs_desk).toBe(0);             // and left it alone
      expect(await tx.audit_logs.findUnique({ where: { id: deskOld.id } })).not.toBeNull();
    });
  });

  it('deletes nothing for any value other than the literal true', async () => {
    for (const v of ['1', 'yes', 'TRUE', '']) {
      process.env.DESK_RETENTION_ENABLED = v;
      await inRollback(async (tx) => {
        const { deskOld } = await auditRows(tx);
        await svc(tx).sweep();
        expect(await tx.audit_logs.findUnique({ where: { id: deskOld.id } })).not.toBeNull();
      });
    }
  });

  it('plan() never writes, whatever the switch says', async () => {
    process.env.DESK_RETENTION_ENABLED = 'true';
    await inRollback(async (tx) => {
      const { deskOld } = await auditRows(tx);
      const plan = await svc(tx).plan();
      expect(plan.counts.audit_logs_desk).toBeGreaterThan(0);
      expect(await tx.audit_logs.findUnique({ where: { id: deskOld.id } })).not.toBeNull();
    });
  });
});

describe('retention removes the Transaction Desk past six months, and nothing else', () => {
  afterAll(async () => { await prisma.$disconnect(); });
  const was = process.env.DESK_RETENTION_ENABLED;
  beforeEach(() => { process.env.DESK_RETENTION_ENABLED = 'true'; });
  afterEach(() => { if (was === undefined) delete process.env.DESK_RETENTION_ENABLED; else process.env.DESK_RETENTION_ENABLED = was; });

  it('purges old DESK audit rows and spares crm, common and unclassified', async () => {
    await inRollback(async (tx) => {
      const { deskOld, deskRecent, crmOld, commonOld, nullOld } = await auditRows(tx);
      await svc(tx).sweep();

      const alive = async (id: number) => (await tx.audit_logs.findUnique({ where: { id } })) !== null;
      expect(await alive(deskOld.id)).toBe(false);      // eligible
      expect(await alive(deskRecent.id)).toBe(true);    // inside the window
      /*
       * The three that make this a Transaction Desk policy rather than a database-wide one.
       * `common` is Users and Company Settings; `null` pre-dates the area split and cannot be
       * attributed, and purging on "we cannot tell" is how the wrong history disappears.
       */
      expect(await alive(crmOld.id)).toBe(true);
      expect(await alive(commonOld.id)).toBe(true);
      expect(await alive(nullOld.id)).toBe(true);
    });
  });

  it('reports the excluded rows rather than merely not deleting them', async () => {
    await inRollback(async (tx) => {
      await auditRows(tx);
      const plan = await svc(tx).plan();
      // The plan is the staging artefact somebody signs off, so it has to show its own boundaries.
      expect(plan.excluded.audit_logs_crm).toBeGreaterThan(0);
      expect(plan.excluded.audit_logs_common).toBeGreaterThan(0);
      expect(plan.excluded.audit_logs_unclassified).toBeGreaterThan(0);
    });
  });

  it('empties the Recycle Bin past the window and leaves live records alone', async () => {
    await inRollback(async (tx) => {
      const n = ++seq;
      const live = await tx.transactions.create({
        data: { trade_no: `RT-live-${Date.now()}${n}`, type: 'Residential Buying', created_at: OLD, updated_at: OLD },
      });
      const trashedOld = await tx.transactions.create({
        data: { trade_no: `RT-old-${Date.now()}${n}`, type: 'Residential Buying', deleted_at: OLD, created_at: OLD, updated_at: OLD },
      });
      const trashedRecent = await tx.transactions.create({
        data: { trade_no: `RT-new-${Date.now()}${n}`, type: 'Residential Buying', deleted_at: RECENT, created_at: OLD, updated_at: OLD },
      });
      // A child, to prove the cascade rather than assume it.
      await tx.documents.create({ data: { transaction_id: trashedOld.id, title: 'APS', created_at: OLD, updated_at: OLD } });

      await svc(tx).sweep();

      const alive = async (id: number) => (await tx.transactions.findUnique({ where: { id } })) !== null;
      expect(await alive(trashedOld.id)).toBe(false);
      expect(await alive(trashedRecent.id)).toBe(true);  // deleted recently — still recoverable
      expect(await alive(live.id)).toBe(true);           // never deleted at all, however old
      expect(await tx.documents.count({ where: { transaction_id: trashedOld.id } })).toBe(0);
    });
  });

  it('never purges a live deal, however old it is', async () => {
    await inRollback(async (tx) => {
      const ancient = await tx.transactions.create({
        data: {
          trade_no: `RT-anc-${Date.now()}${++seq}`, type: 'Residential Buying',
          created_at: new Date('2019-01-01'), updated_at: new Date('2019-01-01'),
        },
      });
      await svc(tx).sweep();
      expect(await tx.transactions.findUnique({ where: { id: ancient.id } })).not.toBeNull();
    });
  });

  it('writes down what it removed', async () => {
    await inRollback(async (tx) => {
      await auditRows(tx);
      await svc(tx).sweep();
      const record = await tx.audit_logs.findFirst({
        where: { category: 'Retention' }, orderBy: { id: 'desc' },
      });
      expect(record).not.toBeNull();
      expect(record?.action).toBe('Records purged');
      // Filed as Desk, so the purge record is itself subject to the same six months.
      expect(record?.domain).toBe('desk');
      expect(record?.details).toMatch(/cutoff \d{4}-\d{2}-\d{2}/);
    });
  });

  it('puts the cutoff six months back, at midnight', async () => {
    const now = new Date('2026-08-14T15:22:11.000Z');
    const cut = svc(prisma as unknown as PrismaService).cutoff(now);
    expect(cut.getMonth()).toBe(new Date('2026-02-14').getMonth());
    expect(cut.getHours()).toBe(0);
    expect(cut.getMinutes()).toBe(0);
  });
});
