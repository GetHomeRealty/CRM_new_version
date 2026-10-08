import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentController } from './recruitment.controller';
import { PermissionService } from '../auth/permission.service';
import { SCREEN_META } from '../auth/decorators';

/**
 * EDITING AND DELETING RECRUITMENT NOTES, and the "Latest Note" every Candidates row carries.
 *
 * Against the real tables, cleaned up afterwards. An edit changes the text only — the note keeps its
 * author and the time it was written — and both edit and delete are recorded in the candidate's
 * history. A note can only be changed through the candidate it belongs to, by someone who may see that
 * candidate. The list's newest note is by creation time, so editing never moves a note and deleting the
 * newest shows the next one; it is fetched for the whole page in one query.
 */

const prisma = new PrismaClient();
const service = new RecruitmentService(prisma as unknown as PrismaService);
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

const ADMIN = { id: 1, name: 'ZZ Admin', role: 'admin' } as unknown as AuthUserRecord;
const OUTSIDER = { id: 999_999_001, name: 'ZZ Outsider', role: 'recruiter' } as unknown as AuthUserRecord;
const made: number[] = [];

async function candidate() {
  const t = tag();
  const row = await prisma.recruitment_candidates.create({
    data: {
      name: `ZZ NoteCand ${t}`, email: `zz-notecand-${t}@probe.test`, status: 'interview', source: 'website',
      assigned_recruiter_id: 1, created_by: 'ZZ Admin',
      created_at: new Date('2026-09-01T09:00:00Z'), updated_at: new Date('2026-09-01T09:00:00Z'),
    },
  });
  made.push(row.id);
  return row;
}
const note = (candidateId: number, body: string, at: string, author = 'Old Author') => prisma.recruitment_notes.create({
  data: { candidate_id: candidateId, body, author, user_id: 2, created_at: new Date(at) },
});

afterAll(async () => {
  await prisma.recruitment_events.deleteMany({ where: { candidate_id: { in: made } } });
  await prisma.recruitment_notes.deleteMany({ where: { candidate_id: { in: made } } });
  await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

describe('editing a note', () => {
  it('changes the text only — author and creation time stay — and the edit is in the history', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Original text', '2026-10-01T10:00:00Z');
    const res = await service.updateNote(ADMIN, c.id, n.id, { body: '  Edited text  ' });
    expect((res.data as { body: string }).body).toBe('Edited text');
    const after = await prisma.recruitment_notes.findUniqueOrThrow({ where: { id: n.id } });
    expect(after).toMatchObject({ body: 'Edited text', author: 'Old Author', user_id: 2, candidate_id: c.id });
    expect(after.created_at?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    const ev = await prisma.recruitment_events.findFirstOrThrow({ where: { candidate_id: c.id }, orderBy: { id: 'desc' } });
    expect(ev).toMatchObject({ action: 'note', detail: 'Note edited (written by Old Author on 2026-10-01).', actor_name: 'ZZ Admin', actor_id: 1 });
  });

  it('refuses an empty or whitespace-only note and leaves it as it was', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Keep me', '2026-10-01T10:00:00Z');
    for (const body of ['', '   ', '\n\t ']) {
      await expect(service.updateNote(ADMIN, c.id, n.id, { body })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect((await prisma.recruitment_notes.findUniqueOrThrow({ where: { id: n.id } })).body).toBe('Keep me');
    expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id } })).toBe(0);
  });

  it('an unchanged save writes nothing to the history', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Same', '2026-10-01T10:00:00Z');
    await service.updateNote(ADMIN, c.id, n.id, { body: 'Same' });
    expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id } })).toBe(0);
  });
});

describe('deleting a note', () => {
  it('removes it and records which note it was and who removed it', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Goodbye', '2026-10-02T10:00:00Z', 'Priya');
    await expect(service.deleteNote(ADMIN, c.id, n.id)).resolves.toEqual({ deleted: true });
    expect(await prisma.recruitment_notes.findUnique({ where: { id: n.id } })).toBeNull();
    const ev = await prisma.recruitment_events.findFirstOrThrow({ where: { candidate_id: c.id }, orderBy: { id: 'desc' } });
    expect(ev).toMatchObject({ action: 'note', detail: 'Note deleted (written by Priya on 2026-10-02).', actor_name: 'ZZ Admin' });
  });
});

describe('a note only through its own candidate, and only for someone who may see that candidate', () => {
  it('another candidate\'s note id is "not found" — for edit and delete — and nothing changes', async () => {
    const a = await candidate();
    const b = await candidate();
    const nb = await note(b.id, 'B\'s note', '2026-10-01T10:00:00Z');
    await expect(service.updateNote(ADMIN, a.id, nb.id, { body: 'hijack' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteNote(ADMIN, a.id, nb.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await prisma.recruitment_notes.findUniqueOrThrow({ where: { id: nb.id } })).body).toBe('B\'s note');
  });

  it('a recruiter not assigned the candidate cannot edit or delete its notes', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Scoped', '2026-10-01T10:00:00Z');
    await expect(service.updateNote(OUTSIDER, c.id, n.id, { body: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteNote(OUTSIDER, c.id, n.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.recruitment_notes.findUnique({ where: { id: n.id } })).not.toBeNull();
  });

  it('both routes need Recruitment: edit, which a view-only role does not have', () => {
    for (const handler of [RecruitmentController.prototype.updateNote, RecruitmentController.prototype.deleteNote]) {
      expect(Reflect.getMetadata(SCREEN_META, handler)).toMatchObject({ screen: 'recruitment', level: 'edit' });
    }
    const perms = new PermissionService();
    expect(perms.can('crm', [{ screen: 'recruitment', level: 'view' }], 'recruitment', 'edit')).toBe(false);
    expect(perms.can('crm', [{ screen: 'recruitment', level: 'view' }], 'recruitment', 'view')).toBe(true);
    expect(perms.can('recruiter', [], 'recruitment', 'edit')).toBe(true);
  });
});

describe('Latest Note on the Candidates list', () => {
  type Row = { id: number; latest_note: { id: number; preview: string; truncated: boolean; author: string | null; created_at: Date | null } | null };
  const rowFor = async (id: number, name: string): Promise<Row> => {
    const res = await service.list(ADMIN, { q: name, per_page: 50 }) as { data: Row[] };
    return res.data.find((r) => r.id === id)!;
  };

  it('is the newest by creation time; editing never moves it; deleting shows the next; none is null', async () => {
    const c = await candidate();
    const name = (await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } })).name;
    expect((await rowFor(c.id, name)).latest_note).toBeNull();

    const oldest = await note(c.id, 'Oldest', '2026-10-01T09:00:00Z');
    const middle = await note(c.id, 'Middle', '2026-10-02T09:00:00Z', 'Priya');
    const newest = await note(c.id, 'Newest', '2026-10-03T09:00:00Z', 'Sam');
    let row = await rowFor(c.id, name);
    expect(row.latest_note).toMatchObject({ id: newest.id, preview: 'Newest', truncated: false, author: 'Sam' });
    expect(new Date(row.latest_note!.created_at!).toISOString()).toBe('2026-10-03T09:00:00.000Z');

    // editing an older note does not promote it; editing the newest updates the preview
    await service.updateNote(ADMIN, c.id, oldest.id, { body: 'Oldest, edited later' });
    expect((await rowFor(c.id, name)).latest_note?.id).toBe(newest.id);
    await service.updateNote(ADMIN, c.id, newest.id, { body: 'Newest, edited' });
    expect((await rowFor(c.id, name)).latest_note).toMatchObject({ id: newest.id, preview: 'Newest, edited' });

    await service.deleteNote(ADMIN, c.id, newest.id);
    expect((await rowFor(c.id, name)).latest_note).toMatchObject({ id: middle.id, preview: 'Middle', author: 'Priya' });
    await service.deleteNote(ADMIN, c.id, middle.id);
    await service.deleteNote(ADMIN, c.id, oldest.id);
    row = await rowFor(c.id, name);
    expect(row.latest_note).toBeNull();
  });

  it('a long note is previewed, not sent whole, and says so', async () => {
    const c = await candidate();
    const name = (await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } })).name;
    await note(c.id, 'x'.repeat(500), '2026-10-01T09:00:00Z');
    const row = await rowFor(c.id, name);
    expect(row.latest_note?.preview).toHaveLength(140);
    expect(row.latest_note?.truncated).toBe(true);
  });

  it('one query fetches the notes for the whole page', async () => {
    const cs = [await candidate(), await candidate(), await candidate()];
    for (const c of cs) await note(c.id, `Note for ${c.id}`, '2026-10-01T09:00:00Z');
    const spy = jest.spyOn(prisma, '$queryRaw');
    const res = await service.list(ADMIN, { q: 'ZZ NoteCand', per_page: 50 }) as { data: Row[] };
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    for (const c of cs) expect(res.data.find((r) => r.id === c.id)?.latest_note?.preview).toBe(`Note for ${c.id}`);
  });
});
