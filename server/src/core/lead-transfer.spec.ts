import { PrismaClient } from '@prisma/client';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadTransferService } from '../leads/lead-transfer.service';
import { ResourceAccessService } from './resource-access.service';

/**
 * Moving a book of leads.
 *
 * An agent's leads are confidential, so when an agent leaves their book is invisible to everybody —
 * including the administrator — and no screen can reassign it, because the reassignment control
 * sits on a lead nobody can open. This is the way back in, and the point of these tests is that it
 * is a narrow one:
 *
 *   it is keyed on the OWNER, so nobody has to name or read a lead to move a book
 *   it returns a count and nothing else
 *   it is Super Admin only
 *   it is written to the audit trail every time
 *
 * The last test is the honest one. An administrator who transfers a working agent's book to
 * themselves CAN then read it — no arrangement makes that impossible while also letting them
 * recover a departed agent's work. What the design guarantees is that the route cannot be taken
 * quietly.
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

async function scene(tx: PrismaService, leadCount = 3) {
  const now = new Date();
  const n = ++seq;
  const mk = (role: string, tag: string, status = 'Active') => tx.users.create({
    data: { name: `${tag} ${n}`, email: `${tag}-${Date.now()}-${n}@x.test`, password: 'x', role, status, company_id: 1, created_at: now, updated_at: now },
  });
  const leaver = await mk('agent', 'leaver');
  const successor = await mk('agent', 'successor');
  const admin = await mk('admin', 'admin');
  for (let i = 0; i < leadCount; i++) {
    await tx.leads.create({
      data: { name: `Lead ${i}`, email: `l-${Date.now()}-${n}-${i}@x.test`, owner_user_id: leaver.id, company_id: 1, created_at: now, updated_at: now },
    });
  }
  return { leaver, successor, admin };
}

const as = (u: { id: number; name: string; role: string | null }) => ({ id: u.id, name: u.name, role: u.role ?? 'agent' }) as never;

describe('a departed agent\'s book can be recovered', () => {
  beforeEach(() => { audits.length = 0; });
  afterAll(async () => { await prisma.$disconnect(); });

  it('moves every lead to the successor', async () => {
    await inRollback(async (tx) => {
      const { leaver, successor, admin } = await scene(tx, 3);
      const svc = new LeadTransferService(tx, auditStub);
      const result = await svc.transfer(as(admin), leaver.id, successor.id);
      expect(result.moved).toBe(3);
      expect(await tx.leads.count({ where: { owner_user_id: leaver.id, deleted_at: null } })).toBe(0);
      expect(await tx.leads.count({ where: { owner_user_id: successor.id, deleted_at: null } })).toBe(3);
    });
  });

  it('makes them reachable by the successor and unreachable by the person who left', async () => {
    await inRollback(async (tx) => {
      const { leaver, successor, admin } = await scene(tx, 1);
      const lead = await tx.leads.findFirst({ where: { owner_user_id: leaver.id }, select: { id: true } });
      const access = new ResourceAccessService(tx);
      await new LeadTransferService(tx, auditStub).transfer(as(admin), leaver.id, successor.id);

      await expect(access.assertLead(as(successor), lead!.id)).resolves.toBeUndefined();
      await expect(access.assertLead(as(leaver), lead!.id)).rejects.toThrow(ForbiddenException);
    });
  });

  it('reports only a count, never the leads themselves', async () => {
    await inRollback(async (tx) => {
      const { leaver, successor, admin } = await scene(tx, 2);
      const result = await new LeadTransferService(tx, auditStub).transfer(as(admin), leaver.id, successor.id);
      // Nothing about who the leads are may come back through this door.
      expect(Object.keys(result).sort()).toEqual(['from', 'moved', 'to']);
    });
  });

  it('shows who holds a book without showing whose leads they are', async () => {
    await inRollback(async (tx) => {
      const { leaver, admin } = await scene(tx, 4);
      const books = await new LeadTransferService(tx, auditStub).books(as(admin));
      const theirs = books.find((b) => b.user_id === leaver.id);
      expect(theirs?.leads).toBe(4);
      // Counts and names of PEOPLE — never a lead name, email or phone.
      expect(Object.keys(theirs ?? {}).sort()).toEqual(['leads', 'name', 'role', 'user_id']);
    });
  });
});

describe('the door is narrow', () => {
  beforeEach(() => { audits.length = 0; });
  afterAll(async () => { await prisma.$disconnect(); });

  it('is refused to an agent and to a manager', async () => {
    await inRollback(async (tx) => {
      const { leaver, successor } = await scene(tx, 1);
      const now = new Date();
      const manager = await tx.users.create({
        data: { name: `mgr ${++seq}`, email: `mgr-${Date.now()}-${seq}@x.test`, password: 'x', role: 'manager', company_id: 1, created_at: now, updated_at: now },
      });
      const svc = new LeadTransferService(tx, auditStub);
      await expect(svc.transfer(as(leaver), leaver.id, successor.id)).rejects.toThrow(ForbiddenException);
      await expect(svc.transfer(as(manager), leaver.id, successor.id)).rejects.toThrow(ForbiddenException);
      // And the counts screen is just as closed.
      await expect(svc.books(as(manager))).rejects.toThrow(ForbiddenException);
    });
  });

  it('refuses to move a book onto an inactive account', async () => {
    await inRollback(async (tx) => {
      const { leaver, admin } = await scene(tx, 1);
      const now = new Date();
      const gone = await tx.users.create({
        data: { name: `gone ${++seq}`, email: `gone-${Date.now()}-${seq}@x.test`, password: 'x', role: 'agent', status: 'Inactive', company_id: 1, created_at: now, updated_at: now },
      });
      // Otherwise the book would be invisible again the moment it landed.
      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), leaver.id, gone.id))
        .rejects.toThrow(UnprocessableEntityException);
    });
  });

  it('refuses to move a book to itself', async () => {
    await inRollback(async (tx) => {
      const { leaver, admin } = await scene(tx, 1);
      await expect(new LeadTransferService(tx, auditStub).transfer(as(admin), leaver.id, leaver.id))
        .rejects.toThrow(UnprocessableEntityException);
    });
  });

  it('cannot be done quietly', async () => {
    await inRollback(async (tx) => {
      const { leaver, successor, admin } = await scene(tx, 2);
      await new LeadTransferService(tx, auditStub).transfer(as(admin), leaver.id, successor.id);

      // This is the whole guarantee. An administrator can take a book — including a working
      // agent's — but the taking is on the record, with both names and a count.
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('Lead ownership transferred');
      expect(audits[0].subject).toContain(leaver.name);
      expect(audits[0].subject).toContain(successor.name);
      expect(audits[0].details).toContain('2 leads moved');
    });
  });
});
