import { checklistVisibility } from './checklist-visibility';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { DocsValidationService } from './docs-validation.service';
import { documentReviewVersion } from './document-review-version';

@Injectable()
export class DocumentLifecycleService {
  constructor(private readonly prisma: PrismaService, private readonly access: ResourceAccessService, private readonly audit: AuditService, private readonly validation: DocsValidationService) {}
  private reviewer(user: AuthUserRecord | null): asserts user is AuthUserRecord {
    if (!user || !['admin', 'manager', 'accounting', 'documentation', 'crm'].includes(user.role)) throw new ForbiddenException();
  }
  async list(user: AuthUserRecord | null, transactionId: number) {
    this.reviewer(user); await this.access.assertTransaction(user, transactionId);
    const rows = await this.prisma.documents.findMany({ where: { transaction_id: transactionId, OR: [{ deleted_at: null, pending_delete: false }, ...(['admin', 'manager'].includes(user.role) ? [{ deleted_at: null, pending_delete: true }] : []), ...(user.role === 'admin' ? [{ deleted_at: { not: null } }] : [])] }, orderBy: [{ position: 'asc' }, { id: 'asc' }], take: 201 });
    const txn = await this.prisma.transactions.findUnique({ where: { id: transactionId }, select: { type: true } });
    const statuses = await this.prisma.transaction_statuses.findMany({ where: { transaction_id: transactionId }, select: { status: true } });
    const visible = checklistVisibility(txn?.type ?? null, statuses.map(row => row.status));
    return { has_more: rows.length > 200, documents: rows.slice(0, 200).filter(row => row.deleted_at || row.pending_delete || visible(row)).map(row => ({ id: row.id, title: row.title, validation: row.validation, is_condition: row.is_condition, state: row.deleted_at ? 'removed' : row.pending_delete ? 'pending' : 'active', deleted_by: row.deleted_by, has_file: !!row.file_path || !!row.files || !!row.validation_file_path, review_version: documentReviewVersion(row) })) };
  }
  async change(user: AuthUserRecord | null, transactionId: number, documentId: number, body: Record<string, unknown>): Promise<{ message: string }> {
    this.reviewer(user); await this.access.assertTransaction(user, transactionId);
    if (!body || !['remove', 'restore'].includes(String(body.action)) || typeof body.review_version !== 'string' || !/^[a-f0-9]{64}$/.test(body.review_version) || Object.keys(body).some(key => !['action', 'review_version'].includes(key))) throw new UnprocessableEntityException({ message: 'Invalid document action. Refresh and review again.' });
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId} AND transaction_id = ${transactionId} FOR UPDATE`;
      const doc = await tx.documents.findFirst({ where: { id: documentId, transaction_id: transactionId } });
      if (!doc) throw new NotFoundException({ message: 'Document unavailable.' });
      if (documentReviewVersion(doc) !== body.review_version) throw new ConflictException({ message: 'This document changed. Close and refresh before another action.' });
      if (doc.pending_delete && !['admin', 'manager'].includes(user.role)) throw new ForbiddenException();
      if (body.action === 'remove') {
        if (doc.deleted_at) throw new ConflictException({ message: 'Document is already removed. Refresh the list.' });
        if ((doc.is_condition || doc.validation === 'Valid') && user.role !== 'admin') throw new ForbiddenException({ message: 'Only a Super Admin can remove a condition or Valid document.' });
        await tx.documents.update({ where: { id: documentId }, data: { deleted_at: new Date(), pending_delete: false, deleted_by: user.name, updated_at: new Date() } });
      } else {
        if (!doc.deleted_at && !doc.pending_delete) throw new ConflictException({ message: 'Document is already active. Refresh the list.' });
        if (doc.deleted_at && user.role !== 'admin') throw new ForbiddenException({ message: 'Only a Super Admin can restore removed documents.' });
        await tx.documents.update({ where: { id: documentId }, data: { deleted_at: null, pending_delete: false, deleted_by: null, updated_at: new Date() } });
      }
      return doc;
    });
    const actor = { id: user.id, name: user.name };
    await this.audit.record(transactionId, actor, { section: 'Legal & Documents', field: result.title, action: body.action === 'remove' ? 'Document deleted' : 'Document restored' });
    await this.validation.sync(transactionId, actor);
    return { message: body.action === 'remove' ? 'Document removed; files retained for Super Admin recovery.' : 'Document restored to the checklist.' };
  }
}
