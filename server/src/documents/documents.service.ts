import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Prisma, type documents as DocRow } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { DocumentDefaultsService, documentKind } from './document-defaults.service';
import { DocsValidationService } from './docs-validation.service';
import { DocumentMailService } from './document-mail.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { isListingType } from '../reference/transaction.constants';
import { parseJson, toDateString } from '../common/serialize';
import type { AuthUserRecord } from '../auth/auth.types';
import { STORAGE_ROOT } from '../config/storage';

import { assertCan, can, isAgent } from '../core/authz';
import { ResourceAccessService } from '../core/resource-access.service';
const SECTION = 'Legal & Documents';
type Actor = AuthUserRecord | null;
type FileEntry = { client_name?: string | null; file_name?: string | null; file_path?: string | null };
interface UploadedFile { originalname: string; buffer: Buffer }

const isListingStatusFamily = (type: string | null): boolean => isListingType(type) || type === 'Business Sale';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly access: ResourceAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly defaults: DocumentDefaultsService,
    private readonly docsValidation: DocsValidationService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
    private readonly mail: DocumentMailService,
  ) {}

  private actor(u: Actor): ActingUser | null { return u ? { id: u.id, name: u.name } : null; }

  private async txnOr404(id: number): Promise<{ id: number; type: string; agent: string | null; property: string | null; trade_no: string; conditional_offer: boolean; reco_audit_ready: string | null; reco_audit_remarks: string | null }> {
    const t = await this.prisma.transactions.findFirst({ where: { id, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${id}.` });
    return t;
  }

  private async guardAgent(user: Actor, txn: { id: number; agent: string | null }): Promise<void> {
    if (user && isAgent(user)) {
      const name = user.name;
      const isMember = (await this.prisma.team_members.findFirst({ where: { transaction_id: txn.id, name } })) !== null;
      if (txn.agent !== name && !isMember) throw new ForbiddenException({ message: 'You do not have access to this transaction.' });
    }
  }

  private actorSource(user: Actor): string { return isAgent(user) ? 'Agent' : 'Manual'; }

  private async docs(txnId: number, extra: Prisma.documentsWhereInput = {}): Promise<DocRow[]> {
    return this.prisma.documents.findMany({ where: { transaction_id: txnId, deleted_at: null, ...extra }, orderBy: { position: 'asc' } });
  }

  private async maxPosition(txnId: number): Promise<number> {
    const r = await this.prisma.documents.aggregate({ where: { transaction_id: txnId, deleted_at: null }, _max: { position: true } });
    return r._max.position ?? 0;
  }

  private async statusList(txnId: number): Promise<string[]> {
    const rows = await this.prisma.transaction_statuses.findMany({ where: { transaction_id: txnId }, select: { status: true } });
    const list = rows.map((r) => r.status);
    return list.length ? list : ['Open'];
  }

  private async createDoc(txnId: number, data: Partial<DocRow>): Promise<DocRow> {
    const now = new Date();
    return this.prisma.documents.create({ data: { ...(data as Prisma.documentsUncheckedCreateInput), transaction_id: txnId, created_at: now, updated_at: now } });
  }

  // ---- index (seed + normalize) ----

  async index(user: Actor, txnId: number): Promise<Record<string, unknown>> {
    const txn = await this.txnOr404(txnId);
    await this.guardAgent(user, txn);

    if ((await this.prisma.documents.count({ where: { transaction_id: txnId, deleted_at: null, condition_id: null } })) === 0) {
      const rows = this.defaults.defaultsFor(txn.type);
      for (let i = 0; i < rows.length; i++) await this.createDoc(txnId, { title: rows[i].title, mandatory: rows[i].mandatory, position: i });
    }

    await this.prisma.documents.updateMany({ where: { transaction_id: txnId, deleted_at: null, mandatory: true }, data: { mandatory: false } });

    await this.stripFormNumberPrefixes(txnId);
    await this.ensureStatusDocs(txn);
    await this.normalizeLeaseAgreementDoc(txn);
    await this.normalizeFintracDoc(txnId);
    await this.ensureRecoGuide(txnId);
    await this.syncConditionDocs(txn);

    return this.payload(txnId);
  }

  private async stripFormNumberPrefixes(txnId: number): Promise<void> {
    for (const doc of await this.docs(txnId, { condition_id: null })) {
      const m = /^\d+\s*\((.+)\)\s*$/.exec(String(doc.title));
      if (m) await this.prisma.documents.update({ where: { id: doc.id }, data: { title: m[1].trim(), updated_at: new Date() } });
    }
  }

  private async ensureRecoGuide(txnId: number): Promise<void> {
    const exists = await this.prisma.documents.findFirst({ where: { transaction_id: txnId, deleted_at: null, condition_id: null, title: { contains: 'RECO Guide', mode: 'insensitive' } } });
    if (!exists) await this.createDoc(txnId, { title: 'RECO Guide', mandatory: false, position: (await this.maxPosition(txnId)) + 1 });
  }

  private async normalizeLeaseAgreementDoc(txn: { id: number; type: string }): Promise<void> {
    if (!txn.type.toLowerCase().includes('lease')) return;
    for (const doc of await this.docs(txn.id, { condition_id: null })) {
      if (doc.title.toLowerCase().includes('agreement of purchase')) await this.prisma.documents.update({ where: { id: doc.id }, data: { title: 'Agreement to Lease', updated_at: new Date() } });
    }
  }

  private async normalizeFintracDoc(txnId: number): Promise<void> {
    for (const doc of await this.docs(txnId, { condition_id: null })) {
      if (String(doc.title).trim().toLowerCase() === 'fintrac') await this.prisma.documents.update({ where: { id: doc.id }, data: { title: 'FINTRACK', updated_at: new Date() } });
    }
  }

  private async ensureStatusDocs(txn: { id: number; type: string }): Promise<void> {
    if (isListingStatusFamily(txn.type)) return;
    const statuses = await this.statusList(txn.id);
    const isMutualRelease = statuses.includes('Mutual Release');
    const isVoid = statuses.includes('Void');
    if (!isMutualRelease && !isVoid) return;

    const isLease = txn.type.toLowerCase().includes('lease');
    const docs = await this.docs(txn.id, { condition_id: null });
    const find = (needle: string): DocRow | undefined => docs.find((d) => d.title.toLowerCase().includes(needle));
    let pos = await this.maxPosition(txn.id);
    const ensure = async (needle: string, title: string): Promise<void> => {
      if (!find(needle)) { pos += 1; const c = await this.createDoc(txn.id, { title, mandatory: false, position: pos }); docs.push(c); }
    };
    if (isLease) await ensure('agreement to lease', 'Agreement to Lease');
    else await ensure('agreement of purchase', 'Agreement of Purchase and Sale');
    if (isMutualRelease) { await ensure('mutual release', 'Mutual Release'); await ensure('deposit receipt', 'Deposit Receipt'); }
  }

  private async syncConditionDocs(txn: { id: number; conditional_offer: boolean }): Promise<void> {
    const conditions = txn.conditional_offer ? await this.prisma.conditions.findMany({ where: { transaction_id: txn.id }, orderBy: { id: 'asc' } }) : [];
    const existingRows = await this.docs(txn.id, { condition_id: { not: null } });
    const existing = new Map<number, DocRow>();
    for (const d of existingRows) if (d.condition_id !== null) existing.set(d.condition_id, d);
    let pos = await this.maxPosition(txn.id);

    for (const c of conditions) {
      const name = c.custom_name || c.type;
      const title = `Condition: ${name}`;
      const doc = existing.get(c.id);
      if (doc) {
        if (doc.title !== title) await this.prisma.documents.update({ where: { id: doc.id }, data: { title, updated_at: new Date() } });
        existing.delete(c.id);
      } else {
        pos += 1;
        await this.createDoc(txn.id, { title, is_condition: true, condition_id: c.id, position: pos });
      }
    }
    // Orphans: condition removed → purge files + hard-delete.
    for (const orphan of existing.values()) {
      await this.purgeFiles(orphan);
      await this.prisma.documents.delete({ where: { id: orphan.id } });
    }
  }

  // ---- bulkUpdate ----

  async bulkUpdate(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const txn = await this.txnOr404(txnId);
    await this.guardAgent(user, txn);
    const data = this.validateBulk(body);
    const rows = data.documents as Record<string, unknown>[];

    if (user && isAgent(user)) {
      let pos = await this.maxPosition(txnId);
      for (const row of rows) {
        if (row.id) {
          if (Object.prototype.hasOwnProperty.call(row, 'agent_accepted')) {
            const doc = await this.prisma.documents.findFirst({ where: { id: Number(row.id), transaction_id: txnId, deleted_at: null } });
            if (doc && !doc.is_condition) {
              const accepted = (row.agent_accepted as string) || null;
              const upd: Prisma.documentsUpdateInput = { agent_accepted: accepted, updated_at: new Date() };
              if (accepted === 'Not Accepted') upd.reminder = false;
              if (String(doc.agent_accepted ?? '') !== String(accepted ?? '')) {
                await this.audit.record(txnId, this.actor(user), { section: SECTION, field: `${doc.title} — Acceptance`, action: 'Updated', old: String(doc.agent_accepted ?? ''), new: String(accepted ?? '') });
              }
              await this.prisma.documents.update({ where: { id: doc.id }, data: upd });
            }
          }
          continue;
        }
        pos += 1;
        const created = await this.createDoc(txnId, { title: String(row.title), mandatory: false, manual: true, status: 'Pending', validation: 'Pending', position: pos });
        await this.audit.record(txnId, this.actor(user), { section: SECTION, field: created.title, action: 'Document added' });
      }
      await this.docsValidation.sync(txnId, this.actor(user));
      return this.payload(txnId);
    }

    // Admin path.
    const keep: number[] = [];
    let reviewed = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const accepted = (row.agent_accepted as string) || null;
      const attrs: Prisma.documentsUncheckedUpdateInput = {
        title: String(row.title),
        mandatory: this.bool(row.mandatory),
        status: (row.status as string) ?? 'Pending',
        validation: (row.validation as string) ?? 'Pending',
        drive_uploaded: (row.drive_uploaded as string) || null,
        remarks: (row.remarks as string) ?? null,
        reminder: accepted === 'Not Accepted' ? false : this.bool(row.reminder),
        agent_accepted: accepted,
        position: i,
      };
      const existing = row.id ? await this.prisma.documents.findFirst({ where: { id: Number(row.id), transaction_id: txnId, deleted_at: null } }) : null;
      if (existing) {
        for (const [k, lbl] of [['title', 'Title'], ['status', 'Status'], ['validation', 'Validation']] as const) {
          const old = String((existing as unknown as Record<string, unknown>)[k] ?? '');
          const nw = String((attrs as Record<string, unknown>)[k] ?? '');
          if (old !== nw) {
            if (k === 'validation') reviewed = true;
            await this.audit.record(txnId, this.actor(user), { section: SECTION, field: `${existing.title} — ${lbl}`, action: 'Updated', old, new: nw });
          }
        }
        await this.prisma.documents.update({ where: { id: existing.id }, data: { ...attrs, updated_at: new Date() } });
        keep.push(existing.id);
      } else {
        const created = await this.createDoc(txnId, { ...(attrs as Partial<DocRow>), manual: true });
        keep.push(created.id);
        await this.audit.record(txnId, this.actor(user), { section: SECTION, field: created.title, action: 'Document added' });
      }
    }

    // Remove client-deleted rows (soft-delete, keep files). Condition rows + agent-flagged excluded.
    const toRemove = await this.prisma.documents.findMany({ where: { transaction_id: txnId, deleted_at: null, condition_id: null, pending_delete: false, id: { notIn: keep.length ? keep : [0] } }, orderBy: { position: 'asc' } });
    for (const d of toRemove) {
      await this.audit.record(txnId, this.actor(user), { section: SECTION, field: d.title, action: 'Document removed' });
      await this.prisma.documents.update({ where: { id: d.id }, data: { deleted_at: new Date(), updated_at: new Date() } });
    }

    if (Object.prototype.hasOwnProperty.call(data, 'reco_audit_ready')) {
      const ready = (data.reco_audit_ready as string) || null;
      const remarks = ready === 'No' ? ((data.reco_audit_remarks as string) ?? null) : null;
      const oldReady = String(txn.reco_audit_ready ?? '');
      if (oldReady !== String(ready ?? '')) {
        await this.audit.record(txnId, this.actor(user), { section: SECTION, field: 'Ready for RECO Audit', action: 'Updated', old: oldReady, new: String(ready ?? '') });
      }
      await this.prisma.transactions.update({ where: { id: txnId }, data: { reco_audit_ready: ready, reco_audit_remarks: remarks, updated_at: new Date() } });
    }

    if (reviewed) {
      const fresh = await this.prisma.documents.findMany({ where: { transaction_id: txnId, deleted_at: null, pending_delete: false } });
      const validCount = fresh.filter((d) => d.validation === 'Valid').length;
      const invalid = fresh.filter((d) => d.validation === 'Invalid');
      const parts = [`${validCount} valid`];
      if (invalid.length) parts.push(`${invalid.length} invalid (${invalid.slice(0, 3).map((d) => d.title).join(', ')})`);
      await this.audit.record(txnId, this.actor(user), { section: SECTION, field: 'Document Review', action: 'Documents reviewed', source: 'DocReview', details: parts.join(' · ') });
      // The agent is told the result of the review that just saved: what passed, and what did not
      // and why. Best-effort — see DocumentMailService.
      await this.mail.sendReviewOutcome(txnId);
    }

    await this.docsValidation.sync(txnId, this.actor(user));
    return this.payload(txnId);
  }

  // ---- file uploads ----

  private async findDocForTxn(txnId: number, docId: number): Promise<DocRow> {
    const d = await this.prisma.documents.findFirst({ where: { id: docId, deleted_at: null } });
    if (!d || d.transaction_id !== txnId) throw new NotFoundException({ message: '' });
    return d;
  }

  private guardAccepted(d: DocRow): void {
    if (d.agent_accepted === 'Not Accepted') throw new UnprocessableEntityException({ message: 'This document was marked "Not Accepted" — uploads are disabled for it.' });
  }

  private guardValidLocked(user: Actor, d: DocRow): void {
    if (d.validation === 'Valid' && !can(user, 'documents.override-valid')) throw new ForbiddenException({ message: 'This document is marked Valid — only a Super Admin can replace or delete it.' });
  }

  private async storeFile(txnId: number, file: UploadedFile): Promise<string> {
    const rel = `documents/${txnId}`;
    const dir = path.join(STORAGE_ROOT, rel);
    await fs.mkdir(dir, { recursive: true });
    const ext = path.extname(file.originalname);
    const name = crypto.randomBytes(20).toString('hex') + ext;
    await fs.writeFile(path.join(dir, name), file.buffer);
    return `${rel}/${name}`;
  }

  private async deleteFile(rel: string | null | undefined): Promise<void> {
    if (!rel) return;
    try { await fs.unlink(path.join(STORAGE_ROOT, rel)); } catch { /* best-effort */ }
  }

  async uploadFile(user: Actor, txnId: number, docId: number, file: UploadedFile | undefined): Promise<Record<string, unknown>> {
    const txn = await this.txnOr404(txnId);
    const document = await this.findDocForTxn(txnId, docId);
    await this.guardAgent(user, txn);
    this.guardAccepted(document);
    this.guardValidLocked(user, document);
    this.requireFile(file);

    if (isAgent(user) && document.file_path) {
      const pos = (await this.maxPosition(txnId)) + 1;
      const stored = await this.storeFile(txnId, file!);
      await this.createDoc(txnId, { title: document.title, mandatory: false, status: 'Received', validation: 'Pending', position: pos, file_name: file!.originalname, file_path: stored });
      await this.audit.record(txnId, this.actor(user), { section: SECTION, field: document.title, action: 'Document version added (previous kept)', new: file!.originalname, source: 'Agent' });
      await this.docsValidation.sync(txnId, this.actor(user));
      await this.notifyDealsDesk(user, txnId, document.title, file!.originalname, stored);
      return this.payload(txnId);
    }

    if (document.file_path) await this.deleteFile(document.file_path);
    const replaced = !!document.file_path;
    const p = await this.storeFile(txnId, file!);
    await this.prisma.documents.update({ where: { id: document.id }, data: { file_name: file!.originalname, file_path: p, status: 'Received', updated_at: new Date() } });
    await this.audit.record(txnId, this.actor(user), { section: SECTION, field: document.title, action: replaced ? 'Document replaced' : 'Document uploaded', new: file!.originalname, source: this.actorSource(user) });
    await this.docsValidation.sync(txnId, this.actor(user));
    await this.notifyDealsDesk(user, txnId, document.title, file!.originalname, p);
    return this.payload(txnId);
  }

  /**
   * Copy an agent's upload to the deals desk. Only an agent's — a document the office uploads itself
   * needs no notice, and sending one would mail the desk its own work.
   */
  private async notifyDealsDesk(user: Actor, txnId: number, title: string, fileName: string, relPath: string): Promise<void> {
    if (!isAgent(user)) return;
    await this.mail.notifyUpload(txnId, user?.name ?? null, title, fileName, relPath);
  }

  async uploadDocFile(user: Actor, txnId: number, docId: number, file: UploadedFile | undefined, clientName: string | null): Promise<Record<string, unknown>> {
    const txn = await this.txnOr404(txnId);
    const document = await this.findDocForTxn(txnId, docId);
    await this.guardAgent(user, txn);
    this.guardAccepted(document);
    this.guardValidLocked(user, document);
    this.requireFile(file);

    let files = (parseJson<FileEntry[]>(document.files) ?? []) as FileEntry[];
    if (clientName) {
      for (const f of files) if ((f.client_name ?? null) === clientName && f.file_path) await this.deleteFile(f.file_path);
      files = files.filter((f) => (f.client_name ?? null) !== clientName);
    }
    const stored = await this.storeFile(txnId, file!);
    files.push({ client_name: clientName, file_name: file!.originalname, file_path: stored });
    const status = await this.docStatusFromFiles(txnId, document, files);
    await this.prisma.documents.update({ where: { id: document.id }, data: { files: JSON.stringify(files), status, updated_at: new Date() } });
    await this.audit.record(txnId, this.actor(user), { section: SECTION, field: document.title + (clientName ? ` (${clientName})` : ''), action: 'Document uploaded', new: file!.originalname, source: this.actorSource(user) });
    await this.docsValidation.sync(txnId, this.actor(user));
    await this.notifyDealsDesk(user, txnId, document.title + (clientName ? ` (${clientName})` : ''), file!.originalname, stored);
    return this.payload(txnId);
  }

  private async docStatusFromFiles(txnId: number, document: DocRow, files: FileEntry[]): Promise<string> {
    if (documentKind(document) === 'per_client') {
      const clientRows = await this.prisma.clients.findMany({ where: { transaction_id: txnId }, select: { name: true } });
      const clients = [...new Set(clientRows.map((c) => c.name).filter((n) => n))];
      if (clients.length) {
        const uploaded = [...new Set(files.map((f) => f.client_name).filter((n) => n))];
        return clients.every((c) => uploaded.includes(c)) ? 'Received' : 'Pending';
      }
    }
    return files.length ? 'Received' : 'Pending';
  }

  async deleteDocFile(user: Actor, txnId: number, docId: number, index: number): Promise<Record<string, unknown>> {
    // The transaction is loaded here anyway; four sibling methods guard on it and these three
    // did not, so an agent with the transactions permission could alter the documents on any
    // deal in the brokerage by its id. Found by probing every write route as an agent who owns
    // nothing.
    const txn = await this.txnOr404(txnId);
    await this.guardAgent(user, txn);
    const document = await this.findDocForTxn(txnId, docId);
    this.guardValidLocked(user, document);
    const files = (parseJson<FileEntry[]>(document.files) ?? []) as FileEntry[];
    if (files[index]) {
      const removed = files[index].file_name ?? null;
      if (files[index].file_path) await this.deleteFile(files[index].file_path);
      files.splice(index, 1);
      const status = await this.docStatusFromFiles(txnId, document, files);
      await this.prisma.documents.update({ where: { id: document.id }, data: { files: JSON.stringify(files), status, updated_at: new Date() } });
      await this.audit.record(txnId, this.actor(user), { section: SECTION, field: document.title, action: 'Document file removed', old: removed });
    }
    await this.docsValidation.sync(txnId, this.actor(user));
    return this.payload(txnId);
  }

  async uploadValidationFile(user: Actor, txnId: number, docId: number, file: UploadedFile | undefined): Promise<Record<string, unknown>> {
    // The transaction is loaded here anyway; four sibling methods guard on it and these three
    // did not, so an agent with the transactions permission could alter the documents on any
    // deal in the brokerage by its id. Found by probing every write route as an agent who owns
    // nothing.
    const txn = await this.txnOr404(txnId);
    await this.guardAgent(user, txn);
    const document = await this.findDocForTxn(txnId, docId);
    this.requireFile(file);
    if (document.validation_file_path) await this.deleteFile(document.validation_file_path);
    await this.prisma.documents.update({ where: { id: document.id }, data: { validation_file_name: file!.originalname, validation_file_path: await this.storeFile(txnId, file!), updated_at: new Date() } });
    await this.audit.record(txnId, this.actor(user), { section: SECTION, field: document.title, action: 'Validation attachment uploaded', new: file!.originalname });
    await this.docsValidation.sync(txnId, this.actor(user));
    return this.payload(txnId);
  }

  async deleteValidationFile(user: Actor, txnId: number, docId: number): Promise<Record<string, unknown>> {
    // The transaction is loaded here anyway; four sibling methods guard on it and these three
    // did not, so an agent with the transactions permission could alter the documents on any
    // deal in the brokerage by its id. Found by probing every write route as an agent who owns
    // nothing.
    const txn = await this.txnOr404(txnId);
    await this.guardAgent(user, txn);
    const document = await this.findDocForTxn(txnId, docId);
    const removed = document.validation_file_name;
    if (document.validation_file_path) await this.deleteFile(document.validation_file_path);
    await this.prisma.documents.update({ where: { id: document.id }, data: { validation_file_name: null, validation_file_path: null, updated_at: new Date() } });
    await this.audit.record(txnId, this.actor(user), { section: SECTION, field: document.title, action: 'Validation attachment removed', old: removed });
    await this.docsValidation.sync(txnId, this.actor(user));
    return this.payload(txnId);
  }

  // ---- destroy / restore ----

  async destroy(user: Actor, docId: number): Promise<{ message: string }> {
    const document = await this.prisma.documents.findFirst({ where: { id: docId, deleted_at: null } });
    if (!document) throw new NotFoundException({ message: `No query results for model [App\\Models\\Document] ${docId}.` });
    if (user && isAgent(user)) throw new ForbiddenException({ message: 'Only an administrator can delete documents.' });
    this.guardValidLocked(user, document);
    const txn = await this.prisma.transactions.findUnique({ where: { id: document.transaction_id } });
    if (txn) await this.audit.record(txn.id, this.actor(user), { section: SECTION, field: document.title, action: 'Document deleted' });
    await this.prisma.documents.update({ where: { id: docId }, data: { deleted_at: new Date(), updated_at: new Date() } });
    if (txn && txn.deleted_at === null) await this.docsValidation.sync(txn.id, this.actor(user));
    return { message: 'Document deleted' };
  }

  async restore(user: Actor, docId: number): Promise<{ message: string }> {
    assertCan(user, 'documents.administer');
    const document = await this.prisma.documents.findFirst({ where: { id: docId, deleted_at: null } });
    if (!document) throw new NotFoundException({ message: `No query results for model [App\\Models\\Document] ${docId}.` });
    await this.prisma.documents.update({ where: { id: docId }, data: { pending_delete: false, deleted_by: null, updated_at: new Date() } });
    const txn = await this.prisma.transactions.findFirst({ where: { id: document.transaction_id, deleted_at: null } });
    if (txn) {
      await this.audit.record(txn.id, this.actor(user), { section: SECTION, field: document.title, action: 'Document restored' });
      await this.docsValidation.sync(txn.id, this.actor(user));
    }
    return { message: 'Document restored' };
  }

  // ---- reminders ----

  async sendReminders(user: Actor, txnId: number): Promise<Record<string, unknown>> {
    const txn = await this.txnOr404(txnId);
    if (user && isAgent(user)) throw new ForbiddenException({ message: 'Only an administrator can send document reminders.' });

    const all = await this.docs(txnId, { reminder: true, pending_delete: false });
    const docs = all.filter((d) => d.status !== 'Received' || d.validation === 'Invalid');
    if (docs.length === 0) throw new UnprocessableEntityException({ message: 'No documents are flagged for a reminder. Tick 🔔 on the pending/invalid documents first, Save, then send.' });

    const emails = await this.agentEmails(txn);
    if (emails.length === 0) throw new UnprocessableEntityException({ message: 'No agent email is on file for this transaction to send the reminder to.' });

    // An "invalid" line without the reason tells the agent something is wrong but not what to
    // fix, so they have to open the deal to find out. The reason lives in `remarks` — the same
    // text shown on the document in Legal & Documentation — so it goes in the email alongside
    // the title. Documents marked invalid with no reason recorded say so plainly rather than
    // rendering an empty trailing colon.
    // Styling is inline because mail clients drop <style> blocks: "Invalid" bold red so it is
    // impossible to miss when skimming, the reason red but NOT bold so the word itself still
    // stands out against it.
    const RED = '#dc2626';
    const list = '<ul>' + docs.map((d) => {
      if (d.validation !== 'Invalid') return '<li>' + this.e(d.title) + '</li>';
      const reason = (d.remarks ?? '').trim();
      const detail = reason
        ? `<span style="color:${RED}">${this.e(reason)}</span>`
        : `<span style="color:${RED}"><em>no reason recorded</em></span>`;
      return '<li>' + this.e(d.title)
        + ` — <strong style="color:${RED}">Invalid</strong>: ` + detail + '</li>';
    }).join('') + '</ul>';
    try {
      await this.mailer.send('document.pending_reminder', {
        agent_name: txn.agent, property_address: txn.property, transaction_number: txn.trade_no, pending_docs: list, company_name: (await this.settings.current()).name,
      }, emails);
    } catch (err) {
      throw new UnprocessableEntityException({ message: 'Could not send the reminder email: ' + ((err as { message?: string })?.message ?? '') });
    }

    await this.audit.record(txnId, this.actor(user), { section: SECTION, field: 'Document Reminder', action: 'Reminder sent', source: 'Quick Action', details: `${docs.length} document(s): ${docs.map((d) => d.title).join(', ')}` });
    return { message: `Reminder emailed to the agent for ${docs.length} document(s).`, count: docs.length, recipients: emails };
  }

  private async agentEmails(txn: { agent: string | null; id: number }): Promise<string[]> {
    const members = await this.prisma.team_members.findMany({ where: { transaction_id: txn.id }, select: { name: true } });
    const names = [...new Set([txn.agent, ...members.map((m) => m.name)].filter((n): n is string => !!n))];
    if (names.length === 0) return [];
    const users = await this.prisma.users.findMany({ where: { name: { in: names }, email: { not: '' } }, select: { email: true } });
    return [...new Set(users.map((u) => u.email).filter((e) => e))];
  }

  private e(s: string): string { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }

  // ---- download helpers (return the on-disk file) ----

  /**
   * Find a document and check the caller may have it.
   *
   * The three download routes used to take an id and stream whatever it pointed at, with no user
   * in scope at all — so any signed-in agent could fetch the contracts and identification on any
   * deal in the brokerage by walking the ids. Ownership is checked here, once, because all three
   * come through this method and a check added to only one of them is the same bug with fewer
   * routes.
   */
  private async ownedDocument(docId: number, user: Actor) {
    const d = await this.prisma.documents.findFirst({ where: { id: docId, deleted_at: null } });
    if (!d) throw new NotFoundException({ message: '' });
    await this.access.assertTransaction(user, d.transaction_id);
    return d;
  }

  async fileFor(docId: number, user: Actor = null): Promise<{ absPath: string; name: string }> {
    const d = await this.ownedDocument(docId, user);
    if (!d.file_path) throw new NotFoundException({ message: '' });
    const abs = path.join(STORAGE_ROOT, d.file_path);
    await this.assertExists(abs);
    return { absPath: abs, name: d.file_name ?? 'download' };
  }

  async docFileFor(docId: number, index: number, user: Actor = null): Promise<{ absPath: string; name: string }> {
    const d = await this.ownedDocument(docId, user);
    const files = parseJson<FileEntry[]>(d.files) ?? [];
    const f = files[index];
    if (!f || !f.file_path) throw new NotFoundException({ message: '' });
    const abs = path.join(STORAGE_ROOT, f.file_path);
    await this.assertExists(abs);
    return { absPath: abs, name: f.file_name ?? 'download' };
  }

  async validationFileFor(docId: number, user: Actor = null): Promise<{ absPath: string; name: string }> {
    const d = await this.ownedDocument(docId, user);
    if (!d.validation_file_path) throw new NotFoundException({ message: '' });
    const abs = path.join(STORAGE_ROOT, d.validation_file_path);
    await this.assertExists(abs);
    return { absPath: abs, name: d.validation_file_name ?? 'download' };
  }

  private async assertExists(abs: string): Promise<void> {
    try { await fs.access(abs); } catch { throw new NotFoundException({ message: '' }); }
  }

  // ---- payload ----

  async payload(txnId: number): Promise<Record<string, unknown>> {
    const txn = await this.prisma.transactions.findUnique({ where: { id: txnId }, select: { reco_audit_ready: true, reco_audit_remarks: true } });
    const allDocs = await this.docs(txnId);
    const deletedDocs = allDocs.filter((d) => d.pending_delete);
    const docs = allDocs.filter((d) => !d.pending_delete);
    const total = docs.length;
    const mandatory = docs.filter((d) => d.mandatory).length;
    const received = docs.filter((d) => d.status === 'Received').length;
    const pending = total - received;

    // Condition deadlines for condition docs.
    const condIds = docs.filter((d) => d.is_condition && d.condition_id !== null).map((d) => d.condition_id as number);
    const conds = condIds.length ? await this.prisma.conditions.findMany({ where: { id: { in: condIds } }, select: { id: true, deadline: true } }) : [];
    const deadlineFor = new Map(conds.map((c) => [c.id, c.deadline]));

    const clientRows = await this.prisma.clients.findMany({ where: { transaction_id: txnId }, orderBy: { position: 'asc' }, select: { name: true } });
    const clients = clientRows.map((c) => c.name).filter((n) => n !== null && n !== '');

    return {
      clients,
      reco_audit_ready: txn?.reco_audit_ready ?? null,
      reco_audit_remarks: txn?.reco_audit_remarks ?? null,
      documents: docs.map((d) => {
        const files = (parseJson<FileEntry[]>(d.files) ?? []) as FileEntry[];
        return {
          id: d.id,
          title: d.title,
          mandatory: !!d.mandatory,
          is_condition: !!d.is_condition,
          manual: !!d.manual,
          kind: documentKind(d),
          deadline: d.is_condition && d.condition_id !== null ? toDateString(deadlineFor.get(d.condition_id) ?? null) : null,
          status: d.status,
          validation: d.validation,
          drive_uploaded: d.drive_uploaded,
          reminder: !!d.reminder,
          agent_accepted: d.agent_accepted,
          remarks: d.remarks,
          file_name: d.file_name,
          has_file: !!d.file_path,
          validation_file_name: d.validation_file_name,
          has_validation_file: !!d.validation_file_path,
          files: files.map((f, idx) => ({ index: idx, client_name: f.client_name ?? null, file_name: f.file_name ?? null })),
          file_count: files.length,
        };
      }),
      deleted_documents: deletedDocs.map((d) => ({
        id: d.id,
        title: d.title,
        deleted_by: d.deleted_by,
        has_file: !!d.file_path,
        file_count: ((parseJson<FileEntry[]>(d.files) ?? []) as FileEntry[]).length,
      })),
      stats: { total, mandatory, received, pending, pct: total > 0 ? Math.round((received / total) * 100) : 0 },
    };
  }

  // ---- helpers ----

  private async purgeFiles(d: DocRow): Promise<void> {
    await this.deleteFile(d.file_path);
    await this.deleteFile(d.validation_file_path);
    for (const f of (parseJson<FileEntry[]>(d.files) ?? []) as FileEntry[]) await this.deleteFile(f.file_path);
  }

  private requireFile(file: UploadedFile | undefined): void {
    if (!file) throwValidation({ file: ['The file field is required.'] });
  }

  private bool(v: unknown): boolean { return v === true || v === 1 || v === '1' || v === 'true'; }

  private validateBulk(body: Record<string, unknown>): Record<string, unknown> {
    const errors: FieldErrors = {};
    const push = (f: string, m: string): void => { (errors[f] ??= []).push(m); };
    const empty = (v: unknown): boolean => v === undefined || v === null || v === '';

    if (!Object.prototype.hasOwnProperty.call(body, 'documents')) push('documents', 'The documents field must be present.');
    else if (!Array.isArray(body.documents)) push('documents', 'The documents field must be an array.');

    const rows = Array.isArray(body.documents) ? (body.documents as Record<string, unknown>[]) : [];
    rows.forEach((row, i) => {
      if (empty(row.title)) push(`documents.${i}.title`, `The documents.${i}.title field is required.`);
      else if (typeof row.title !== 'string') push(`documents.${i}.title`, `The documents.${i}.title field must be a string.`);
      else if ([...(row.title as string)].length > 255) push(`documents.${i}.title`, `The documents.${i}.title field must not be greater than 255 characters.`);
      const inRule = (f: string, allowed: string[]): void => { if (!empty(row[f]) && !allowed.includes(String(row[f]))) push(`documents.${i}.${f}`, `The selected documents.${i}.${f} is invalid.`); };
      inRule('status', ['Pending', 'Received']);
      inRule('validation', ['Pending', 'Valid', 'Invalid']);
      inRule('drive_uploaded', ['Yes', 'No']);
      inRule('agent_accepted', ['Accepted', 'Not Accepted']);
    });
    if (!empty(body.reco_audit_ready) && !['Yes', 'No'].includes(String(body.reco_audit_ready))) push('reco_audit_ready', 'The selected reco audit ready is invalid.');

    if (Object.keys(errors).length) throwValidation(errors);

    const out: Record<string, unknown> = { documents: rows };
    for (const k of ['reco_audit_ready', 'reco_audit_remarks']) if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
    return out;
  }
}
