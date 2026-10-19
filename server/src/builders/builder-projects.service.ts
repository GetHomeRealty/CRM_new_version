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
import { BuildersService } from './builders.service';

/**
 * INDIA BUILDER PROJECTS (stage 3b, 17 Oct 2026).
 *
 * A builder's project, described with the same building blocks the precon website uses for its
 * projects (status, home types, location, starting price, occupancy, bedrooms, overview, files sorted
 * by kind) so it can be shown there later - plus what the office needs: RERA (number, dates,
 * certificate), the price history, the available-units PDFs, and which India deals are in it.
 *
 * Super Admin, working in India - the same rule as the builders (see BuildersService).
 */
export const PROJECT_STATUSES = ['Coming Soon', 'Registration', 'Now Selling', 'Sold Out'] as const;
export const HOME_TYPES = ['Apartment/Flat', 'Villa', 'Independent House', 'Row House', 'Plot', 'Commercial'] as const;
export const FILE_KINDS = ['rera_certificate', 'price_list', 'available_units', 'floor_plan', 'brochure', 'site_plan', 'photo', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type Actor = AuthUserRecord | null | undefined;
interface UploadedFile { originalname: string; buffer: Buffer }

const text = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s.slice(0, max);
};
const dateOrNull = (v: unknown, field: string): Date | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throwValidation({ [field]: [`"${s}" is not a date (YYYY-MM-DD).`] });
  return new Date(`${s}T00:00:00Z`);
};
const money = (v: unknown, field: string): Prisma.Decimal | null => {
  const raw = String(v ?? '').replace(/[,\s₹]/g, '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throwValidation({ [field]: ['Enter an amount in rupees, e.g. 7500000.'] });
  return new Prisma.Decimal(n);
};
const num = (d: Prisma.Decimal | null | undefined): number | null => (d === null || d === undefined ? null : Number(d));
const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

const PROJECT_INCLUDE = {
  builder: { select: { id: true, name: true, agreement: { select: { commission_pct: true } } } },
  files: { where: { deleted_at: null }, orderBy: [{ uploaded_at: 'desc' as const }, { id: 'desc' as const }] },
  prices: { orderBy: [{ changed_on: 'desc' as const }, { id: 'desc' as const }] },
  _count: { select: { transactions: { where: { deleted_at: null } } } },
};

@Injectable()
export class BuilderProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  private guard(user: Actor): void {
    if (!isSuperAdmin(user)) throw new ForbiddenException({ message: 'Only a Super Admin can open builder projects.' });
    if (marketOf(user) !== 'IN') throw new NotFoundException({ message: 'Builder projects are kept in India. Switch to India to open them.' });
  }

  private async projectOr404(id: number) {
    const p = await this.prisma.builder_projects.findFirst({ where: { id, market: 'IN', deleted_at: null }, include: PROJECT_INCLUDE });
    if (!p) throw new NotFoundException({ message: 'Project not found.' });
    return p;
  }

  private view(p: Awaited<ReturnType<BuilderProjectsService['projectOr404']>>): Record<string, unknown> {
    const builderPct = num(p.builder.agreement?.commission_pct);
    return {
      id: p.id,
      builder_id: p.builder_id,
      builder_name: p.builder.name,
      name: p.name,
      status: p.status,
      home_types: (p.home_types ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      state: p.state, city: p.city, locality: p.locality, address: p.address, overview: p.overview,
      starting_price: num(p.starting_price), max_price: num(p.max_price),
      bedrooms: p.bedrooms, occupancy: p.occupancy,
      commission_pct: num(p.commission_pct),
      // What applies: the project's own %, else the builder's agreement %.
      effective_commission_pct: num(p.commission_pct) ?? builderPct,
      builder_commission_pct: builderPct,
      rera: {
        number: p.rera_number,
        approved_on: ymd(p.rera_approved_on),
        valid_until: ymd(p.rera_valid_until),
        days_left: BuildersService.daysLeft(p.rera_valid_until),
      },
      files: p.files.map((f) => ({ id: f.id, kind: f.kind, file_name: f.file_name, note: f.note, uploaded_at: f.uploaded_at })),
      prices: p.prices.map((r) => ({ id: r.id, changed_on: ymd(r.changed_on), starting_price: num(r.starting_price), note: r.note, file_id: r.file_id })),
      deals: p._count.transactions,
      updated_at: p.updated_at,
    };
  }

  async list(user: Actor, builderId?: number): Promise<{ data: Record<string, unknown>[] }> {
    this.guard(user);
    const rows = await this.prisma.builder_projects.findMany({
      where: { market: 'IN', deleted_at: null, builder: { deleted_at: null }, ...(builderId ? { builder_id: builderId } : {}) },
      include: PROJECT_INCLUDE,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { data: rows.map((p) => this.view(p)) };
  }

  /** The short list an India deal picks its project from - any India user working in India may read it. */
  async pickList(user: Actor): Promise<{ data: { id: number; name: string; builder_name: string; city: string | null }[] }> {
    if (marketOf(user) !== 'IN') return { data: [] };
    const rows = await this.prisma.builder_projects.findMany({
      where: { market: 'IN', deleted_at: null, builder: { deleted_at: null } },
      select: { id: true, name: true, city: true, builder: { select: { name: true } } },
      orderBy: [{ name: 'asc' }],
    });
    return { data: rows.map((r) => ({ id: r.id, name: r.name, builder_name: r.builder.name, city: r.city })) };
  }

  async show(user: Actor, id: number): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    return { data: this.view(await this.projectOr404(id)) };
  }

  private fields(body: Record<string, unknown>) {
    const name = text(body.name);
    if (!name) throwValidation({ name: ['The project name is required.'] });
    const status = String(body.status ?? 'Coming Soon');
    if (!(PROJECT_STATUSES as readonly string[]).includes(status)) throwValidation({ status: [`Status must be one of: ${PROJECT_STATUSES.join(', ')}.`] });
    const types = (Array.isArray(body.home_types) ? body.home_types : String(body.home_types ?? '').split(','))
      .map((t) => String(t).trim()).filter((t) => (HOME_TYPES as readonly string[]).includes(t));
    const pctRaw = String(body.commission_pct ?? '').trim();
    const pct = pctRaw === '' ? null : Number(pctRaw);
    if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) throwValidation({ commission_pct: ['Commission % must be between 0 and 100.'] });
    const r = (body.rera ?? {}) as Record<string, unknown>;
    const approved = dateOrNull(r.approved_on, 'rera.approved_on');
    const valid = dateOrNull(r.valid_until, 'rera.valid_until');
    if (approved && valid && valid < approved) throwValidation({ 'rera.valid_until': ['RERA valid-until is before the approval date.'] });
    const start = money(body.starting_price, 'starting_price');
    const max = money(body.max_price, 'max_price');
    if (start && max && max.lessThan(start)) throwValidation({ max_price: ['The highest price is below the starting price.'] });
    return {
      name: name as string, status, home_types: types.length ? [...new Set(types)].join(',') : null,
      state: text(body.state, 128), city: text(body.city, 128), locality: text(body.locality), address: text(body.address, 2000),
      overview: text(body.overview, 5000), starting_price: start, max_price: max,
      bedrooms: text(body.bedrooms, 64), occupancy: text(body.occupancy, 64),
      commission_pct: pct === null ? null : new Prisma.Decimal(pct),
      rera_number: text(r.number, 128), rera_approved_on: approved, rera_valid_until: valid,
    };
  }

  async create(user: Actor, body: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    const builderId = Number(body.builder_id);
    const builder = Number.isInteger(builderId)
      ? await this.prisma.builders.findFirst({ where: { id: builderId, market: 'IN', deleted_at: null }, select: { id: true } })
      : null;
    if (!builder) throwValidation({ builder_id: ['Choose the builder this project belongs to.'] });
    const now = new Date();
    const p = await this.prisma.builder_projects.create({
      data: { ...this.fields(body), builder_id: builderId, market: 'IN', created_by_id: user?.id ?? null, created_at: now, updated_at: now },
    });
    return this.show(user, p.id);
  }

  async update(user: Actor, id: number, body: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    const existing = await this.projectOr404(id);
    const f = this.fields(body);
    // A new RERA valid-until date starts its reminders afresh.
    const moved = ymd(existing.rera_valid_until) !== ymd(f.rera_valid_until);
    await this.prisma.builder_projects.update({
      where: { id },
      data: { ...f, ...(moved ? { rera_last_reminder_at: null, rera_reminder_started_at: null } : {}), updated_at: new Date() },
    });
    return this.show(user, id);
  }

  async destroy(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const p = await this.projectOr404(id);
    if (p._count.transactions > 0) {
      throwValidation({ project: [`${p._count.transactions} deal(s) are linked to this project, so it cannot be removed.`] });
    }
    await this.prisma.builder_projects.update({ where: { id }, data: { deleted_at: new Date() } });
    return { message: 'Project removed.' };
  }

  /** Store a file of a kind. Every version is kept. */
  async uploadFile(user: Actor, id: number, kind: string, file: UploadedFile | undefined, note?: string): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    await this.projectOr404(id);
    const saved = await this.saveFile(user, id, kind, file, note);
    return { data: { file_id: saved.id, ...(await this.show(user, id)).data } };
  }

  private async saveFile(user: Actor, id: number, kind: string, file: UploadedFile | undefined, note?: string) {
    if (!(FILE_KINDS as readonly string[]).includes(kind)) throwValidation({ kind: [`File kind must be one of: ${FILE_KINDS.join(', ')}.`] });
    if (!file || !file.buffer?.length) throw new BadRequestException({ message: 'Choose a file to upload.' });
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_DOC_EXT.has(ext)) throwValidation({ file: [`"${ext || 'no extension'}" files cannot be uploaded. Use a PDF, image, Word or Excel file.`] });
    if (file.buffer.length > MAX_FILE_BYTES) throwValidation({ file: ['The file is larger than 25 MB.'] });
    const rel = path.posix.join('builder-projects', String(id), `${kind}-${randomUUID()}${ext}`);
    const abs = path.join(STORAGE_ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.buffer);
    return this.prisma.builder_project_files.create({
      data: { project_id: id, kind, file_path: rel, file_name: path.basename(file.originalname).slice(0, 255), note: text(note, 500), uploaded_by_id: user?.id ?? null },
    });
  }

  async file(user: Actor, id: number, fileId: number): Promise<{ abs: string; name: string }> {
    this.guard(user);
    await this.projectOr404(id);
    const f = await this.prisma.builder_project_files.findFirst({ where: { id: fileId, project_id: id, deleted_at: null } });
    if (!f) throw new NotFoundException({ message: 'File not found.' });
    const abs = path.join(STORAGE_ROOT, f.file_path);
    if (!path.resolve(abs).startsWith(path.resolve(STORAGE_ROOT)) || !fs.existsSync(abs)) throw new NotFoundException({ message: 'The file is missing.' });
    return { abs, name: f.file_name };
  }

  /** Take a file off the project. It stays on disk for the record. */
  async removeFile(user: Actor, id: number, fileId: number): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    await this.projectOr404(id);
    const f = await this.prisma.builder_project_files.findFirst({ where: { id: fileId, project_id: id, deleted_at: null } });
    if (!f) throw new NotFoundException({ message: 'File not found.' });
    await this.prisma.builder_project_files.update({ where: { id: fileId }, data: { deleted_at: new Date() } });
    return this.show(user, id);
  }

  /**
   * Record a price change: the date, the new starting price, a note, and optionally the price list
   * that came with it (stored as a price_list file). The project's starting price follows the newest.
   */
  async addPrice(user: Actor, id: number, body: Record<string, unknown>, file: UploadedFile | undefined): Promise<{ data: Record<string, unknown> }> {
    this.guard(user);
    await this.projectOr404(id);
    const changed = dateOrNull(body.changed_on, 'changed_on');
    if (!changed) throwValidation({ changed_on: ['Enter the date of the price change.'] });
    const price = money(body.starting_price, 'starting_price');
    const note = text(body.note, 1000);
    if (!price && !note && !file) throwValidation({ starting_price: ['Enter the new starting price, a note, or attach the price list.'] });
    const saved = file && file.buffer?.length ? await this.saveFile(user, id, 'price_list', file, `Price change ${ymd(changed)}`) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.builder_project_prices.create({
        data: { project_id: id, changed_on: changed as Date, starting_price: price, note, file_id: saved?.id ?? null, created_by_id: user?.id ?? null },
      });
      if (price) {
        const newest = await tx.builder_project_prices.findFirst({ where: { project_id: id, starting_price: { not: null } }, orderBy: [{ changed_on: 'desc' }, { id: 'desc' }] });
        if (newest?.starting_price) await tx.builder_projects.update({ where: { id }, data: { starting_price: newest.starting_price, updated_at: new Date() } });
      }
    });
    return this.show(user, id);
  }
}
