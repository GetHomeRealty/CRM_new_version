import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from './documents.service';
import type { AuthUserRecord } from '../auth/auth.types';

/*
 * SHARED SET-UP COPIED FROM THE TD-204 SPEC. A DOCUMENT CARRIES ITS OWN "UPLOADED" AND "REVIEWED" DATES.
 *
 * The document reports used to show `created_at` as Uploaded and `updated_at` as Reviewed. The
 * first is when the checklist row was made, usually weeks before a file arrived; the second moves
 * on any change at all, a rename included. On the live system on 2026-10-06, 11 of the 22 uploads
 * that could be checked against the history showed the wrong date.
 *
 * These tests hold the four places the dates are written, the backfill that dated the documents
 * already on file, and the reports reading the new columns rather than the old ones.
 *
 * Real rows in a rolled-back transaction, the pattern the other document specs use.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const AGENT_ID = 990204;
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (String((e as Error).message).includes(ROLLBACK) === false) throw e;
  }
}

const theAdmin = { id: 1, name: 'Dates Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;
const LONG_AGO = new Date('2026-09-13T12:00:00.000Z');

function serviceFor(tx: PrismaService): DocumentsService {
  // The service opens its own transaction for agent submissions; inside this rolled-back one it
  // simply runs on the same connection.
  const db = new Proxy(tx as object, { get: (t, k) => (k === '$transaction' ? (fn: (x: unknown) => unknown) => fn(t) : (t as any)[k]) }) as PrismaService;
  const svc = new DocumentsService(
    {} as never, db,
    { record: async () => undefined } as never,
    { sync: async () => undefined } as never,
    {} as never, {} as never,
    { notifyUpload: async () => undefined, sendReviewOutcome: async () => undefined } as never,
  );
  // No file reaches the disk from a test.
  let n = 0;
  jest.spyOn(svc as any, 'storeFile').mockImplementation(async () => `td204/${++n}.pdf`);
  jest.spyOn(svc as any, 'deleteFile').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'notifyDealsDesk').mockResolvedValue(undefined);
  return svc;
}

async function deal(tx: PrismaService) {
  const now = new Date();
  return tx.transactions.create({ data: {
    trade_no: `TD204-${Date.now()}-${++seq}`, type: 'Residential Buying',
    agent: 'Dates Agent', agent_user_id: AGENT_ID, price: 500000,
    comm_type: '%', comm_value: 0, comm_pct: 2.5, comm_status: 'Pending', comm_paid_status: 'No',
    closing_date: new Date('2026-12-15T00:00:00.000Z'), offer_date: new Date('2026-09-01T00:00:00.000Z'),
    adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
  } });
}

const doc = (tx: PrismaService, txnId: number, over: Record<string, unknown> = {}) => tx.documents.create({ data: {
  transaction_id: txnId, title: 'Schedule B', mandatory: false, manual: true,
  status: 'Pending', validation: 'Pending', position: 1, created_at: LONG_AGO, updated_at: LONG_AGO, ...over,
} as never });

const reread = (tx: PrismaService, id: number) => tx.documents.findUniqueOrThrow({ where: { id } });


/*
 * TD-042 - deleting a client file at a position that holds nothing used to answer as if it had
 * worked. A single-file document has no client-file list at all, so the "delete" removed nothing
 * and reported success.
 */
describe('TD-042 - removing a file that is not there says so', () => {
  it('refuses on a single-file document, and its file is untouched', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id, { status: 'Received', file_path: 'x/one.pdf', file_name: 'one.pdf' });
      const err = await serviceFor(tx).deleteDocFile(theAdmin as never, t.id, d.id, 0).then(() => null, (e) => e);
      expect(String((err as Error)?.message ?? '')).toMatch(/single file/);
      const after = await reread(tx, d.id);
      expect(after.file_name).toBe('one.pdf');
      expect(after.status).toBe('Received');
    });
  });

  it('refuses a position past the end of a client-file list', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id, { title: "Client Photo ID's", status: 'Received', files: JSON.stringify([{ client_name: 'A', file_name: 'a.pdf', file_path: 'x/a.pdf' }]) });
      const err = await serviceFor(tx).deleteDocFile(theAdmin as never, t.id, d.id, 5).then(() => null, (e) => e);
      expect(String((err as Error)?.message ?? '')).toMatch(/no file at that position/);
      expect(JSON.parse((await reread(tx, d.id)).files ?? '[]')).toHaveLength(1);
    });
  });

  it('still removes a real client file, as before', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id, { title: "Client Photo ID's", status: 'Received', files: JSON.stringify([{ client_name: 'A', file_name: 'a.pdf', file_path: 'x/a.pdf' }]) });
      await serviceFor(tx).deleteDocFile(theAdmin as never, t.id, d.id, 0);
      expect(JSON.parse((await reread(tx, d.id)).files ?? '[]')).toHaveLength(0);
    });
  });
});
