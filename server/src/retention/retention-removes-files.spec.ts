import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RetentionService, RETENTION_MONTHS } from './retention.service';
import { STORAGE_ROOT } from '../config/storage';

/**
 * THE RETENTION SWEEP TAKES THE FILES WITH THE ROWS — ALL FOUR SOURCES.
 *
 * It already unlinked three of them. `draft_files` — the agent's unsubmitted uploads — was in
 * neither the query nor the cleanup, so every sweep deleted the rows that pointed at those files
 * and left the files behind: invisible to the product, still on disk, and still somebody's
 * identification documents.
 *
 * ======================================================================================
 * THESE TESTS WRITE REAL FILES UNDER `STORAGE_ROOT` AND READ THE DISK BACK, for the reason the
 * Recycle Bin's do: asserting that a helper was called would have passed throughout the life of
 * this bug. The helper existed and worked — `draft_files` simply never reached it.
 *
 * The database work is rolled back; files are not, so `afterEach` removes the directories whatever
 * the test did. Nothing outside `documents/zz-retain-*` is ever touched.
 * ======================================================================================
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

const svc = (tx: PrismaService) => new RetentionService(tx, new AuditService(tx));

/**
 * The same service with a batch of two, so a handful of rows spans several batches.
 *
 * The cursor only matters once there IS a second batch, and the interesting case — what happens to
 * the batches AFTER one that kept a record — cannot happen at all with the production batch of 500
 * unless a test seeds 500 deals. Shrinking the batch is the only way to reach that path in a test
 * that finishes.
 */
class SmallBatch extends RetentionService {
  protected readonly batchSize: number = 2;
}
const smallSvc = (tx: PrismaService) => new SmallBatch(tx, new AuditService(tx));

/** Comfortably outside the window, and comfortably inside it. */
const OLD = new Date(Date.now() - (RETENTION_MONTHS + 2) * 30 * 86400000);
const RECENT = new Date(Date.now() - 5 * 86400000);

const made: string[] = [];

async function realFile(folder: string, name: string): Promise<string> {
  const rel = `documents/${folder}/${name}`;
  const abs = path.join(STORAGE_ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `contents of ${name}`);
  return rel;
}

const onDisk = (rel: string): Promise<boolean> =>
  fs.access(path.join(STORAGE_ROOT, rel)).then(() => true, () => false);

/**
 * Every unlink the sweep attempts, counted per path.
 *
 * COUNTING REMOVALS IS NOT THE SAME AS COUNTING ATTEMPTS, and only the second can see duplicate
 * processing. A record visited twice is unlinked twice — the first call removes the file and the
 * second returns ENOENT, which `files_removed` deliberately does not count. So the result object
 * looks identical whether a record was processed once or five times; the spy is what tells them
 * apart.
 */
function countUnlinks(): { per: Map<string, number>; restore: () => void } {
  const per = new Map<string, number>();
  const real = fs.unlink.bind(fs);
  const spy = jest.spyOn(fs, 'unlink').mockImplementation(async (p) => {
    const name = path.basename(String(p));
    per.set(name, (per.get(name) ?? 0) + 1);
    return real(p as string);
  });
  return { per, restore: () => spy.mockRestore() };
}

function folderName(): string {
  seq += 1;
  const f = `zz-retain-${Date.now()}-${seq}`;
  made.push(f);
  return f;
}

/** A trashed deal, old enough to be eligible unless `deletedAt` says otherwise. */
async function trashedDeal(tx: PrismaService, deletedAt: Date = OLD): Promise<number> {
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `ZZRET-${Date.now()}-${++seq}`, type: 'Residential Buying', agent: 'Retention Agent',
      price: 500000, comm_type: '%', comm_value: 0, comm_pct: 2.5,
      comm_status: 'Pending', comm_paid_status: 'No',
      closing_date: new Date('2025-06-15T00:00:00.000Z'), offer_date: new Date('2025-03-01T00:00:00.000Z'),
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
      deleted_at: deletedAt, created_at: now, updated_at: now,
    },
  });
  return t.id;
}

async function document(tx: PrismaService, txnId: number, data: Record<string, unknown>): Promise<number> {
  const now = new Date();
  const d = await tx.documents.create({
    data: {
      transaction_id: txnId, title: `ZZ Retain Doc ${++seq}`, mandatory: false,
      status: 'Received', validation: 'Pending', position: seq,
      created_at: now, updated_at: now, ...data,
    },
  });
  return d.id;
}

const enabled = process.env.DESK_RETENTION_ENABLED;
beforeEach(() => { process.env.DESK_RETENTION_ENABLED = 'true'; });
afterEach(async () => {
  // The switch is restored exactly as it was found — this suite must not leave it on.
  if (enabled === undefined) delete process.env.DESK_RETENTION_ENABLED;
  else process.env.DESK_RETENTION_ENABLED = enabled;

  for (const folder of made.splice(0)) {
    await fs.rm(path.join(STORAGE_ROOT, 'documents', folder), { recursive: true, force: true })
      .catch(() => undefined);
  }
});

afterAll(async () => { await prisma.$disconnect(); });

describe('the retention sweep removes every file a document points at', () => {
  jest.setTimeout(60_000);

  it('REMOVES DRAFT UPLOADS TOO — the leak this exists for', async () => {
    await inRollback(async (tx) => {
      const folder = folderName();
      const main = await realFile(folder, 'main.pdf');
      const validation = await realFile(folder, 'validation.pdf');
      const listed = await realFile(folder, 'listed.pdf');
      const draft = await realFile(folder, 'draft.pdf');

      const txn = await trashedDeal(tx);
      await document(tx, txn, {
        file_path: main,
        validation_file_path: validation,
        files: JSON.stringify([{ client_name: 'A', file_name: 'listed.pdf', file_path: listed }]),
        draft_files: JSON.stringify([{ id: 'd1', client_name: 'A', file_name: 'draft.pdf', file_path: draft }]),
      });

      const r = await svc(tx).sweep();

      expect(await Promise.all([onDisk(main), onDisk(validation), onDisk(listed), onDisk(draft)]))
        .toEqual([false, false, false, false]);
      expect(r.files_removed).toBeGreaterThanOrEqual(4);
      expect(r.files_failed).toBe(0);
      expect(await tx.transactions.findUnique({ where: { id: txn } })).toBeNull();
    });
  });

  it('removes draft uploads on a document trashed on its own, with its deal still live', async () => {
    // The second path. A document deleted by itself never reaches the transaction sweep.
    await inRollback(async (tx) => {
      const folder = folderName();
      const draft = await realFile(folder, 'lone-draft.pdf');

      const live = await trashedDeal(tx, RECENT);
      await tx.transactions.update({ where: { id: live }, data: { deleted_at: null } });
      const doc = await document(tx, live, {
        deleted_at: OLD,
        draft_files: JSON.stringify([{ id: 'd1', client_name: 'A', file_name: 'd.pdf', file_path: draft }]),
      });

      const r = await svc(tx).sweep();

      expect(await onDisk(draft)).toBe(false);
      expect(r.files_failed).toBe(0);
      expect(await tx.documents.findUnique({ where: { id: doc } })).toBeNull();
      expect(await tx.transactions.findUnique({ where: { id: live } })).not.toBeNull();
    });
  });

  it('counts a missing file as done, without counting it as removed', async () => {
    /*
     * ENOENT is the state the sweep wanted. It must not fail, and it must not inflate
     * `files_removed` either — a counter that counted absences would report work never done.
     */
    await inRollback(async (tx) => {
      const folder = folderName();
      const present = await realFile(folder, 'present.pdf');

      const txn = await trashedDeal(tx);
      await document(tx, txn, { file_path: `documents/${folder}/never-written.pdf` });
      await document(tx, txn, { file_path: present });

      const r = await svc(tx).sweep();

      expect(r.files_removed).toBe(1);
      expect(r.files_failed).toBe(0);
      expect(await tx.transactions.findUnique({ where: { id: txn } })).toBeNull();
    });
  });

  describe('when a file cannot be removed', () => {
    it('KEEPS THAT RECORD AND ITS PATHS, and still purges the others', async () => {
      /*
       * A sweep must not be all-or-nothing. One unreachable file costs its own record — which stays
       * eligible for the next pass, with its paths intact — and every other record still goes.
       */
      await inRollback(async (tx) => {
        const folder = folderName();
        const fine = await realFile(folder, 'fine.pdf');

        const blocked = await trashedDeal(tx);
        await document(tx, blocked, { file_path: '../retention-outside.pdf' });
        const clean = await trashedDeal(tx);
        await document(tx, clean, { file_path: fine });

        const r = await svc(tx).sweep();

        expect(r.files_failed).toBe(1);
        expect(r.records_retained).toBe(1);
        expect(await onDisk(fine)).toBe(false);

        // The blocked deal survives with its path, so the next sweep can try again.
        const kept = await tx.documents.findFirst({ where: { transaction_id: blocked } });
        expect(kept?.file_path).toBe('../retention-outside.pdf');
        expect(await tx.transactions.findUnique({ where: { id: blocked } })).not.toBeNull();
        expect(await tx.transactions.findUnique({ where: { id: clean } })).toBeNull();
      });
    });

    it('RETRIES SUCCESSFULLY once the obstruction is cleared, and terminates rather than looping', async () => {
      /*
       * A retained record still matches the eligibility query, so a sweep that re-queried from the
       * start would fetch it for ever. The cursor steps past it — and once the path is corrected,
       * the next sweep finishes the job.
       */
      await inRollback(async (tx) => {
        const txn = await trashedDeal(tx);
        const doc = await document(tx, txn, { file_path: '../retention-retry.pdf' });

        const first = await svc(tx).sweep();
        expect(first.records_retained).toBe(1);
        expect(await tx.transactions.findUnique({ where: { id: txn } })).not.toBeNull();

        await tx.documents.update({ where: { id: doc }, data: { file_path: null } });

        const second = await svc(tx).sweep();
        expect(second.files_failed).toBe(0);
        expect(await tx.transactions.findUnique({ where: { id: txn } })).toBeNull();
      });
    });
  });

  describe('containment follows links, not just the spelling of a path', () => {
    it('REFUSES A FILE REACHED THROUGH A LINKED DIRECTORY, and keeps the record', async () => {
      const outsideDir = path.join(STORAGE_ROOT, '..', `zz-retain-outside-${Date.now()}`);
      const linkName = `zz-retain-link-${Date.now()}`;
      const linkPath = path.join(STORAGE_ROOT, 'documents', linkName);
      await fs.mkdir(outsideDir, { recursive: true });
      const secret = path.join(outsideDir, 'secret.pdf');
      await fs.writeFile(secret, 'must survive the sweep');
      await fs.symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

      try {
        await inRollback(async (tx) => {
          const txn = await trashedDeal(tx);
          await document(tx, txn, { file_path: `documents/${linkName}/secret.pdf` });

          const r = await svc(tx).sweep();

          expect(r.files_failed).toBe(1);
          await expect(fs.access(secret)).resolves.toBeUndefined();
          expect(await tx.transactions.findUnique({ where: { id: txn } })).not.toBeNull();
        });
      } finally {
        await fs.rm(linkPath, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it('still removes a file reached through a link that stays INSIDE the root', async () => {
      // The control: a check that refused every link would refuse legitimate storage layouts.
      const folder = folderName();
      const real = await realFile(folder, 'real.pdf');
      const linkName = `zz-retain-inner-${Date.now()}`;
      const linkPath = path.join(STORAGE_ROOT, 'documents', linkName);
      await fs.symlink(path.join(STORAGE_ROOT, 'documents', folder), linkPath,
        process.platform === 'win32' ? 'junction' : 'dir');

      try {
        await inRollback(async (tx) => {
          const txn = await trashedDeal(tx);
          await document(tx, txn, { file_path: `documents/${linkName}/real.pdf` });

          const r = await svc(tx).sweep();
          expect(r.files_failed).toBe(0);
          expect(await onDisk(real)).toBe(false);
        });
      } finally {
        await fs.rm(linkPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });

  describe('across several batches', () => {
    /*
     * ================================================================================================
     * A RETAINED RECORD STILL MATCHES THE ELIGIBILITY QUERY.
     *
     * That is the whole hazard. A sweep that re-queried from the start would fetch the kept record
     * again on the next pass of the loop, keep it again, and never terminate — and the records
     * behind it would never be reached. The cursor steps past the last row SCANNED, not the last
     * row deleted, which is why it is advanced before anything is purged.
     *
     * These run with a batch of two so five deals span three batches and the blocked one sits in
     * the first, leaving two whole batches behind it.
     * ================================================================================================
     */

    it('AN EARLY FAILURE DOES NOT LOOP, SKIP LATER RECORDS, OR REPEAT THEM', async () => {
      await inRollback(async (tx) => {
        const folder = folderName();
        const deals: number[] = [];
        const files: string[] = [];

        // The first is blocked; the four behind it are ordinary and must all be purged.
        const blocked = await trashedDeal(tx);
        await document(tx, blocked, { file_path: '../retention-batch-blocked.pdf' });
        deals.push(blocked);

        for (let i = 0; i < 4; i += 1) {
          const id = await trashedDeal(tx);
          const f = await realFile(folder, `batch-${i}.pdf`);
          await document(tx, id, { file_path: f });
          deals.push(id);
          files.push(f);
        }

        const attempts = countUnlinks();
        let r;
        try { r = await smallSvc(tx).sweep(); } finally { attempts.restore(); }

        // Terminated, and reached every batch behind the blocked one.
        expect(r.records_retained).toBe(1);
        expect(r.files_failed).toBe(1);
        expect(await Promise.all(files.map(onDisk))).toEqual([false, false, false, false]);
        expect(r.files_removed).toBe(4);

        /*
         * EACH FILE ATTEMPTED EXACTLY ONCE — the direct test for duplicate processing. `>1` means
         * a record was visited twice; `0` means it was skipped. Neither is visible in the counters,
         * because a second visit finds the file already gone and is not counted as a removal.
         */
        for (let i = 0; i < 4; i += 1) {
          expect({ file: `batch-${i}.pdf`, attempts: attempts.per.get(`batch-${i}.pdf`) })
            .toEqual({ file: `batch-${i}.pdf`, attempts: 1 });
        }

        expect(await tx.transactions.findUnique({ where: { id: blocked } })).not.toBeNull();
        for (const id of deals.slice(1)) {
          expect(await tx.transactions.findUnique({ where: { id } })).toBeNull();
        }
      });
    });

    it('the same holds for documents trashed on their own', async () => {
      await inRollback(async (tx) => {
        const folder = folderName();
        const live = await trashedDeal(tx, RECENT);
        await tx.transactions.update({ where: { id: live }, data: { deleted_at: null } });

        const blocked = await document(tx, live, { deleted_at: OLD, file_path: '../retention-doc-blocked.pdf' });
        const docs: number[] = [];
        const files: string[] = [];
        for (let i = 0; i < 4; i += 1) {
          const f = await realFile(folder, `doc-batch-${i}.pdf`);
          docs.push(await document(tx, live, { deleted_at: OLD, file_path: f }));
          files.push(f);
        }

        const attempts = countUnlinks();
        let r;
        try { r = await smallSvc(tx).sweep(); } finally { attempts.restore(); }

        expect(r.records_retained).toBe(1);
        expect(r.files_removed).toBe(4);
        expect(await Promise.all(files.map(onDisk))).toEqual([false, false, false, false]);
        for (let i = 0; i < 4; i += 1) {
          expect({ file: `doc-batch-${i}.pdf`, attempts: attempts.per.get(`doc-batch-${i}.pdf`) })
            .toEqual({ file: `doc-batch-${i}.pdf`, attempts: 1 });
        }
        expect(await tx.documents.findUnique({ where: { id: blocked } })).not.toBeNull();
        for (const id of docs) expect(await tx.documents.findUnique({ where: { id } })).toBeNull();
      });
    });

    it('a failure in a LATER batch still leaves the earlier batches purged', async () => {
      // The mirror image, so the cursor is not merely tolerating a failure in the first batch.
      await inRollback(async (tx) => {
        const folder = folderName();
        const early: number[] = [];
        const files: string[] = [];
        for (let i = 0; i < 4; i += 1) {
          const id = await trashedDeal(tx);
          const f = await realFile(folder, `late-${i}.pdf`);
          await document(tx, id, { file_path: f });
          early.push(id);
          files.push(f);
        }
        const blocked = await trashedDeal(tx);
        await document(tx, blocked, { file_path: '../retention-late-blocked.pdf' });

        const r = await smallSvc(tx).sweep();

        expect(r.records_retained).toBe(1);
        expect(r.files_removed).toBe(4);
        for (const id of early) expect(await tx.transactions.findUnique({ where: { id } })).toBeNull();
        expect(await tx.transactions.findUnique({ where: { id: blocked } })).not.toBeNull();
      });
    });
  });

  describe('when the database delete fails after the files are gone', () => {
    /**
     * A client that refuses a model's deletes. `many` alone fails the batch statement and leaves
     * the per-row fallback working; `all` refuses both, standing in for a row the database will
     * not part with however it is asked.
     */
    const refusingDeletes = (tx: PrismaService, model: string, scope: 'many' | 'all'): PrismaService =>
      new Proxy(tx as unknown as Record<string, unknown>, {
        get(target, prop, receiver) {
          if (prop !== model) return Reflect.get(target, prop, receiver);
          const real = Reflect.get(target, prop, receiver) as Record<string, unknown>;
          return new Proxy(real, {
            get(t2, p2, r2) {
              if (p2 === 'deleteMany') return async () => { throw new Error('batch delete failed'); };
              if (p2 === 'delete' && scope === 'all') return async () => { throw new Error('row delete failed'); };
              return Reflect.get(t2, p2, r2);
            },
          });
        },
      }) as unknown as PrismaService;

    it('A BATCH FAILURE COSTS NOTHING — the rows go one at a time instead', async () => {
      /*
       * `deleteMany` is all or nothing, so one row the database refuses used to take its whole
       * batch with it. The fallback means a batch statement failing is a performance event, not a
       * correctness one.
       */
      await inRollback(async (tx) => {
        const folder = folderName();
        const ids: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          const id = await trashedDeal(tx);
          await document(tx, id, { file_path: await realFile(folder, `batchfail-${i}.pdf`) });
          ids.push(id);
        }

        const r = await svc(refusingDeletes(tx, 'transactions', 'many')).sweep();

        expect(r.delete_failures).toBe(0);
        expect(r.deleted.trashed_transactions).toBe(3);
        for (const id of ids) expect(await tx.transactions.findUnique({ where: { id } })).toBeNull();
      });
    });

    it('AN EARLY DELETE FAILURE RETAINS THAT RECORD AND THE SWEEP CARRIES ON', async () => {
      /*
       * The case this follow-up is for. One undeletable deal must not abort the pass: it is kept
       * with its paths, counted, and every later eligible record is still purged.
       *
       * Only the first deal is refused — by id, so the rest take the ordinary route.
       */
      await inRollback(async (tx) => {
        const folder = folderName();
        const stubborn = await trashedDeal(tx);
        const stubbornFile = await realFile(folder, 'stubborn.pdf');
        await document(tx, stubborn, { file_path: stubbornFile });

        const later: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          const id = await trashedDeal(tx);
          await document(tx, id, { file_path: await realFile(folder, `later-${i}.pdf`) });
          later.push(id);
        }

        const onlyStubborn = new Proxy(tx as unknown as Record<string, unknown>, {
          get(target, prop, receiver) {
            if (prop !== 'transactions') return Reflect.get(target, prop, receiver);
            const real = Reflect.get(target, prop, receiver) as Record<string, unknown>;
            return new Proxy(real, {
              get(t2, p2, r2) {
                if (p2 === 'deleteMany') return async () => { throw new Error('batch delete failed'); };
                if (p2 === 'delete') {
                  return async (args: { where: { id: number } }) => {
                    if (args.where.id === stubborn) throw new Error('row delete failed');
                    return (Reflect.get(t2, 'delete', r2) as (a: unknown) => Promise<unknown>)(args);
                  };
                }
                return Reflect.get(t2, p2, r2);
              },
            });
          },
        }) as unknown as PrismaService;

        const r = await svc(onlyStubborn).sweep();

        // Reported, not swallowed, and separated from the file-level count.
        expect(r.delete_failures).toBe(1);
        expect(r.records_retained).toBe(1);
        expect(r.files_failed).toBe(0);
        expect(r.deleted.trashed_transactions).toBe(3);

        // The stubborn one survives WITH its path; the rest are gone.
        const kept = await tx.documents.findFirst({ where: { transaction_id: stubborn } });
        expect(kept?.file_path).toBe(stubbornFile);
        expect(await tx.transactions.findUnique({ where: { id: stubborn } })).not.toBeNull();
        for (const id of later) expect(await tx.transactions.findUnique({ where: { id } })).toBeNull();
      });
    });

    it('the retry succeeds once the database will part with it, counting no phantom removal', async () => {
      await inRollback(async (tx) => {
        const folder = folderName();
        const file = await realFile(folder, 'retry-me.pdf');
        const txn = await trashedDeal(tx);
        await document(tx, txn, { file_path: file });

        const first = await svc(refusingDeletes(tx, 'transactions', 'all')).sweep();
        expect(first.delete_failures).toBe(1);
        expect(first.deleted.trashed_transactions).toBe(0);
        expect(await onDisk(file)).toBe(false);      // files-first: the unlink did happen

        const second = await svc(tx).sweep();
        expect(second.delete_failures).toBe(0);
        expect(second.files_failed).toBe(0);
        expect(second.files_removed).toBe(0);        // already gone is not a removal
        expect(second.deleted.trashed_transactions).toBe(1);
        expect(await tx.transactions.findUnique({ where: { id: txn } })).toBeNull();
      });
    });

    it('a refused document delete behaves the same way', async () => {
      await inRollback(async (tx) => {
        const folder = folderName();
        const file = await realFile(folder, 'doc-refused.pdf');
        const live = await trashedDeal(tx, RECENT);
        await tx.transactions.update({ where: { id: live }, data: { deleted_at: null } });
        const doc = await document(tx, live, { deleted_at: OLD, file_path: file });

        const r = await svc(refusingDeletes(tx, 'documents', 'all')).sweep();

        expect(r.delete_failures).toBe(1);
        expect(r.records_retained).toBe(1);
        const kept = await tx.documents.findUnique({ where: { id: doc } });
        expect(kept?.file_path).toBe(file);
      });
    });
  });

  describe('a broader failure', () => {
    it('ABORTS, BUT SAYS WHAT IT HAD ALREADY DONE', async () => {
      /*
       * Something that is not record-level — a lost connection, a statement timeout. The error
       * belongs to the scheduler, so it is re-thrown; what must not happen is the counts dying
       * with it, leaving a log that cannot distinguish a sweep that did nothing from one that did
       * almost everything.
       */
      await inRollback(async (tx) => {
        const folder = folderName();
        const file = await realFile(folder, 'before-the-fall.pdf');
        const txn = await trashedDeal(tx);
        await document(tx, txn, { file_path: file });

        // The deals pass completes; the invoices pass that follows it does not.
        const brokenLater = new Proxy(tx as unknown as Record<string, unknown>, {
          get(target, prop, receiver) {
            if (prop !== 'invoices') return Reflect.get(target, prop, receiver);
            const real = Reflect.get(target, prop, receiver) as Record<string, unknown>;
            return new Proxy(real, {
              get(t2, p2, r2) {
                if (p2 === 'findMany') return async () => { throw new Error('connection lost'); };
                return Reflect.get(t2, p2, r2);
              },
            });
          },
        }) as unknown as PrismaService;

        const service = svc(brokenLater);
        const logged: string[] = [];
        const spy = jest.spyOn((service as unknown as { log: { error: (m: string) => void } }).log, 'error')
          .mockImplementation((m: string) => { logged.push(String(m)); });

        try {
          await expect(service.sweep()).rejects.toThrow('connection lost');
        } finally {
          spy.mockRestore();
        }

        // The work already done is named in the abort log, not lost with the exception.
        expect(logged.join(' ')).toMatch(/ABORTED/);
        expect(logged.join(' ')).toMatch(/connection lost/);
        expect(logged.join(' ')).toMatch(/Completed before it stopped: .*1 file\(s\)/);
        expect(await onDisk(file)).toBe(false);
      });
    });
  });

  it('LEAVES AN INELIGIBLE RECORD AND ITS FILES ALONE', async () => {
    /*
     * The eligibility rules are untouched by this change, and this is the assertion that says so:
     * a deal trashed recently, and a LIVE deal, keep both their rows and their files.
     */
    await inRollback(async (tx) => {
      const folder = folderName();
      const recentFile = await realFile(folder, 'recent.pdf');
      const liveFile = await realFile(folder, 'live.pdf');

      const recent = await trashedDeal(tx, RECENT);
      await document(tx, recent, { file_path: recentFile });
      const live = await trashedDeal(tx, RECENT);
      await tx.transactions.update({ where: { id: live }, data: { deleted_at: null } });
      await document(tx, live, { file_path: liveFile });

      await svc(tx).sweep();

      expect(await Promise.all([onDisk(recentFile), onDisk(liveFile)])).toEqual([true, true]);
      expect(await tx.transactions.findUnique({ where: { id: recent } })).not.toBeNull();
      expect(await tx.transactions.findUnique({ where: { id: live } })).not.toBeNull();
    });
  });

  describe('dry run', () => {
    it('DELETES NEITHER FILES NOR ROWS when the switch is off', async () => {
      /*
       * The safety property the whole module rests on. Adding file handling to the sweep must not
       * move any of it above the `enabled` gate.
       */
      delete process.env.DESK_RETENTION_ENABLED;
      await inRollback(async (tx) => {
        const folder = folderName();
        const main = await realFile(folder, 'dry-main.pdf');
        const draft = await realFile(folder, 'dry-draft.pdf');

        const txn = await trashedDeal(tx);
        await document(tx, txn, {
          file_path: main,
          draft_files: JSON.stringify([{ id: 'd1', client_name: 'A', file_name: 'd.pdf', file_path: draft }]),
        });

        const r = await svc(tx).sweep();

        expect(r.enabled).toBe(false);
        expect(r.files_removed).toBe(0);
        expect(r.files_failed).toBe(0);
        expect(await Promise.all([onDisk(main), onDisk(draft)])).toEqual([true, true]);
        expect(await tx.transactions.findUnique({ where: { id: txn } })).not.toBeNull();
      });
    });

    it('plan() counts without touching a single file', async () => {
      await inRollback(async (tx) => {
        const folder = folderName();
        const main = await realFile(folder, 'plan-main.pdf');
        const txn = await trashedDeal(tx);
        await document(tx, txn, { file_path: main });

        const plan = await svc(tx).plan();

        expect(plan.counts.trashed_transactions).toBeGreaterThanOrEqual(1);
        expect(await onDisk(main)).toBe(true);
        expect(await tx.transactions.findUnique({ where: { id: txn } })).not.toBeNull();
      });
    });
  });
});
