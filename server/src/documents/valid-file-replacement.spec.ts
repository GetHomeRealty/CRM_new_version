import { promises as fs } from 'fs';
import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { documents } from '@prisma/client';
import type { AuthUserRecord } from '../auth/auth.types';
import { ValidFileReplacementService } from './valid-file-replacement.service';
import { documentReviewVersion } from './document-review-version';
const file = { originalname: 'New.pdf', buffer: Buffer.from('NEW') };
function scene() {
  let doc = { id: 9, transaction_id: 2, title: 'QA Valid document', validation: 'Valid', drive_uploaded: 'Yes', reminder: true, status: 'Received', agent_accepted: 'Accepted', deleted_at: null, pending_delete: false, file_path: 'documents/2/old.pdf', file_name: 'Old.pdf', validation_file_path: 'documents/2/support.pdf', files: '[{"client_name":"A","file_name":"A.pdf","file_path":"documents/2/a.pdf"},{"client_name":"B","file_name":"B.pdf","file_path":"documents/2/b.pdf"}]', updated_at: new Date() } as unknown as documents;
  const events: string[] = []; jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined); const write = jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined), unlink = jest.spyOn(fs, 'unlink').mockImplementation(async () => { events.push('unlink'); });
  const tx = { $queryRaw: jest.fn(async () => []), documents: { findFirst: jest.fn(async ({ where }) => where.transaction_id === 2 && !doc.deleted_at && !doc.pending_delete ? doc : null), update: jest.fn(async ({ data }) => { events.push('update'); doc = { ...doc, ...data }; return doc; }) } };
  const prisma = { $transaction: jest.fn(async fn => fn(tx)) }, access = { assertTransaction: jest.fn(async () => {}) }, audit = { record: jest.fn(async () => {}) }, validation = { sync: jest.fn(async () => {}) };
  const service = new ValidFileReplacementService(prisma as never, access as never, audit as never, validation as never), user = { id: 1, name: 'QA Admin', role: 'admin' } as AuthUserRecord;
  return { service, user, tx, access, audit, validation, write, unlink, events, get doc() { return doc; }, body: (kind = 'primary', index?: number) => ({ kind, ...(index !== undefined ? { index: String(index) } : {}), review_version: documentReviewVersion(doc) }), change: (patch: object) => { doc = { ...doc, ...patch }; } };
}
afterEach(() => jest.restoreAllMocks());
test('Primary replacement commits before cleanup, resets review/Drive and preserves other files', async () => {
  const s = scene(), before = s.doc.files; await s.service.replace(s.user, 2, 9, s.body(), file); expect(s.doc.file_name).toBe('New.pdf'); expect(s.doc.validation).toBe('Pending'); expect(s.doc.drive_uploaded).toBe('No'); expect(s.doc.reminder).toBe(false); expect(s.doc.files).toBe(before); expect(s.doc.validation_file_path).toBe('documents/2/support.pdf'); expect(s.events).toEqual(['update', 'unlink']); expect(s.validation.sync).toHaveBeenCalledTimes(1);
});
test('Indexed replacement preserves selected client identity, other entries, primary and support', async () => {
  const s = scene(); await s.service.replace(s.user, 2, 9, s.body('indexed', 0), file); const entries = JSON.parse(s.doc.files!); expect(entries[0]).toEqual(expect.objectContaining({ client_name: 'A', file_name: 'New.pdf' })); expect(entries[1]).toEqual({ client_name: 'B', file_name: 'B.pdf', file_path: 'documents/2/b.pdf' }); expect(s.doc.file_path).toBe('documents/2/old.pdf'); expect(s.unlink.mock.calls[0][0]).toMatch(/documents\/2\/a\.pdf$/);
});
test('Only Super Admin and canonical-access callers reach replacement; stale/invalid/missing selections fail closed', async () => {
  const s = scene(); for (const role of ['manager', 'documentation', 'agent', 'unknown']) await expect(s.service.replace({ ...s.user, role }, 2, 9, s.body(), file)).rejects.toBeInstanceOf(ForbiddenException);
  s.access.assertTransaction.mockRejectedValueOnce(new ForbiddenException()); await expect(s.service.replace(s.user, 2, 9, s.body(), file)).rejects.toBeInstanceOf(ForbiddenException);
  const stale = s.body(); s.change({ file_path: 'documents/2/newer.pdf' }); await expect(s.service.replace(s.user, 2, 9, stale, file)).rejects.toBeInstanceOf(ConflictException);
  await expect(s.service.replace(s.user, 2, 9, s.body('indexed', 8), file)).rejects.toBeInstanceOf(NotFoundException);
  s.change({ validation: 'Pending' }); await expect(s.service.replace(s.user, 2, 9, s.body(), file)).rejects.toBeInstanceOf(UnprocessableEntityException); expect(s.write).not.toHaveBeenCalled();
});
test('Missing/empty/oversize/unsafe file and rejected document cannot change storage', async () => {
  const s = scene(); for (const value of [undefined, { ...file, buffer: Buffer.alloc(0) }, { ...file, buffer: Buffer.alloc(20 * 1024 * 1024 + 1) }, { ...file, originalname: '../new.pdf' }]) await expect(s.service.replace(s.user, 2, 9, s.body(), value)).rejects.toBeInstanceOf(UnprocessableEntityException);
  s.change({ agent_accepted: 'Not Accepted' }); await expect(s.service.replace(s.user, 2, 9, s.body(), file)).rejects.toBeInstanceOf(UnprocessableEntityException); expect(s.write).not.toHaveBeenCalled();
});
test('Failed DB replacement cleans staged upload without losing original', async () => {
  const s = scene(); s.tx.documents.update.mockRejectedValueOnce(new Error('DB failed')); await expect(s.service.replace(s.user, 2, 9, s.body(), file)).rejects.toThrow('DB failed'); expect(s.doc.file_path).toBe('documents/2/old.pdf'); expect(s.unlink).toHaveBeenCalledTimes(1); expect(s.unlink.mock.calls[0][0]).toBe(s.write.mock.calls[0][0]); expect(s.audit.record).not.toHaveBeenCalled();
});
