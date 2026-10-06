import { readFileSync } from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from './documents.service';
import type { AuthUserRecord } from '../auth/auth.types';

/*
 * TD-204 - A DOCUMENT CARRIES ITS OWN "UPLOADED" AND "REVIEWED" DATES.
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

const theAgent = { id: AGENT_ID, name: 'Dates Agent', role: 'agent', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;
const theAdmin = { id: 1, name: 'Dates Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;
const pdf = { originalname: 'signed.pdf', buffer: Buffer.from('%PDF-1.4 td204'), size: 14, mimetype: 'application/pdf' };
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
const recent = (d: Date | null) => !!d && Math.abs(Date.now() - d.getTime()) < 120_000;
const row = (d: { id: number; title: string; mandatory: boolean; status: string; validation: string }, over: Record<string, unknown> = {}) =>
  ({ id: d.id, title: d.title, mandatory: d.mandatory, status: d.status, validation: d.validation, ...over });

describe('TD-204 - a document is dated when its file arrives and when it is reviewed', () => {
  it('an office upload records today as Uploaded, not the day the checklist row was made', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id);
      await serviceFor(tx).uploadFile(theAdmin as never, t.id, d.id, pdf as never);
      const after = await reread(tx, d.id);
      expect(recent(after.uploaded_at)).toBe(true);
      expect(after.created_at?.toISOString()).toBe(LONG_AGO.toISOString());
    });
  });

  it('choosing Valid records the review; a rename alone does not move it; back to Pending clears it', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id, { status: 'Received', file_path: 'x/1.pdf', file_name: 'one.pdf' });
      const svc = serviceFor(tx);

      await svc.bulkUpdate(theAdmin as never, t.id, { documents: [row(d, { validation: 'Valid' })] });
      const reviewed = await reread(tx, d.id);
      expect(recent(reviewed.reviewed_at)).toBe(true);

      const pinned = new Date('2026-09-20T15:00:00.000Z');
      await tx.documents.update({ where: { id: d.id }, data: { reviewed_at: pinned } });
      await svc.bulkUpdate(theAdmin as never, t.id, { documents: [row(reviewed, { title: 'Schedule B (signed)' })] });
      expect((await reread(tx, d.id)).reviewed_at?.toISOString()).toBe(pinned.toISOString());

      await svc.bulkUpdate(theAdmin as never, t.id, { documents: [row(await reread(tx, d.id), { validation: 'Pending' })] });
      expect((await reread(tx, d.id)).reviewed_at).toBeNull();
    });
  });

  it('an agent submission dates the new file and sends it back for review', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id, { reviewed_at: LONG_AGO });
      const svc = serviceFor(tx);
      await svc.uploadFile(theAgent as never, t.id, d.id, pdf as never);
      const draftId = JSON.parse((await reread(tx, d.id)).draft_files ?? '[]')[0].id;
      await svc.submitDrafts(theAgent as never, t.id, { draft_ids: [draftId] });
      const after = await reread(tx, d.id);
      expect(recent(after.uploaded_at)).toBe(true);
      expect(after.reviewed_at).toBeNull();
      expect(after.validation).toBe('Pending');
    });
  });

  it('removing the last per-client file leaves no upload date behind', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id, {
        title: "Client Photo ID's", status: 'Received', uploaded_at: LONG_AGO,
        files: JSON.stringify([{ client_name: null, file_name: 'id.pdf', file_path: 'x/id.pdf' }]),
      });
      await serviceFor(tx).deleteDocFile(theAdmin as never, t.id, d.id, 0);
      expect((await reread(tx, d.id)).uploaded_at).toBeNull();
    });
  });
});

describe('TD-204 - the documents already on file are dated from the history, or left blank', () => {
  const migration = readFileSync(path.join(__dirname, '../../prisma/migrations/20261006200000_document_upload_review_dates/migration.sql'), 'utf8');
  // The ALTER TABLE half has already run on this database; only the backfill is re-run here.
  const backfill = migration.replace(/--[^\n]*\n/g, '\n').split(';').map((s) => s.trim()).filter((s) => /^UPDATE/i.test(s));

  it('carries exactly two backfill statements', () => {
    expect(backfill).toHaveLength(2);
  });

  it('takes the latest upload, the matching review, and invents nothing', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const replaced = await doc(tx, t.id, { title: 'Agreement of Purchase and Sale (APS)', status: 'Received', file_path: 'x/a.pdf', file_name: 'a.pdf', validation: 'Valid' });
      const perClient = await doc(tx, t.id, { title: 'Fintrac', status: 'Received', files: JSON.stringify([{ client_name: 'Alex', file_name: 'f.pdf', file_path: 'x/f.pdf' }]) });
      const noHistory = await doc(tx, t.id, { title: 'Deposit Receipt', status: 'Received', file_path: 'x/d.pdf', file_name: 'd.pdf', validation: 'Valid' });
      const handTicked = await doc(tx, t.id, { title: 'Schedule A', status: 'Received', validation: 'Valid' });
      const log = (field: string, action: string, at: string, new_value: string | null = null) =>
        tx.audit_logs.create({ data: { transaction_id: t.id, field, action, new_value, section: 'Documents', created_at: new Date(at), updated_at: new Date(at) } });
      await log('Agreement of Purchase and Sale (APS)', 'Document uploaded', '2026-09-20T10:00:00Z');
      await log('Agreement of Purchase and Sale (APS)', 'Document replaced', '2026-09-28T10:33:00Z');
      await log('Agreement of Purchase and Sale (APS) — Validation', 'Updated', '2026-09-22T09:00:00Z', 'Invalid');
      await log('Agreement of Purchase and Sale (APS) — Validation', 'Updated', '2026-09-29T11:00:00Z', 'Valid');
      await log('Fintrac (Alex)', 'Document uploaded', '2026-09-25T14:00:00Z');
      await log('Schedule A — Validation', 'Updated', '2026-09-28T10:33:00Z', 'Pending');

      for (const sql of backfill) await tx.$executeRawUnsafe(sql);

      const a = await reread(tx, replaced.id);
      expect(a.uploaded_at?.toISOString()).toBe('2026-09-28T10:33:00.000Z');   // the file it holds now
      expect(a.reviewed_at?.toISOString()).toBe('2026-09-29T11:00:00.000Z');   // the review that made it Valid
      expect((await reread(tx, perClient.id)).uploaded_at?.toISOString()).toBe('2026-09-25T14:00:00.000Z');
      const n = await reread(tx, noHistory.id);
      expect(n.uploaded_at).toBeNull();                                         // no history: blank, not borrowed
      expect(n.reviewed_at).toBeNull();
      const h = await reread(tx, handTicked.id);
      expect(h.uploaded_at).toBeNull();                                         // nothing was ever uploaded
      expect(h.reviewed_at).toBeNull();                                         // the history says Pending, not Valid
    });
  });
});

describe('TD-204 - the reports read the document dates, not the row dates', () => {
  const src = (f: string) => readFileSync(path.join(__dirname, '../reports', f), 'utf8');

  it('the document report rows take Uploaded and Reviewed from the new columns', () => {
    const s = src('report-data.service.ts');
    expect(s).toContain('uploaded_at: dateStr(d.uploaded_at)');
    expect(s).toContain('reviewed_at: dateStr(d.reviewed_at)');
    expect(s).not.toMatch(/uploaded_at: dateStr\(d\.created_at\)|reviewed_at: dateStr\(d\.updated_at\)/);
  });

  it('the SQL paths agree with them', () => {
    const s = src('report-docs.sql.ts');
    expect(s).toContain('d.uploaded_at::date AS uploaded_at');
    expect(s).toContain('MAX(d.reviewed_at::date)');
    expect(s).not.toMatch(/d\.created_at::date AS uploaded_at|MAX\(d\.updated_at::date\)/);
  });
});
