import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { documents } from '@prisma/client';
import type { AuthUserRecord } from '../auth/auth.types';
import { DocumentLifecycleService } from './document-lifecycle.service';
import { documentReviewVersion } from './document-review-version';
function scene(role = 'documentation') {
  let doc = { id: 9, transaction_id: 2, title: 'QA manual document', is_condition: false, validation: 'Pending', pending_delete: false, deleted_at: null, deleted_by: null, file_path: 'documents/2/primary.pdf', validation_file_path: 'documents/2/support.pdf', files: '[{"file_path":"documents/2/extra.pdf"}]', updated_at: new Date() } as unknown as documents;
  const tx = { $queryRaw: jest.fn(async () => []), documents: { findFirst: jest.fn(async ({ where }) => where.transaction_id === 2 ? doc : null), update: jest.fn(async ({ data }) => { doc = { ...doc, ...data }; return doc; }) } };
  const prisma = { transactions: {findUnique: jest.fn(async()=>({type:'Purchase'}))}, transaction_statuses: {findMany: jest.fn(async()=>[])}, $transaction: jest.fn(async fn => fn(tx)), documents: { findMany: jest.fn(async () => [doc]) } }, access = { assertTransaction: jest.fn(async () => {}) }, audit = { record: jest.fn(async () => {}) }, validation = { sync: jest.fn(async () => {}) };
  const service = new DocumentLifecycleService(prisma as never, access as never, audit as never, validation as never), user = { id: 1, name: 'QA Reviewer', role } as AuthUserRecord;
  return { service, user, tx, prisma, access, audit, validation, get doc() { return doc; }, body: (action: string) => ({ action, review_version: documentReviewVersion(doc) }), change: (patch: object) => { doc = { ...doc, ...patch }; } };
}
test('Recoverable removal retains every file pointer, changes only target lifecycle fields and synchronizes audit/clearance', async () => {
  const s = scene(); await s.service.change(s.user, 2, 9, s.body('remove'));
  expect(s.doc.deleted_at).toBeInstanceOf(Date); expect(s.doc.file_path).toBe('documents/2/primary.pdf'); expect(s.doc.validation_file_path).toBe('documents/2/support.pdf'); expect(s.doc.files).toContain('extra.pdf');
  expect(Object.keys(s.tx.documents.update.mock.calls[0][0].data).sort()).toEqual(['deleted_at', 'deleted_by', 'pending_delete', 'updated_at']); expect(s.audit.record).toHaveBeenCalledTimes(1); expect(s.validation.sync).toHaveBeenCalledTimes(1);
});
test('Only Super Admin can remove Valid/condition documents and restore actually removed documents', async () => {
  const s = scene('manager'); s.change({ is_condition: true }); await expect(s.service.change(s.user, 2, 9, s.body('remove'))).rejects.toBeInstanceOf(ForbiddenException);
  s.change({ is_condition: false, validation: 'Valid' }); await expect(s.service.change(s.user, 2, 9, s.body('remove'))).rejects.toBeInstanceOf(ForbiddenException);
  await s.service.change({ ...s.user, role: 'admin' }, 2, 9, s.body('remove'));
  await expect(s.service.change(s.user, 2, 9, s.body('restore'))).rejects.toBeInstanceOf(ForbiddenException);
  await s.service.change({ ...s.user, role: 'admin' }, 2, 9, s.body('restore')); expect(s.doc.deleted_at).toBeNull(); expect(s.doc.deleted_by).toBeNull(); expect(s.doc.file_path).toBe('documents/2/primary.pdf');
});
test('Manager can restore pending review; lower roles cannot act on pending records', async () => {
  const s = scene(); s.change({ pending_delete: true, deleted_by: 'QA Agent' });
  for (const action of ['remove', 'restore']) await expect(s.service.change(s.user, 2, 9, s.body(action))).rejects.toBeInstanceOf(ForbiddenException);
  await s.service.change({ ...s.user, role: 'manager' }, 2, 9, s.body('restore')); expect(s.doc.pending_delete).toBe(false); expect(s.doc.deleted_by).toBeNull(); expect(s.doc.deleted_at).toBeNull();
});
test('Stale, invalid, foreign, redundant and unauthorized actions cannot update', async () => {
  const s = scene(); const body = s.body('remove'); s.change({ file_path: 'documents/2/new.pdf' }); await expect(s.service.change(s.user, 2, 9, body)).rejects.toBeInstanceOf(ConflictException);
  await expect(s.service.change(s.user, 3, 9, s.body('remove'))).rejects.toBeInstanceOf(NotFoundException);
  await expect(s.service.change(s.user, 2, 9, s.body('restore'))).rejects.toBeInstanceOf(ConflictException);
  await expect(s.service.change(s.user, 2, 9, { ...s.body('remove'), title: 'Overwrite' })).rejects.toBeInstanceOf(UnprocessableEntityException);
  for (const role of ['agent', 'unknown']) await expect(s.service.change({ ...s.user, role }, 2, 9, s.body('remove'))).rejects.toBeInstanceOf(ForbiddenException);
  s.access.assertTransaction.mockRejectedValueOnce(new ForbiddenException()); await expect(s.service.change(s.user, 2, 9, s.body('remove'))).rejects.toBeInstanceOf(ForbiddenException); expect(s.tx.documents.update).not.toHaveBeenCalled();
});
test('Lifecycle listing restricts pending/removed states by role and never returns private file paths', async () => {
  const s = scene(); const list = await s.service.list(s.user, 2); expect(s.prisma.documents.findMany.mock.calls[0][0].where.OR).toEqual([{ deleted_at: null, pending_delete: false }]); expect(list.documents[0]).not.toHaveProperty('file_path'); expect(list.documents[0].review_version).toMatch(/^[a-f0-9]{64}$/);
  await s.service.list({ ...s.user, role: 'manager' }, 2); expect(s.prisma.documents.findMany.mock.calls[1][0].where.OR).toHaveLength(2);
  await s.service.list({ ...s.user, role: 'admin' }, 2); expect(s.prisma.documents.findMany.mock.calls[2][0].where.OR).toHaveLength(3);
  await expect(s.service.list({ ...s.user, role: 'agent' }, 2)).rejects.toBeInstanceOf(ForbiddenException);
});

test('Lifecycle visibility hides active out-of-scope rows while keeping pending and removed recovery discoverable', async()=>{
 const s=scene('admin');s.prisma.transaction_statuses.findMany.mockResolvedValue([{status:'Void'}] as never);
 s.prisma.documents.findMany.mockResolvedValue([{...s.doc,title:'APS'}, {...s.doc,id:10,title:'Hidden active condition'}, {...s.doc,id:11,title:'Hidden pending condition',pending_delete:true}, {...s.doc,id:12,title:'Hidden removed condition',deleted_at:new Date()}]);
 const result=await s.service.list(s.user,2);expect(result.documents.map(doc=>doc.id)).toEqual([9,11,12]);expect(result.documents.map(doc=>doc.state)).toEqual(['active','pending','removed']);expect(s.tx.documents.update).not.toHaveBeenCalled();
});
