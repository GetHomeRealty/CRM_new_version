import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { LeadsService } from './leads.service';
import { LeadActivityService } from './lead-activity.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import { ResourceAccessService } from '../core/resource-access.service';

/**
 * ONE AGENT CANNOT REACH ANOTHER AGENT'S LEAD, BY ANY ROUTE OR ANY PAYLOAD.
 *
 * ================================================================================================
 * WHY THIS EXISTS AS A SEPARATE FILE. `lead-ownership-scope.spec.ts` already proves the SCOPE rule —
 * which rows each role's queries return, and that the per-record guard agrees with them. What it
 * does not cover is the two things an attacker actually tries:
 *
 *   THE SIDE DOORS. The lead itself is scoped, but a lead has notes, tasks, showings and calls, each
 *   with its own endpoint taking a lead id in the path. Every one of those is a chance to forget the
 *   check — and forgetting it in ONE of eleven mutators is the realistic defect, not forgetting it
 *   everywhere. So all of them are asserted, individually and by name.
 *
 *   THE PAYLOAD. Ownership is decided by the server from the signed-in user. If any of
 *   `owner_user_id`, `assigned_to`, `created_by`, `brokerage_id`, `role` or `permission` could be
 *   set by sending it in the body, an agent could hand themselves someone else's book, or hand their
 *   own lead a different owner, without ever touching an endpoint they lack rights to.
 *
 * NOTHING HERE IS A FIX. Every control asserted below was already present and already correct when
 * this was written; the file is the regression net, and it is written so that REMOVING a control
 * fails it. That is the claim being made — not that a hole was found and closed.
 * ================================================================================================
 *
 * WHY 404 AND NOT 403 is itself part of the contract, and asserted: a 403 on a lead that exists and
 * a 404 on one that does not turns every endpoint into an oracle for "is lead 4,182 real?", one id
 * at a time, answerable by anyone who can sign in. Both answers must be the same answer.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 120_000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** The services under test, wired to one transaction. */
function services(tx: PrismaService) {
  const audit = new LeadAuditService(tx);
  const leads = new LeadsService(tx, audit, new LeadNotificationService(tx, null as never));
  /*
   * Only `access`, `prisma` and `audit` are exercised here: notes, tasks and showings never reach
   * the telephony, mail, recording or disclosure collaborators. They are passed as null so the test
   * cannot accidentally depend on them — if a refactor made a note write touch Twilio, this would
   * fail loudly rather than quietly send something.
   */
  const activity = new LeadActivityService(
    new ResourceAccessService(tx), tx, audit,
    null as never, null as never, null as never, null as never,
  );
  return { leads, activity };
}

async function makeAgent(tx: PrismaService, role = 'agent'): Promise<AuthUserRecord> {
  const now = new Date();
  const u = await tx.users.create({
    data: {
      name: `Cross agent ${tag()}`, email: `cross-${tag()}@example.test`,
      role, status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
  });
  return { ...u, user_permissions: [] } as unknown as AuthUserRecord;
}

/** A lead owned privately by `owner`, or the brokerage's own when `owner` is null. */
async function makeLead(tx: PrismaService, owner: number | null, assignedTo: number | null = null) {
  const now = new Date();
  return tx.leads.create({
    data: {
      name: `Lead ${tag()}`, email: `lead-${tag()}@example.test`,
      owner_user_id: owner, assigned_to: assignedTo,
      created_at: now, updated_at: now,
    } as never,
  });
}

/** What a refusal must look like: not found, and worded so it cannot confirm the lead exists. */
async function expectNotFound(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toMatchObject({ status: 404 });
  await expect(run()).rejects.toMatchObject({ response: { message: 'Lead not found.' } });
}

describe('an agent cannot read, edit or delete a colleague’s lead', () => {
  it('refuses get, update and delete, with the same answer as for a lead that does not exist', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx);
      const b = await makeAgent(tx);
      const hers = await makeLead(tx, a.id!);
      const { leads } = services(tx);

      // Agent A can, so the fixture is known good and the refusals below mean something.
      expect(await leads.get(hers.id, a)).toMatchObject({ id: hers.id });

      await expectNotFound(() => leads.get(hers.id, b));
      await expectNotFound(() => leads.update(hers.id, { name: 'Taken over' }, b));
      await expectNotFound(() => leads.remove(hers.id, b));

      // And the lead is untouched by the attempts.
      const after = await tx.leads.findUnique({ where: { id: hers.id } });
      expect(after).toMatchObject({ name: hers.name, owner_user_id: a.id, deleted_at: null });
    });
  });

  it('answers identically for a lead id that was never real', async () => {
    await inRollback(async (tx) => {
      const b = await makeAgent(tx);
      const { leads } = services(tx);
      // The point of the pairing: a caller cannot tell these two cases apart.
      await expectNotFound(() => leads.get(2_146_000_000, b));
    });
  });

  /**
   * Every activity mutator, by name. A lead id in the path is the only thing these take, so each is
   * an independent chance to omit the check — and the omission would be invisible from the outside.
   */
  it('refuses every note, task, showing and call mutator', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx);
      const b = await makeAgent(tx);
      const hers = await makeLead(tx, a.id!);
      const { activity } = services(tx);

      // Real child rows, created legitimately by A, so the refusals below are about ACCESS and not
      // about the note or task simply being absent.
      const note = await activity.addNote(hers.id, { content: 'Private' }, a) as { id: number };
      const task = await activity.addTask(hers.id, { title: 'Call back', due_date: '2026-09-01' }, a) as { id: number };
      const showing = await activity.addShowing(hers.id, { address: '1 Main St', showing_date: '2026-09-01' }, a) as { id: number };

      await expectNotFound(() => activity.addNote(hers.id, { content: 'Injected' }, b));
      await expectNotFound(() => activity.updateNote(hers.id, note.id, { content: 'Rewritten' }, b));
      await expectNotFound(() => activity.removeNote(hers.id, note.id, b));

      await expectNotFound(() => activity.addTask(hers.id, { title: 'Injected', due_date: '2026-09-01' }, b));
      await expectNotFound(() => activity.updateTask(hers.id, task.id, { title: 'Rewritten' }, b));
      await expectNotFound(() => activity.removeTask(hers.id, task.id, b));

      await expectNotFound(() => activity.addShowing(hers.id, { address: 'Injected', showing_date: '2026-09-01' }, b));
      await expectNotFound(() => activity.updateShowing(hers.id, showing.id, { address: 'Rewritten' }, b));
      await expectNotFound(() => activity.removeShowing(hers.id, showing.id, b));

      await expectNotFound(() => activity.addCall(hers.id, { outcome: 'Answered', duration: 30 }, b));

      // Nothing was created, changed or removed by any of the eleven attempts.
      expect(await tx.lead_notes.count({ where: { lead_id: hers.id } })).toBe(1);
      expect(await tx.lead_tasks.count({ where: { lead_id: hers.id } })).toBe(1);
      expect(await tx.lead_showings.count({ where: { lead_id: hers.id } })).toBe(1);
      expect(await tx.lead_calls.count({ where: { lead_id: hers.id } })).toBe(0);
      expect(await tx.lead_notes.findUnique({ where: { id: note.id } })).toMatchObject({ content: 'Private' });
    });
  });

  it('does not surface a colleague’s lead in the list, in any page of it', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx);
      const b = await makeAgent(tx);
      const hers = await makeLead(tx, a.id!);
      const his = await makeLead(tx, b.id!);
      const { leads } = services(tx);

      const page = await leads.list(b, { per_page: 200 } as never) as { data: { id: number }[] };
      const ids = page.data.map((r) => r.id);
      expect(ids).toContain(his.id);
      expect(ids).not.toContain(hers.id);
    });
  });
});

/**
 * THE PAYLOAD HALF.
 *
 * `LeadsService.validate` builds its output from a hard-coded allow-list rather than from the keys
 * of the request body, which is what makes all of this safe. These tests assert the CONSEQUENCE
 * rather than the mechanism, so a rewrite that keeps the behaviour passes and one that starts
 * copying fields across fails — including a change to a spread, which is the way this usually breaks.
 */
describe('identity fields cannot be set from a request body', () => {
  /** Everything an attacker would try, in one body. */
  const HOSTILE = {
    owner_user_id: 999_999,
    user_id: 999_999,
    created_by: 'Someone Else',
    brokerage_id: 999_999,
    role: 'admin',
    permission: 'admin',
    permissions: ['admin'],
    is_admin: true,
    id: 123_456,
    deleted_at: null,
  } as Record<string, unknown>;

  it('an agent creating a lead owns it, whatever the body claims', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx);
      const other = await makeAgent(tx);
      const { leads } = services(tx);

      const created = await leads.create(
        { name: 'Payload test', email: `payload-${tag()}@example.test`, ...HOSTILE, owner_user_id: other.id } as never,
        a,
      ) as { id: number };

      const row = await tx.leads.findUnique({ where: { id: created.id } });
      // The server decided the owner from the session, not from the body.
      expect(row!.owner_user_id).toBe(a.id);
      expect(row!.created_by).toBe(a.name);
      // And the id in the body did not become the row's id.
      expect(row!.id).not.toBe(123_456);
    });
  });

  it('an agent editing their own lead cannot re-point it at someone else', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx);
      const other = await makeAgent(tx);
      const mine = await makeLead(tx, a.id!);
      const { leads } = services(tx);

      await leads.update(mine.id, { name: 'Renamed', ...HOSTILE, owner_user_id: other.id } as never, a);

      const row = await tx.leads.findUnique({ where: { id: mine.id } });
      expect(row!.name).toBe('Renamed');            // the legitimate edit landed…
      expect(row!.owner_user_id).toBe(a.id);        // …and the hostile fields did not.
      expect(row!.created_by).toBe(mine.created_by);
    });
  });

  /**
   * The inverse, and the one that would matter most: a body cannot be used to PULL a colleague's
   * lead into your own book. The attempt is refused before ownership is even considered, because the
   * lead is not in the caller's scope — so this fails at the same 404 as everything above.
   */
  it('an agent cannot claim a colleague’s lead by naming themselves as its owner', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx);
      const b = await makeAgent(tx);
      const hers = await makeLead(tx, a.id!);
      const { leads } = services(tx);

      await expectNotFound(() => leads.update(hers.id, { owner_user_id: b.id, assigned_to: b.id } as never, b));

      const row = await tx.leads.findUnique({ where: { id: hers.id } });
      expect(row).toMatchObject({ owner_user_id: a.id, assigned_to: null });
    });
  });
});

/**
 * THE BOUNDARY BETWEEN A BROKERAGE LEAD AND A PRIVATE ONE, asked of the endpoints rather than of the
 * scope helper. A brokerage lead is shared with the roles that hold the brokerage scope; a lead an
 * agent created is theirs, and being senior is not a way in.
 */
describe('a private lead stays private, and a brokerage lead is shared', () => {
  it('a brokerage lead is reachable by a Manager and by the agent it is assigned to', async () => {
    await inRollback(async (tx) => {
      const manager = await makeAgent(tx, 'manager');
      const agent = await makeAgent(tx);
      const shared = await makeLead(tx, null, agent.id!);
      const { leads, activity } = services(tx);

      expect(await leads.get(shared.id, manager)).toMatchObject({ id: shared.id });
      expect(await leads.get(shared.id, agent)).toMatchObject({ id: shared.id });
      // And the side doors open for them too — the check admits as well as refuses.
      await expect(activity.addNote(shared.id, { content: 'ok' }, agent)).resolves.toBeDefined();
    });
  });

  it('an unassigned colleague still cannot reach that brokerage lead', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const stranger = await makeAgent(tx);
      const shared = await makeLead(tx, null, agent.id!);
      const { leads, activity } = services(tx);

      await expectNotFound(() => leads.get(shared.id, stranger));
      await expectNotFound(() => activity.addNote(shared.id, { content: 'no' }, stranger));
    });
  });

  it('a Manager cannot reach an agent’s private lead, by the record or by its notes', async () => {
    await inRollback(async (tx) => {
      const manager = await makeAgent(tx, 'manager');
      const agent = await makeAgent(tx);
      const private_ = await makeLead(tx, agent.id!);
      const { leads, activity } = services(tx);

      await expectNotFound(() => leads.get(private_.id, manager));
      await expectNotFound(() => leads.update(private_.id, { name: 'Seen' } as never, manager));
      await expectNotFound(() => activity.addNote(private_.id, { content: 'Seen' }, manager));
    });
  });

  it('a soft-deleted lead is out of reach even for the agent who owns it', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const mine = await makeLead(tx, agent.id!);
      await tx.leads.update({ where: { id: mine.id }, data: { deleted_at: new Date() } });
      const { leads, activity } = services(tx);

      // Recently Deleted has its own endpoints; the ordinary ones must treat it as gone.
      await expectNotFound(() => leads.get(mine.id, agent));
      await expectNotFound(() => activity.addNote(mine.id, { content: 'after deletion' }, agent));
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
