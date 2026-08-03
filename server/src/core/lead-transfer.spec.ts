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

const audits: { action: string; subject: string; details: string }[] = [];
const auditStub = { record: async (_u: unknown, action: string, subject: string, details = '') => { audits.push({ action, subject, details }); } } as never;

const as = (u: { id: number; name: string; role: string | null }) => ({ id: u.id, name: u.name, role: u.role ?? 'agent' }) as never;

async function scene(tx: PrismaService, poolLeads = 3) {
  const now = new Date();
  const n = ++seq;
  const mk = (role: string, tag: string, status = 'Active') => tx.users.create({
    data: { name: `${tag} ${n}`, email: `${tag}-${Date.now()}-${n}@x.test`, password: 'x', role, status, company_id: 1, created_at: now, updated_at: now },
  });
  const agent = await mk('agent', 'agent');
  const successor = await mk('agent', 'successor');
  const admin = await mk('admin', 'admin');

  // Unassigned brokerage leads: no owner, no assignee. The only kind this screen may touch.
  for (let i = 0; i < poolLeads; i++) {
    await tx.leads.create({
      data: { name: `Pool ${i}`, email: `pool-${Date.now()}-${n}-${i}@x.test`, company_id: 1, created_at: now, updated_at: now },
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
      owner_user_id: userId, assigned_to: userId, company_id: 1, created_at: now, updated_at: now, ...over,
    },
  });
}

describe('unassigned brokerage leads can be handed out', () => {
  beforeEach(() => { audits.length = 0; });
  afterAll(async () => { await prisma.$disconnect(); });

  it('gives the pool to the chosen person, as owner and assignee', async () => {
    await inRollback(async (tx) => {
      const { successor, admin } = await scene(tx, 3);
      const result = await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);

      expect(result.moved).toBe(3);
      expect(result.remaining).toBe(0);
      expect(await tx.leads.count({ where: { owner_user_id: successor.id, assigned_to: successor.id, deleted_at: null } })).toBe(3);
    });
  });

  it('makes them reachable by the person who received them', async () => {
    await inRollback(async (tx) => {
      const { successor, admin } = await scene(tx, 1);
      const lead = await tx.leads.findFirst({ where: { owner_user_id: null, assigned_to: null }, select: { id: true } });
      await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);

      await expect(new ResourceAccessService(tx).assertLead(as(successor), lead!.id)).resolves.toBeUndefined();
    });
  });

  it('hands over only as many as asked for, oldest first', async () => {
    await inRollback(async (tx) => {
      const { successor, admin } = await scene(tx, 5);
      const oldest = await tx.leads.findMany({
        where: { owner_user_id: null, assigned_to: null }, select: { id: true }, orderBy: { id: 'asc' }, take: 2,
      });

      const result = await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id, 2);

      expect(result.moved).toBe(2);
      expect(result.remaining).toBe(3);
      const moved = await tx.leads.findMany({ where: { owner_user_id: successor.id }, select: { id: true }, orderBy: { id: 'asc' } });
      expect(moved.map((m) => m.id)).toEqual(oldest.map((o) => o.id));
    });
  });

  it('reports only counts, never the leads themselves', async () => {
    await inRollback(async (tx) => {
      const { successor, admin } = await scene(tx, 2);
      const result = await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);
      expect(Object.keys(result).sort()).toEqual(['moved', 'remaining', 'to']);
    });
  });

  it('refuses when there is nothing waiting, rather than reporting a silent success', async () => {
    await inRollback(async (tx) => {
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
      const { agent, successor, admin } = await scene(tx, 0);
      // No owner, but it is on a named person's list. Taking it would be the same intrusion by
      // another route.
      const assigned = await ownedLead(tx, agent.id, { owner_user_id: null });

      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id))
        .rejects.toThrow(UnprocessableEntityException);
      expect((await tx.leads.findUnique({ where: { id: assigned.id } }))?.assigned_to).toBe(agent.id);
    });
  });

  it('will not take a Meta lead even when it has no owner at all', async () => {
    await inRollback(async (tx) => {
      const { successor, admin } = await scene(tx, 0);
      const now = new Date();
      const meta = await tx.leads.create({
        data: {
          name: `Meta ${++seq}`, email: `meta-${Date.now()}-${seq}@x.test`,
          source: META_LEAD_SOURCE, company_id: 1, created_at: now, updated_at: now,
        },
      });

      expect((await new LeadTransferService(tx, auditStub).books(as(admin))).available).toBe(0);
      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id))
        .rejects.toThrow(UnprocessableEntityException);
      expect((await tx.leads.findUnique({ where: { id: meta.id } }))?.owner_user_id).toBeNull();
    });
  });
});

describe('no agent-level statistics leave this screen', () => {
  it('returns a pool size and a list of names, and nothing per person', async () => {
    await inRollback(async (tx) => {
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
      const { agent, successor } = await scene(tx, 1);
      const now = new Date();
      const manager = await tx.users.create({
        data: { name: `mgr ${++seq}`, email: `mgr-${Date.now()}-${seq}@x.test`, password: 'x', role: 'manager', company_id: 1, created_at: now, updated_at: now },
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
      const { admin } = await scene(tx, 1);
      const now = new Date();
      const gone = await tx.users.create({
        data: { name: `gone ${++seq}`, email: `gone-${Date.now()}-${seq}@x.test`, password: 'x', role: 'agent', status: 'Inactive', company_id: 1, created_at: now, updated_at: now },
      });
      // Otherwise they would be invisible again the moment they landed.
      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), gone.id))
        .rejects.toThrow(UnprocessableEntityException);
    });
  });

  it('cannot be done quietly', async () => {
    await inRollback(async (tx) => {
      const { successor, admin } = await scene(tx, 2);
      await new LeadTransferService(tx, auditStub).transfer(as(admin), successor.id);

      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('Brokerage leads assigned');
      expect(audits[0].subject).toContain(successor.name);
      expect(audits[0].details).toContain('2 unassigned brokerage leads');
    });
  });
});
