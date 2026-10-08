import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentImportService, parseCsv, IMPORT_LIMITS } from './recruitment-import.service';
import { RecruitmentController } from './recruitment.controller';
import { PermissionService } from '../auth/permission.service';
import { SCREEN_META } from '../auth/decorators';

/**
 * BULK CANDIDATE IMPORT, against the real tables (myapp_test), cleaned up afterwards. No mail is sent:
 * the import service has no mailer at all, and the test checks no email, interview, follow-up or
 * account rows appear.
 */

const prisma = new PrismaClient();
const recruitment = new RecruitmentService(prisma as unknown as PrismaService);
const importer = new RecruitmentImportService(prisma as unknown as PrismaService, recruitment);
const T = `${Date.now()}`;
const mail = (k: string) => `zz-imp-${k}-${T}@probe.test`;

const ADMIN = { id: 1, name: 'ZZ Import Admin', email: 'zz-imp-admin@probe.test', role: 'admin' } as unknown as AuthUserRecord;
let RECRUITER: AuthUserRecord;
let OTHER_ACTIVE: { id: number; email: string };

beforeAll(async () => {
  const now = new Date();
  const r = await prisma.users.create({ data: { name: 'ZZ Import Recruiter', email: mail('recruiter'), password: 'x', role: 'recruiter', status: 'Active', created_at: now, updated_at: now } });
  RECRUITER = { id: r.id, name: r.name, email: r.email, role: 'recruiter' } as unknown as AuthUserRecord;
  const o = await prisma.users.create({ data: { name: 'ZZ Import Other', email: mail('other'), password: 'x', role: 'recruiter', status: 'Active', created_at: now, updated_at: now } });
  OTHER_ACTIVE = { id: o.id, email: o.email };
});

afterAll(async () => {
  const ids = (await prisma.recruitment_candidates.findMany({ where: { email: { contains: `-${T}@probe.test` } }, select: { id: true } })).map((c) => c.id);
  await prisma.recruitment_events.deleteMany({ where: { candidate_id: { in: ids } } });
  await prisma.recruitment_notes.deleteMany({ where: { candidate_id: { in: ids } } });
  await prisma.recruitment_candidates.deleteMany({ where: { id: { in: ids } } });
  await prisma.users.deleteMany({ where: { email: { in: [mail('recruiter'), mail('other')] } } });
  await prisma.$disconnect();
});

const csv = (rows: string[][]) => ({ filename: 'candidates.csv', content_base64: Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n'), 'utf8').toString('base64') });
const HEAD = ['Name', 'Email', 'Phone', 'Source', 'Recruiter Email', 'Note'];

async function xlsx(rows: (string | number | { formula: string })[][], opts: { phoneAsText?: boolean } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Candidates');
  ws.addRow(HEAD);
  for (const r of rows) {
    const row = ws.addRow(r.map((v) => (typeof v === 'object' ? { formula: v.formula, result: 'x' } : v)));
    if (opts.phoneAsText !== false && typeof r[2] === 'string') row.getCell(3).numFmt = '@';
  }
  return { filename: 'candidates.xlsx', content_base64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
}

type Preview = { rows: { row: number; status: string; reasons: string[]; phone: string; email: string }[]; counts: Record<string, number> };
type Result = { added: number; skipped: number; failed: number; results: { row: number; outcome: string; reason: string; candidate_id: number | null }[] };

describe('reading files', () => {
  it('parses quoted CSV with commas, quotes and newlines', () => {
    expect(parseCsv('a,"b,c","d ""e""","f\ng"\r\n1,2,3,4')).toEqual([['a', 'b,c', 'd "e"', 'f\ng'], ['1', '2', '3', '4']]);
  });

  it('rejects unsupported files, fake workbooks, missing headings, empty files and files over the limits', async () => {
    await expect(importer.preview(ADMIN, { filename: 'old.xls', content_base64: 'AAAA' })).rejects.toThrow('.xlsx file or a .csv');
    await expect(importer.preview(ADMIN, { filename: 'fake.xlsx', content_base64: Buffer.from('Name,Email\n').toString('base64') })).rejects.toThrow('not a real .xlsx');
    await expect(importer.preview(ADMIN, csv([['Full name', 'Mail'], ['A', 'a@b.co']]))).rejects.toThrow('Missing: Name, Email');
    await expect(importer.preview(ADMIN, csv([HEAD]))).rejects.toThrow('no candidate rows');
    const many = [HEAD, ...Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) => [`N${i}`, `n${i}@x.co`, '', '', '', ''])];
    await expect(importer.preview(ADMIN, csv(many))).rejects.toThrow(`more than ${IMPORT_LIMITS.maxRows}`);
    const big = { filename: 'big.csv', content_base64: Buffer.alloc(IMPORT_LIMITS.maxFileBytes + 10, 'a').toString('base64') };
    await expect(importer.preview(ADMIN, big)).rejects.toThrow('larger than 2 MB');
  });

  it('the template downloads with the six headings and a text Phone column, and has no candidate rows', async () => {
    const t = await importer.template();
    expect(t.filename).toBe('recruitment-candidates-template.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(t.content_base64, 'base64') as unknown as ArrayBuffer);
    expect((wb.worksheets[0].getRow(1).values as unknown[]).slice(1)).toEqual(HEAD);
    expect(wb.worksheets[0].getCell('C2').numFmt).toBe('@');
    await expect(importer.preview(ADMIN, t)).rejects.toThrow('no candidate rows');
  });
});

describe('preview', () => {
  it('labels rows valid / duplicate / error with reasons, and writes nothing', async () => {
    const writes = [
      jest.spyOn(prisma.recruitment_candidates, 'create'), jest.spyOn(prisma.recruitment_notes, 'create'),
      jest.spyOn(prisma.recruitment_events, 'create'), jest.spyOn(prisma, '$transaction'), jest.spyOn(prisma, '$executeRaw'),
    ];
    const p = await importer.preview(ADMIN, csv([HEAD,
      ['Ava Valid', mail('ava'), '+44 020 7946 0018', 'Website', '', 'Interested in Brampton'],
      ['', mail('noname'), '', '', '', ''],
      ['Bad Email', 'not-an-email', '', '', '', ''],
      ['Ava Again', mail('ava').toUpperCase(), '', '', '', ''],
    ])) as Preview;
    expect(p.counts).toEqual({ total: 4, valid: 1, duplicate: 1, error: 2 });
    expect(p.rows.map((r) => [r.row, r.status])).toEqual([[2, 'valid'], [3, 'error'], [4, 'error'], [5, 'duplicate']]);
    expect(p.rows[1].reasons).toContain('Name is required.');
    expect(p.rows[2].reasons).toContain('Email is not a valid email address.');
    expect(p.rows[3].reasons).toContain('Same email as row 2 in this file.');
    for (const w of writes) { expect(w).not.toHaveBeenCalled(); w.mockRestore(); }
    expect(await prisma.recruitment_candidates.count({ where: { email: { in: [mail('ava'), mail('noname')] } } })).toBe(0);
  });
});

describe('importing', () => {
  it('creates valid rows at New with phones exactly as written and the note in note history', async () => {
    const file = csv([HEAD,
      ['Uma UK', mail('uma'), '+44 020 7946 0018', 'referral', '', 'Met at open house; wants evening calls.'],
      ['Leo Zero', mail('leo'), '0049 30 1234567', 'Walk-in', '', ''],
      ['Kim Plain', mail('kim'), '(416) 555-0199 ext 22', '', '', ''],
    ]);
    const res = await importer.import(ADMIN, file) as Result;
    expect([res.added, res.skipped, res.failed]).toEqual([3, 0, 0]);
    const rows = await prisma.recruitment_candidates.findMany({ where: { email: { in: [mail('uma'), mail('leo'), mail('kim')] } }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.name, r.phone, r.status, r.source, r.assigned_recruiter_id, r.agent_user_id])).toEqual([
      ['Uma UK', '+44 020 7946 0018', 'new', 'referral', null, null],
      ['Leo Zero', '0049 30 1234567', 'new', 'walk-in', null, null],
      ['Kim Plain', '(416) 555-0199 ext 22', 'new', null, null, null],
    ]);
    const notes = await prisma.recruitment_notes.findMany({ where: { candidate_id: rows[0].id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ body: 'Met at open house; wants evening calls.', author: 'ZZ Import Admin' });
    expect(await prisma.recruitment_notes.count({ where: { candidate_id: rows[1].id } })).toBe(0);
    // the Candidates list's Latest Note shows it
    const list = await recruitment.list(ADMIN, { q: 'Uma UK' }) as { data: { id: number; latest_note: { preview: string } | null }[] };
    expect(list.data.find((r) => r.id === rows[0].id)?.latest_note?.preview).toBe('Met at open house; wants evening calls.');
    // history, and nothing else created
    const ev = await prisma.recruitment_events.findMany({ where: { candidate_id: rows[0].id }, orderBy: { id: 'asc' } });
    expect(ev.map((e) => e.action)).toEqual(['created', 'note']);
    expect(ev[0].detail).toBe('Added as a candidate by import (candidates.csv) from referral.');
    const ids = rows.map((r) => r.id);
    expect(await prisma.recruitment_interviews.count({ where: { candidate_id: { in: ids } } })).toBe(0);
    expect(await prisma.recruitment_followups.count({ where: { candidate_id: { in: ids } } })).toBe(0);
    expect(await prisma.recruitment_emails.count({ where: { candidate_id: { in: ids } } })).toBe(0);
  });

  it('skips duplicates of existing candidates (email any case, phone by digits) without changing them', async () => {
    const now = new Date('2026-09-01T09:00:00Z');
    const existing = await prisma.recruitment_candidates.create({
      data: { name: 'ZZ Existing', email: mail('exist'), phone: '+1 (905) 555-0142', status: 'contacted', created_at: now, updated_at: now },
    });
    const res = await importer.import(ADMIN, csv([HEAD,
      ['Same Email', mail('exist').toUpperCase(), '', '', '', 'should not be saved'],
      ['Same Phone', mail('samephone'), '1 905 555 0142', '', '', ''],
      ['Fresh', mail('fresh'), '905-555-0199', '', '', ''],
    ])) as Result;
    expect([res.added, res.skipped, res.failed]).toEqual([1, 2, 0]);
    expect(res.results[0].reason).toBe('A candidate with this email already exists.');
    expect(res.results[1].reason).toBe('A candidate with this phone number already exists.');
    const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after).toMatchObject({ name: 'ZZ Existing', status: 'contacted', phone: '+1 (905) 555-0142' });
    expect(after.updated_at?.toISOString()).toBe(now.toISOString());
    expect(await prisma.recruitment_notes.count({ where: { candidate_id: existing.id } })).toBe(0);
    expect(await prisma.recruitment_candidates.count({ where: { email: mail('samephone') } })).toBe(0);
  });

  it('a retry, and two imports at once, never create a candidate twice', async () => {
    const file = csv([HEAD, ['Rita Retry', mail('rita'), '+1 289 555 0110', '', '', 'once'], ['Ravi Retry', mail('ravi'), '', '', '', '']]);
    expect((await importer.import(ADMIN, file) as Result).added).toBe(2);
    const again = await importer.import(ADMIN, file) as Result;
    expect([again.added, again.skipped]).toEqual([0, 2]);

    const par = csv([HEAD, ['Pat Parallel', mail('pat'), '', '', '', 'note'], ['Pia Parallel', mail('pia'), '+1 289 555 0111', '', '', '']]);
    const [a, b] = await Promise.all([importer.import(ADMIN, par), importer.import(ADMIN, par)]) as Result[];
    expect(a.added + b.added).toBe(2);
    expect(a.skipped + b.skipped).toBe(2);
    expect(await prisma.recruitment_candidates.count({ where: { email: { in: [mail('pat'), mail('pia')] } } })).toBe(2);
    const pat = await prisma.recruitment_candidates.findFirstOrThrow({ where: { email: mail('pat') } });
    expect(await prisma.recruitment_notes.count({ where: { candidate_id: pat.id } })).toBe(1);
  });

  it('invalid rows fail with their reasons and are not created', async () => {
    const res = await importer.import(ADMIN, csv([HEAD,
      ['Letters Phone', mail('lp'), '416-555-CALL', '', '', ''],
      ['Short Phone', mail('sp'), '12345', '', '', ''],
      ['Plus Inside', mail('pi'), '416+5550101', '', '', ''],
      ['Bad Source', mail('bs'), '', 'Billboard', '', ''],
      ['Who Recruiter', mail('wr'), '', '', 'nobody-here@probe.test', ''],
      ['Long Note', mail('ln'), '', '', '', 'x'.repeat(IMPORT_LIMITS.note + 1)],
      ['=HYPERLINK("x")', mail('fx'), '', '', '', ''],
    ])) as Result;
    expect([res.added, res.skipped, res.failed]).toEqual([0, 0, 7]);
    expect(res.results.map((r) => r.reason)).toEqual([
      'Phone may contain digits, spaces, ( ) - . / and a leading +.',
      'Phone must have 7–20 digits.',
      'Phone may contain digits, spaces, ( ) - . / and a leading +.',
      'Source must be one of: referral, website, walk-in, agency, other — or blank.',
      'Recruiter Email does not match an active user.',
      `Note is longer than ${IMPORT_LIMITS.note} characters.`,
      'Name starts with "=", which a spreadsheet would treat as a formula. Enter a plain value.',
    ]);
    expect(await prisma.recruitment_candidates.count({ where: { email: { in: ['lp', 'sp', 'pi', 'bs', 'wr', 'ln', 'fx'].map(mail) } } })).toBe(0);
  });

  it('xlsx: text phones keep zeros and +; a numeric phone or a formula cell is refused', async () => {
    const file = await xlsx([
      ['Xena Text', mail('xena'), '+353 01 555 0101', '', '', ''],
      ['Nina Number', mail('nina'), 4165550101, '', '', ''],
      ['Fred Formula', { formula: 'CONCAT("a","@b.co")' }, '', '', '', ''],
    ]);
    const p = await importer.preview(ADMIN, file) as Preview;
    expect(p.rows[0]).toMatchObject({ status: 'valid', phone: '+353 01 555 0101' });
    expect(p.rows[1].status).toBe('error');
    expect(p.rows[1].reasons[0]).toMatch(/stored as a number/);
    expect(p.rows[2].status).toBe('error');
    expect(p.rows[2].reasons).toContain('Email is a formula. Enter a plain value.');
    const res = await importer.import(ADMIN, file) as Result;
    expect([res.added, res.failed]).toEqual([1, 2]);
    expect((await prisma.recruitment_candidates.findFirstOrThrow({ where: { email: mail('xena') } })).phone).toBe('+353 01 555 0101');
  });

  it('a candidate and its note are saved together: if the note fails, no candidate is left behind', async () => {
    const spy = jest.spyOn(recruitment, 'event').mockImplementation(async (db, id, action) => {
      if (action === 'note') throw new Error('simulated failure');
      return RecruitmentService.prototype.event.call(recruitment, db, id, action, null, null);
    });
    const res = await importer.import(ADMIN, csv([HEAD, ['Tom Txn', mail('tom'), '', '', '', 'will fail']])) as Result;
    spy.mockRestore();
    expect([res.added, res.failed]).toEqual([0, 1]);
    expect(res.results[0].reason).toMatch(/Nothing was created for this row/);
    expect(await prisma.recruitment_candidates.count({ where: { email: mail('tom') } })).toBe(0);
  });
});

describe('recruiters and permissions', () => {
  it('a recruiter: blank or own email assigns themselves; anyone else is refused', async () => {
    const res = await importer.import(RECRUITER, csv([HEAD,
      ['Self Blank', mail('selfblank'), '', '', '', ''],
      ['Self Named', mail('selfnamed'), '', '', mail('recruiter').toUpperCase(), ''],
      ['Other Named', mail('othernamed'), '', '', OTHER_ACTIVE.email, ''],
    ])) as Result;
    expect([res.added, res.failed]).toEqual([2, 1]);
    expect(res.results[2].reason).toBe('Only an administrator can assign a recruiter other than yourself.');
    const made = await prisma.recruitment_candidates.findMany({ where: { email: { in: [mail('selfblank'), mail('selfnamed')] } } });
    expect(made.every((c) => c.assigned_recruiter_id === RECRUITER.id)).toBe(true);
  });

  it('an administrator may assign any active user by exact email, or leave it unassigned', async () => {
    const res = await importer.import(ADMIN, csv([HEAD,
      ['Assigned', mail('assigned'), '', '', OTHER_ACTIVE.email, ''],
      ['Unassigned', mail('unassigned'), '', '', '', ''],
    ])) as Result;
    expect(res.added).toBe(2);
    expect((await prisma.recruitment_candidates.findFirstOrThrow({ where: { email: mail('assigned') } })).assigned_recruiter_id).toBe(OTHER_ACTIVE.id);
    expect((await prisma.recruitment_candidates.findFirstOrThrow({ where: { email: mail('unassigned') } })).assigned_recruiter_id).toBeNull();
  });

  it('all three routes need Recruitment: edit, which view-only does not have', () => {
    for (const h of [RecruitmentController.prototype.importTemplate, RecruitmentController.prototype.importPreview, RecruitmentController.prototype.importCandidates]) {
      expect(Reflect.getMetadata(SCREEN_META, h)).toMatchObject({ screen: 'recruitment', level: 'edit' });
    }
    expect(new PermissionService().can('crm', [{ screen: 'recruitment', level: 'view' }], 'recruitment', 'edit')).toBe(false);
  });

  it('bad requests are refused cleanly', async () => {
    await expect(importer.import(ADMIN, { filename: 'x.csv', content_base64: '' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
