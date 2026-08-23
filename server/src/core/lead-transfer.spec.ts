import { PrismaClient } from '@prisma/client';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadTransferService } from '../leads/lead-transfer.service';
import { META_LEAD_SOURCE } from '../leads/lead.constants';
import { ResourceAccessService } from './resource-access.service';

/**
 * Lead Books — handing out the brokerage's own unassigned leads.
 *
 * WHAT THESE DEFEND, and it is mostly a set of refusals. The screen used to move one person's whole
 * book to another and list every agent beside a count of what they held. Both were ruled out on
 * 2026-08-02: an agent's leads are not available here, and how many leads a named agent holds is
 * not something this screen reports.
 *
 * So the tests below are largely about what CANNOT be reached:
 *
 *   an agent's own leads are not eligible and are never moved
 *   a lead merely assigned to an agent is not eligible either
 *   a Meta lead is never eligible, wherever it sits
 *   no per-agent figure appears anywhere in the response
 *
 * and then the narrow thing that remains: unassigned brokerage leads may be handed to somebody, by
 * a Super Admin, on the record.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 20000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/**
 * Start each test with an EMPTY brokerage pool.
 *
 * WHY THIS IS NEEDED, and why it is not loosening anything. `eligibleWhere()` is deliberately
 * GLOBAL — the pool genuinely is "every lead nobody owns and nobody is working", with no scope to
 * one test's rows. That is the product being right, and these assertions are the product's real
 * claims: hand over three, three move.
 *
 * But those claims are only checkable when the pool contains nothing else, and this suite runs
 * against the shared development database, which accumulates unowned leads over time. So the tests
 * were silently measuring the environment: `toBe(3)` became `Received: 4` the moment somebody
 * imported a lead nobody owned.
 *
 * Parking the pre-existing rows inside the transaction gives every test the clean pool it was
 * written for. `deleted_at` is used because it is the one field `eligibleWhere()` already filters
 * on, so nothing about the query under test is bypassed — and the whole thing is inside a
 * transaction that always rolls back, so no development row is changed for even a moment beyond it.
 */
async function emptyPool(tx: PrismaService): Promise<void> {
  await tx.leads.updateMany({
    where: { deleted_at: null, owner_user_id: null, assigned_to: null },
    data: { deleted_at: new Date() },
  });
}

const audits: { action: string; subject: string; details: string }[] = [];
const auditStub = { record: async (_u: unknown, action: string, subject: string, details = '') => { audits.push({ action, subject, details }); } } as never;

const as = (u: { id: number; name: string; role: string | null }) => ({ id: u.id, name: u.name, role: u.role ?? 'agent' }) as never;

async function scene(tx: PrismaService, poolLeads = 3) {
  const now = new Date();
  const n = ++seq;
  const mk = (role: string, tag: string, status = 'Active') => tx.users.create({
    data: { name: `${tag} ${n}`, email: `${tag}-${Date.now()}-${n}@x.test`, password: 'x', role, status, created_at: now, updated_at: now },
  });
  const agent = await mk('agent', 'agent');
  const successor = await mk('agent', 'successor');
  const admin = await mk('admin', 'admin');

  // Unassigned brokerage leads: no owner, no assignee. The only kind this screen may touch.
  for (let i = 0; i < poolLeads; i++) {
    await tx.leads.create({
      data: { name: `Pool ${i}`, email: `pool-${Date.now()}-${n}-${i}@x.test`, created_at: now, updated_at: now },
    });
  }
  return { agent, successor, admin };
}

/** A lead sitting in somebody's book, which Lead Books must never see. */
async function ownedLead(tx: PrismaService, userId: number, over: Record<string, unknown> = {}) {
  const now = new Date();
  return tx.leads.create({
    data: {
      name: `Owned ${++seq}`, email: `owned-${Date.now()}-${seq}@x.test`,
      owner_user_id: userId, assigned_to: userId, created_at: now, updated_at: now, ...over,
    },
  });
}

describe('unassigned brokerage leads can be handed out', () => {
  beforeEach(() => { audits.length = 0; });
  afterAll(async () => { await prisma.$disconnect(); });

  /**
   * ASSIGNS THE POOL, AND THE BROKERAGE STAYS THE OWNER.
   *
   * This used to expect `owner_user_id = successor` as well, and that expectation was the bug: it
   * CONVERTED a brokerage lead into that agent's private one, so the moment a lead was handed out
   * the brokerage could no longer see the lead it had generated. Ownership and assignment are
   * separate columns precisely so they can say different things — see `common/lead-scope.ts`.
   *
   * The test now asserts both halves of the corrected model at once: the assignee is set, and the
   * owner is still nobody.
   */
  it('assigns the pool to the chosen person while the brokerage keeps ownership', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { successor, admin } = await scene(tx, 3);
      const result = await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);

      expect(result.moved).toBe(3);
      expect(result.remaining).toBe(0);
      expect(await tx.leads.count({
        where: { owner_user_id: null, assigned_to: successor.id, deleted_at: null },
      })).toBe(3);
      // And nothing was quietly taken into the successor's own book.
      expect(await tx.leads.count({ where: { owner_user_id: successor.id, deleted_at: null } })).toBe(0);
    });
  });

  it('makes them reachable by the person who received them', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { successor, admin } = await scene(tx, 1);
      // `deleted_at: null` so this picks the lead the SERVICE would pick. Without it the test
      // selected a parked development row, transferred a different one, and then asked whether
      // the successor could reach the row nobody had moved.
      const lead = await tx.leads.findFirst({ where: { deleted_at: null, owner_user_id: null, assigned_to: null }, select: { id: true } });
      await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);

      await expect(new ResourceAccessService(tx).assertLead(as(successor), lead!.id)).resolves.toBeUndefined();
    });
  });

  it('hands over only as many as asked for, oldest first', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { successor, admin } = await scene(tx, 5);
      const oldest = await tx.leads.findMany({
        // Mirrors `eligibleWhere()` exactly, `deleted_at` included — an expectation that asks a
        // DIFFERENT question from the code under test is not checking that code.
        where: { deleted_at: null, owner_user_id: null, assigned_to: null }, select: { id: true }, orderBy: { id: 'asc' }, take: 2,
      });

      const result = await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id, 2);

      expect(result.moved).toBe(2);
      expect(result.remaining).toBe(3);
      // Identified by ASSIGNMENT now, not ownership — the brokerage still owns all five.
      const moved = await tx.leads.findMany({ where: { assigned_to: successor.id }, select: { id: true }, orderBy: { id: 'asc' } });
      expect(moved.map((m) => m.id)).toEqual(oldest.map((o) => o.id));
    });
  });

  it('reports only counts, never the leads themselves', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { successor, admin } = await scene(tx, 2);
      const result = await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);
      expect(Object.keys(result).sort()).toEqual(['moved', 'remaining', 'to']);
    });
  });

  it('refuses when there is nothing waiting, rather than reporting a silent success', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { agent, successor, admin } = await scene(tx, 0);
      await ownedLead(tx, agent.id);   // exists, but is not the brokerage's to give

      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id))
        .rejects.toThrow(UnprocessableEntityException);
    });
  });
});

describe('an agent\'s own leads are out of reach', () => {
  beforeEach(() => { audits.length = 0; });

  it('never counts a lead somebody owns as available', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { agent, admin } = await scene(tx, 2);
      await ownedLead(tx, agent.id);
      await ownedLead(tx, agent.id);
      await ownedLead(tx, agent.id);

      // Three in a book, two in the pool. Only the pool is the brokerage's to hand out.
      expect((await new LeadTransferService(tx, auditStub).books(as(admin))).available).toBe(2);
    });
  });

  it('leaves an agent\'s leads exactly where they are when the pool is handed over', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { agent, successor, admin } = await scene(tx, 1);
      const theirs = await ownedLead(tx, agent.id);

      const result = await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);

      expect(result.moved).toBe(1);
      const after = await tx.leads.findUnique({ where: { id: theirs.id } });
      expect(after?.owner_user_id).toBe(agent.id);
      expect(after?.assigned_to).toBe(agent.id);
    });
  });

  it('will not take a lead that is unowned but assigned to somebody', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { agent, successor, admin } = await scene(tx, 0);
      // No owner, but it is on a named person's list. Taking it would be the same intrusion by
      // another route.
      const assigned = await ownedLead(tx, agent.id, { owner_user_id: null });

      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id))
        .rejects.toThrow(UnprocessableEntityException);
      expect((await tx.leads.findUnique({ where: { id: assigned.id } }))?.assigned_to).toBe(agent.id);
    });
  });

  /**
   * A META LEAD NOBODY OWNS IS THE BROKERAGE'S, AND IS HANDABLE. This asserted the opposite.
   *
   * The pool used to exclude `source = 'facebook_meta'` outright, to keep an agent's personal Meta
   * leads out of it. That exclusion is now redundant — a personal Meta lead is OWNED by its agent,
   * and the pool already requires `owner_user_id IS NULL` — and it had become actively harmful:
   * a Page connected by brokerage staff produces brokerage-owned Meta leads, and once the person
   * triaging them leaves, those leads land unowned and unassigned with nothing able to hand them on.
   * A lead the brokerage paid for would have been stranded for ever.
   *
   * The protection that matters is unchanged and is asserted directly below: an agent's OWN Meta
   * lead is still untouchable, because it has an owner.
   */
  it("takes an unowned Meta lead — nobody owns it, so it is the brokerage's to hand out", async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { successor, admin } = await scene(tx, 0);
      const now = new Date();
      const meta = await tx.leads.create({
        data: {
          name: `Meta ${++seq}`, email: `meta-${Date.now()}-${seq}@x.test`,
          source: META_LEAD_SOURCE, created_at: now, updated_at: now,
        },
      });

      expect((await new LeadTransferService(tx, auditStub).books(as(admin))).available).toBe(1);
      const r = await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);
      expect(r.moved).toBe(1);

      const after = await tx.leads.findUnique({ where: { id: meta.id } });
      expect(after?.assigned_to).toBe(successor.id);   // handed on
      expect(after?.owner_user_id).toBeNull();         // still the brokerage's
    });
  });

  it("will NOT take an agent's own Meta lead — that one has an owner", async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { successor, admin } = await scene(tx, 0);
      const now = new Date();
      const agent = await tx.users.create({
        data: {
          name: `MetaAgent ${++seq}`, email: `meta-agent-${Date.now()}-${seq}@x.test`,
          password: 'x', role: 'agent', created_at: now, updated_at: now,
        },
      });
      const mine = await tx.leads.create({
        data: {
          name: `Mine ${++seq}`, email: `mine-${Date.now()}-${seq}@x.test`,
          source: META_LEAD_SOURCE, owner_user_id: agent.id,
          created_at: now, updated_at: now,
        },
      });

      expect((await new LeadTransferService(tx, auditStub).books(as(admin))).available).toBe(0);
      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id))
        .rejects.toThrow(UnprocessableEntityException);
      expect((await tx.leads.findUnique({ where: { id: mine.id } }))?.owner_user_id).toBe(agent.id);
    });
  });
});

describe('no agent-level statistics leave this screen', () => {
  it('returns a pool size and a list of names, and nothing per person', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { agent, admin } = await scene(tx, 2);
      await ownedLead(tx, agent.id);
      await ownedLead(tx, agent.id);
      await ownedLead(tx, agent.id);
      await ownedLead(tx, agent.id);

      const pool = await new LeadTransferService(tx, auditStub).books(as(admin));

      expect(Object.keys(pool).sort()).toEqual(['available', 'recipients']);
      // A recipient is somebody a lead can be given to — a name and a role, never a figure.
      for (const r of pool.recipients) {
        expect(Object.keys(r).sort()).toEqual(['name', 'role', 'user_id']);
      }

      // The pool itself is only the two unowned leads — the agent's four are not counted anywhere.
      expect(pool.available).toBe(2);
    });
  });

  /**
   * The property stated as a property, rather than as a shape.
   *
   * Giving an agent four more leads must change NOTHING in this response. A field added later
   * called `total`, `assigned` or `book_size` would pass a key check written today and fail this,
   * which is the point — the guarantee is "reveals nothing about anybody's book", not "has these
   * particular keys".
   */
  it('answers identically however many leads an agent is holding', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { agent, admin } = await scene(tx, 2);
      const svc = new LeadTransferService(tx, auditStub);

      const before = await svc.books(as(admin));
      for (let i = 0; i < 4; i++) await ownedLead(tx, agent.id);
      const after = await svc.books(as(admin));

      expect(after).toEqual(before);
    });
  });
});

describe('the door is narrow', () => {
  beforeEach(() => { audits.length = 0; });

  it('is refused to an agent and to a manager', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { agent, successor } = await scene(tx, 1);
      const now = new Date();
      const manager = await tx.users.create({
        data: { name: `mgr ${++seq}`, email: `mgr-${Date.now()}-${seq}@x.test`, password: 'x', role: 'manager', created_at: now, updated_at: now },
      });
      const svc = new LeadTransferService(tx, auditStub);
      await expect(svc.transfer(as(agent), successor.id)).rejects.toThrow(ForbiddenException);
      await expect(svc.transfer(as(manager), successor.id)).rejects.toThrow(ForbiddenException);
      // And the pool screen is just as closed.
      await expect(svc.books(as(manager))).rejects.toThrow(ForbiddenException);
    });
  });

  it('refuses to hand leads to an inactive account', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin } = await scene(tx, 1);
      const now = new Date();
      const gone = await tx.users.create({
        data: { name: `gone ${++seq}`, email: `gone-${Date.now()}-${seq}@x.test`, password: 'x', role: 'agent', status: 'Inactive', created_at: now, updated_at: now },
      });
      // Otherwise they would be invisible again the moment they landed.
      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), gone.id))
        .rejects.toThrow(UnprocessableEntityException);
    });
  });

  it('cannot be done quietly', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { successor, admin } = await scene(tx, 2);
      await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);

      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('Brokerage leads assigned');
      expect(audits[0].subject).toContain(successor.name);
      expect(audits[0].details).toContain('2 unassigned brokerage leads');
    });
  });
});

/**
 * A MALFORMED RECIPIENT IS THE CALLER'S MISTAKE, NOT A SERVER FAULT.
 *
 * ================================================================================================
 * THE DEFECT THIS PINS DOWN, found by probing the running API during the CRM audit. The controller
 * reads the recipient with `Number(body?.to_user_id)`, and that is `NaN` for a missing field and for
 * anything non-numeric. `NaN` cannot be compiled into a Prisma `where`, so `findUnique` threw a
 * validation error and the request ended as:
 *
 *     POST /api/leads/transfer-ownership  {}                  -> 500 Internal Server Error
 *     POST /api/leads/transfer-ownership  {to_user_id:'abc'}  -> 500 Internal Server Error
 *
 * No stack reached the client — the body was the generic "Internal server error" — so this was never
 * a disclosure. It was still wrong: a bad request body must not be a server-level failure, and every
 * one of them wrote a Prisma stack into the error log as though something had broken.
 * ================================================================================================
 *
 * ZERO AND NEGATIVES ARE REFUSED TOO, and that is the part worth reading twice. `Number(null)` is
 * `0` — an integer, so a test for "is this a number" would pass it straight through to a lookup for
 * user zero, which then answered "that person no longer exists" to what was really a missing field.
 * A well-formed id that matches nobody is a genuinely different answer and is still a 404.
 */
describe('the recipient must be a valid id before anything is moved', () => {
  it.each([
    ['a missing field', Number(undefined)],   // NaN — `{}`
    ['a non-numeric value', Number('abc')],   // NaN — `{to_user_id:'abc'}`
    ['null', Number(null)],                   // 0
    ['zero', 0],
    ['a negative id', -1],
    ['a fractional id', 1.5],
  ])('refuses %s with 422 rather than failing', async (_label, value) => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin } = await scene(tx, 1);
      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), value))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('still answers 404 for a well-formed id that matches nobody', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin } = await scene(tx, 1);
      // Not 422: the request is well formed, the person simply is not there. Collapsing the two
      // would lose the distinction between "you sent nothing" and "they have gone".
      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), 2_146_000_000))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  it('refuses a malformed recipient BEFORE the permission check is passed, not after', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { agent } = await scene(tx, 1);
      // An ordinary agent sending rubbish must still be told they may not do this at all — the
      // validation must not become a way to probe the endpoint from an unprivileged account.
      await expect(new LeadTransferService(tx, auditStub).transfer(as(agent), Number('abc')))
        .rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('moves nothing and records nothing when the recipient is malformed', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin } = await scene(tx, 3);
      const before = audits.length;

      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), Number(undefined)))
        .rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(audits).toHaveLength(before);
      // Every eligible lead is still eligible: nothing was handed to anybody.
      expect((await new LeadTransferService(tx, auditStub).books(as(admin))).available).toBe(3);
    });
  });
});
