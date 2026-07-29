import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type company_settings } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { decimalCast, jsonField, laravelJsonDate, phpBlank, parseJsonObject, phpJsonNormalize } from '../common/serialize';
import type { UpdateCompanySettingsDto } from './dto/update-company-settings.dto';
import { trimPngTransparentBorder } from './image-trim';
import { STORAGE_ROOT } from '../config/storage';

const LOGO_DIR = 'branding';
/** A brand logo is a small asset; anything larger is a mistake, not a logo. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
/** Raster + SVG. Anything else is rejected — this file is rendered in customers' inboxes. */
const LOGO_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Canonical company details — mirrors CompanySetting::defaults(). */
const DEFAULTS: Record<string, string | number> = {
  name: 'GetHomeRealty INC',
  address: 'UNIT-101, 218 Export Blvd, Mississauga, L5S 0A7, Ontario, Canada',
  phone: '905-565-9933',
  email: 'info@GetHomeRealty.ca & Commissionpayouts@gethomerealty.ca',
  hst_number: '786493262RT0001',
  bank_beneficiary: 'GET HOME REALTY INC',
  bank_name: 'TD',
  transit_no: '21222',
  account_no: '5086185',
  institution_no: '004',
  currency: 'CAD',
  default_tax_rate: 13,
  invoice_prefix: 'INV-',
  default_terms: 'Due on Receipt',
  thank_you_note: 'Thank you for the payment. You just made our day.',
  deposit_heading: 'Beneficiary Bank Account Detail:',
};

@Injectable()
export class CompanySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** CompanySettingController::update — save present fields, audit, return the model. */
  async update(user: ActingUser | null, dto: UpdateCompanySettingsDto): Promise<company_settings> {
    const cur = await this.current(); // ensure the row exists (+ self-heal blanks) first
    // Only fields actually present in the request are saved (matches validated()).
    const data: Record<string, unknown> = {};
    const flags = parseJsonObject(cur.feature_flags);
    let flagsChanged = false;
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      // `lawyer_reminder_days` isn't a column — it lives inside the feature_flags JSON.
      if (k === 'lawyer_reminder_days') {
        flags.lawyer_reminder_days = Math.max(0, Math.floor(Number(v) || 0));
        flagsChanged = true;
      } else {
        data[k] = v;
      }
    }
    if (flagsChanged) data.feature_flags = JSON.stringify(phpJsonNormalize(flags));
    data.updated_at = new Date();

    const s = await this.prisma.company_settings.update({
      where: { id: 1 },
      data: data as Prisma.company_settingsUpdateInput,
    });
    await this.audit.logModule(user, 'Settings', {
      section: 'Company Settings',
      field: 'Company Settings',
      action: 'Settings updated',
      details: dto.name ?? null,
    });
    return s;
  }

  /** CompanySetting::current() — firstOrCreate(id=1) then self-heal blank fields. */
  async current(): Promise<company_settings> {
    let s = await this.prisma.company_settings.findUnique({ where: { id: 1 } });
    if (!s) s = await this.prisma.company_settings.create({ data: { id: 1 } });

    const fill: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (phpBlank((s as Record<string, unknown>)[key])) fill[key] = value;
    }
    if (Object.keys(fill).length > 0) {
      s = await this.prisma.company_settings.update({ where: { id: 1 }, data: fill });
    }
    return s;
  }

  // ------------------------------------------------------------------ logo
  /**
   * Store an uploaded brand logo and point `logo_path` at it. The previous file is removed
   * so the branding folder never accumulates orphans. The stored name is randomised, so a
   * re-upload always produces a new URL and no browser serves a stale cached logo.
   */
  async storeLogo(user: ActingUser | null, fileName: string, base64: string): Promise<company_settings> {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    const mime = LOGO_TYPES[ext];
    if (!mime) {
      throw new BadRequestException({
        message: `"${ext || fileName}" is not a supported image. Use ${Object.keys(LOGO_TYPES).join(', ')}.`,
      });
    }
    let buffer: Buffer;
    try { buffer = Buffer.from(String(base64 ?? ''), 'base64'); }
    catch { throw new BadRequestException({ message: 'The uploaded file could not be read.' }); }
    if (!buffer.length) throw new BadRequestException({ message: 'The uploaded file is empty.' });
    if (buffer.length > MAX_LOGO_BYTES) {
      throw new BadRequestException({
        message: `The logo is ${(buffer.length / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_LOGO_BYTES / 1024 / 1024} MB.`,
      });
    }

    // Logo exports are routinely centred on a big square canvas. That padding is pixels in
    // the file, so no styling can remove it — the mark would render with a thick empty band
    // above and below it on every letterhead. Trim it once, here, rather than everywhere.
    const trim = trimPngTransparentBorder(buffer);
    buffer = trim.buffer;

    const current = await this.current();
    const dir = path.join(STORAGE_ROOT, LOGO_DIR);
    await fs.mkdir(dir, { recursive: true });
    const name = `logo-${crypto.randomBytes(12).toString('hex')}${ext}`;
    await fs.writeFile(path.join(dir, name), buffer);

    const rel = `${LOGO_DIR}/${name}`;
    const saved = await this.prisma.company_settings.update({
      where: { id: 1 },
      data: { logo_path: rel, updated_at: new Date() },
    });
    await this.removeFile(current.logo_path);
    await this.audit.logModule(user, 'Settings', {
      section: 'Company Settings', field: 'Logo', action: 'Logo uploaded', details: fileName,
    });
    return saved;
  }

  /** Clear the logo — every surface falls back to the text wordmark. */
  async removeLogo(user: ActingUser | null): Promise<company_settings> {
    const current = await this.current();
    const saved = await this.prisma.company_settings.update({
      where: { id: 1 },
      data: { logo_path: null, updated_at: new Date() },
    });
    await this.removeFile(current.logo_path);
    await this.audit.logModule(user, 'Settings', {
      section: 'Company Settings', field: 'Logo', action: 'Logo removed', details: null,
    });
    return saved;
  }

  /** Absolute path + content type of the current logo, or null when none is set. */
  async logoFile(): Promise<{ abs: string; mime: string; size: number; mtime: number } | null> {
    const s = await this.current();
    if (!s.logo_path) return null;
    // Defend the storage root: logo_path is written by this service, but never trust a
    // database value with a filesystem read.
    const abs = path.resolve(STORAGE_ROOT, s.logo_path);
    if (!abs.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) return null;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return null;
      return { abs, mime: LOGO_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', size: stat.size, mtime: stat.mtimeMs };
    } catch {
      return null; // recorded but missing from disk — treated as "no logo"
    }
  }

  private async removeFile(rel: string | null | undefined): Promise<void> {
    if (!rel) return;
    const abs = path.resolve(STORAGE_ROOT, rel);
    if (!abs.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) return;
    try { await fs.unlink(abs); } catch { /* best-effort */ }
  }

  /** Serialize the model to JSON exactly as Laravel does (column order + casts). */
  serialize(s: company_settings): Record<string, unknown> {
    return {
      id: s.id,
      feature_flags: jsonField(s.feature_flags),
      name: s.name,
      address: s.address,
      phone: s.phone,
      email: s.email,
      logo_path: s.logo_path,
      hst_number: s.hst_number,
      bank_beneficiary: s.bank_beneficiary,
      bank_name: s.bank_name,
      transit_no: s.transit_no,
      account_no: s.account_no,
      institution_no: s.institution_no,
      currency: s.currency,
      default_tax_rate: decimalCast(s.default_tax_rate, 2),
      invoice_prefix: s.invoice_prefix,
      next_invoice_no: s.next_invoice_no,
      default_terms: s.default_terms,
      thank_you_note: s.thank_you_note,
      deposit_heading: s.deposit_heading,
      // Recurring lawyer-detail reminder cadence (days) — surfaced from feature_flags for the UI.
      lawyer_reminder_days: (() => { const n = Number(parseJsonObject(s.feature_flags).lawyer_reminder_days); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 3; })(),
      created_at: laravelJsonDate(s.created_at),
      updated_at: laravelJsonDate(s.updated_at),
    };
  }
}
