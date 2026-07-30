import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { type client_identifications } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { IdExtractionService } from './id-extraction.service';
import { throwValidation } from '../common/laravel-exceptions';
import { toIso8601String } from '../common/serialize';
import type { AuthUserRecord } from '../auth/auth.types';
import { STORAGE_ROOT } from '../config/storage';

import { isAgent } from '../core/authz';
const FIELDS = ['full_legal_name', 'address', 'dob', 'occupation', 'id_type', 'id_number', 'issuing_jurisdiction', 'country', 'expiry_date'] as const;
type Actor = AuthUserRecord | null;
type FileEntry = { client_name?: string | null; file_path?: string | null };

@Injectable()
export class ClientIdentificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypt: LaravelCryptService,
    private readonly extractor: IdExtractionService,
  ) {}

  private async guard(user: Actor, txnId: number): Promise<{ id: number; agent: string | null }> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });
    if (user && isAgent(user)) {
      const member = await this.prisma.team_members.findFirst({ where: { transaction_id: txnId, name: user.name } });
      if (t.agent !== user.name && !member) throw new ForbiddenException({ message: 'You do not have access to this transaction.' });
    }
    return t;
  }

  async show(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.guard(user, txnId);
    const client = this.requireString(body, 'client_name');
    const rec = await this.prisma.client_identifications.findFirst({ where: { transaction_id: txnId, client_name: client } });
    return this.present(rec, client);
  }

  async update(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.guard(user, txnId);
    const client = this.requireString(body, 'client_name');
    this.validateOptionalStrings(body);

    const existing = await this.prisma.client_identifications.findFirst({ where: { transaction_id: txnId, client_name: client } });
    const now = new Date();
    const enc: Record<string, string | null> = {};
    for (const f of FIELDS) { const v = body[f]; enc[f] = v === undefined || v === null || v === '' ? null : this.crypt.encryptString(String(v)); }
    const verified = body.verified !== undefined ? this.bool(body.verified) : (existing?.verified ?? false);

    if (existing) {
      await this.prisma.client_identifications.update({ where: { id: existing.id }, data: { ...enc, source: 'manual', verified, updated_at: now } });
    } else {
      await this.prisma.client_identifications.create({ data: { transaction_id: txnId, client_name: client, ...enc, source: 'manual', verified, created_at: now, updated_at: now } });
    }
    const fresh = await this.prisma.client_identifications.findFirst({ where: { transaction_id: txnId, client_name: client } });
    return this.present(fresh, client);
  }

  async extract(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.guard(user, txnId);
    const client = this.requireString(body, 'client_name');
    if (body.document_id === undefined || body.document_id === null || body.document_id === '') throwValidation({ document_id: ['The document id field is required.'] });
    if (!Number.isInteger(Number(body.document_id))) throwValidation({ document_id: ['The document id field must be an integer.'] });
    const documentId = Number(body.document_id);

    const document = await this.prisma.documents.findFirst({ where: { id: documentId, transaction_id: txnId, deleted_at: null } });
    if (!document) throw new NotFoundException({ message: 'Document not found.' });

    const files = (this.parse(document.files)).filter((f) => (f.client_name ?? null) === client && f.file_path);
    const file = files[0];
    const abs = file?.file_path ? path.join(STORAGE_ROOT, file.file_path) : null;
    if (!file || !abs || !(await this.exists(abs))) {
      throw new UnprocessableEntityException({ ok: false, message: 'No uploaded ID file found for this client.' });
    }

    const contents = await fs.readFile(abs);
    const mime = this.mimeFor(file.file_path!);
    const result = await this.extractor.extractIdFields(contents, mime);
    const existing = await this.prisma.client_identifications.findFirst({ where: { transaction_id: txnId, client_name: client } });

    if (!result.configured) {
      return { ok: false, configured: false, message: 'ID auto-extraction is not configured — enter the details manually.', identification: this.present(existing, client) };
    }

    const now = new Date();
    const isNew = !existing;
    const currentDecoded: Record<string, string | null> = {};
    for (const f of FIELDS) currentDecoded[f] = existing ? this.crypt.decryptString((existing as unknown as Record<string, string | null>)[f]) : null;

    let filled = 0;
    const enc: Record<string, string | null> = {};
    for (const f of FIELDS) {
      const val = result.fields[f] ?? null;
      if (val !== null && (currentDecoded[f] === null || currentDecoded[f] === '')) { currentDecoded[f] = val; filled++; }
      enc[f] = currentDecoded[f] === null ? (existing ? (existing as unknown as Record<string, string | null>)[f] : null) : this.crypt.encryptString(currentDecoded[f]!);
    }

    if (existing) {
      await this.prisma.client_identifications.update({ where: { id: existing.id }, data: { ...enc, extracted_at: now, updated_at: now } });
    } else {
      await this.prisma.client_identifications.create({ data: { transaction_id: txnId, client_name: client, ...enc, source: 'extracted', verified: false, extracted_at: now, created_at: now, updated_at: now } });
    }
    const fresh = await this.prisma.client_identifications.findFirst({ where: { transaction_id: txnId, client_name: client } });

    return {
      ok: result.ok,
      configured: true,
      filled,
      message: result.ok
        ? (filled ? `Extracted ${filled} field(s) from the ID — review and confirm in Form 630.` : 'No new fields extracted (existing values kept).')
        : 'Could not read the ID clearly — enter the details manually.',
      identification: this.present(fresh, client),
    };
    void isNew;
  }

  private present(rec: client_identifications | null, client: string): Record<string, unknown> {
    const out: Record<string, unknown> = {
      client_name: client,
      source: rec?.source ?? null,
      verified: !!rec?.verified,
      extracted_at: rec?.extracted_at ? toIso8601String(rec.extracted_at) : null,
    };
    for (const f of FIELDS) out[f] = rec ? this.crypt.decryptString((rec as unknown as Record<string, string | null>)[f]) : null;
    return out;
  }

  private requireString(body: Record<string, unknown>, field: string): string {
    if (body[field] === undefined || body[field] === null || body[field] === '') throwValidation({ [field]: [`The ${field.replace(/_/g, ' ')} field is required.`] });
    if (typeof body[field] !== 'string') throwValidation({ [field]: [`The ${field.replace(/_/g, ' ')} field must be a string.`] });
    return String(body[field]);
  }

  private validateOptionalStrings(body: Record<string, unknown>): void {
    for (const f of FIELDS) {
      if (body[f] !== undefined && body[f] !== null && typeof body[f] !== 'string') throwValidation({ [f]: [`The ${f.replace(/_/g, ' ')} field must be a string.`] });
    }
  }

  private bool(v: unknown): boolean { return v === true || v === 1 || v === '1' || v === 'true'; }
  private parse(json: string | null): FileEntry[] { if (!json) return []; try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; } }
  private async exists(abs: string): Promise<boolean> { try { await fs.access(abs); return true; } catch { return false; } }

  private mimeFor(rel: string): string {
    const ext = path.extname(rel).toLowerCase();
    const map: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    return map[ext] ?? 'application/octet-stream';
  }
}
