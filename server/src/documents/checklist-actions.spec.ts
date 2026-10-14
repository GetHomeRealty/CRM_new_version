import { promises as fs } from 'fs';
import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { documents, transactions } from '@prisma/client';
import type { AuthUserRecord } from '../auth/auth.types';
import { ChecklistActionsService } from './checklist-actions.service';
import { documentReviewVersion } from './document-review-version';
import { recoVersion } from './reco-version';
function scene(role = 'documentation') {
  let doc = { id: 9, transaction_id: 2, title: 'Client Photo IDs', manual: false, is_condition: false, pending_delete: false, deleted_at: null, status: 'Received', validation: 'Pending', file_path: 'documents/2/primary.pdf', file_name: 'Primary.pdf', validation_file_path: 'documents/2/support.pdf', files: JSON.stringify([{ client_name: 'A', file_name: 'A.pdf', file_path: 'documents/2/a.pdf' }, { client_name: 'B', file_name: 'B.pdf', file_path: 'documents/2/b.pdf' }]), updated_at: new Date() } as unknown as documents;
  let txn = { id: 2, deleted_at: null, reco_audit_ready: null, reco_audit_remarks: null, price: 750000 } as unknown as transactions;
  const unlink = jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);
  const tx = { $queryRaw: jest.fn(async () => []), transactions: { findFirst: jest.fn(async () => txn.deleted_at ? null : txn), update: jest.fn(async ({ data }) => { txn = { ...txn, ...data }; return txn; }) }, documents: { findFirst: jest.fn(async ({ where }) => where.manual ? doc.manual && doc.title.toLowerCase() === where.title.equals.toLowerCase() ? doc : null : where.transaction_id === 2 && !doc.deleted_at && !doc.pending_delete ? doc : null), aggregate: jest.fn(async () => ({ _max: { position: 2 } })), create: jest.fn(async ({ data }) => ({ id: 10, ...data })), update: jest.fn(async ({ data }) => { doc = { ...doc, ...data }; return doc; }) }, clients: { findMany: jest.fn(async () => [{ name: 'A' }, { name: 'B' }]) } };
  const access = { assertTransaction: jest.fn(async () => {}) }, audit = { record: jest.fn(async () => {}) }, validation = { sync: jest.fn(async () => {}) }, prisma = { $transaction: jest.fn(async fn => fn(tx)) };
  const service = new ChecklistActionsService(prisma as never, access as never, audit as never, validation as never), user = { id: 1, name: 'QA Reviewer', role } as AuthUserRecord;
  return { service, user, tx, access, audit, validation, unlink, get doc() { return doc; }, get txn() { return txn; }, fileBody: (kind = 'indexed', index = 0) => ({ kind, ...(kind === 'indexed' ? { index } : {}), review_version: documentReviewVersion(doc) }), readyBody: (ready: string | null, remarks: string | null) => ({ ready, remarks, version: recoVersion(2, txn.reco_audit_ready, txn.reco_audit_remarks) }), changeDoc: (patch: object) => { doc = { ...doc, ...patch }; }, changeTxn: (patch: object) => { txn = { ...txn, ...patch }; } };
}
afterEach(() => jest.restoreAllMocks());
test('Manual creation locks transaction, inserts one Pending manual row and never round-trips existing documents', async () => {
  const s = scene('agent'); const result = await s.service.create(s.user, 2, { title: '  QA Extra document  ' }); expect(result).toEqual({ id: 10, reused: false }); expect(s.tx.documents.create).toHaveBeenCalledWith({ data: expect.objectContaining({ title: 'QA Extra document', manual: true, status: 'Pending', validation: 'Pending', mandatory: false, position: 3 }) }); expect(s.tx.documents.update).not.toHaveBeenCalled(); expect(s.audit.record).toHaveBeenCalledTimes(1); expect(s.validation.sync).toHaveBeenCalledTimes(1);
});
test('Existing manual title is reused without new row, duplicate audit or notification', async () => {
  const s = scene(); s.changeDoc({ manual: true, title: 'QA Extra document' }); expect(await s.service.create(s.user, 2, { title: 'qa extra DOCUMENT' })).toEqual({ id: 9, reused: true }); expect(s.tx.documents.create).not.toHaveBeenCalled(); expect(s.audit.record).not.toHaveBeenCalled();
});
test('Creation rejects empty/oversize/extra fields and inaccessible/deleted transactions', async () => {
  const s = scene(); for (const body of [{ title: '' }, { title: 'x'.repeat(256) }, { title: 'QA', mandatory: true }]) await expect(s.service.create(s.user, 2, body)).rejects.toBeInstanceOf(UnprocessableEntityException);
  s.access.assertTransaction.mockRejectedValueOnce(new ForbiddenException()); await expect(s.service.create(s.user, 2, { title: 'QA' })).rejects.toBeInstanceOf(ForbiddenException); s.changeTxn({ deleted_at: new Date() }); await expect(s.service.create(s.user, 2, { title: 'QA' })).rejects.toBeInstanceOf(NotFoundException); expect(s.tx.documents.create).not.toHaveBeenCalled();
});
test('RECO readiness patches only readiness fields and clears reason outside No', async () => {
  const s = scene(); await s.service.readiness(s.user, 2, s.readyBody('No', 'Missing signature.')); expect(s.txn.reco_audit_ready).toBe('No'); expect(s.txn.reco_audit_remarks).toBe('Missing signature.'); expect(s.txn.price).toBe(750000); expect(s.tx.documents.update).not.toHaveBeenCalled();
  await s.service.readiness(s.user, 2, s.readyBody('Yes', 'Do not retain this reason')); expect(s.txn.reco_audit_remarks).toBeNull(); expect(Object.keys(s.tx.transactions.update.mock.calls[0][0].data).sort()).toEqual(['reco_audit_ready', 'reco_audit_remarks', 'updated_at']);
});
test('Readiness denies agents, stale snapshots, oversize remarks and document/financial injection', async () => {
  const s = scene(); const body = s.readyBody('No', 'QA'); s.changeTxn({ reco_audit_ready: 'Yes' }); await expect(s.service.readiness(s.user, 2, body)).rejects.toBeInstanceOf(ConflictException);
  await expect(s.service.readiness({ ...s.user, role: 'agent' }, 2, s.readyBody('No', 'QA'))).rejects.toBeInstanceOf(ForbiddenException);
  for (const value of [{ ...s.readyBody('No', 'QA'), price: 1 }, s.readyBody('No', 'x'.repeat(5001)), s.readyBody('Other', null)]) await expect(s.service.readiness(s.user, 2, value)).rejects.toBeInstanceOf(UnprocessableEntityException); expect(s.tx.transactions.update).not.toHaveBeenCalled();
});
test('Per-client removal targets exact index, retains primary/support/other client and recalculates Pending', async () => {
  const s = scene(); await s.service.removeFile(s.user, 2, 9, s.fileBody()); expect(JSON.parse(s.doc.files!)).toEqual([{ client_name: 'B', file_name: 'B.pdf', file_path: 'documents/2/b.pdf' }]); expect(s.doc.status).toBe('Pending'); expect(s.doc.file_path).toBe('documents/2/primary.pdf'); expect(s.doc.validation_file_path).toBe('documents/2/support.pdf'); expect(s.unlink.mock.calls[0][0]).toMatch(/documents\/2\/a\.pdf$/); expect(s.validation.sync).toHaveBeenCalledTimes(1);
});
test('Primary removal retains indexed/support files and calculates remaining-file receipt', async () => {
  const s = scene(); s.changeDoc({ title: 'QA General document' }); await s.service.removeFile(s.user, 2, 9, s.fileBody('primary')); expect(s.doc.file_path).toBeNull(); expect(s.doc.file_name).toBeNull(); expect(JSON.parse(s.doc.files!)).toHaveLength(2); expect(s.doc.validation_file_path).toBe('documents/2/support.pdf'); expect(s.doc.status).toBe('Received');
});
test('Valid file requires Super Admin; stale/missing/index/access failure cannot unlink or update', async () => {
  const s = scene(); const stale = s.fileBody(); s.changeDoc({ file_path: 'documents/2/new.pdf' }); await expect(s.service.removeFile(s.user, 2, 9, stale)).rejects.toBeInstanceOf(ConflictException);
  s.changeDoc({ validation: 'Valid' }); await expect(s.service.removeFile(s.user, 2, 9, s.fileBody())).rejects.toBeInstanceOf(ForbiddenException);
  await expect(s.service.removeFile({ ...s.user, role: 'agent' }, 2, 9, s.fileBody())).rejects.toBeInstanceOf(ForbiddenException);
  s.changeDoc({ validation: 'Pending' }); await expect(s.service.removeFile(s.user, 2, 9, s.fileBody('indexed', -1))).rejects.toBeInstanceOf(UnprocessableEntityException); await expect(s.service.removeFile(s.user, 3, 9, s.fileBody())).rejects.toBeInstanceOf(NotFoundException); expect(s.unlink).not.toHaveBeenCalled(); expect(s.tx.documents.update).not.toHaveBeenCalled();
  await s.service.removeFile({ ...s.user, role: 'admin' }, 2, 9, s.fileBody()); expect(s.tx.documents.update).toHaveBeenCalledTimes(1);
});
test('Failed file pointer update preserves physical file', async () => {
  const s = scene(); s.tx.documents.update.mockRejectedValueOnce(new Error('DB failure')); await expect(s.service.removeFile(s.user, 2, 9, s.fileBody())).rejects.toThrow('DB failure'); expect(s.unlink).not.toHaveBeenCalled(); expect(s.audit.record).not.toHaveBeenCalled();
});
