import { checklistVisibility } from './checklist-visibility';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, type documents, type document_reminder_receipts } from '@prisma/client';
import type { AuthUserRecord } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { documentReviewVersion } from './document-review-version';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
export function remindable(doc: Pick<documents, 'status' | 'validation' | 'agent_accepted'>): boolean { return doc.validation !== 'Valid' && doc.agent_accepted !== 'Not Accepted' && (doc.status !== 'Received' || doc.validation === 'Invalid'); }
@Injectable()
export class DocumentReminderService {
 constructor(private readonly prisma: PrismaService, private readonly access: ResourceAccessService, private readonly audit: AuditService, private readonly mail: MailerService, private readonly settings: CompanySettingsService) {}
 private async authorize(user: AuthUserRecord | null, txnId: number): Promise<AuthUserRecord> { if (!user || !['admin','manager','accounting','documentation','crm'].includes(user.role)) throw new ForbiddenException(); await this.access.assertTransaction(user, txnId); return user; }
 private async snapshot(txnId: number, db: Prisma.TransactionClient = this.prisma) {
  const txn = await db.transactions.findFirst({ where: { id: txnId, deleted_at: null } }); if (!txn) throw new NotFoundException();
  const allDocs = await db.documents.findMany({ where: { transaction_id: txnId, deleted_at: null, pending_delete: false }, orderBy: { id: 'asc' }, take: 201 }); if (allDocs.length > 200) throw new UnprocessableEntityException({ message: 'Use the website for checklists larger than 200 documents.' });
  const statuses = await db.transaction_statuses.findMany({ where: { transaction_id: txnId }, select: { status: true } });
  const docs = allDocs.filter(checklistVisibility(txn.type, statuses.map(row => row.status)));
  const flagged = docs.filter(doc => doc.reminder && remindable(doc)), flagVersion = hash([txn.type, statuses.map(row => row.status).sort(), allDocs.map(documentReviewVersion)]);
  const members = await db.team_members.findMany({ where: { transaction_id: txnId }, select: { user_id: true, name: true } });
  const people = [{ user_id: txn.agent_user_id, name: txn.agent }, ...members];
  const recipients: { id: number; name: string; email: string }[] = []; let recipientError = '';
  for (const person of people) {
   if (!person.user_id && !person.name) continue;
   const users = await db.users.findMany({ where: { ...(person.user_id ? { id: person.user_id } : { name: person.name! }), status: 'Active' }, select: { id: true, name: true, email: true }, take: 2 });
   if (users.length !== 1 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(users[0].email)) { recipientError = 'An agent/team email is missing or ambiguous. Update transaction contacts before sending.'; continue; }
   const personUser = users[0]; if (!recipients.some(item => item.email.toLowerCase() === personUser.email.toLowerCase())) recipients.push(personUser);
  }
  if (!recipients.length) recipientError ||= 'No agent/team recipient is configured.'; if (recipients.length > 50) recipientError = 'Too many recipients for this reminder.';
  const list = '<ul>' + flagged.map(doc => `<li>${e(doc.title)}${doc.validation === 'Invalid' ? ` — <strong>Invalid</strong>: ${e(doc.remarks?.trim() || 'no reason recorded')}` : ''}</li>`).join('') + '</ul>';
  let prepared: Awaited<ReturnType<MailerService['prepareDocumentReminder']>> | null = null, senderError = '';
  try { prepared = await this.mail.prepareDocumentReminder({ agent_name: e(txn.agent), property_address: e(txn.property), transaction_number: e(txn.trade_no), pending_docs: list, company_name: e((await this.settings.current()).name) }); } catch (error) { senderError = error instanceof Error ? error.message : 'Desk sender unavailable.'; }
  const version = hash([flagVersion, txn.agent, txn.agent_user_id, txn.property, txn.trade_no, recipients, recipientError, prepared]);
  return { docs, flagged, flagVersion, version, recipients, recipientError, prepared, senderError };
 }
 async preview(user: AuthUserRecord | null, txnId: number) {
  await this.authorize(user, txnId); const s = await this.snapshot(txnId), enabled = process.env.DESK_DOCUMENT_REMINDERS_ENABLED === 'true';
  return { flag_version: s.flagVersion, send_version: s.version, delivery_enabled: enabled, can_send: enabled && !!s.prepared && !s.recipientError && s.flagged.length > 0, disabled_reason: !enabled ? 'Reminder delivery is disabled until provider acceptance.' : s.recipientError || s.senderError || (!s.flagged.length ? 'Flag pending/invalid documents first.' : null), documents: s.docs.map(doc => ({ id: doc.id, title: doc.title, status: doc.status, validation: doc.validation, remarks: doc.remarks, flagged: doc.reminder, eligible: remindable(doc) })), recipients: s.recipients, sender: s.prepared?.sender ?? null, subject: s.prepared?.subject ?? null, attachments: s.prepared?.attachments.map(file => ({ name: file.name, mime: file.mime })) ?? [] };
 }
 async flags(user: AuthUserRecord | null, txnId: number, body: Record<string, unknown>) {
  const actor = await this.authorize(user, txnId); if (!body || typeof body.flag !== 'boolean' || typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version) || Object.keys(body).some(key => !['flag','version'].includes(key))) throw new UnprocessableEntityException();
  const changed = await this.prisma.$transaction(async tx => {
   await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${txnId} FOR UPDATE`; await tx.$queryRaw`SELECT id FROM documents WHERE transaction_id = ${txnId} AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
   const s = await this.snapshot(txnId, tx); if (s.flagVersion !== body.version) throw new ConflictException({ message: 'Checklist changed. Refresh before changing reminders.' });
   let count = 0; for (const doc of s.docs) { const next = body.flag === true && remindable(doc); if (doc.reminder !== next) { await tx.documents.update({ where: { id: doc.id }, data: { reminder: next, updated_at: new Date() } }); count++; } } return count;
  });
  if (changed) await this.audit.record(txnId, { id: actor.id, name: actor.name }, { section: 'Legal & Documents', field: 'Document reminders', action: body.flag ? 'Reminders flagged' : 'Reminders cleared', details: `${changed} document flags changed; no email sent.` });
  return { changed };
 }
 private receipt(row: document_reminder_receipts) { return { request_id: row.request_id, status: row.status, document_count: row.document_count, recipient_count: row.recipient_count, created_at: row.created_at.toISOString() }; }
 async recover(user: AuthUserRecord | null, txnId: number, requestId: string) { const actor = await this.authorize(user, txnId); if (!uuid(requestId)) throw new UnprocessableEntityException(); const row = await this.prisma.document_reminder_receipts.findFirst({ where: { owner_user_id: actor.id, transaction_id: txnId, request_id: requestId } }); if (!row) throw new NotFoundException(); return this.receipt(row); }
 async send(user: AuthUserRecord | null, txnId: number, body: Record<string, unknown>) {
  const actor = await this.authorize(user, txnId); if (!body || !uuid(body.request_id) || typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version) || Object.keys(body).some(key => !['request_id','version'].includes(key))) throw new UnprocessableEntityException();
  const requestId = body.request_id, version = body.version;
  const claim = await this.prisma.$transaction(async tx => {
   await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${txnId} FOR UPDATE`;
   const existing = await tx.document_reminder_receipts.findUnique({ where: { owner_user_id_request_id: { owner_user_id: actor.id, request_id: requestId } } });
   if (existing) { if (existing.transaction_id !== txnId || existing.version !== version) throw new ConflictException(); return { row: existing, prepared: null, recipients: [] as string[] }; }
   if (process.env.DESK_DOCUMENT_REMINDERS_ENABLED !== 'true') throw new ServiceUnavailableException({ message: 'Reminder delivery is disabled.' });
   await tx.$queryRaw`SELECT id FROM documents WHERE transaction_id = ${txnId} AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
   const s = await this.snapshot(txnId, tx); if (s.version !== version) throw new ConflictException({ message: 'Reminder contents or recipients changed. Refresh and confirm again.' });
   if (!s.prepared || s.recipientError || !s.flagged.length) throw new UnprocessableEntityException({ message: s.recipientError || s.senderError || 'No eligible flagged documents.' });
   const row = await tx.document_reminder_receipts.create({ data: { owner_user_id: actor.id, transaction_id: txnId, request_id: requestId, version, status: 'sending', document_count: s.flagged.length, recipient_count: s.recipients.length } });
   return { row, prepared: s.prepared, recipients: s.recipients.map(person => person.email) };
  });
  if (!claim.prepared) return this.receipt(claim.row);
  let status = 'sent'; try { await this.mail.deliverDocumentReminderOnce(claim.prepared, claim.recipients); } catch { status = 'uncertain'; }
  const saved = await this.prisma.document_reminder_receipts.update({ where: { id: claim.row.id }, data: { status, updated_at: new Date() } });
  await this.audit.record(txnId, { id: actor.id, name: actor.name }, { section: 'Legal & Documents', field: 'Document reminder', action: status === 'sent' ? 'Reminder accepted by mail transport' : 'Reminder delivery unconfirmed', details: `${saved.document_count} documents; ${saved.recipient_count} recipients; request ${requestId}. Do not automatically resend.` }).catch(() => {});
  return this.receipt(saved);
 }
}
