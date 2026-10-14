import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { documentReviewVersion } from './document-review-version';
import { STORAGE_ROOT } from '../config/storage';

@Injectable()
export class ValidationAttachmentService {
  constructor(private readonly prisma: PrismaService, private readonly access: ResourceAccessService, private readonly audit: AuditService) {}
  async save(user: AuthUserRecord | null, transactionId: number, documentId: number, version: unknown, file?: { originalname: string; buffer: Buffer }): Promise<{ message: string }> {
    if (!user || !['admin', 'manager', 'accounting', 'documentation', 'crm'].includes(user.role)) throw new ForbiddenException();
    await this.access.assertTransaction(user, transactionId);
    if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) throw new UnprocessableEntityException({ message: 'Refresh this document before changing its attachment.' });
    if (file && (!file.originalname.trim() || file.originalname.length > 255 || /[\/\\\x00-\x1f]/.test(file.originalname) || !file.buffer.length || file.buffer.length > 20 * 1024 * 1024)) throw new UnprocessableEntityException({ message: 'Choose a non-empty file of no more than 20 MB with a valid filename.' });
    let stored: string | null = null;
    let committed = false;
    try {
      const result = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId} AND transaction_id = ${transactionId} FOR UPDATE`;
        const doc = await tx.documents.findFirst({ where: { id: documentId, transaction_id: transactionId, deleted_at: null, pending_delete: false } });
        if (!doc) throw new NotFoundException({ message: 'Document unavailable.' });
        if (documentReviewVersion(doc) !== version) throw new ConflictException({ message: 'This document changed. Close and refresh before changing its attachment.' });
        if (doc.validation !== 'Invalid') throw new UnprocessableEntityException({ message: 'Supporting attachments are for Invalid documents.' });
        if (!file && !doc.validation_file_path) return { doc, changed: false };
        if (file) {
          stored = `documents/${transactionId}/${randomBytes(20).toString('hex')}${path.extname(file.originalname)}`;
          await fs.mkdir(path.dirname(path.join(STORAGE_ROOT, stored)), { recursive: true });
          await fs.writeFile(path.join(STORAGE_ROOT, stored), file.buffer, { flag: 'wx' });
        }
        await tx.documents.update({ where: { id: documentId }, data: { validation_file_path: stored, validation_file_name: file?.originalname ?? null, updated_at: new Date() } });
        return { doc, changed: true };
      });
      committed = true;
      if (!result.changed) return { message: 'No attachment to remove.' };
      // Commit the new pointer first. A failed DB update must retain the original file.
      if (result.doc.validation_file_path) await this.dispose(result.doc.validation_file_path);
      await this.audit.record(transactionId, { id: user.id, name: user.name }, { section: 'Legal & Documents', field: result.doc.title, action: file ? 'Validation attachment uploaded' : 'Validation attachment removed', old: result.doc.validation_file_name, new: file?.originalname ?? null });
      return { message: file ? 'Validation attachment uploaded.' : 'Validation attachment removed.' };
    } finally { if (!committed && stored) await this.dispose(stored); }
  }
  private async dispose(relative: string): Promise<void> {
    const resolved = path.resolve(STORAGE_ROOT, relative);
    if (!resolved.startsWith(STORAGE_ROOT + path.sep)) return;
    try { await fs.unlink(resolved); } catch { /* private storage cleanup best effort */ }
  }
}
