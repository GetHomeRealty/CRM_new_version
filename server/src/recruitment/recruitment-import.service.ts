import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { can } from '../core/authz';
import { RecruitmentService } from './recruitment.service';

/*
 * BULK CANDIDATE IMPORT — an .xlsx or CSV of new candidates, previewed, then imported.
 *
 * WHAT IT WILL AND WILL NOT DO. It creates candidates at status New, each with an optional first note,
 * by the same rules as "+ Add Candidate". It never sends email or texts, never books interviews or
 * follow-ups, never creates accounts, and never changes an existing candidate: a row that matches one
 * already recorded (same email, or same phone digits) is skipped, not merged.
 *
 * PREVIEW WRITES NOTHING. Import re-reads and re-checks the file from scratch — nothing the preview
 * said is trusted — and creates each candidate, its note and their history in ONE transaction, so a
 * failure leaves no half-made record. Within that transaction an advisory lock on the email and phone
 * makes a second click, a retry or a parallel import wait, re-check, and skip what the first created.
 */

export const IMPORT_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxRows: 500,
  name: 255,
  email: 255,
  phone: 64,
  phoneMinDigits: 7,
  phoneMaxDigits: 20,
  note: 5000,
  recruiterEmail: 255,
} as const;

export const IMPORT_HEADERS = ['Name', 'Email', 'Phone', 'Source', 'Recruiter Email', 'Note'] as const;
/** The same vocabulary as the Add Candidate form. */
export const IMPORT_SOURCES = ['referral', 'website', 'walk-in', 'agency', 'other'] as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Digits, spaces and the usual phone punctuation; a `+` only at the start; an optional extension. */
const PHONE_SHAPE = /^\+?[0-9 ().\-/]+(\s*(x|ext\.?)\s*[0-9]{1,6})?$/i;

type Field = 'name' | 'email' | 'phone' | 'source' | 'recruiter_email' | 'note';
const FIELD_FOR: Record<string, Field> = {
  name: 'name', email: 'email', phone: 'phone', source: 'source', 'recruiter email': 'recruiter_email', note: 'note',
};

/** One spreadsheet row as read: the row number people see in Excel, its values, and any problem reading it. */
export interface RawRow { row: number; values: Partial<Record<Field, string>>; readErrors: string[] }

export type RowStatus = 'valid' | 'duplicate' | 'error';
export interface CheckedRow {
  row: number;
  name: string; email: string; phone: string; source: string; recruiter_email: string; note: string;
  status: RowStatus;
  reasons: string[];
  /** Resolved at check time; re-resolved at import. */
  recruiter_id: number | null;
}

/** Digits only — the comparison key for phones. No country is assumed, so `+1 416…` and `416…` differ. */
export const phoneDigits = (phone: string): string => phone.replace(/\D/g, '');
const clean = (v: unknown): string => String(v ?? '').replace(/\r\n?/g, '\n').trim();

/** A cell that would run as a formula if the file were opened in a spreadsheet. */
const looksLikeFormula = (v: string): boolean => /^[=@]/.test(v);

// ---------------------------------------------------------------------------------- reading

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function mapHeaders(header: string[]): Map<number, Field> {
  const map = new Map<number, Field>();
  header.forEach((h, i) => {
    const f = FIELD_FOR[clean(h).toLowerCase().replace(/\s+/g, ' ')];
    if (f && ![...map.values()].includes(f)) map.set(i, f);
  });
  const have = new Set(map.values());
  const missing = (['name', 'email'] as Field[]).filter((f) => !have.has(f));
  if (missing.length) {
    throw new BadRequestException({
      message: `The first row must be the column headings: ${IMPORT_HEADERS.join(', ')}. Missing: ${missing.map((m) => (m === 'name' ? 'Name' : 'Email')).join(', ')}. Download the template to start from the right layout.`,
    });
  }
  return map;
}

function fromCsv(buffer: Buffer): RawRow[] {
  if (buffer.includes(0)) throw new BadRequestException({ message: 'That file is not a text CSV. Upload the .xlsx template or a CSV saved as text.' });
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const table = parseCsv(text);
  if (!table.length) throw new BadRequestException({ message: 'The file is empty.' });
  const map = mapHeaders(table[0]);
  const out: RawRow[] = [];
  table.slice(1).forEach((cells, i) => {
    const values: Partial<Record<Field, string>> = {};
    const readErrors: string[] = [];
    map.forEach((field, col) => {
      const v = clean(cells[col]);
      if (looksLikeFormula(v)) readErrors.push(`${labelOf(field)} starts with "${v[0]}", which a spreadsheet would treat as a formula. Enter a plain value.`);
      values[field] = v;
    });
    if (Object.values(values).some((v) => v) || readErrors.length) out.push({ row: i + 2, values, readErrors });
  });
  return out;
}

async function fromXlsx(buffer: Buffer): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException({ message: 'That file could not be read as an Excel workbook (.xlsx).' });
  }
  const sheet = wb.worksheets[0];
  if (!sheet) throw new BadRequestException({ message: 'The workbook has no sheets.' });
  const header: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { header[col - 1] = cell.text ?? ''; });
  const map = mapHeaders(header);
  const out: RawRow[] = [];
  const last = Math.min(sheet.rowCount, IMPORT_LIMITS.maxRows + 2);   // read just past the limit to detect it
  for (let r = 2; r <= last; r += 1) {
    const row = sheet.getRow(r);
    const values: Partial<Record<Field, string>> = {};
    const readErrors: string[] = [];
    map.forEach((field, col) => {
      const cell = row.getCell(col + 1);
      if (cell.type === ExcelJS.ValueType.Formula || cell.formula) {
        readErrors.push(`${labelOf(field)} is a formula. Enter a plain value.`);
        values[field] = '';
        return;
      }
      /*
       * A PHONE STORED AS A NUMBER has already lost any leading zero or "+" — Excel dropped them when
       * it was typed — and there is no way to tell what it was. Refused with the fix, rather than
       * imported with digits that may be wrong. The template formats the column as text.
       */
      if (field === 'phone' && cell.type === ExcelJS.ValueType.Number) {
        readErrors.push('Phone is stored as a number, so a leading zero or "+" may have been lost. Format the Phone column as Text and type it again.');
      }
      const v = clean(cell.text);
      if (looksLikeFormula(v)) readErrors.push(`${labelOf(field)} starts with "${v[0]}", which a spreadsheet would treat as a formula. Enter a plain value.`);
      values[field] = v;
    });
    if (Object.values(values).some((v) => v) || readErrors.length) out.push({ row: r, values, readErrors });
  }
  return out;
}

const labelOf = (f: Field): string => ({ name: 'Name', email: 'Email', phone: 'Phone', source: 'Source', recruiter_email: 'Recruiter Email', note: 'Note' })[f];

/** Read the uploaded file. Only .xlsx and .csv, within the size and row limits. */
export async function readImportFile(filename: string, contentBase64: string): Promise<RawRow[]> {
  const name = clean(filename).toLowerCase();
  const ext = name.endsWith('.xlsx') ? 'xlsx' : name.endsWith('.csv') ? 'csv' : null;
  if (!ext) throw new BadRequestException({ message: 'Upload an Excel .xlsx file or a .csv file. Older .xls files and other formats are not supported.' });
  const b64 = String(contentBase64 ?? '');
  if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new BadRequestException({ message: 'No file was received.' });
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw new BadRequestException({ message: 'The file is empty.' });
  if (buffer.length > IMPORT_LIMITS.maxFileBytes) {
    throw new BadRequestException({ message: `The file is larger than ${IMPORT_LIMITS.maxFileBytes / (1024 * 1024)} MB. Split it into smaller files.` });
  }
  if (ext === 'xlsx' && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw new BadRequestException({ message: 'That file is not a real .xlsx workbook. Save it from Excel as "Excel Workbook (.xlsx)".' });
  }
  const rows = ext === 'xlsx' ? await fromXlsx(buffer) : fromCsv(buffer);
  if (!rows.length) throw new BadRequestException({ message: 'The file has headings but no candidate rows.' });
  if (rows.length > IMPORT_LIMITS.maxRows) {
    throw new BadRequestException({ message: `The file has more than ${IMPORT_LIMITS.maxRows} candidate rows. Split it into files of ${IMPORT_LIMITS.maxRows} or fewer.` });
  }
  return rows;
}

// ---------------------------------------------------------------------------------- the service

@Injectable()
export class RecruitmentImportService {
  private readonly log = new Logger(RecruitmentImportService.name);

  constructor(private readonly prisma: PrismaService, private readonly recruitment: RecruitmentService) {}

  /** The template: headings, a text-formatted Phone column, a Source drop-down, and an instructions sheet. */
  async template(): Promise<{ filename: string; content_base64: string }> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Candidates');
    ws.columns = [
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Email', key: 'email', width: 32 },
      { header: 'Phone', key: 'phone', width: 20, style: { numFmt: '@' } },
      { header: 'Source', key: 'source', width: 14 },
      { header: 'Recruiter Email', key: 'recruiter', width: 30 },
      { header: 'Note', key: 'note', width: 50 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (let r = 2; r <= IMPORT_LIMITS.maxRows + 1; r += 1) {
      ws.getCell(`C${r}`).numFmt = '@';
      ws.getCell(`D${r}`).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`"${IMPORT_SOURCES.join(',')}"`],
        showErrorMessage: true, errorTitle: 'Source', error: `Choose one of: ${IMPORT_SOURCES.join(', ')} — or leave it blank.`,
      };
    }
    const help = wb.addWorksheet('Instructions');
    help.getColumn(1).width = 110;
    [
      'How to fill in the Candidates sheet',
      '',
      'Name and Email are required. Everything else is optional.',
      `Phone is kept exactly as typed, including "+" country codes and leading zeros. The column is formatted as Text — keep it that way.`,
      `Source: one of ${IMPORT_SOURCES.join(', ')} — or blank.`,
      'Recruiter Email: the exact email of an active user. Only administrators may assign someone other than themselves; leave blank to use the usual default.',
      `Note: saved as the candidate's first note (up to ${IMPORT_LIMITS.note} characters).`,
      'Every imported candidate starts at status New. No emails are sent and no interviews, follow-ups or accounts are created.',
      'A row with the same email, or the same phone digits, as an existing candidate or an earlier row is skipped — existing records are never changed.',
      'Do not use formulas. Keep the headings in row 1.',
      `Up to ${IMPORT_LIMITS.maxRows} candidates and ${IMPORT_LIMITS.maxFileBytes / (1024 * 1024)} MB per file.`,
    ].forEach((line, i) => { help.getCell(`A${i + 1}`).value = line; });
    help.getCell('A1').font = { bold: true };
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { filename: 'recruitment-candidates-template.xlsx', content_base64: buffer.toString('base64') };
  }

  /** Read and check the file. Writes nothing. */
  async preview(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows = await this.check(user, await readImportFile(String(body.filename ?? ''), String(body.content_base64 ?? '')));
    return { rows: rows.map(present), counts: countOf(rows), limits: IMPORT_LIMITS };
  }

  /** Re-read, re-check, and create every valid row — each in its own transaction. */
  async import(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filename = clean(body.filename).slice(0, 120);
    const rows = await this.check(user, await readImportFile(filename, String(body.content_base64 ?? '')));
    const results: { row: number; name: string; email: string; outcome: 'added' | 'skipped' | 'failed'; reason: string; candidate_id: number | null }[] = [];

    for (const r of rows) {
      if (r.status !== 'valid') {
        results.push({ row: r.row, name: r.name, email: r.email, outcome: r.status === 'duplicate' ? 'skipped' : 'failed', reason: r.reasons.join(' '), candidate_id: null });
        continue;
      }
      try {
        const created = await this.createOne(user, r, filename);
        results.push(created
          ? { row: r.row, name: r.name, email: r.email, outcome: 'added', reason: '', candidate_id: created }
          : { row: r.row, name: r.name, email: r.email, outcome: 'skipped', reason: 'A candidate with this email or phone already exists.', candidate_id: null });
      } catch (err) {
        this.log.warn(`Import row ${r.row} failed: ${(err as Error).message}`);
        results.push({ row: r.row, name: r.name, email: r.email, outcome: 'failed', reason: 'Could not be saved. Nothing was created for this row; try again.', candidate_id: null });
      }
    }
    const count = (o: string) => results.filter((x) => x.outcome === o).length;
    return { added: count('added'), skipped: count('skipped'), failed: count('failed'), results };
  }

  /**
   * One candidate, its note and their history, together — or nothing.
   *
   * The advisory locks are per email and per phone digits, taken inside the transaction and released
   * with it. Two imports of the same file — a double click, a retry after a timeout, two people at once
   * — queue on the same keys, and the second re-checks after the first committed and finds the
   * candidate, so it skips instead of creating a twin. Returns null when that happens.
   */
  private async createOne(user: AuthUserRecord, r: CheckedRow, filename: string): Promise<number | null> {
    const digits = phoneDigits(r.phone);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recruitment-candidate-email:${r.email}`}))`;
      if (digits.length >= IMPORT_LIMITS.phoneMinDigits) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recruitment-candidate-phone:${digits}`}))`;
      }
      if (await this.existsAlready(tx, r.email, digits)) return null;

      const now = new Date();
      const row = await tx.recruitment_candidates.create({
        data: {
          name: r.name,
          email: r.email,
          phone: r.phone || null,   // exactly as written: no reformatting, no country assumed
          source: r.source || null,
          // The same default as Add Candidate: a recruiter takes it on; an administrator leaves it unassigned.
          assigned_recruiter_id: r.recruiter_id ?? (can(user, 'recruitment.view-all') ? null : user.id ?? null),
          status: 'new',
          created_by: user.name ?? null,
          created_at: now,
          updated_at: now,
        },
      });
      await this.recruitment.event(tx, row.id, 'created',
        `Added as a candidate by import${filename ? ` (${filename})` : ''}${row.source ? ` from ${row.source}` : ''}.`, user);
      if (r.note) {
        await tx.recruitment_notes.create({
          data: { candidate_id: row.id, body: r.note, author: user.name ?? null, user_id: user.id ?? null, created_at: now },
        });
        await this.recruitment.event(tx, row.id, 'note', 'Note added.', user);
      }
      return row.id;
    }, { timeout: 20_000 });
  }

  private async existsAlready(db: Prisma.TransactionClient | PrismaService, email: string, digits: string): Promise<boolean> {
    const phone = digits.length >= IMPORT_LIMITS.phoneMinDigits ? digits : '';
    const found = await db.$queryRaw<{ id: number }[]>`
      SELECT id FROM recruitment_candidates
      WHERE deleted_at IS NULL
        AND (LOWER(email) = ${email} OR (${phone} <> '' AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = ${phone}))
      LIMIT 1`;
    return found.length > 0;
  }

  /** Validate every row the way Add Candidate would, then mark duplicates. Reads only. */
  private async check(user: AuthUserRecord, raw: RawRow[]): Promise<CheckedRow[]> {
    const isAdmin = can(user, 'recruitment.view-all');
    const recruiterEmails = [...new Set(raw.map((r) => clean(r.values.recruiter_email).toLowerCase()).filter(Boolean))];
    const recruiters = recruiterEmails.length
      ? await this.prisma.users.findMany({
        where: { status: 'Active', OR: recruiterEmails.map((e) => ({ email: { equals: e, mode: 'insensitive' as const } })) },
        select: { id: true, email: true },
      })
      : [];
    const recruiterBy = new Map(recruiters.map((u) => [u.email.toLowerCase(), u.id]));
    const myEmail = String(user.email ?? '').toLowerCase();

    const rows: CheckedRow[] = raw.map((r) => {
      const v = r.values;
      const reasons = [...r.readErrors];
      const name = clean(v.name);
      const email = clean(v.email).toLowerCase();
      const phone = clean(v.phone);
      const sourceIn = clean(v.source).toLowerCase().replace(/\s+/g, '-');
      const recruiterEmail = clean(v.recruiter_email).toLowerCase();
      const note = clean(v.note);

      if (!name) reasons.push('Name is required.');
      else if (name.length > IMPORT_LIMITS.name) reasons.push(`Name is longer than ${IMPORT_LIMITS.name} characters.`);
      if (!email) reasons.push('Email is required.');
      else if (!EMAIL_SHAPE.test(email) || email.length > IMPORT_LIMITS.email) reasons.push('Email is not a valid email address.');
      if (phone) {
        const d = phoneDigits(phone);
        if (phone.length > IMPORT_LIMITS.phone || !PHONE_SHAPE.test(phone)) reasons.push('Phone may contain digits, spaces, ( ) - . / and a leading +.');
        else if (d.length < IMPORT_LIMITS.phoneMinDigits || d.length > IMPORT_LIMITS.phoneMaxDigits) {
          reasons.push(`Phone must have ${IMPORT_LIMITS.phoneMinDigits}–${IMPORT_LIMITS.phoneMaxDigits} digits.`);
        }
      }
      let source = '';
      if (sourceIn) {
        if ((IMPORT_SOURCES as readonly string[]).includes(sourceIn)) source = sourceIn;
        else reasons.push(`Source must be one of: ${IMPORT_SOURCES.join(', ')} — or blank.`);
      }
      let recruiterId: number | null = null;
      if (recruiterEmail) {
        const id = recruiterBy.get(recruiterEmail);
        if (!id) reasons.push('Recruiter Email does not match an active user.');
        else if (!isAdmin && id !== user.id && recruiterEmail !== myEmail) reasons.push('Only an administrator can assign a recruiter other than yourself.');
        else recruiterId = id;
      }
      if (note.length > IMPORT_LIMITS.note) reasons.push(`Note is longer than ${IMPORT_LIMITS.note} characters.`);

      return {
        row: r.row, name, email, phone, source, recruiter_email: recruiterEmail, note,
        status: reasons.length ? 'error' : 'valid', reasons, recruiter_id: recruiterId,
      };
    });

    // Duplicates within the file: the first row with an email or phone keeps it.
    const seenEmail = new Map<string, number>();
    const seenPhone = new Map<string, number>();
    for (const r of rows) {
      if (r.status === 'error') continue;
      const d = phoneDigits(r.phone);
      const byEmail = seenEmail.get(r.email);
      const byPhone = d.length >= IMPORT_LIMITS.phoneMinDigits ? seenPhone.get(d) : undefined;
      if (byEmail) { r.status = 'duplicate'; r.reasons.push(`Same email as row ${byEmail} in this file.`); continue; }
      if (byPhone) { r.status = 'duplicate'; r.reasons.push(`Same phone as row ${byPhone} in this file.`); continue; }
      seenEmail.set(r.email, r.row);
      if (d.length >= IMPORT_LIMITS.phoneMinDigits) seenPhone.set(d, r.row);
    }

    // Duplicates of existing candidates — one query for the file. Said without revealing whose record it is.
    const valid = rows.filter((r) => r.status === 'valid');
    if (valid.length) {
      const emails = valid.map((r) => r.email);
      const phones = valid.map((r) => phoneDigits(r.phone)).filter((d) => d.length >= IMPORT_LIMITS.phoneMinDigits);
      const existing = await this.prisma.$queryRaw<{ email: string; digits: string }[]>`
        SELECT LOWER(email) AS email, regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') AS digits
        FROM recruitment_candidates
        WHERE deleted_at IS NULL
          AND (LOWER(email) IN (${Prisma.join(emails)})
            ${phones.length ? Prisma.sql`OR regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') IN (${Prisma.join(phones)})` : Prisma.empty})`;
      const existingEmails = new Set(existing.map((e) => e.email));
      const existingPhones = new Set(existing.map((e) => e.digits).filter(Boolean));
      for (const r of valid) {
        if (existingEmails.has(r.email)) { r.status = 'duplicate'; r.reasons.push('A candidate with this email already exists.'); }
        else if (existingPhones.has(phoneDigits(r.phone))) { r.status = 'duplicate'; r.reasons.push('A candidate with this phone number already exists.'); }
      }
    }
    return rows;
  }
}

function present(r: CheckedRow): Record<string, unknown> {
  return { row: r.row, name: r.name, email: r.email, phone: r.phone, source: r.source, recruiter_email: r.recruiter_email, note: r.note, status: r.status, reasons: r.reasons };
}
function countOf(rows: CheckedRow[]): Record<string, number> {
  return {
    total: rows.length,
    valid: rows.filter((r) => r.status === 'valid').length,
    duplicate: rows.filter((r) => r.status === 'duplicate').length,
    error: rows.filter((r) => r.status === 'error').length,
  };
}
