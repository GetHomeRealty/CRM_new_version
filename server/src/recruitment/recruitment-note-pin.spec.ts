import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentController } from './recruitment.controller';
import { PermissionService } from '../auth/permission.service';
import { SCREEN_META } from '../auth/decorators';

/**
 * PINNING A RECRUITMENT NOTE — against the real tables, cleaned up afterwards.
 *
 * Pinning is SHARED STATE, not a per-viewer preference: it lives on the note, so it survives a
 * refresh and everyone who may see the candidate sees the same notes at the top. That is why it
 * needs the same permission and the same candidate scope as editing, and why these tests check the
 * database rather than only the value handed back.
 *
 * WHAT MUST NOT CHANGE. A pin moves a note in the list and does nothing else: its text, author,
 * `user_id` and `created_at` stay, and unpinning puts it back exactly where it was.
 */

const prisma = new PrismaClient();
const service = new RecruitmentService(prisma as unknown as PrismaService);
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

const ADMIN = { id: 1, name: 'ZZ Admin', role: 'admin' } as unknown as AuthUserRecord;
const OUTSIDER = { id: 999_999_002, name: 'ZZ Outsider', role: 'recruiter' } as unknown as AuthUserRecord;
const made: number[] = [];

async function candidate() {
  const t = tag();
  const row = await prisma.recruitment_candidates.create({
    data: {
      name: `ZZ PinCand ${t}`, email: `zz-pincand-${t}@probe.test`, status: 'interview', source: 'website',
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

/** The note ids as the candidate page would render them, top first. */
const shownOrder = async (candidateId: number): Promise<number[]> => {
  const res = await service.show(ADMIN, candidateId) as { notes: { id: number }[] };
  return res.notes.map((n) => n.id);
};

const pinnedInDb = async (noteId: number): Promise<boolean> =>
  (await prisma.recruitment_notes.findUniqueOrThrow({ where: { id: noteId } })).pinned;

afterAll(async () => {
  await prisma.recruitment_events.deleteMany({ where: { candidate_id: { in: made } } });
  await prisma.recruitment_notes.deleteMany({ where: { candidate_id: { in: made } } });
  await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

describe('pinning and unpinning', () => {
  it('SAVES TO THE DATABASE, so it survives a refresh and another person sees it', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Licence number 1234567', '2026-10-01T10:00:00Z');
    expect(await pinnedInDb(n.id)).toBe(false);

    const res = await service.setNotePinned(ADMIN, c.id, n.id, { pinned: true });
    expect((res.data as { pinned: boolean }).pinned).toBe(true);

    // The row itself, not the value just returned — a refresh reads this.
    expect(await pinnedInDb(n.id)).toBe(true);
    // And a fresh read of the candidate, which is what the screen actually fetches.
    const fresh = await service.show(ADMIN, c.id) as { notes: { id: number; pinned: boolean }[] };
    expect(fresh.notes.find((x) => x.id === n.id)?.pinned).toBe(true);

    await service.setNotePinned(ADMIN, c.id, n.id, { pinned: false });
    expect(await pinnedInDb(n.id)).toBe(false);
  });

  it('CHANGES NOTHING ELSE ABOUT THE NOTE', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Text that must not move', '2026-10-01T10:00:00Z', 'Priya');

    await service.setNotePinned(ADMIN, c.id, n.id, { pinned: true });

    const after = await prisma.recruitment_notes.findUniqueOrThrow({ where: { id: n.id } });
    expect(after).toMatchObject({
      body: 'Text that must not move', author: 'Priya', user_id: 2, candidate_id: c.id, pinned: true,
    });
    expect(after.created_at?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });

  it('writes nothing to the candidate history — a pin is not an edit', async () => {
    /*
     * Deliberate, and the reason is worth keeping: editing and deleting change or destroy what a
     * note SAYS, and the history exists to record that. Pinning changes only where it sits, and
     * somebody tidying a long list would otherwise bury the entries that matter.
     */
    const c = await candidate();
    const n = await note(c.id, 'Pinned and unpinned', '2026-10-01T10:00:00Z');

    await service.setNotePinned(ADMIN, c.id, n.id, { pinned: true });
    await service.setNotePinned(ADMIN, c.id, n.id, { pinned: false });

    expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id } })).toBe(0);
  });

  it('IS IDEMPOTENT, so a double click or a retry cannot land anywhere different', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Clicked twice', '2026-10-01T10:00:00Z');

    const first = await service.setNotePinned(ADMIN, c.id, n.id, { pinned: true });
    const second = await service.setNotePinned(ADMIN, c.id, n.id, { pinned: true });
    expect((first.data as { pinned: boolean }).pinned).toBe(true);
    expect((second.data as { pinned: boolean }).pinned).toBe(true);
    expect(await pinnedInDb(n.id)).toBe(true);

    // Unpinning twice is the same story in the other direction.
    await service.setNotePinned(ADMIN, c.id, n.id, { pinned: false });
    await service.setNotePinned(ADMIN, c.id, n.id, { pinned: false });
    expect(await pinnedInDb(n.id)).toBe(false);
  });

  it('REFUSES A MISSING OR MALFORMED VALUE, and leaves the whole note as it was', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Unchanged', '2026-10-01T10:00:00Z', 'Priya');
    const before = await prisma.recruitment_notes.findUniqueOrThrow({ where: { id: n.id } });

    const bad: unknown[] = [
      {},                      // the caller said nothing at all
      { pinned: null },
      { pinned: undefined },
      { pinned: '' },
      { pinned: 'yes' },       // a word that means it, but is not the contract
      { pinned: 'TRUE' },      // close enough to be tempting; still not accepted
      { pinned: 2 },
      { pinned: 0 },           // numeric falsy is NOT read as false
      { pinned: 1 },
      { pinned: [] },
      { pinned: {} },
    ];
    for (const body of bad) {
      await expect(service.setNotePinned(ADMIN, c.id, n.id, body as Record<string, unknown>))
        .rejects.toBeInstanceOf(BadRequestException);
    }

    // Not merely still unpinned — byte for byte the row it was.
    expect(await prisma.recruitment_notes.findUniqueOrThrow({ where: { id: n.id } })).toEqual(before);
    // And a rejected call is not an event either.
    expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id } })).toBe(0);
  });

  it('ACCEPTS AN EXPLICIT BOOLEAN BOTH WAYS, including false on an already-pinned note', async () => {
    /*
     * `false` is the half that is easy to get wrong: a truthiness check would read it as "nothing
     * was said" and refuse, or worse, as a no-op. It has to unpin.
     */
    const c = await candidate();
    const n = await note(c.id, 'Both ways', '2026-10-01T10:00:00Z');

    const on = await service.setNotePinned(ADMIN, c.id, n.id, { pinned: true });
    expect((on.data as { pinned: boolean }).pinned).toBe(true);
    expect(await pinnedInDb(n.id)).toBe(true);

    const off = await service.setNotePinned(ADMIN, c.id, n.id, { pinned: false });
    expect((off.data as { pinned: boolean }).pinned).toBe(false);
    expect(await pinnedInDb(n.id)).toBe(false);

    // Explicit false on a note that was never pinned is accepted too, and stays false.
    const other = await note(c.id, 'Never pinned', '2026-10-02T10:00:00Z');
    await expect(service.setNotePinned(ADMIN, c.id, other.id, { pinned: false })).resolves.toBeDefined();
    expect(await pinnedInDb(other.id)).toBe(false);
  });

  it('accepts the string a form-encoded client sends', async () => {
    const c = await candidate();
    const n = await note(c.id, 'From a form', '2026-10-01T10:00:00Z');

    await service.setNotePinned(ADMIN, c.id, n.id, { pinned: 'true' });
    expect(await pinnedInDb(n.id)).toBe(true);
    await service.setNotePinned(ADMIN, c.id, n.id, { pinned: 'false' });
    expect(await pinnedInDb(n.id)).toBe(false);
  });
});

describe('the order notes are shown in', () => {
  /*
   * The existing order is newest first by id. Pinning adds ONE key in front of that and replaces
   * nothing, which is what makes unpinning put a note back exactly where it was.
   */
  it('PUTS PINNED NOTES FIRST and keeps the existing order inside each group', async () => {
    const c = await candidate();
    const a = await note(c.id, 'A, oldest', '2026-10-01T09:00:00Z');
    const b = await note(c.id, 'B', '2026-10-02T09:00:00Z');
    const d = await note(c.id, 'D, newest', '2026-10-04T09:00:00Z');
    const e = await note(c.id, 'E, newer still', '2026-10-05T09:00:00Z');

    expect(await shownOrder(c.id)).toEqual([e.id, d.id, b.id, a.id]);

    // Pin the two oldest — the ones furthest from the top — so a change of order is unmistakable.
    await service.setNotePinned(ADMIN, c.id, a.id, { pinned: true });
    await service.setNotePinned(ADMIN, c.id, b.id, { pinned: true });

    // Pinned first, newest-first WITHIN the pinned group (b before a), then the rest unchanged.
    expect(await shownOrder(c.id)).toEqual([b.id, a.id, e.id, d.id]);
  });

  it('ALLOWS SEVERAL PINNED AT ONCE — it is not a single slot', async () => {
    const c = await candidate();
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push((await note(c.id, `Note ${i}`, `2026-10-0${i + 1}T09:00:00Z`)).id);

    for (const id of ids) await service.setNotePinned(ADMIN, c.id, id, { pinned: true });

    expect(await prisma.recruitment_notes.count({ where: { candidate_id: c.id, pinned: true } })).toBe(4);
    // All four pinned, still newest first among themselves.
    expect(await shownOrder(c.id)).toEqual([...ids].reverse());
  });

  it('UNPINNING RESTORES THE EXACT ORIGINAL POSITION, not the top of the unpinned group', async () => {
    const c = await candidate();
    const a = await note(c.id, 'A', '2026-10-01T09:00:00Z');
    const b = await note(c.id, 'B', '2026-10-02T09:00:00Z');
    const d = await note(c.id, 'D', '2026-10-03T09:00:00Z');
    const before = await shownOrder(c.id);

    await service.setNotePinned(ADMIN, c.id, a.id, { pinned: true });
    expect(await shownOrder(c.id)).toEqual([a.id, d.id, b.id]);

    await service.setNotePinned(ADMIN, c.id, a.id, { pinned: false });
    expect(await shownOrder(c.id)).toEqual(before);
  });

  it('a note added after a pin still arrives at the top of the UNPINNED group', async () => {
    // The pinned ones stay above it; a new note does not jump the pins.
    const c = await candidate();
    const old = await note(c.id, 'Old', '2026-10-01T09:00:00Z');
    await service.setNotePinned(ADMIN, c.id, old.id, { pinned: true });

    const added = await service.addNote(ADMIN, c.id, { body: 'Just written' });
    const addedId = (added.data as { id: number }).id;

    expect(await shownOrder(c.id)).toEqual([old.id, addedId]);
    // And a brand new note is not pinned by accident.
    expect(await pinnedInDb(addedId)).toBe(false);
  });
});

describe('scope, permissions and isolation between candidates', () => {
  it('ANOTHER CANDIDATE\'S NOTE ID IS "NOT FOUND", and nothing is pinned', async () => {
    const a = await candidate();
    const b = await candidate();
    const nb = await note(b.id, 'B\'s note', '2026-10-01T10:00:00Z');

    await expect(service.setNotePinned(ADMIN, a.id, nb.id, { pinned: true }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(await pinnedInDb(nb.id)).toBe(false);
  });

  it('a recruiter not assigned the candidate cannot pin its notes', async () => {
    const c = await candidate();
    const n = await note(c.id, 'Scoped', '2026-10-01T10:00:00Z');

    await expect(service.setNotePinned(OUTSIDER, c.id, n.id, { pinned: true }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(await pinnedInDb(n.id)).toBe(false);
  });

  it('the route needs Recruitment: edit, exactly like editing and deleting', () => {
    expect(Reflect.getMetadata(SCREEN_META, RecruitmentController.prototype.setNotePinned))
      .toMatchObject({ screen: 'recruitment', level: 'edit' });

    const perms = new PermissionService();
    expect(perms.can('crm', [{ screen: 'recruitment', level: 'view' }], 'recruitment', 'edit')).toBe(false);
    expect(perms.can('recruiter', [], 'recruitment', 'edit')).toBe(true);
  });

  it('PINNING ONE CANDIDATE\'S NOTE LEAVES EVERY OTHER CANDIDATE UNTOUCHED', async () => {
    const a = await candidate();
    const b = await candidate();
    const a1 = await note(a.id, 'A1', '2026-10-01T09:00:00Z');
    const a2 = await note(a.id, 'A2', '2026-10-02T09:00:00Z');
    const b1 = await note(b.id, 'B1', '2026-10-01T09:00:00Z');
    const b2 = await note(b.id, 'B2', '2026-10-02T09:00:00Z');
    const bOrderBefore = await shownOrder(b.id);

    await service.setNotePinned(ADMIN, a.id, a1.id, { pinned: true });

    // A reordered...
    expect(await shownOrder(a.id)).toEqual([a1.id, a2.id]);
    // ...and B did not, in its order or in its data.
    expect(await shownOrder(b.id)).toEqual(bOrderBefore);
    expect(await pinnedInDb(b1.id)).toBe(false);
    expect(await pinnedInDb(b2.id)).toBe(false);
  });
});
