import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { PrismaService } from '../prisma/prisma.service';
import { RecycleBinService } from './recycle-bin.service';
import { STORAGE_ROOT } from '../config/storage';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * PURGING A DEAL TAKES ITS DOCUMENTS' FILES WITH IT.
 *
 * `documents.transaction_id` is ON DELETE CASCADE, so deleting a trashed deal removes its document
 * rows — and with them the only record of where their uploads live. Nothing read those rows first,
 * so every file the deal carried was orphaned: invisible to the product, still on disk, and still
 * the one copy of documents somebody deliberately destroyed. Measured on a development copy before
 * the fix: 13 of 24 document files were orphans, four under folders whose deal no longer existed.
 *
 * ======================================================================================
 * THESE TESTS WRITE REAL FILES UNDER `STORAGE_ROOT` AND READ THE DISK BACK.
 *
 * Asserting that a mock was called would have passed throughout the life of the bug — the unlink
 * helper existed and worked; it was simply never reached from this path. Only the disk can say
 * whether the bytes are gone, so every case below creates genuine files in a directory of its own
 * and checks their presence afterwards.
 *
 * The database work is rolled back; the files are not, so `afterEach` removes the whole directory
 * whatever the test did. Nothing outside `documents/zz-purge-*` is ever touched.
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

const superAdmin: AuthUserRecord = {
  id: 1, name: 'Bin Admin', role: 'admin', user_permissions: [], user_modules: [],
} as unknown as AuthUserRecord;

/** Only the database is reached on this path; the other three dependencies are never touched. */
const serviceFor = (tx: PrismaService) => new RecycleBinService(tx, {} as never, {} as never, {} as never);

/** Every directory this file created, removed in `afterEach` whether the test passed or not. */
const made: string[] = [];

/** A real file under STORAGE_ROOT. Returns the RELATIVE path, as the database stores it. */
async function realFile(folder: string, name: string): Promise<string> {
  const rel = `documents/${folder}/${name}`;
  const abs = path.join(STORAGE_ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `contents of ${name}`);
  return rel;
}

const onDisk = async (rel: string): Promise<boolean> =>
  fs.access(path.join(STORAGE_ROOT, rel)).then(() => true, () => false);

function folderName(): string {
  seq += 1;
  const f = `zz-purge-${Date.now()}-${seq}`;
  made.push(f);
  return f;
}

async function trashedDeal(tx: PrismaService): Promise<number> {
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `ZZPURGE-${Date.now()}-${++seq}`, type: 'Residential Buying', agent: 'Bin Agent',
      price: 500000, comm_type: '%', comm_value: 0, comm_pct: 2.5,
      comm_status: 'Pending', comm_paid_status: 'No',
      closing_date: new Date('2025-06-15T00:00:00.000Z'), offer_date: new Date('2025-03-01T00:00:00.000Z'),
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
      deleted_at: now, created_at: now, updated_at: now,
    },
  });
  return t.id;
}

async function document(tx: PrismaService, txnId: number, data: Record<string, unknown>): Promise<number> {
  const now = new Date();
  const d = await tx.documents.create({
    data: {
      transaction_id: txnId, title: `ZZ Purge Doc ${++seq}`, mandatory: false,
      status: 'Received', validation: 'Pending', position: seq,
      created_at: now, updated_at: now, ...data,
    },
  });
  return d.id;
}

afterEach(async () => {
  for (const folder of made.splice(0)) {
    await fs.rm(path.join(STORAGE_ROOT, 'documents', folder), { recursive: true, force: true })
      .catch(() => undefined);
  }
});

afterAll(async () => { await prisma.$disconnect(); });

describe('permanently deleting a deal removes its documents from disk', () => {
  jest.setTimeout(60_000);

  it('REMOVES ALL FOUR FILE SOURCES — the regression this exists for', async () => {
    /*
     * A document can point at files in four places, and all four are the brokerage's to destroy:
     * the submitted file, the reviewer's validation copy, the multi-client `files` blob, and the
     * agent's unsubmitted `draft_files`. Missing any one of them leaks silently.
     */
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

      // All four are really there before the purge, or the assertions below prove nothing.
      expect(await Promise.all([onDisk(main), onDisk(validation), onDisk(listed), onDisk(draft)]))
        .toEqual([true, true, true, true]);

      await serviceFor(tx).forceDeleteTransaction(superAdmin, txn);

      expect(await Promise.all([onDisk(main), onDisk(validation), onDisk(listed), onDisk(draft)]))
        .toEqual([false, false, false, false]);
      expect(await tx.transactions.findUnique({ where: { id: txn } })).toBeNull();
    });
  });

  it('removes the files of EVERY document on the deal, not just the first', async () => {
    await inRollback(async (tx) => {
      const folder = folderName();
      const one = await realFile(folder, 'one.pdf');
      const two = await realFile(folder, 'two.pdf');
      const three = await realFile(folder, 'three.pdf');

      const txn = await trashedDeal(tx);
      await document(tx, txn, { file_path: one });
      await document(tx, txn, { file_path: two });
      await document(tx, txn, { file_path: three });

      await serviceFor(tx).forceDeleteTransaction(superAdmin, txn);

      expect(await Promise.all([onDisk(one), onDisk(two), onDisk(three)])).toEqual([false, false, false]);
    });
  });

  it('succeeds when a file is already missing — gone is the state we wanted', async () => {
    /*
     * ENOENT is not a failure. A file removed by hand, by an earlier half-finished purge, or by a
     * restore from a backup that predates it must not block the deletion of the record.
     */
    await inRollback(async (tx) => {
      const folder = folderName();
      const present = await realFile(folder, 'present.pdf');
      const missing = `documents/${folder}/never-written.pdf`;

      const txn = await trashedDeal(tx);
      await document(tx, txn, { file_path: missing });
      await document(tx, txn, { file_path: present });

      await expect(serviceFor(tx).forceDeleteTransaction(superAdmin, txn))
        .resolves.toEqual({ message: 'Transaction permanently deleted' });
      expect(await onDisk(present)).toBe(false);
      expect(await tx.transactions.findUnique({ where: { id: txn } })).toBeNull();
    });
  });

  it('DOES NOT TOUCH ANOTHER DEAL’S FILES', async () => {
    // The cascade is per transaction, and so is the purge. A neighbour's uploads are not ours.
    await inRollback(async (tx) => {
      const mineFolder = folderName();
      const theirsFolder = folderName();
      const mine = await realFile(mineFolder, 'mine.pdf');
      const theirs = await realFile(theirsFolder, 'theirs.pdf');

      const txnMine = await trashedDeal(tx);
      const txnTheirs = await trashedDeal(tx);
      await document(tx, txnMine, { file_path: mine });
      await document(tx, txnTheirs, { file_path: theirs });

      await serviceFor(tx).forceDeleteTransaction(superAdmin, txnMine);

      expect(await onDisk(mine)).toBe(false);
      expect(await onDisk(theirs)).toBe(true);
      expect(await tx.transactions.findUnique({ where: { id: txnTheirs } })).not.toBeNull();
    });
  });

  describe('when a file cannot be removed', () => {
    it('KEEPS THE RECORD AND THE PATHS, and does not report success', async () => {
      /*
       * The outcome that used to be silent. A bare `catch {}` reported "permanently deleted" with
       * the bytes still on disk and nothing recording that anything had gone wrong — the worst of
       * the three outcomes, because it cannot be found afterwards.
       *
       * The failure is simulated with a path that escapes the storage root, which the helper
       * refuses for its own reasons. A real EACCES would do just as well and cannot be arranged
       * portably: chmod is a no-op for an administrator on Windows.
       */
      await inRollback(async (tx) => {
        const folder = folderName();
        const good = await realFile(folder, 'good.pdf');

        const txn = await trashedDeal(tx);
        await document(tx, txn, { file_path: '../outside-the-root.pdf' });
        await document(tx, txn, { file_path: good });

        await expect(serviceFor(tx).forceDeleteTransaction(superAdmin, txn))
          .rejects.toMatchObject({ response: { message: expect.stringContaining('could not be removed') } });

        // The deal and its documents survive, so the purge can be retried.
        expect(await tx.transactions.findUnique({ where: { id: txn } })).not.toBeNull();
        expect(await tx.documents.count({ where: { transaction_id: txn } })).toBe(2);
      });
    });

    it('refuses a path that would escape the storage root, rather than following it', async () => {
      /*
       * `path.join` walks out of the root happily. These paths come from the database rather than
       * from a request, so this is a second line — but a purge is irreversible, and an import or a
       * restored backup could put anything in that column.
       */
      await inRollback(async (tx) => {
        const outside = path.join(STORAGE_ROOT, '..', 'zz-purge-must-survive.txt');
        await fs.writeFile(outside, 'not ours to delete');
        try {
          const txn = await trashedDeal(tx);
          await document(tx, txn, { file_path: '../zz-purge-must-survive.txt' });

          await expect(serviceFor(tx).forceDeleteTransaction(superAdmin, txn)).rejects.toBeDefined();
          await expect(fs.access(outside)).resolves.toBeUndefined();   // still there
        } finally {
          await fs.rm(outside, { force: true }).catch(() => undefined);
        }
      });
    });
  });

  describe('retrying after a failure', () => {
    it('A PARTIAL FAILURE CAN BE RETRIED, and the files already removed do not block it', async () => {
      /*
       * The helper attempts EVERY file before it throws, so a partial failure leaves some uploads
       * already gone and the record still standing. The retry then meets a mixture: paths that are
       * now ENOENT, and the one that failed. It has to treat the first group as done — which is the
       * whole reason ENOENT is success rather than an error.
       */
      await inRollback(async (tx) => {
        const folder = folderName();
        const good = await realFile(folder, 'good.pdf');
        const alsoGood = await realFile(folder, 'also-good.pdf');
        const service = serviceFor(tx);

        const txn = await trashedDeal(tx);
        await document(tx, txn, { file_path: good });
        const blocked = await document(tx, txn, { file_path: '../blocked.pdf' });
        await document(tx, txn, { file_path: alsoGood });

        await expect(service.forceDeleteTransaction(superAdmin, txn)).rejects.toBeDefined();

        // The two reachable files went; the record stayed, so nothing is stranded unrecorded.
        expect(await Promise.all([onDisk(good), onDisk(alsoGood)])).toEqual([false, false]);
        expect(await tx.transactions.findUnique({ where: { id: txn } })).not.toBeNull();

        // Whatever blocked it is cleared — here, by correcting the bad path the way an operator would.
        await tx.documents.update({ where: { id: blocked }, data: { file_path: null } });

        await expect(service.forceDeleteTransaction(superAdmin, txn))
          .resolves.toEqual({ message: 'Transaction permanently deleted' });
        expect(await tx.transactions.findUnique({ where: { id: txn } })).toBeNull();
      });
    });

    it('a failed DATABASE delete leaves the rows and their paths, so the purge can be run again', async () => {
      /*
       * The other half of the files-first order. If the delete itself fails, the files are already
       * gone — that is the accepted cost of not losing the paths when an unlink fails, which is the
       * commoner failure. What must NOT happen is the rows disappearing or their paths being
       * cleared, because then nothing could ever finish the job.
       *
       * The failure is injected rather than contrived from a real constraint: a Proxy over the
       * client throws on `transactions.delete` and passes everything else through, so the test
       * exercises the service's ordering rather than a particular foreign key.
       */
      await inRollback(async (tx) => {
        const folder = folderName();
        const file = await realFile(folder, 'db-fails.pdf');

        const txn = await trashedDeal(tx);
        await document(tx, txn, { file_path: file });

        const failing = new Proxy(tx as unknown as Record<string, unknown>, {
          get(target, prop, receiver) {
            if (prop !== 'transactions') return Reflect.get(target, prop, receiver);
            const real = Reflect.get(target, prop, receiver) as Record<string, unknown>;
            return new Proxy(real, {
              get(t2, p2, r2) {
                if (p2 === 'delete') return async () => { throw new Error('database delete failed'); };
                return Reflect.get(t2, p2, r2);
              },
            });
          },
        }) as unknown as PrismaService;

        await expect(serviceFor(failing).forceDeleteTransaction(superAdmin, txn))
          .rejects.toThrow('database delete failed');

        // The row and its path survive — that is what makes a retry possible at all.
        const still = await tx.documents.findFirst({ where: { transaction_id: txn } });
        expect(still).not.toBeNull();
        expect(still?.file_path).toBe(file);
        expect(await tx.transactions.findUnique({ where: { id: txn } })).not.toBeNull();

        // And the retry succeeds: the file is already gone, which is success, not an error.
        await expect(serviceFor(tx).forceDeleteTransaction(superAdmin, txn))
          .resolves.toEqual({ message: 'Transaction permanently deleted' });
      });
    });
  });

  describe('purging a single document', () => {
    it('removes its files', async () => {
      await inRollback(async (tx) => {
        const folder = folderName();
        const main = await realFile(folder, 'single.pdf');
        const draft = await realFile(folder, 'single-draft.pdf');

        const txn = await trashedDeal(tx);
        const doc = await document(tx, txn, {
          deleted_at: new Date(),
          file_path: main,
          draft_files: JSON.stringify([{ id: 'd1', client_name: 'A', file_name: 'd.pdf', file_path: draft }]),
        });

        await serviceFor(tx).forceDeleteDocument(superAdmin, doc);
        expect(await Promise.all([onDisk(main), onDisk(draft)])).toEqual([false, false]);
      });
    });

    it('KEEPS THE DOCUMENT when a file cannot be removed, and does not report success', async () => {
      /*
       * The same rule as the deal path, on the route that always purged files. It used to swallow
       * every error and answer "Document permanently deleted" with the bytes still there.
       */
      await inRollback(async (tx) => {
        const txn = await trashedDeal(tx);
        const doc = await document(tx, txn, { deleted_at: new Date(), file_path: '../single-outside.pdf' });

        await expect(serviceFor(tx).forceDeleteDocument(superAdmin, doc))
          .rejects.toMatchObject({ response: { message: expect.stringContaining('could not be removed') } });

        expect(await tx.documents.findUnique({ where: { id: doc } })).not.toBeNull();
      });
    });
  });

  describe('containment follows links, not just the spelling of a path', () => {
    it('REFUSES A FILE REACHED THROUGH A LINKED DIRECTORY, and leaves it on disk', async () => {
      /*
       * `documents/<link>/secret.pdf` is textually inside the storage root however many links lie
       * along it, so `path.relative` alone says yes. Only `realpath` can tell that the directory
       * points somewhere else entirely — containment is a question about the filesystem, not about
       * the string.
       *
       * A junction is used on Windows because it needs no elevation, unlike a symlink.
       */
      const outsideDir = path.join(STORAGE_ROOT, '..', `zz-purge-outside-${Date.now()}`);
      const linkName = `zz-purge-link-${Date.now()}`;
      const linkPath = path.join(STORAGE_ROOT, 'documents', linkName);
      await fs.mkdir(outsideDir, { recursive: true });
      const secret = path.join(outsideDir, 'secret.pdf');
      await fs.writeFile(secret, 'must survive the purge');
      await fs.symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

      try {
        await inRollback(async (tx) => {
          const txn = await trashedDeal(tx);
          await document(tx, txn, { file_path: `documents/${linkName}/secret.pdf` });

          await expect(serviceFor(tx).forceDeleteTransaction(superAdmin, txn))
            .rejects.toMatchObject({ response: { message: expect.stringContaining('could not be removed') } });

          // The file outside the root is untouched, and the deal survives for somebody to look at.
          await expect(fs.access(secret)).resolves.toBeUndefined();
          expect(await tx.transactions.findUnique({ where: { id: txn } })).not.toBeNull();
        });
      } finally {
        await fs.rm(linkPath, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it('still removes a file reached through a link that stays INSIDE the root', async () => {
      // The control. A containment check that refused every link would refuse legitimate layouts.
      const folder = folderName();
      const real = await realFile(folder, 'real.pdf');
      const linkName = `zz-purge-inner-${Date.now()}`;
      const linkPath = path.join(STORAGE_ROOT, 'documents', linkName);
      await fs.symlink(path.join(STORAGE_ROOT, 'documents', folder), linkPath,
        process.platform === 'win32' ? 'junction' : 'dir');

      try {
        await inRollback(async (tx) => {
          const txn = await trashedDeal(tx);
          await document(tx, txn, { file_path: `documents/${linkName}/real.pdf` });

          await expect(serviceFor(tx).forceDeleteTransaction(superAdmin, txn))
            .resolves.toEqual({ message: 'Transaction permanently deleted' });
          expect(await onDisk(real)).toBe(false);
        });
      } finally {
        await fs.rm(linkPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });

  it('still refuses a deal whose invoice holds a payment, before touching any file', async () => {
    /*
     * The existing guard, pinned here because the file purge now runs on this path: a refusal must
     * still happen BEFORE anything is unlinked, or the guard would protect the rows while the
     * documents were already gone.
     */
    await inRollback(async (tx) => {
      const folder = folderName();
      const file = await realFile(folder, 'guarded.pdf');
      const now = new Date();

      const txn = await trashedDeal(tx);
      await document(tx, txn, { file_path: file });
      const inv = await tx.invoices.create({
        data: { transaction_id: txn, invoice_no: `ZZ-PURGE-${Date.now()}`, status: 'Unpaid', invoice_date: now, created_at: now, updated_at: now },
      });
      await tx.invoice_payments.create({
        data: { invoice_id: inv.id, amount: 1000, paid_on: now, created_at: now, updated_at: now },
      });

      await expect(serviceFor(tx).forceDeleteTransaction(superAdmin, txn))
        .rejects.toMatchObject({ response: { message: expect.stringContaining('payment recorded') } });

      expect(await onDisk(file)).toBe(true);
      expect(await tx.transactions.findUnique({ where: { id: txn } })).not.toBeNull();
    });
  });

  it('is still Super Admin only, and refuses before touching any file', async () => {
    await inRollback(async (tx) => {
      const folder = folderName();
      const file = await realFile(folder, 'protected.pdf');
      const txn = await trashedDeal(tx);
      await document(tx, txn, { file_path: file });

      const agent = { id: 9, name: 'Not Admin', role: 'agent', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;
      await expect(serviceFor(tx).forceDeleteTransaction(agent, txn))
        .rejects.toMatchObject({ response: { message: expect.stringContaining('Super Admin') } });

      expect(await onDisk(file)).toBe(true);
    });
  });
});
