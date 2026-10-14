import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { AuditService } from '../audit/audit.service';
import { DocsValidationService } from './docs-validation.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { documentReviewVersion } from './document-review-version';
import { STORAGE_ROOT } from '../config/storage';
@Injectable()
export class ValidFileReplacementService {
  constructor(private readonly prisma: PrismaService, private readonly access: ResourceAccessService, private readonly audit: AuditService, private readonly validation: DocsValidationService) {}
  async replace(user: AuthUserRecord | null, txnId: number, docId: number, body: Record<string, unknown>, file: { originalname: string; buffer: Buffer } | undefined): Promise<{ message: string }> {
    if (!user || user.role !== 'admin') throw new ForbiddenException({ message: 'Only a Super Admin may replace a Valid document file.' });
    await this.access.assertTransaction(user, txnId);
    if (!file || !file.originalname.trim() || file.originalname.length > 255 || /[\/\\\x00-\x1f]/.test(file.originalname) || !file.buffer.length || file.buffer.length > 20 * 1024 * 1024) throw new UnprocessableEntityException({ message: 'Choose a non-empty file up to 20 MB.' });
    if (!body || !['primary', 'indexed'].includes(String(body.kind)) || typeof body.review_version !== 'string' || !/^[a-f0-9]{64}$/.test(body.review_version) || (body.kind === 'indexed' && (!/^\d+$/.test(String(body.index)) || !Number.isSafeInteger(Number(body.index)))) || Object.keys(body).some(key => !['kind', 'index', 'review_version'].includes(key))) throw new UnprocessableEntityException({ message: 'Refresh and choose the file to replace.' });
    let stored: string | null = null, committed = false;
    try {
      const result = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM documents WHERE id = ${docId} AND transaction_id = ${txnId} FOR UPDATE`;
        const doc = await tx.documents.findFirst({ where: { id: docId, transaction_id: txnId, deleted_at: null, pending_delete: false } }); if (!doc) throw new NotFoundException();
        if (documentReviewVersion(doc) !== body.review_version) throw new ConflictException({ message: 'This document changed. Refresh before replacing its file.' });
        if (doc.validation !== 'Valid' || doc.agent_accepted === 'Not Accepted') throw new UnprocessableEntityException({ message: 'This privileged action requires an accepted Valid document.' });
        let entries: { file_name?: string | null; file_path?: string | null; client_name?: string | null }[];
        try { entries = doc.files ? JSON.parse(doc.files) : []; } catch { throw new UnprocessableEntityException(); }
        if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== 'object')) throw new UnprocessableEntityException();
        const chosen = body.kind === 'primary' ? { file_path: doc.file_path, file_name: doc.file_name } : entries[Number(body.index)];
        if (!chosen || typeof chosen.file_path !== 'string' || !chosen.file_path) throw new NotFoundException({ message: 'File unavailable.' });
        stored = `documents/${txnId}/${randomBytes(20).toString('hex')}${path.extname(file.originalname)}`;
        await fs.mkdir(path.dirname(path.join(STORAGE_ROOT, stored)), { recursive: true }); await fs.writeFile(path.join(STORAGE_ROOT, stored), file.buffer, { flag: 'wx' });
        const replacement = { file_name: file.originalname, file_path: stored };
        await tx.documents.update({ where: { id: docId }, data: { ...(body.kind === 'primary' ? replacement : { files: JSON.stringify(entries.map((entry, index) => index === Number(body.index) ? { ...entry, ...replacement } : entry)) }), validation: 'Pending', drive_uploaded: 'No', reminder: false, updated_at: new Date() } });
        const stillReferenced = doc.validation_file_path === chosen.file_path || (body.kind === 'indexed' && doc.file_path === chosen.file_path) || entries.some((entry, index) => (body.kind === 'primary' || index !== Number(body.index)) && entry.file_path === chosen.file_path);
        return { doc, chosen, stillReferenced };
      });
      committed = true;
      if (!result.stillReferenced) await this.dispose(result.chosen.file_path!);
      const actor = { id: user.id, name: user.name };
      await this.audit.record(txnId, actor, { section: 'Legal & Documents', field: result.doc.title, action: 'Valid document file replaced — review reset', old: result.chosen.file_name, new: file.originalname });
      await this.validation.sync(txnId, actor);
      return { message: 'File replaced. Validation reset to Pending for review.' };
    } finally { if (!committed && stored) await this.dispose(stored); }
  }
  private async dispose(relative: string) { const absolute = path.resolve(STORAGE_ROOT, relative); if (!absolute.startsWith(STORAGE_ROOT + path.sep)) return; try { await fs.unlink(absolute); } catch { /* private cleanup best effort */ } }
}
