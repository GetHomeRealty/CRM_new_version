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
 * BUILDER OFFERS (stage 4, 17 Oct 2026).
 *
 * Builders give offers mostly in meetings, and no two look alike ("sell 3, get 1% extra on the
 * next", a fixed bonus, a discount...). So nothing is fixed in advance:
 *   - an offer is RECORDED when it is given - plain words first, with optional structure (kind,
 *     value, from which of our units it starts, dates) and the proof (the builder's letter/email);
 *   - the app COUNTS our units in each project (India deals linked to it that are not Void, Mutual
 *     Release or DFT), oldest offer date first, so every deal knows it is unit 1, 2, 3...;
 *   - on a deal in that project the app SUGGESTS which offers may apply ("this is unit 4");
 *   - a Super Admin CONFIRMS it on the deal and writes what was actually agreed.
 * The app never changes a commission by itself - builders' offers have too many exceptions to
 * calculate safely - and every confirmation is kept, with who and when, on the deal's history.
 */
export const OFFER_KINDS = ['extra_percent', 'fixed_bonus', 'discount', 'other'] as const;
const DEAD_STATUSES = ['Void', 'Mutual Release', 'DFT'];
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
const decOrNull = (v: unknown, field: string): Prisma.Decimal | null => {
  const raw = String(v ?? '').replace(/[,\s₹%]/g, '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throwValidation({ [field]: ['Enter a number, e.g. 1 or 50000.'] });
  return new Prisma.Decimal(n);
};
const num = (d: Prisma.Decimal | null | undefined): number | null => (d === null || d === undefined ? null : Number(d));
const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

@Injectable()
export class BuilderOffersService {
  constructor(private readonly prisma: PrismaService) {}

  private guard(user: Actor): void {
    if (!isSuperAdmin(user)) throw new ForbiddenException({ message: 'Only a Super Admin can manage builder offers.' });
    if (marketOf(user) !== 'IN') throw new NotFoundException({ message: 'Builder offers are kept in India. Switch to India to open them.' });
  }

  private async projectOr404(id: number) {
    const p = await this.prisma.builder_projects.findFirst({ where: { id, market: 'IN', deleted_at: null }, select: { id: true, name: true } });
    if (!p) throw new NotFoundException({ message: 'Project not found.' });
    return p;
  }

  private async offerOr404(id: number) {
    const o = await this.prisma.builder_project_offers.findFirst({ where: { id, deleted_at: null, project: { market: 'IN', deleted_at: null } } });
    if (!o) throw new NotFoundException({ message: 'Offer not found.' });
    return o;
  }

  /**
   * Our live units in a project, in order: unit 1 is the earliest offer date (then the earliest
   * entry). A deal that fell through (Void, Mutual Release, DFT) is not a unit sold.
   */
  async unitsOf(projectId: number): Promise<{ id: number; trade_no: string }[]> {
    return this.prisma.transactions.findMany({
      where: {
        builder_project_id: projectId, market: 'IN', deleted_at: null,
        transaction_statuses: { none: { status: { in: DEAD_STATUSES } } },
      },
      select: { id: true, trade_no: true },
      orderBy: [{ offer_date: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });
  }

  private view(o: Prisma.builder_project_offersGetPayload<{ include: { applications: { include: { transaction: { select: { id: true; trade_no: true; property: true } } } } } }>) {
    return {
      id: o.id, project_id: o.project_id, title: o.title, details: o.details, kind: o.kind, value: num(o.value),
      from_unit: o.from_unit, starts_on: ymd(o.starts_on), ends_on: ymd(o.ends_on),
      has_proof: !!o.proof_path, proof_name: o.proof_name, created_at: o.created_at,
      applications: o.applications.map((a) => ({
        id: a.id, transaction_id: a.transaction_id, trade_no: a.transaction.trade_no, property: a.transaction.property,
        unit_number: a.unit_number, agreed: a.agreed, agreed_value: num(a.agreed_value), applied_by: a.applied_by, applied_at: a.applied_at,
      })),
    };
  }

  private readonly INCLUDE = { applications: { include: { transaction: { select: { id: true, trade_no: true, property: true } } }, orderBy: { applied_at: 'desc' as const } } };

  async listForProject(user: Actor, projectId: number) {
    this.guard(user);
    await this.projectOr404(projectId);
    const [offers, units] = await Promise.all([
      this.prisma.builder_project_offers.findMany({ where: { project_id: projectId, deleted_at: null }, include: this.INCLUDE, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] }),
      this.unitsOf(projectId),
    ]);
    return { data: offers.map((o) => this.view(o)), units_sold: units.length };
  }

  private fields(body: Record<string, unknown>) {
    const title = text(body.title);
    if (!title) throwValidation({ title: ['Write what the builder offered, in a few words.'] });
    const kind = String(body.kind ?? 'other');
    if (!(OFFER_KINDS as readonly string[]).includes(kind)) throwValidation({ kind: ['Unknown offer kind.'] });
    const fromRaw = String(body.from_unit ?? '').trim();
    const from = fromRaw === '' ? null : Number(fromRaw);
    if (from !== null && (!Number.isInteger(from) || from < 1)) throwValidation({ from_unit: ['"From unit" must be a whole number, 1 or more.'] });
    const starts = dateOrNull(body.starts_on, 'starts_on');
    const ends = dateOrNull(body.ends_on, 'ends_on');
    if (starts && ends && ends < starts) throwValidation({ ends_on: ['The end date is before the start date.'] });
    return { title: title as string, details: text(body.details, 5000), kind, value: decOrNull(body.value, 'value'), from_unit: from, starts_on: starts, ends_on: ends };
  }

  private saveProof(offerKey: string, file: UploadedFile) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_DOC_EXT.has(ext)) throwValidation({ file: [`"${ext || 'no extension'}" files cannot be uploaded. Use a PDF, image, Word, Excel or email file.`] });
    if (file.buffer.length > MAX_FILE_BYTES) throwValidation({ file: ['The file is larger than 25 MB.'] });
    const rel = path.posix.join('builder-offers', offerKey, `proof-${randomUUID()}${ext}`);
    const abs = path.join(STORAGE_ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.buffer);
    return { proof_path: rel, proof_name: path.basename(file.originalname).slice(0, 255) };
  }

  async create(user: Actor, projectId: number, body: Record<string, unknown>, file?: UploadedFile) {
    this.guard(user);
    await this.projectOr404(projectId);
    const proof = file && file.buffer?.length ? this.saveProof(String(projectId), file) : {};
    await this.prisma.builder_project_offers.create({ data: { project_id: projectId, ...this.fields(body), ...proof, created_by_id: user?.id ?? null } });
    return this.listForProject(user, projectId);
  }

  async update(user: Actor, offerId: number, body: Record<string, unknown>, file?: UploadedFile) {
    this.guard(user);
    const o = await this.offerOr404(offerId);
    const proof = file && file.buffer?.length ? this.saveProof(String(o.project_id), file) : {};
    await this.prisma.builder_project_offers.update({ where: { id: offerId }, data: { ...this.fields(body), ...proof, updated_at: new Date() } });
    return this.listForProject(user, o.project_id);
  }

  /** Remove an offer that was entered by mistake. One already confirmed on a deal stays - end it instead. */
  async destroy(user: Actor, offerId: number) {
    this.guard(user);
    const o = await this.offerOr404(offerId);
    const used = await this.prisma.builder_offer_applications.count({ where: { offer_id: offerId } });
    if (used > 0) throwValidation({ offer: [`This offer is confirmed on ${used} deal(s). Set an end date instead of removing it.`] });
    await this.prisma.builder_project_offers.update({ where: { id: offerId }, data: { deleted_at: new Date() } });
    return this.listForProject(user, o.project_id);
  }

  async proof(user: Actor, offerId: number): Promise<{ abs: string; name: string }> {
    this.guard(user);
    const o = await this.offerOr404(offerId);
    if (!o.proof_path) throw new NotFoundException({ message: 'No proof was attached to this offer.' });
    const abs = path.join(STORAGE_ROOT, o.proof_path);
    if (!path.resolve(abs).startsWith(path.resolve(STORAGE_ROOT)) || !fs.existsSync(abs)) throw new NotFoundException({ message: 'The proof file is missing.' });
    return { abs, name: o.proof_name || path.basename(abs) };
  }

  /** Whether an offer is open on a day: started (or no start) and not ended (or no end). */
  static openOn(o: { starts_on: Date | null; ends_on: Date | null }, day: Date): boolean {
    const d = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    if (o.starts_on && o.starts_on.getTime() > d) return false;
    if (o.ends_on && o.ends_on.getTime() < d) return false;
    return true;
  }

  /**
   * For one India deal in a project: which unit it is, every offer on the project, and whether each
   * MAY apply (open on the deal's offer date - or today if it has none - and from_unit reached) and
   * whether it has been confirmed on this deal.
   */
  async forDeal(user: Actor, txnId: number) {
    this.guard(user);
    const t = await this.prisma.transactions.findFirst({
      where: { id: txnId, deleted_at: null, market: 'IN' },
      select: { id: true, builder_project_id: true, offer_date: true, linked_project: { select: { id: true, name: true } } },
    });
    if (!t) throw new NotFoundException({ message: 'Deal not found.' });
    if (!t.builder_project_id || !t.linked_project) return { project: null, unit_number: null, units_sold: 0, offers: [] };
    const units = await this.unitsOf(t.builder_project_id);
    const idx = units.findIndex((u) => u.id === t.id);
    const unit = idx >= 0 ? idx + 1 : null;
    const day = t.offer_date ?? new Date();
    const offers = await this.prisma.builder_project_offers.findMany({
      where: { project_id: t.builder_project_id, deleted_at: null }, include: this.INCLUDE, orderBy: [{ created_at: 'desc' }],
    });
    return {
      project: t.linked_project,
      unit_number: unit,
      units_sold: units.length,
      offers: offers.map((o) => {
        const applied = o.applications.find((a) => a.transaction_id === t.id) ?? null;
        const reached = o.from_unit === null || (unit !== null && unit >= o.from_unit);
        const open = BuilderOffersService.openOn(o, day);
        return {
          ...this.view(o),
          may_apply: !applied && reached && open,
          why_not: applied ? null : !reached ? `starts from unit ${o.from_unit}; this deal is unit ${unit ?? '?'}` : !open ? 'not open on this deal\'s offer date' : null,
          applied: applied ? { agreed: applied.agreed, agreed_value: num(applied.agreed_value), applied_by: applied.applied_by, applied_at: applied.applied_at, unit_number: applied.unit_number } : null,
        };
      }),
    };
  }

  /** Confirm an offer on a deal, with what was actually agreed. Written to the deal's history. */
  async apply(user: Actor, txnId: number, offerId: number, body: Record<string, unknown>) {
    this.guard(user);
    const info = await this.forDeal(user, txnId);
    const o = info.offers.find((x) => x.id === offerId);
    if (!o) throw new NotFoundException({ message: 'That offer is not on this deal\'s project.' });
    if (o.applied) throw new BadRequestException({ message: 'This offer is already confirmed on this deal.' });
    const agreed = text(body.agreed, 2000);
    if (!agreed) throwValidation({ agreed: ['Write what was actually agreed for this deal.'] });
    const value = decOrNull(body.agreed_value, 'agreed_value');
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.builder_offer_applications.create({
        data: { offer_id: offerId, transaction_id: txnId, unit_number: info.unit_number, agreed: agreed as string, agreed_value: value, applied_by_id: user?.id ?? null, applied_by: user?.name ?? null, applied_at: now },
      });
      await tx.audit_logs.create({
        data: {
          category: 'Transaction', domain: 'desk', transaction_id: txnId, who: user?.name ?? 'System', section: 'Builder offers', field: o.title,
          action: 'Offer confirmed', source: 'Desk', new_value: agreed, details: `Unit ${info.unit_number ?? '?'} of ${info.project?.name ?? 'the project'}`, created_at: now, updated_at: now,
        },
      });
    });
    return this.forDeal(user, txnId);
  }

  /** Take a confirmation back (entered on the wrong deal, say). Written to the deal's history. */
  async unapply(user: Actor, txnId: number, offerId: number) {
    this.guard(user);
    const a = await this.prisma.builder_offer_applications.findFirst({ where: { offer_id: offerId, transaction_id: txnId }, include: { offer: { select: { title: true } } } });
    if (!a) throw new NotFoundException({ message: 'That offer is not confirmed on this deal.' });
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.builder_offer_applications.delete({ where: { id: a.id } });
      await tx.audit_logs.create({
        data: { category: 'Transaction', domain: 'desk', transaction_id: txnId, who: user?.name ?? 'System', section: 'Builder offers', field: a.offer.title, action: 'Offer confirmation removed', source: 'Desk', old_value: a.agreed, created_at: now, updated_at: now },
      });
    });
    return this.forDeal(user, txnId);
  }
}
