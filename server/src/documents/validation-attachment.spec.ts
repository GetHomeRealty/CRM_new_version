jest.mock('../common/archive', () => ({ createZip: jest.fn() }));
import { promises as fs } from 'fs';
import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { documents } from '@prisma/client';
import type { AuthUserRecord } from '../auth/auth.types';
import { ValidationAttachmentService } from './validation-attachment.service';
import { documentReviewVersion } from './document-review-version';
import { DocumentsController } from './documents.controller';
const file = { originalname: 'Review.pdf', buffer: Buffer.from('QA') };
function scene() {
  const events: string[] = [];
  const mkdir = jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined), write = jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined), unlink = jest.spyOn(fs, 'unlink').mockImplementation(async () => { events.push('unlink'); });
  let doc = { id: 9, transaction_id: 2, title: 'QA document', validation: 'Invalid', status: 'Received', file_path: 'documents/2/original', validation_file_path: 'documents/2/support-old', validation_file_name: 'Old.pdf', pending_delete: false, deleted_at: null, updated_at: new Date() } as unknown as documents;
  const tx = { $queryRaw: jest.fn(async () => []), documents: { findFirst: jest.fn(async ({ where }) => where.transaction_id === 2 && !doc.deleted_at && !doc.pending_delete ? doc : null), update: jest.fn(async ({ data }) => { events.push('update'); doc = { ...doc, ...data }; return doc; }) } };
  const prisma = { $transaction: jest.fn(async fn => fn(tx)) }, access = { assertTransaction: jest.fn(async () => {}) }, audit = { record: jest.fn(async () => {}) };
  const service = new ValidationAttachmentService(prisma as never, access as never, audit as never), user = { id: 1, name: 'QA Reviewer', role: 'documentation' } as AuthUserRecord;
  return { service, user, tx, access, audit, mkdir, write, unlink, events, get doc() { return doc; }, version: () => documentReviewVersion(doc), change: (patch: object) => { doc = { ...doc, ...patch }; } };
}
afterEach(() => jest.restoreAllMocks());
test('Upload persists selected supporting file before unlinking old support; primary document is untouched', async () => {
  const s = scene(); await s.service.save(s.user, 2, 9, s.version(), file);
  expect(s.write).toHaveBeenCalledWith(expect.stringMatching(/documents\/2\/.*\.pdf$/), file.buffer, { flag: 'wx' });
  expect(s.doc.validation_file_name).toBe('Review.pdf'); expect(s.doc.file_path).toBe('documents/2/original'); expect(s.doc.validation).toBe('Invalid');
  expect(s.events).toEqual(['update', 'unlink']); expect(s.audit.record).toHaveBeenCalledTimes(1);
  expect(Object.keys(s.tx.documents.update.mock.calls[0][0].data).sort()).toEqual(['updated_at', 'validation_file_name', 'validation_file_path']);
});
test('Removal clears only support pointer then deletes the old support; repeated empty removal is inert', async () => {
  const s = scene(); await s.service.save(s.user, 2, 9, s.version());
  expect(s.doc.validation_file_path).toBeNull(); expect(s.doc.validation_file_name).toBeNull(); expect(s.doc.file_path).toBe('documents/2/original'); expect(s.events).toEqual(['update', 'unlink']);
  await s.service.save(s.user, 2, 9, s.version()); expect(s.tx.documents.update).toHaveBeenCalledTimes(1); expect(s.audit.record).toHaveBeenCalledTimes(1);
});
test('Failed DB update disposes only the staged file and retains old support', async () => {
  const s = scene(); s.tx.documents.update.mockRejectedValueOnce(new Error('mock DB failure'));
  await expect(s.service.save(s.user, 2, 9, s.version(), file)).rejects.toThrow('mock DB failure');
  expect(s.doc.validation_file_path).toBe('documents/2/support-old'); expect(s.unlink).toHaveBeenCalledTimes(1);
  expect(s.unlink.mock.calls[0][0]).toBe(s.write.mock.calls[0][0]); expect(s.audit.record).not.toHaveBeenCalled();
});
test('Agents/unknown roles, canonical denial, invalid version, empty/oversized/traversal files fail before file writes', async () => {
  const s = scene();
  for (const role of ['agent', 'unknown']) await expect(s.service.save({ ...s.user, role }, 2, 9, s.version(), file)).rejects.toBeInstanceOf(ForbiddenException);
  s.access.assertTransaction.mockRejectedValueOnce(new ForbiddenException()); await expect(s.service.save(s.user, 2, 9, s.version(), file)).rejects.toBeInstanceOf(ForbiddenException);
  await expect(s.service.save(s.user, 2, 9, 'invalid', file)).rejects.toBeInstanceOf(UnprocessableEntityException);
  for (const value of [{ ...file, buffer: Buffer.alloc(0) }, { ...file, buffer: Buffer.alloc(20 * 1024 * 1024 + 1) }, { ...file, originalname: '../Review.pdf' }]) await expect(s.service.save(s.user, 2, 9, s.version(), value)).rejects.toBeInstanceOf(UnprocessableEntityException);
  expect(s.write).not.toHaveBeenCalled(); expect(s.tx.documents.update).not.toHaveBeenCalled();
});
test('Stale review, non-Invalid, foreign, deleted and pending-delete records fail without unlink/write', async () => {
  const s = scene(); const version = s.version(); s.change({ validation_file_path: 'documents/2/newer' });
  await expect(s.service.save(s.user, 2, 9, version)).rejects.toBeInstanceOf(ConflictException);
  s.change({ validation: 'Valid' }); await expect(s.service.save(s.user, 2, 9, s.version(), file)).rejects.toBeInstanceOf(UnprocessableEntityException);
  await expect(s.service.save(s.user, 3, 9, s.version(), file)).rejects.toBeInstanceOf(NotFoundException);
  s.change({ pending_delete: true }); await expect(s.service.save(s.user, 2, 9, s.version(), file)).rejects.toBeInstanceOf(NotFoundException);
  s.change({ pending_delete: false, deleted_at: new Date() }); await expect(s.service.save(s.user, 2, 9, s.version(), file)).rejects.toBeInstanceOf(NotFoundException);
  expect(s.write).not.toHaveBeenCalled(); expect(s.unlink).not.toHaveBeenCalled();
});
test('Upload route without a file cannot fall through to removal', async () => {
  const save = jest.fn(); const controller = new DocumentsController({} as never, {} as never, {} as never, { save } as never);
  expect(() => controller.saveValidationAttachment(undefined, 2, 9, { review_version: 'a'.repeat(64) }, undefined as never)).toThrow(UnprocessableEntityException); expect(save).not.toHaveBeenCalled();
});
