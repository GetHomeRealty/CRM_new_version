import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_ROOT } from '../config/storage';
import { ALLOWED_DOC_EXT } from '../documents/documents.service';
import { throwValidation } from '../common/laravel-exceptions';
import { isSuperAdmin } from '../core/authz';
import { marketOf, type Market } from '../common/market';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * COMPANY DOCUMENTS (19 Oct 2026) - Settings -> Company Documents.
 *
 * The brokerage's own papers, one store per country (Canada's GetHomeRealty INC, India's Get Home
 * Realty Private Limited): certificates and documents of the kinds below or any other name, every
 * uploaded file kept as a version (newest first), with expiry reminders (CompanyDocumentReminderService);
 * and the company's stakeholders / partners, as many as needed, each with their own files.
 *
 * Who: Super Admin only (Sai). Which country: the one being worked in - the other country's papers
 * answer "not found", like every other India / Canada record.
 */
export const DOCUMENT_KINDS: Record<Market, readonly string[]> = {
  CA: [
    'Certificate of Incorporation', 'RECO Brokerage Registration', 'HST / Business Number', 'Errors & Omissions Insurance',
    'Liability Insurance', 'Bank Letter', 'Office Lease', 'Partner Agreement',
  ],
  IN: [
    'Certificate of Incorporation (CIN)', 'RERA Agent Registration', 'GST Certificate', 'PAN', 'TAN', 'Insurance',
    'Bank Letter', 'Office Lease', 'Partner Agreement',
  ],
};
/** "+ Add document": any other paper, by its own name. */
export const OTHER_KIND = 'Other';
export const STAKEHOLDER_ROLES = ['Director', 'Partner', 'Shareholder', 'Broker of Record', 'Other'] as const;
/** Suggested ID kinds per country; any other may be typed. */
export const ID_TYPES: Record<Market, readonly string[]> = {
  CA: ['Licence / registration number', 'Passport'],
  IN: ['PAN', 'DIN', 'Aadhaar', 'Passport'],
};
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type Actor = AuthUserRecord | null | undefined;
interface UploadedFile { originalname: string; buffer: Buffer; size?: number }

const text = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s.slice(0, max);
};
const dateOrNull = (v: unknown, field: string): Date | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throwValidation({ [field]: [`"${s}" is not a date (YYYY-MM-DD).`] });
  return new Date(`${s}T00:00:00Z`);
};
const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

@Injectable()
export class CompanyDocumentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Super Admin only, in the country being worked in. */
  private guard(user: Actor): Market {
    if (!isSuperAdmin(user)) throw new ForbiddenException({ message: 'Only a Super Admin can open the company documents.' });
    return marketOf(user);
  }

  private async log(user: Actor, market: Market, action: string, field: string, details?: string | null): Promise<void> {
    await this.audit.logModule(user ? { id: user.id, name: user.name } : null, 'Company Documents', {
      section: 'Company Documents', field, action, details: details ?? null, source: 'Manual', market,
    });
  }

  /** Whole calendar days until a date (negative once past). */
  static daysLeft(expiry: Date | null | undefined, today: Date): number | null {
    if (!expiry) return null;
    const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Math.round((expiry.getTime() - t) / 86_400_000);
  }

  // ---- the page --------------------------------------------------------

  async index(user: Actor) {
    const market = this.guard(user);
    const [docs, people] = await Promise.all([
      this.prisma.company_documents.findMany({
        where: { market, deleted_at: null },
        include: { files: { where: { deleted_at: null }, orderBy: [{ uploaded_at: 'desc' }, { id: 'desc' }] } },
        orderBy: [{ kind: 'asc' }, { title: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.company_stakeholders.findMany({
        where: { market, deleted_at: null },
        include: { files: { where: { deleted_at: null }, orderBy: [{ uploaded_at: 'desc' }, { id: 'desc' }] } },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const today = new Date();
    return {
      market,
      kinds: [...DOCUMENT_KINDS[market], OTHER_KIND],
      other_kind: OTHER_KIND,
      roles: STAKEHOLDER_ROLES,
      id_types: ID_TYPES[market],
      documents: docs.map((d) => this.docView(d, today)),
      stakeholders: people.map((p) => this.personView(p)),
    };
  }

  private fileView(f: { id: number; file_name: string; note: string | null; uploaded_at: Date }) {
    return { id: f.id, file_name: f.file_name, note: f.note, uploaded_at: f.uploaded_at };
  }

  private docView(d: Prisma.company_documentsGetPayload<{ include: { files: true } }>, today: Date) {
    const left = CompanyDocumentsService.daysLeft(d.expiry_date, today);
    return {
      id: d.id, kind: d.kind, title: d.title, number: d.number, issued_by: d.issued_by, holder: d.holder,
      contact_name: d.contact_name, contact_phone: d.contact_phone, contact_email: d.contact_email,
      issue_date: ymd(d.issue_date), expiry_date: ymd(d.expiry_date), notes: d.notes,
      days_left: left,
      expiry_status: left === null ? 'none' : left < 0 ? 'expired' : left <= 15 ? 'soon' : 'ok',
      files: d.files.map((f) => this.fileView(f)),
      updated_at: d.updated_at,
    };
  }

  private personView(p: Prisma.company_stakeholdersGetPayload<{ include: { files: true } }>) {
    return {
      id: p.id, name: p.name, role: p.role, share_pct: p.share_pct === null ? null : Number(p.share_pct),
      phone: p.phone, email: p.email, address: p.address,
      id_details: Array.isArray(p.id_details) ? p.id_details : [],
      joined_on: ymd(p.joined_on), left_on: ymd(p.left_on), notes: p.notes,
      files: p.files.map((f) => this.fileView(f)),
    };
  }

  // ---- documents -------------------------------------------------------

  private docFields(market: Market, body: Record<string, unknown>) {
    const kind = String(body.kind ?? '').trim();
    if (![...DOCUMENT_KINDS[market], OTHER_KIND].includes(kind)) throwValidation({ kind: ['Choose what kind of document this is (or "Other").'] });
    // A listed kind names itself; "Other" needs the name it goes by.
    const title = text(body.title) ?? (kind === OTHER_KIND ? null : kind);
    if (!title) throwValidation({ title: ['Write the document\'s name.'] });
    const issue = dateOrNull(body.issue_date, 'issue_date');
    const expiry = dateOrNull(body.expiry_date, 'expiry_date');
    if (issue && expiry && expiry < issue) throwValidation({ expiry_date: ['The expiry date is before the issue date.'] });
    const email = text(body.contact_email);
    if (email && !isEmail(email)) throwValidation({ contact_email: ['That is not an email address.'] });
    return {
      kind, title: title as string, number: text(body.number, 128), issued_by: text(body.issued_by), holder: text(body.holder),
      contact_name: text(body.contact_name), contact_phone: text(body.contact_phone, 64), contact_email: email,
      issue_date: issue, expiry_date: expiry, notes: text(body.notes, 5000),
    };
  }

  private async docOr404(market: Market, id: number) {
    const d = await this.prisma.company_documents.findFirst({ where: { id, market, deleted_at: null } });
    if (!d) throw new NotFoundException({ message: 'Document not found.' });
    return d;
  }

  async createDocument(user: Actor, body: Record<string, unknown>) {
    const market = this.guard(user);
    const now = new Date();
    const d = await this.prisma.company_documents.create({
      data: { ...this.docFields(market, body), market, created_by_id: user?.id ?? null, created_at: now, updated_at: now },
    });
    await this.log(user, market, 'Company document added', d.title, d.expiry_date ? `Expires ${ymd(d.expiry_date)}` : null);
    return { data: { id: d.id } };
  }

  async updateDocument(user: Actor, id: number, body: Record<string, unknown>) {
    const market = this.guard(user);
    const before = await this.docOr404(market, id);
    const f = this.docFields(market, body);
    // A new expiry date is a renewal: the reminders start again from that date.
    const moved = ymd(before.expiry_date) !== ymd(f.expiry_date);
    await this.prisma.company_documents.update({
      where: { id },
      data: { ...f, ...(moved ? { reminder_started_at: null, last_reminder_at: null } : {}), updated_at: new Date() },
    });
    await this.log(user, market, 'Company document updated', f.title, moved ? `Expiry ${ymd(before.expiry_date) ?? 'none'} -> ${ymd(f.expiry_date) ?? 'none'}` : null);
    return { data: { id } };
  }

  async deleteDocument(user: Actor, id: number) {
    const market = this.guard(user);
    const d = await this.docOr404(market, id);
    // Soft: the files stay on disk and the row stays for the record.
    await this.prisma.company_documents.update({ where: { id }, data: { deleted_at: new Date() } });
    await this.log(user, market, 'Company document removed', d.title);
    return { message: 'Document removed.' };
  }

  // ---- stakeholders ----------------------------------------------------

  private personFields(body: Record<string, unknown>) {
    const name = text(body.name);
    if (!name) throwValidation({ name: ['The name is required.'] });
    const role = String(body.role ?? 'Other');
    if (!(STAKEHOLDER_ROLES as readonly string[]).includes(role)) throwValidation({ role: [`Role must be one of: ${STAKEHOLDER_ROLES.join(', ')}.`] });
    const shareRaw = String(body.share_pct ?? '').trim();
    const share = shareRaw === '' ? null : Number(shareRaw);
    if (share !== null && (!Number.isFinite(share) || share < 0 || share > 100)) throwValidation({ share_pct: ['Share % must be between 0 and 100.'] });
    const email = text(body.email);
    if (email && !isEmail(email)) throwValidation({ email: ['That is not an email address.'] });
    const joined = dateOrNull(body.joined_on, 'joined_on');
    const left = dateOrNull(body.left_on, 'left_on');
    if (joined && left && left < joined) throwValidation({ left_on: ['The date left is before the date joined.'] });
    const ids = (Array.isArray(body.id_details) ? body.id_details : [])
      .map((x) => ({ type: text((x as Record<string, unknown>)?.type, 64), number: text((x as Record<string, unknown>)?.number, 128) }))
      .filter((x) => x.type || x.number);
    return {
      name: name as string, role, share_pct: share === null ? null : new Prisma.Decimal(share),
      phone: text(body.phone, 64), email, address: text(body.address, 2000), id_details: ids as Prisma.InputJsonValue,
      joined_on: joined, left_on: left, notes: text(body.notes, 5000),
    };
  }

  private async personOr404(market: Market, id: number) {
    const p = await this.prisma.company_stakeholders.findFirst({ where: { id, market, deleted_at: null } });
    if (!p) throw new NotFoundException({ message: 'Stakeholder not found.' });
    return p;
  }

  async createStakeholder(user: Actor, body: Record<string, unknown>) {
    const market = this.guard(user);
    const now = new Date();
    const last = await this.prisma.company_stakeholders.aggregate({ where: { market, deleted_at: null }, _max: { position: true } });
    const p = await this.prisma.company_stakeholders.create({
      data: { ...this.personFields(body), market, position: (last._max.position ?? -1) + 1, created_by_id: user?.id ?? null, created_at: now, updated_at: now },
    });
    // The ID numbers themselves are never written to the history.
    await this.log(user, market, 'Stakeholder added', p.name, p.role);
    return { data: { id: p.id } };
  }

  async updateStakeholder(user: Actor, id: number, body: Record<string, unknown>) {
    const market = this.guard(user);
    await this.personOr404(market, id);
    const f = this.personFields(body);
    await this.prisma.company_stakeholders.update({ where: { id }, data: { ...f, updated_at: new Date() } });
    await this.log(user, market, 'Stakeholder updated', f.name, f.role);
    return { data: { id } };
  }

  async deleteStakeholder(user: Actor, id: number) {
    const market = this.guard(user);
    const p = await this.personOr404(market, id);
    await this.prisma.company_stakeholders.update({ where: { id }, data: { deleted_at: new Date() } });
    await this.log(user, market, 'Stakeholder removed', p.name);
    return { message: 'Stakeholder removed.' };
  }

  // ---- files (both kinds) ----------------------------------------------

  private save(folder: string, owner: number, file: UploadedFile | undefined): { rel: string; name: string } {
    if (!file || !file.buffer?.length) throw new BadRequestException({ message: 'Choose a file to upload.' });
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_DOC_EXT.has(ext)) throwValidation({ file: [`"${ext || 'no extension'}" files cannot be uploaded. Use a PDF, image, Word or Excel file.`] });
    if (file.buffer.length > MAX_FILE_BYTES) throwValidation({ file: ['The file is larger than 25 MB.'] });
    const rel = path.posix.join(folder, String(owner), `${randomUUID()}${ext}`);
    const abs = path.join(STORAGE_ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.buffer);
    return { rel, name: path.basename(file.originalname).slice(0, 255) };
  }

  private absOf(rel: string): string {
    const abs = path.join(STORAGE_ROOT, rel);
    // The stored path is ours, but one that climbs out of storage is refused all the same.
    if (!path.resolve(abs).startsWith(path.resolve(STORAGE_ROOT)) || !fs.existsSync(abs)) throw new NotFoundException({ message: 'The file is missing.' });
    return abs;
  }

  async uploadDocumentFile(user: Actor, id: number, file: UploadedFile | undefined, note?: unknown) {
    const market = this.guard(user);
    const d = await this.docOr404(market, id);
    const s = this.save('company-documents', id, file);
    await this.prisma.company_document_files.create({
      data: { document_id: id, file_path: s.rel, file_name: s.name, note: text(note, 500), uploaded_by_id: user?.id ?? null, uploaded_at: new Date() },
    });
    await this.log(user, market, 'Company document file uploaded', d.title, s.name);
    return { data: { id } };
  }

  async uploadStakeholderFile(user: Actor, id: number, file: UploadedFile | undefined, note?: unknown) {
    const market = this.guard(user);
    const p = await this.personOr404(market, id);
    const s = this.save('company-stakeholders', id, file);
    await this.prisma.company_stakeholder_files.create({
      data: { stakeholder_id: id, file_path: s.rel, file_name: s.name, note: text(note, 500), uploaded_by_id: user?.id ?? null, uploaded_at: new Date() },
    });
    await this.log(user, market, 'Stakeholder file uploaded', p.name, s.name);
    return { data: { id } };
  }

  async documentFile(user: Actor, id: number, fileId: number): Promise<{ abs: string; name: string }> {
    const market = this.guard(user);
    await this.docOr404(market, id);
    const f = await this.prisma.company_document_files.findFirst({ where: { id: fileId, document_id: id, deleted_at: null } });
    if (!f) throw new NotFoundException({ message: 'File not found.' });
    return { abs: this.absOf(f.file_path), name: f.file_name };
  }

  async stakeholderFile(user: Actor, id: number, fileId: number): Promise<{ abs: string; name: string }> {
    const market = this.guard(user);
    await this.personOr404(market, id);
    const f = await this.prisma.company_stakeholder_files.findFirst({ where: { id: fileId, stakeholder_id: id, deleted_at: null } });
    if (!f) throw new NotFoundException({ message: 'File not found.' });
    return { abs: this.absOf(f.file_path), name: f.file_name };
  }

  /** Take a wrongly uploaded file off the list (kept on disk). */
  async removeDocumentFile(user: Actor, id: number, fileId: number) {
    const market = this.guard(user);
    const d = await this.docOr404(market, id);
    const f = await this.prisma.company_document_files.findFirst({ where: { id: fileId, document_id: id, deleted_at: null } });
    if (!f) throw new NotFoundException({ message: 'File not found.' });
    await this.prisma.company_document_files.update({ where: { id: fileId }, data: { deleted_at: new Date() } });
    await this.log(user, market, 'Company document file removed', d.title, f.file_name);
    return { message: 'File removed.' };
  }

  async removeStakeholderFile(user: Actor, id: number, fileId: number) {
    const market = this.guard(user);
    const p = await this.personOr404(market, id);
    const f = await this.prisma.company_stakeholder_files.findFirst({ where: { id: fileId, stakeholder_id: id, deleted_at: null } });
    if (!f) throw new NotFoundException({ message: 'File not found.' });
    await this.prisma.company_stakeholder_files.update({ where: { id: fileId }, data: { deleted_at: new Date() } });
    await this.log(user, market, 'Stakeholder file removed', p.name, f.file_name);
    return { message: 'File removed.' };
  }
}
