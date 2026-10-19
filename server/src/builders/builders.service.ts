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
import { marketOf } from '../common/market';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * INDIA BUILDER DATABASE (stage 3, 17 Oct 2026).
 *
 * The office's record of every Indian builder Get Home Realty works with: the builder, the people and
 * numbers to reach them (as many sales offices and sales persons as needed), and the ONE agreement
 * with that builder - its file, dates, commission and payment terms. The agreement's expiry is chased
 * by `BuilderAgreementReminderService`.
 *
 * Who: Super Admin only for now (Sai: new roles will follow), and only while working in India -
 * builders are India's, so from Canada the whole module answers "not found".
 */
export const CONTACT_KINDS = ['Sales office', 'Sales person', 'Other'] as const;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type Actor = AuthUserRecord | null | undefined;
interface UploadedFile { originalname: string; buffer: Buffer; size?: number }

const text = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s.slice(0, max);
};
const dateOrNull = (v: unknown): Date | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throwValidation({ date: [`"${s}" is not a date (YYYY-MM-DD).`] });
  return new Date(`${s}T00:00:00Z`);
};
const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

@Injectable()
export class BuildersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Super Admin, working in India. Anything else is refused before any data is read. */
  private guard(user: Actor): void {
    if (!isSuperAdmin(user)) throw new ForbiddenException({ message: 'Only a Super Admin can open the builder database.' });
    if (marketOf(user) !== 'IN') throw new NotFoundException({ message: 'Builders are kept in India. Switch to India to open them.' });
  }

  private async builderOr404(id: number) {
    const b = await this.prisma.builders.findFirst({
      where: { id, market: 'IN', deleted_at: null },
      include: { contacts: { orderBy: [{ position: 'asc' }, { id: 'asc' }] }, agreement: true },
    });
    if (!b) throw new NotFoundException({ message: 'Builder not found.' });
    return b;
  }

  /** Days until the agreement expires (negative once expired), counted in whole calendar days. */
  static daysLeft(expiry: Date | null | undefined, today = new Date()): number | null {
    if (!expiry) return null;
    const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Math.round((expiry.getTime() - t) / 86_400_000);
  }

  private view(b: Awaited<ReturnType<BuildersService['builderOr404']>>): Record<string, unknown> {
    const a = b.agreement;
    return {
      id: b.id,
      name: b.name,
      company_name: b.company_name,
      email: b.email,
      phone: b.phone,
      website: b.website,
      address: b.address,
      notes: b.notes,
      gstin: b.gstin,
      billing_address: b.billing_address,
      state: b.state,
      created_at: b.created_at,
      updated_at: b.updated_at,
      contacts: b.contacts.map((c) => ({ id: c.id, kind: c.kind, name: c.name, phone: c.phone, email: c.email })),
      agreement: a
        ? {
            start_date: ymd(a.start_date),
            expiry_date: ymd(a.expiry_date),
            days_left: BuildersService.daysLeft(a.expiry_date),
            commission_pct: a.commission_pct === null ? null : Number(a.commission_pct),
            payment_terms: a.payment_terms,
            file_name: a.file_name,
            has_file: !!a.file_path,
            file_uploaded_at: a.file_uploaded_at,
          }
        : null,
    };
  }

  async list(user: Actor, search?: string): Promise<{ data: Record<string, unknown>[] }> {
    this.guard(user);
    const q = (search ?? '').trim();
    const rows = await this.prisma.builders.findMany({
      where: {
        market: 'IN',
        deleted_at: null,
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { company_name: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      include: { contacts: { orderBy: [{ position: 'asc' }, { id: 'asc' }] }, agreement: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { data: rows.map((b) => this.view(b)) };
  }

  async show(user: Actor, id: number): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    return { data: this.view(await this.builderOr404(id)) };
  }

  /** The builder's own fields, checked. The name is the only required one. */
  private fields(body: Record<string, unknown>) {
    const name = text(body.name);
    if (!name) throwValidation({ name: ['The builder name is required.'] });
    return {
      name: name as string,
      company_name: text(body.company_name),
      email: text(body.email),
      phone: text(body.phone, 64),
      website: text(body.website),
      address: text(body.address, 2000),
      notes: text(body.notes, 5000),
      // For the India invoice - all optional (Sai, 19 Oct 2026).
      gstin: text(body.gstin, 32)?.toUpperCase() ?? null,
      billing_address: text(body.billing_address, 2000),
      state: text(body.state, 64),
    };
  }

  /** The contacts list as sent - replaces the stored list. Blank rows are dropped. */
  private contacts(body: Record<string, unknown>): Prisma.builder_contactsCreateManyBuilderInput[] | null {
    if (!Array.isArray(body.contacts)) return null;
    const now = new Date();
    return (body.contacts as Record<string, unknown>[])
      .map((c, i) => ({
        kind: (CONTACT_KINDS as readonly string[]).includes(String(c?.kind)) ? String(c.kind) : 'Other',
        name: text(c?.name), phone: text(c?.phone, 64), email: text(c?.email), position: i, created_at: now, updated_at: now,
      }))
      .filter((c) => c.name || c.phone || c.email);
  }

  /** The agreement's fields, when the form sent them. */
  private agreement(body: Record<string, unknown>) {
    const a = body.agreement as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object') return null;
    const start = dateOrNull(a.start_date);
    const expiry = dateOrNull(a.expiry_date);
    if (start && expiry && expiry < start) throwValidation({ 'agreement.expiry_date': ['The expiry date is before the start date.'] });
    const pctRaw = String(a.commission_pct ?? '').trim();
    const pct = pctRaw === '' ? null : Number(pctRaw);
    if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) throwValidation({ 'agreement.commission_pct': ['Commission % must be between 0 and 100.'] });
    return { start_date: start, expiry_date: expiry, commission_pct: pct === null ? null : new Prisma.Decimal(pct), payment_terms: text(a.payment_terms, 5000) };
  }

  async create(user: Actor, body: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    const now = new Date();
    const contacts = this.contacts(body) ?? [];
    const agreement = this.agreement(body);
    const b = await this.prisma.builders.create({
      data: {
        ...this.fields(body), market: 'IN', created_by_id: user?.id ?? null, created_at: now, updated_at: now,
        contacts: contacts.length ? { createMany: { data: contacts } } : undefined,
        agreement: agreement ? { create: { ...agreement, created_at: now, updated_at: now } } : undefined,
      },
    });
    return this.show(user, b.id);
  }

  async update(user: Actor, id: number, body: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    const existing = await this.builderOr404(id);
    const now = new Date();
    const contacts = this.contacts(body);
    const agreement = this.agreement(body);
    await this.prisma.$transaction(async (tx) => {
      await tx.builders.update({ where: { id }, data: { ...this.fields(body), updated_at: now } });
      if (contacts) {
        await tx.builder_contacts.deleteMany({ where: { builder_id: id } });
        if (contacts.length) await tx.builder_contacts.createMany({ data: contacts.map((c) => ({ ...c, builder_id: id })) });
      }
      if (agreement) {
        // A new expiry date starts the reminders afresh.
        const moved = ymd(existing.agreement?.expiry_date) !== ymd(agreement.expiry_date);
        await tx.builder_agreements.upsert({
          where: { builder_id: id },
          create: { builder_id: id, ...agreement, created_at: now, updated_at: now },
          update: { ...agreement, ...(moved ? { last_reminder_at: null, reminder_started_at: null } : {}), updated_at: now },
        });
      }
    });
    return this.show(user, id);
  }

  /** Soft delete: the builder leaves the list; its agreement file stays on disk for the record. */
  async destroy(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    await this.builderOr404(id);
    await this.prisma.builders.update({ where: { id }, data: { deleted_at: new Date() } });
    return { message: 'Builder removed.' };
  }

  /** Upload (or replace) the signed agreement file. */
  async uploadAgreementFile(user: Actor, id: number, file: UploadedFile | undefined): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    await this.builderOr404(id);
    if (!file || !file.buffer?.length) throw new BadRequestException({ message: 'Choose a file to upload.' });
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_DOC_EXT.has(ext)) throwValidation({ file: [`"${ext || 'no extension'}" files cannot be uploaded. Use a PDF, image, Word or Excel file.`] });
    if (file.buffer.length > MAX_FILE_BYTES) throwValidation({ file: ['The file is larger than 25 MB.'] });
    const rel = path.posix.join('builders', String(id), `agreement-${randomUUID()}${ext}`);
    const abs = path.join(STORAGE_ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.buffer);
    const now = new Date();
    await this.prisma.builder_agreements.upsert({
      where: { builder_id: id },
      create: { builder_id: id, file_path: rel, file_name: path.basename(file.originalname).slice(0, 255), file_uploaded_at: now, created_at: now, updated_at: now },
      update: { file_path: rel, file_name: path.basename(file.originalname).slice(0, 255), file_uploaded_at: now, updated_at: now },
    });
    return this.show(user, id);
  }

  /** The agreement file, for download. */
  async agreementFile(user: Actor, id: number): Promise<{ abs: string; name: string }> {
    this.guard(user);
    const b = await this.builderOr404(id);
    const rel = b.agreement?.file_path;
    if (!rel) throw new NotFoundException({ message: 'No agreement file has been uploaded.' });
    const abs = path.join(STORAGE_ROOT, rel);
    // The stored path is ours, but a path that climbs out of storage is refused all the same.
    if (!path.resolve(abs).startsWith(path.resolve(STORAGE_ROOT)) || !fs.existsSync(abs)) throw new NotFoundException({ message: 'The agreement file is missing.' });
    return { abs, name: b.agreement?.file_name || path.basename(abs) };
  }
}
