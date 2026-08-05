import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type company_settings } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { decimalCast, jsonField, laravelJsonDate, parseJsonObject, phpJsonNormalize } from '../common/serialize';
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

/**
 * Does this actually look like the image its extension claims?
 *
 * The extension was the only check. 22 bytes reading "MZ  not a PNG at all" were accepted, stored
 * and served back as `image/png` (measured 2026-08-04) — and that file is the letterhead of every
 * Invoice, Deposit Receipt, Lawyer Statement, Notice of Sale and Trade Sheet, plus the sign-in
 * screen. A corrupt logo is not a security problem; it is six broken documents nobody notices until
 * a client has one.
 *
 * Signatures only — the first few bytes each format is defined to start with. This is not image
 * decoding and is not trying to be: it catches the file that is not the thing it says it is, which
 * is the whole failure mode here.
 */
function looksLikeImage(ext: string, buf: Buffer): boolean {
  const startsWith = (...bytes: number[]): boolean =>
    buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

  switch (ext) {
    case '.png':
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case '.jpg':
    case '.jpeg':
      return startsWith(0xff, 0xd8, 0xff);
    case '.gif':
      return startsWith(0x47, 0x49, 0x46, 0x38);            // GIF8 (87a and 89a both)
    case '.webp':
      // RIFF....WEBP — the size field sits between the two markers.
      return startsWith(0x52, 0x49, 0x46, 0x46)
        && buf.length >= 12 && buf.subarray(8, 12).toString('ascii') === 'WEBP';
    case '.svg': {
      // Text, so there is no signature — but it has to contain an <svg root somewhere near the
      // start, after an optional XML declaration, BOM or comment.
      return /<svg[\s>]/i.test(buf.subarray(0, 2048).toString('utf8'));
    }
    default:
      return false;
  }
}

/**
 * Strip anything executable out of an uploaded SVG.
 *
 * WHAT THIS IS AND IS NOT. An SVG carrying `<script>` and `onload=` was accepted, stored, and served
 * from the API origin as `image/svg+xml` with the script bytes intact. It did NOT execute — helmet
 * sets `script-src 'self'; script-src-attr 'none'`, and Chromium refused it when the file was loaded
 * directly (verified 2026-08-04). So this is defence in depth, not a live hole: today one header
 * stands between a stored payload and a same-origin script, and that header is set for reasons that
 * have nothing to do with this file.
 *
 * Stripped at upload rather than sanitised on the way out, so the bytes on disk are the safe ones —
 * anything that ever serves this file, now or later, gets a clean one without having to know.
 */
function sanitizeSvg(buf: Buffer): Buffer {
  const cleaned = buf.toString('utf8')
    // <script>…</script>, and a self-closing or unterminated one.
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/?>/gi, '')
    // Inline event handlers: onload=, onclick=, quoted or bare.
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    // javascript: in href/xlink:href, and embedded foreign content.
    .replace(/(href|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '');
  return Buffer.from(cleaned, 'utf8');
}

/**
 * Written into the row THE FIRST TIME IT IS CREATED, and never again.
 *
 * WHAT THIS USED TO BE, AND WHY IT CHANGED. `current()` re-filled every blank field from this
 * constant on EVERY READ, and the constant carried the brokerage's real identity: its street
 * address, its HST registration, and its TD beneficiary, transit, institution and account numbers.
 * Two things followed from that, both measured during the 2026-08-04 audit:
 *
 *   - A field could not be cleared. Blanking the address or the account number returned 200, the
 *     screen showed it cleared, the blank was written — and the next read silently put the old
 *     value back, so the audit trail recorded a change that a read had already undone.
 *   - On any deployment that is not this brokerage — a second office, a white-label, a demo — a
 *     banking field left blank silently populated with ANOTHER COMPANY'S ACCOUNT NUMBER, and that
 *     number prints on the Deposit Receipt and the Lawyer Statement telling clients where to wire
 *     a trust deposit.
 *
 * So the identifying values are gone from source entirely. Everything they covered either has a
 * database default already (`name`, `currency`, `default_tax_rate`, `invoice_prefix`,
 * `next_invoice_no`, `default_terms` — see schema.prisma) or should start empty and be filled in by
 * the administrator, which is what the form is for. A blank field now stays blank.
 *
 * Existing deployments are untouched: the row already exists, so nothing here runs against them.
 */
const SEED_ON_CREATE: Record<string, string> = {
  thank_you_note: 'Thank you for the payment. You just made our day.',
  deposit_heading: 'Beneficiary Bank Account Detail:',
};

/**
 * Columns worth naming individually in the audit trail, in the words the Settings screen uses.
 *
 * Every save used to write ONE entry — `Settings updated`, details = the company name, `old_value`
 * and `new_value` null — so changing the operating bank account was byte-for-byte indistinguishable
 * from correcting a typo in the office phone number, and the previous value was recorded nowhere.
 * Payment redirection against a brokerage's trust deposits is the most expensive fraud in this
 * industry and these are the fields that decide where the money goes.
 */
const FIELD_LABELS: Record<string, string> = {
  name: 'Company Name',
  address: 'Address',
  phone: 'Phone',
  email: 'Email',
  hst_number: 'HST / Tax Number',
  bank_beneficiary: 'Beneficiary Name',
  bank_name: 'Bank Name',
  transit_no: 'Transit No.',
  account_no: 'Account No.',
  institution_no: 'Institution No.',
  currency: 'Currency',
  default_tax_rate: 'Default Tax Rate (%)',
  invoice_prefix: 'Invoice Prefix',
  next_invoice_no: 'Next Invoice No.',
  default_terms: 'Default Terms',
  thank_you_note: 'Thank-you Note',
  deposit_heading: 'Deposit Heading',
  lawyer_reminder_days: 'Lawyer Reminder (days)',
};

/**
 * The fields that decide where money goes, flagged with their own action string so the trail can be
 * filtered and alerted on without parsing a details sentence.
 */
const BANKING_FIELDS = new Set([
  'bank_beneficiary', 'bank_name', 'transit_no', 'account_no', 'institution_no', 'hst_number',
]);

@Injectable()
export class CompanySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** CompanySettingController::update — save present fields, audit each change, return the model. */
  async update(user: ActingUser | null, dto: UpdateCompanySettingsDto): Promise<company_settings> {
    const cur = await this.current(); // ensure the row exists first

    this.assertNotStale(cur, dto.expected_updated_at);
    this.assertNotesWithinLimit(cur, dto);
    await this.assertCounterNotRewound(cur, dto.next_invoice_no);

    // Only fields actually present in the request are saved (matches validated()).
    const data: Record<string, unknown> = {};
    const flags = parseJsonObject(cur.feature_flags);
    const beforeReminderDays = this.reminderDays(cur);
    let flagsChanged = false;
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      // Not a column — it carries the caller's view of the row, not a value to store.
      if (k === 'expected_updated_at') continue;
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

    await this.auditChanges(user, cur, s, beforeReminderDays, flagsChanged);
    return s;
  }

  /**
   * Refuse a save built on a copy of the row somebody else has already replaced.
   *
   * Two administrators loaded the same settings, both pressed Save, both got 200, and the second
   * silently discarded the first's work — with neither told anything (measured 2026-08-04). There is
   * no version column here, but `updated_at` is written on every save and is therefore exactly the
   * token needed; the editor echoes back the one it loaded.
   *
   * Compared to the SECOND, not the millisecond: `@db.Timestamp(0)` stores whole seconds, so the
   * value that goes out to the browser and the value stored can differ by sub-second noise
   * depending on how the date is serialised. Comparing at the resolution the column actually keeps
   * is the difference between a conflict check and a random refusal.
   *
   * A caller that sends nothing is unaffected — this is the screen's protection, not a new
   * requirement on the API.
   */
  private assertNotStale(cur: company_settings, expected: string | null | undefined): void {
    if (!expected) return;
    const seen = new Date(expected).getTime();
    if (Number.isNaN(seen)) return;   // unparseable is not a conflict; ignore rather than refuse
    const actual = cur.updated_at?.getTime() ?? 0;
    if (Math.floor(seen / 1000) === Math.floor(actual / 1000)) return;

    throw new ConflictException({
      message: 'These settings were changed by somebody else while this page was open. Reload to see their version, then make your change again — saving now would quietly overwrite it.',
    });
  }

  /**
   * Bound the two free-text invoice notes — but only when they are being changed.
   *
   * Both were `@IsString()` against a `Text` column with no ceiling at all: 100,000 characters were
   * accepted with 200, for a value printed on an invoice and a deposit receipt.
   *
   * WHY THIS IS NOT A DTO RULE. The screen loads the whole row and posts the whole row back, so a
   * validator on the field would reject an over-long value that was already stored — every save of
   * every OTHER field would 422 because of a note somebody pasted months ago, and the message would
   * point at a field the person never touched. That is the same shape as the findings this audit is
   * closing, and it was caught by these changes breaking their own regression suite.
   *
   * So: you may not introduce an over-long note, and you may not make an over-long one longer. You
   * may leave one alone, and you may shorten it. That is the rule the field actually needs.
   */
  private assertNotesWithinLimit(cur: company_settings, dto: UpdateCompanySettingsDto): void {
    const MAX = 2000;
    const notes: [keyof UpdateCompanySettingsDto, string | null, string][] = [
      ['thank_you_note', cur.thank_you_note, 'Thank-you Note'],
      ['deposit_heading', cur.deposit_heading, 'Deposit Heading'],
    ];
    for (const [key, stored, label] of notes) {
      const next = dto[key];
      if (typeof next !== 'string') continue;
      if (next === (stored ?? '')) continue;                 // unchanged — not this save's problem
      if (next.length <= MAX) continue;                      // within the limit
      if (next.length <= (stored ?? '').length) continue;    // shortening an over-long legacy value

      throw new BadRequestException({
        message: `The ${label} is ${next.length.toLocaleString()} characters — the limit is ${MAX.toLocaleString()}. It is printed on the invoice, so it has to fit on one.`,
        errors: { [key]: [`Must be ${MAX} characters or fewer.`] },
      });
    }
  }

  /**
   * Refuse a counter rewound onto a number that has already been printed on an invoice.
   *
   * `next_invoice_no` had `@Min(1)`, so setting it to 1 was accepted with 200 — rewinding a live
   * counter from 601107 onto six hundred thousand numbers already issued. `invoices.invoice_no` is
   * unique, so the damage surfaces as a failed invoice creation rather than a duplicate document,
   * which is the good outcome of a bad situation: whoever is trying to bill a client is the one who
   * finds out, at the moment they are trying to bill them.
   *
   * The check reads the Invoices table, which is another module's, and does so deliberately: this
   * column IS that module's counter, and there is no way to validate it without knowing what has
   * been issued. Read-only, one indexed lookup, no behaviour taken on.
   */
  private async assertCounterNotRewound(cur: company_settings, next: number | null | undefined): Promise<void> {
    if (next === null || next === undefined) return;
    if (next >= cur.next_invoice_no) return;   // holding or advancing is always fine

    const prefix = cur.invoice_prefix ?? 'INV-';
    // Only the continuous-counter invoices carry this prefix; the transaction-tied ones are
    // `GHR-<trade>` and are not drawn from this counter at all.
    const issued = await this.prisma.invoices.findMany({
      where: { invoice_no: { startsWith: prefix } },
      select: { invoice_no: true },
    });
    let highest = 0;
    for (const row of issued) {
      const n = Number(row.invoice_no.slice(prefix.length));
      if (Number.isInteger(n) && n > highest) highest = n;
    }
    if (highest === 0 || next > highest) return;

    throw new ConflictException({
      message: `Invoice ${prefix}${highest} has already been issued, so the next number cannot be set to ${next} — the counter would re-issue numbers already printed on a client's invoice. Set it to ${highest + 1} or higher.`,
    });
  }

  /**
   * One audit entry per field that actually changed, carrying what it was and what it became.
   *
   * Compared AFTER the write against the row as it was BEFORE it, rather than against the DTO —
   * a decimal column round-trips as a string, an absent key means "leave it alone", and comparing
   * the two rows is the only version of this that cannot report a change that did not happen.
   *
   * A save that changes nothing writes nothing. That is deliberate: a trail full of "Settings
   * updated" entries recording no change is how the previous version became unreadable, and an
   * empty result here is itself the useful fact.
   */
  private async auditChanges(
    user: ActingUser | null,
    before: company_settings,
    after: company_settings,
    beforeReminderDays: number,
    flagsChanged: boolean,
  ): Promise<void> {
    const a = before as unknown as Record<string, unknown>;
    const b = after as unknown as Record<string, unknown>;
    const changes: { column: string; old: string; next: string }[] = [];

    for (const column of Object.keys(FIELD_LABELS)) {
      if (column === 'lawyer_reminder_days') continue;   // not a column — handled below
      const old = this.auditValue(a[column]);
      const next = this.auditValue(b[column]);
      if (old !== next) changes.push({ column, old, next });
    }

    if (flagsChanged) {
      const old = String(beforeReminderDays);
      const next = String(this.reminderDays(after));
      if (old !== next) changes.push({ column: 'lawyer_reminder_days', old, next });
    }

    for (const { column, old, next } of changes) {
      const label = FIELD_LABELS[column];
      const banking = BANKING_FIELDS.has(column);
      await this.audit.logModule(user, 'Settings', {
        section: 'Company Settings',
        field: label,
        // Its own action string, so a bank-account substitution can be filtered for and alerted on
        // without reading through every phone-number correction.
        action: banking ? 'Banking details changed' : 'Settings updated',
        old,
        new: next,
        details: `${label}: ${old || '(blank)'} → ${next || '(blank)'}`,
      });
    }
  }

  /** Cleared and never-set are the same change to a reader, so both render as an empty string. */
  private auditValue(v: unknown): string {
    if (v === null || v === undefined) return '';
    // Decimal columns arrive as Prisma Decimal; String() gives the same text either way.
    return String(v);
  }

  private reminderDays(s: company_settings): number {
    const n = Number(parseJsonObject(s.feature_flags).lawyer_reminder_days);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 3;
  }

  /**
   * CompanySetting::current() — firstOrCreate(id=1).
   *
   * NO LONGER SELF-HEALS. It used to re-fill every blank field from a constant on every read, which
   * made a cleared field impossible and shipped one brokerage's bank account as another's default.
   * See `SEED_ON_CREATE`. A field left blank now stays blank, which is what the form says happens.
   */
  async current(): Promise<company_settings> {
    const existing = await this.prisma.company_settings.findUnique({ where: { id: 1 } });
    if (existing) return existing;
    // First run only. Everything else the row needs has a database default.
    return this.prisma.company_settings.create({ data: { id: 1, ...SEED_ON_CREATE } });
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

    // The extension said what this is; these bytes have to agree. See `looksLikeImage`.
    if (!looksLikeImage(ext, buffer)) {
      throw new BadRequestException({
        message: `That file is named "${fileName}" but its contents are not a valid ${ext.slice(1).toUpperCase()} image. Re-export it, or pick a different file.`,
      });
    }

    // Executable content out of the SVG before it is ever written to disk.
    if (ext === '.svg') buffer = sanitizeSvg(buffer);

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
