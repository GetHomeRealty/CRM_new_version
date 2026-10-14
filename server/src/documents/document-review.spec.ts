import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { documents } from '@prisma/client';
import type { AuthUserRecord } from '../auth/auth.types';
import { DocumentReviewService } from './document-review.service';
import { documentReviewVersion } from './document-review-version';
function scene(role = 'documentation') {
  let doc = { id: 9, transaction_id: 2, title: 'Synthetic offer', manual: true, is_condition: false, deleted_at: null, pending_delete: false, status: 'Received', validation: 'Pending', drive_uploaded: null, agent_accepted: null, reminder: false, remarks: null, file_path: 'documents/2/old', files: null, updated_at: new Date('2026-10-10T12:00:00Z') } as unknown as documents;
  const user = { id: 1, name: 'QA Reviewer', role } as AuthUserRecord;
  const tx = { $queryRaw: jest.fn(async () => [{ id: 9 }]), documents: { findFirst: jest.fn(async ({ where }) => where.transaction_id === 2 && !doc.deleted_at && !doc.pending_delete ? doc : null), update: jest.fn(async ({ data }) => { doc = { ...doc, ...data }; return doc; }) } };
  const prisma = { $transaction: jest.fn(async fn => fn(tx)), transactions: { findUnique: jest.fn(async () => ({ agent: 'QA Agent' })) }, users: { findFirst: jest.fn(async () => ({ id: 3 })) } };
  const access = { assertTransaction: jest.fn(async () => {}) }, audit = { record: jest.fn(async () => {}) }, validation = { sync: jest.fn(async () => {}) }, mail = { sendReviewOutcome: jest.fn(async () => {}) }, dispatcher = { dispatch: jest.fn(async () => {}) };
  const service = new DocumentReviewService(prisma as never, access as never, audit as never, validation as never, mail as never, dispatcher as never);
  const body = (patch: object) => ({ review_version: documentReviewVersion(doc), ...patch });
  return { service, user, tx, access, audit, validation, mail, dispatcher, body, get doc() { return doc; }, change: (patch: object) => { doc = { ...doc, ...patch }; } };
}
test('Narrow review locks and changes only the selected row, preserves file identity, audits and notifies', async () => {
  const s = scene(); const body = s.body({ validation: 'Invalid', remarks: 'Please replace page two.' });
  await s.service.save(s.user, 2, 9, body);
  expect(s.tx.$queryRaw).toHaveBeenCalledTimes(1); expect(s.tx.documents.update).toHaveBeenCalledWith({ where: { id: 9 }, data: expect.objectContaining({ validation: 'Invalid', remarks: 'Please replace page two.' }) });
  expect(s.doc.file_path).toBe('documents/2/old'); expect(s.doc.title).toBe('Synthetic offer'); expect(s.doc.status).toBe('Received');
  expect(s.validation.sync).toHaveBeenCalledWith(2, { id: 1, name: 'QA Reviewer' }); expect(s.mail.sendReviewOutcome).toHaveBeenCalledTimes(1); expect(s.dispatcher.dispatch).toHaveBeenCalledTimes(1);
  expect(s.audit.record).toHaveBeenCalledTimes(2);
});
test('File changes within the same timestamp second invalidate the review snapshot', async () => {
  const s = scene(); const body = s.body({ validation: 'Valid' }); s.change({ file_path: 'documents/2/replacement' });
  await expect(s.service.save(s.user, 2, 9, body)).rejects.toBeInstanceOf(ConflictException); expect(s.tx.documents.update).not.toHaveBeenCalled();
});
test('Agent cannot review validation or accept generated/condition documents; canonical scope denial blocks writes', async () => {
  const s = scene('agent');
  await expect(s.service.save(s.user, 2, 9, s.body({ validation: 'Valid' }))).rejects.toBeInstanceOf(UnprocessableEntityException);
  s.change({ is_condition: true }); await expect(s.service.save(s.user, 2, 9, s.body({ agent_accepted: 'Accepted' }))).rejects.toBeInstanceOf(ForbiddenException);
  s.change({ is_condition: false, manual: false }); await expect(s.service.save(s.user, 2, 9, s.body({ agent_accepted: 'Accepted' }))).rejects.toBeInstanceOf(ForbiddenException);
  s.access.assertTransaction.mockRejectedValueOnce(new ForbiddenException()); await expect(s.service.save(s.user, 2, 9, s.body({ agent_accepted: 'Accepted' }))).rejects.toBeInstanceOf(ForbiddenException);
  expect(s.tx.documents.update).not.toHaveBeenCalled();
});
test('Agent rejection only updates acceptance/reminder, without reviewer notifications', async () => {
  const s = scene('agent'); s.change({ reminder: true }); await s.service.save(s.user, 2, 9, s.body({ agent_accepted: 'Not Accepted' }));
  expect(s.doc.agent_accepted).toBe('Not Accepted'); expect(s.doc.reminder).toBe(false); expect(s.doc.validation).toBe('Pending'); expect(s.mail.sendReviewOutcome).not.toHaveBeenCalled();
});
test('Invalid and foreign/deleted/pending-delete rows fail closed; unknown role denied', async () => {
  const s = scene();
  for (const patch of [{ title: 'Changed' }, { remarks: 'x'.repeat(5001) }, { validation: 'Other' }, { reminder: 'true' }, { drive_uploaded: 'Yes' }]) await expect(s.service.save(s.user, 2, 9, s.body(patch))).rejects.toBeInstanceOf(UnprocessableEntityException);
  await expect(s.service.save(s.user, 3, 9, s.body({ remarks: 'QA' }))).rejects.toBeInstanceOf(NotFoundException);
  s.change({ pending_delete: true }); await expect(s.service.save(s.user, 2, 9, s.body({ remarks: 'QA' }))).rejects.toBeInstanceOf(NotFoundException);
  s.change({ pending_delete: false, deleted_at: new Date() }); await expect(s.service.save(s.user, 2, 9, s.body({ remarks: 'QA' }))).rejects.toBeInstanceOf(NotFoundException);
  await expect(s.service.save({ ...s.user, role: 'unknown' }, 2, 9, {})).rejects.toBeInstanceOf(ForbiddenException); expect(s.tx.documents.update).not.toHaveBeenCalled();
});
test('Valid review clears reminder and defaults Drive to No; explicit Drive Yes is preserved', async () => {
  const s = scene(); s.change({ reminder: true }); await s.service.save(s.user, 2, 9, s.body({ validation: 'Valid' })); expect(s.doc.reminder).toBe(false); expect(s.doc.drive_uploaded).toBe('No');
  const other = scene(); await other.service.save(other.user, 2, 9, other.body({ validation: 'Valid', drive_uploaded: 'Yes' })); expect(other.doc.drive_uploaded).toBe('Yes');
});
test('Unchanged reviews and best-effort notification failures do not duplicate or undo saved changes', async () => {
  const s = scene(); await s.service.save(s.user, 2, 9, s.body({ validation: 'Pending' })); expect(s.tx.documents.update).not.toHaveBeenCalled(); expect(s.audit.record).not.toHaveBeenCalled();
  s.mail.sendReviewOutcome.mockRejectedValueOnce(new Error('mock transport failure')); s.dispatcher.dispatch.mockRejectedValueOnce(new Error('mock push failure'));
  await s.service.save(s.user, 2, 9, s.body({ validation: 'Invalid' })); expect(s.doc.validation).toBe('Invalid');
});
