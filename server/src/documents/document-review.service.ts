import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { DocsValidationService } from './docs-validation.service';
import { DocumentMailService } from './document-mail.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { documentReviewVersion } from './document-review-version';

@Injectable()
export class DocumentReviewService {
  constructor(private readonly prisma: PrismaService, private readonly access: ResourceAccessService, private readonly audit: AuditService, private readonly validation: DocsValidationService, private readonly mail: DocumentMailService, private readonly dispatcher: NotificationDispatcher) {}
  async save(user: AuthUserRecord | null, transactionId: number, documentId: number, body: Record<string, unknown>): Promise<{ message: string }> {
    if (!user || !['admin', 'manager', 'accounting', 'documentation', 'crm', 'agent'].includes(user.role)) throw new ForbiddenException();
    await this.access.assertTransaction(user, transactionId);
    const agent = user.role === 'agent';
    const fields = agent ? ['agent_accepted'] : ['status', 'validation', 'remarks', 'drive_uploaded', 'reminder'];
    if (!body || typeof body.review_version !== 'string' || !/^[a-f0-9]{64}$/.test(body.review_version) || Object.keys(body).some(key => key !== 'review_version' && !fields.includes(key)) || !fields.some(key => Object.hasOwn(body, key))) throw new UnprocessableEntityException({ message: 'Invalid document review.' });
    const enums: Record<string, unknown[]> = { status: ['Pending', 'Received'], validation: ['Pending', 'Valid', 'Invalid'], agent_accepted: [null, 'Accepted', 'Not Accepted'], drive_uploaded: [null, 'Yes', 'No'], reminder: [true, false] };
    for (const [key, values] of Object.entries(enums)) if (Object.hasOwn(body, key) && !values.includes(body[key])) throw new UnprocessableEntityException({ message: `Invalid ${key}.` });
    if (Object.hasOwn(body, 'remarks') && body.remarks !== null && (typeof body.remarks !== 'string' || body.remarks.length > 5000)) throw new UnprocessableEntityException({ message: 'Remarks must be at most 5000 characters.' });
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId} AND transaction_id = ${transactionId} FOR UPDATE`;
      const doc = await tx.documents.findFirst({ where: { id: documentId, transaction_id: transactionId, deleted_at: null, pending_delete: false } });
      if (!doc) throw new NotFoundException({ message: 'Document unavailable.' });
      if (documentReviewVersion(doc) !== body.review_version) throw new ConflictException({ message: 'This document changed. Close and refresh before reviewing it again.' });
      if (agent && (!doc.manual || doc.is_condition)) throw new ForbiddenException({ message: 'Only manual non-condition documents can be accepted.' });
      const patch: Record<string, unknown> = Object.fromEntries(fields.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
      const status = String(patch.status ?? doc.status), validation = String(patch.validation ?? doc.validation);
      if (!agent && Object.hasOwn(patch, 'validation') && patch.validation !== 'Pending' && status !== 'Received') throw new UnprocessableEntityException({ message: 'Only received documents can be validated.' });
      if (patch.validation === 'Valid' && !Object.hasOwn(patch, 'drive_uploaded')) patch.drive_uploaded = 'No';
      if (patch.drive_uploaded === 'Yes' && validation !== 'Valid') throw new UnprocessableEntityException({ message: 'Only valid documents can be marked uploaded to Drive.' });
      if (patch.agent_accepted === 'Not Accepted' || validation === 'Valid' || (status === 'Received' && validation !== 'Invalid')) patch.reminder = false;
      const changed = Object.entries(patch).filter(([key, value]) => (doc as unknown as Record<string, unknown>)[key] !== value);
      if (changed.length) await tx.documents.update({ where: { id: documentId }, data: { ...Object.fromEntries(changed), updated_at: new Date() } as Prisma.documentsUpdateInput });
      return { doc, changed };
    });
    if (!result.changed.length) return { message: 'Document unchanged.' };
    const actor = { id: user.id, name: user.name };
    for (const [field, value] of result.changed) await this.audit.record(transactionId, actor, { section: 'Legal & Documents', field: `${result.doc.title} — ${field}`, action: 'Updated', old: (result.doc as unknown as Record<string, unknown>)[field], new: value, source: agent ? 'Agent' : 'DocReview' });
    await this.validation.sync(transactionId, actor);
    if (result.changed.some(([key]) => key === 'validation')) {
      await this.mail.sendReviewOutcome(transactionId).catch(() => {});
      const txn = await this.prisma.transactions.findUnique({ where: { id: transactionId }, select: { agent: true } });
      const recipient = txn?.agent ? await this.prisma.users.findFirst({ where: { name: txn.agent, status: 'Active' }, select: { id: true }, orderBy: { id: 'asc' } }) : null;
      if (recipient) await this.dispatcher.dispatch({ category: 'document_review', userId: recipient.id, title: 'Your document was reviewed', body: `${result.doc.title}: ${body.validation}`, link: `/desk/transactions/${transactionId}`, channels: ['push'] }).catch(() => {});
    }
    return { message: 'Document saved.' };
  }
}
