import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { AuthUserRecord } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { AuditService } from '../audit/audit.service';
import { DocsValidationService } from './docs-validation.service';
import { documentReviewVersion } from './document-review-version';
import { documentKind } from './document-defaults.service';
import { recoVersion } from './reco-version';
import { STORAGE_ROOT } from '../config/storage';
type Actor = AuthUserRecord | null;
interface FileEntry { client_name?: string | null; file_name?: string | null; file_path?: string | null }
@Injectable()
export class ChecklistActionsService {
  constructor(private readonly prisma: PrismaService, private readonly access: ResourceAccessService, private readonly audit: AuditService, private readonly validation: DocsValidationService) {}
  private role(user: Actor, agents = false): asserts user is AuthUserRecord {
    if (!user || ![...['admin', 'manager', 'accounting', 'documentation', 'crm'], ...(agents ? ['agent'] : [])].includes(user.role)) throw new ForbiddenException();
  }
  async create(user: Actor, txnId: number, body: Record<string, unknown>): Promise<{ id: number; reused: boolean }> {
    this.role(user, true); await this.access.assertTransaction(user, txnId);
    if (!body || Object.keys(body).some(key => key !== 'title') || typeof body.title !== 'string' || !body.title.trim() || [...body.title.trim()].length > 255) throw new UnprocessableEntityException({ message: 'Enter a document title of 1–255 characters.' });
    const title = body.title.trim();
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${txnId} FOR UPDATE`;
      if (!await tx.transactions.findFirst({ where: { id: txnId, deleted_at: null } })) throw new NotFoundException();
      const existing = await tx.documents.findFirst({ where: { transaction_id: txnId, deleted_at: null, pending_delete: false, manual: true, title: { equals: title, mode: 'insensitive' } }, orderBy: { id: 'asc' } });
      if (existing) return { doc: existing, reused: true };
      const position = await tx.documents.aggregate({ where: { transaction_id: txnId }, _max: { position: true } });
      const doc = await tx.documents.create({ data: { transaction_id: txnId, title, manual: true, mandatory: false, status: 'Pending', validation: 'Pending', position: (position._max.position ?? 0) + 1, created_at: new Date(), updated_at: new Date() } });
      return { doc, reused: false };
    });
    if (!result.reused) {
      const actor = { id: user.id, name: user.name };
      await this.audit.record(txnId, actor, { section: 'Legal & Documents', field: result.doc.title, action: 'Document added' });
      await this.validation.sync(txnId, actor);
    }
    return { id: result.doc.id, reused: result.reused };
  }
  async readiness(user: Actor, txnId: number, body: Record<string, unknown>): Promise<{ message: string }> {
    this.role(user); await this.access.assertTransaction(user, txnId);
    if (!body || Object.keys(body).some(key => !['ready', 'remarks', 'version'].includes(key)) || ![null, 'Yes', 'No'].includes(body.ready as string | null) || typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version) || (body.remarks !== null && (typeof body.remarks !== 'string' || body.remarks.length > 5000))) throw new UnprocessableEntityException({ message: 'Invalid RECO readiness changes.' });
    const ready = body.ready as string | null, remarks = ready === 'No' ? body.remarks as string | null : null;
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${txnId} FOR UPDATE`;
      const txn = await tx.transactions.findFirst({ where: { id: txnId, deleted_at: null } }); if (!txn) throw new NotFoundException();
      if (recoVersion(txnId, txn.reco_audit_ready, txn.reco_audit_remarks) !== body.version) throw new ConflictException({ message: 'Readiness changed. Refresh before saving again.' });
      const changed = txn.reco_audit_ready !== ready || txn.reco_audit_remarks !== remarks;
      if (changed) await tx.transactions.update({ where: { id: txnId }, data: { reco_audit_ready: ready, reco_audit_remarks: remarks, updated_at: new Date() } });
      return { txn, changed };
    });
    if (result.changed) for (const [field, old, next] of [['Ready for RECO Audit', result.txn.reco_audit_ready, ready], ['RECO Audit Remarks', result.txn.reco_audit_remarks, remarks]]) if (old !== next) await this.audit.record(txnId, { id: user.id, name: user.name }, { section: 'Legal & Documents', field: field!, action: 'Updated', old, new: next });
    return { message: result.changed ? 'RECO readiness saved.' : 'Readiness unchanged.' };
  }
  async removeFile(user: Actor, txnId: number, docId: number, body: Record<string, unknown>): Promise<{ message: string }> {
    this.role(user); await this.access.assertTransaction(user, txnId);
    if (!body || !['primary', 'indexed'].includes(String(body.kind)) || Object.keys(body).some(key => !['kind', 'index', 'review_version'].includes(key)) || typeof body.review_version !== 'string' || !/^[a-f0-9]{64}$/.test(body.review_version) || (body.kind === 'indexed' && (!Number.isSafeInteger(body.index) || Number(body.index) < 0))) throw new UnprocessableEntityException({ message: 'Invalid file selection. Refresh the document.' });
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM documents WHERE id = ${docId} AND transaction_id = ${txnId} FOR UPDATE`;
      const doc = await tx.documents.findFirst({ where: { id: docId, transaction_id: txnId, deleted_at: null, pending_delete: false } }); if (!doc) throw new NotFoundException();
      if (documentReviewVersion(doc) !== body.review_version) throw new ConflictException({ message: 'Document files changed. Refresh before removing a file.' });
      if (doc.validation === 'Valid' && user.role !== 'admin') throw new ForbiddenException({ message: 'Only a Super Admin may remove a Valid document file.' });
      let entries: FileEntry[];
      try { entries = doc.files ? JSON.parse(doc.files) : []; } catch { throw new UnprocessableEntityException({ message: 'The stored attachment list needs review.' }); }
      if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== 'object')) throw new UnprocessableEntityException();
      const chosen = body.kind === 'primary' ? { file_path: doc.file_path, file_name: doc.file_name } : entries[Number(body.index)];
      if (!chosen || typeof chosen.file_path !== 'string' || !chosen.file_path) throw new NotFoundException({ message: 'File unavailable.' });
      const remaining = body.kind === 'indexed' ? entries.filter((_, index) => index !== Number(body.index)) : entries;
      const primary = body.kind === 'primary' ? null : doc.file_path;
      let status = primary || remaining.length ? 'Received' : 'Pending';
      if (documentKind(doc) === 'per_client') {
        const clients = await tx.clients.findMany({ where: { transaction_id: txnId }, select: { name: true } });
        const names = [...new Set(clients.map(client => client.name).filter((name): name is string => Boolean(name)))];
        if (names.length) status = names.every(name => remaining.some(entry => entry.client_name === name)) ? 'Received' : 'Pending';
      }
      await tx.documents.update({ where: { id: docId }, data: { ...(body.kind === 'primary' ? { file_path: null, file_name: null } : { files: JSON.stringify(remaining) }), status, updated_at: new Date() } });
      return { doc, chosen };
    });
    const absolute = path.resolve(STORAGE_ROOT, result.chosen.file_path!);
    if (absolute.startsWith(STORAGE_ROOT + path.sep)) { try { await fs.unlink(absolute); } catch { /* committed removal; private cleanup best effort */ } }
    const actor = { id: user.id, name: user.name };
    await this.audit.record(txnId, actor, { section: 'Legal & Documents', field: result.doc.title, action: 'Document file removed', old: result.chosen.file_name });
    await this.validation.sync(txnId, actor);
    return { message: 'File removed.' };
  }
}
