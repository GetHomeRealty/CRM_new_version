import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AccountingReadOnlyGuard } from './accounting-readonly.guard';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import type { AuthUserRecord } from '../auth/auth.types';

// The controller is imported only for its route handlers' metadata; its ZIP helper loads an ESM-only
// package jest cannot parse, and nothing here builds a ZIP.
jest.mock('../common/archive', () => ({ createZip: jest.fn() }));

/**
 * ACCOUNTING ADDS DOCUMENTS AND FILES, AND CHANGES NOTHING ELSE (brokerage request, 2026-10-22).
 *
 * Until then the role was read-only on documents (2026-10-13). Now it may add a document to the
 * list and upload into an empty one; it still may not replace a file, delete anything, or change a
 * document's status, validation, remarks or reminders. These cases hold the line on the server,
 * which is what a request actually reaches; the screen only mirrors them.
 */

const guard = new AccountingReadOnlyGuard(new Reflector());
type Handler = (...args: never[]) => unknown;
const proto = DocumentsController.prototype as unknown as Record<string, Handler>;
const ctx = (method: string, role: string, handler: Handler): ExecutionContext => ({
  switchToHttp: () => ({ getRequest: () => ({ method, authUser: { role } }) }),
  getHandler: () => handler,
  getClass: () => DocumentsController,
}) as unknown as ExecutionContext;

describe('which document routes Accounting may write through', () => {
  it('SAVING THE LIST and the two UPLOADS are open to Accounting', () => {
    expect(guard.canActivate(ctx('PUT', 'accounting', proto.bulkUpdate))).toBe(true);
    expect(guard.canActivate(ctx('POST', 'accounting', proto.uploadFile))).toBe(true);
    expect(guard.canActivate(ctx('POST', 'accounting', proto.uploadDocFile))).toBe(true);
  });

  it('EVERY OTHER WRITE is still refused — deletes, validation files, reminders, drafts', () => {
    for (const [method, name] of [
      ['DELETE', 'deleteDocFile'], ['POST', 'uploadValidationFile'], ['DELETE', 'deleteValidationFile'],
      ['POST', 'sendReminders'], ['POST', 'replaceDraft'],
    ] as const) {
      expect(proto[name]).toBeDefined();
      expect(() => guard.canActivate(ctx(method, 'accounting', proto[name]))).toThrow(ForbiddenException);
    }
  });

  it('reads stay open, and other roles are not this guard\'s business', () => {
    expect(guard.canActivate(ctx('GET', 'accounting', proto.deleteDocFile))).toBe(true);
    expect(guard.canActivate(ctx('DELETE', 'documentation', proto.deleteDocFile))).toBe(true);
  });
});

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const accountant = { id: 990101, name: 'ZZ Accounts', role: 'accounting', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;
const serviceFor = (tx: PrismaService) => new DocumentsService(
  {} as never, tx,
  { record: async () => undefined } as never,
  { sync: async () => undefined } as never,
  {} as never, {} as never, {} as never,
);

async function deal(tx: PrismaService) {
  const now = new Date();
  return tx.transactions.create({ data: {
    trade_no: `ACCDOC-${Date.now()}-${++seq}`, type: 'Residential Buying', agent: 'ZZ Agent', price: 500000,
    adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
  } });
}

describe('what an Accounting save and upload may do', () => {
  jest.setTimeout(60_000);

  it('A SAVE ADDS THE NEW ROW and leaves every stored row exactly as it was', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const now = new Date();
      const kept = await tx.documents.create({ data: {
        transaction_id: t.id, title: 'ZZ Stored doc', mandatory: true, manual: false, status: 'Received', validation: 'Pending',
        remarks: 'as it was', position: 1, created_at: now, updated_at: now,
      } as never });
      const other = await tx.documents.create({ data: {
        transaction_id: t.id, title: 'ZZ Other doc', mandatory: false, manual: true, status: 'Pending', validation: 'Pending', position: 2, created_at: now, updated_at: now,
      } as never });

      // The screen sends the whole list: one row changed, one row missing, one row new.
      await serviceFor(tx).bulkUpdate(accountant, t.id, { documents: [
        { id: kept.id, title: 'ZZ Stored doc', mandatory: false, status: 'Pending', validation: 'Valid', remarks: 'changed', reminder: true },
        { title: 'ZZ Added by accounts' },
      ] });

      const after = await tx.documents.findUniqueOrThrow({ where: { id: kept.id } });
      expect([after.mandatory, after.status, after.validation, after.remarks]).toEqual([true, 'Received', 'Pending', 'as it was']);
      expect((await tx.documents.findUniqueOrThrow({ where: { id: other.id } })).deleted_at).toBeNull();
      const added = await tx.documents.findFirst({ where: { transaction_id: t.id, title: 'ZZ Added by accounts', deleted_at: null } });
      expect([added?.manual, added?.status, added?.mandatory]).toEqual([true, 'Pending', false]);
    });
  });

  it('AN UPLOAD OVER AN EXISTING FILE is refused before anything is stored', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const now = new Date();
      const d = await tx.documents.create({ data: {
        transaction_id: t.id, title: 'ZZ Has a file', mandatory: false, manual: true, status: 'Received', validation: 'Pending',
        file_name: 'old.pdf', file_path: 'documents/zz-old.pdf', position: 1, created_at: now, updated_at: now,
      } as never });
      const file = { originalname: 'new.pdf', buffer: Buffer.from('%PDF-1.4'), size: 8, mimetype: 'application/pdf' } as never;
      await expect(serviceFor(tx).uploadFile(accountant, t.id, d.id, file)).rejects.toBeInstanceOf(ForbiddenException);
      expect((await tx.documents.findUniqueOrThrow({ where: { id: d.id } })).file_path).toBe('documents/zz-old.pdf');
    });
  });
});
