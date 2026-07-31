import { PrismaClient } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from './resource-access.service';

/**
 * Lead and template ownership, as the brokerage described it.
 *
 *   A lead is the agent's who owns it. Assigning it to somebody makes it visible to BOTH, and both
 *   can work it — but only the owner may delete it, and only the owner may change who the lead IS:
 *   name, email, phone, source, assignment. Everything else — notes, tasks, calls, status — is fair
 *   game for either of them, because that is the work.
 *
 *   A campaign template with no owner is one of the six built-ins: everybody starts from them and
 *   nobody may change them. Anything an agent writes is theirs to edit and delete, and invisible to
 *   every other agent and to the brokerage's own templates.
 *
 * The brokerage is not scoped by either rule. It is the party that has to be able to see the whole
 * pipeline and everything being sent under its name.
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

async function people(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const mk = async (role: string, tag: string) => tx.users.create({
    data: { name: `${tag} ${n}`, email: `${tag}-${Date.now()}-${n}@x.test`, password: 'x', role, company_id: 1, created_at: now, updated_at: now },
  });
  return { owner: await mk('agent', 'owner'), colleague: await mk('agent', 'colleague'), admin: await mk('admin', 'brokerage') };
}

const as = (u: { id: number; name: string; role: string | null }) => ({ id: u.id, name: u.name, role: u.role ?? 'agent' });

describe('a lead belongs to its owner, and an assignment is shared', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  async function lead(tx: PrismaService, ownerId: number, assignedTo: number | null) {
    const now = new Date();
    return tx.leads.create({
      data: { name: 'A Lead', email: `lead-${Date.now()}-${++seq}@x.test`, owner_user_id: ownerId, assigned_to: assignedTo, company_id: 1, created_at: now, updated_at: now },
    });
  }

  it('shows it to the owner and to the person it was assigned to', async () => {
    await inRollback(async (tx) => {
      const { owner, colleague } = await people(tx);
      const l = await lead(tx, owner.id, colleague.id);
      const access = new ResourceAccessService(tx);
      await expect(access.assertLead(as(owner), l.id)).resolves.toBeUndefined();
      await expect(access.assertLead(as(colleague), l.id)).resolves.toBeUndefined();
    });
  });

  it('hides it from an agent who is neither', async () => {
    await inRollback(async (tx) => {
      const { owner, colleague } = await people(tx);
      const l = await lead(tx, owner.id, null);
      const access = new ResourceAccessService(tx);
      await expect(access.assertLead(as(colleague), l.id)).rejects.toThrow(ForbiddenException);
    });
  });

  it('shows every lead to the brokerage, including one an agent created', async () => {
    await inRollback(async (tx) => {
      const { owner, admin } = await people(tx);
      const l = await lead(tx, owner.id, null);
      const access = new ResourceAccessService(tx);
      // This is the case that used to fail: the scope applied to everyone, so a lead an agent made
      // was invisible to the administrators of the brokerage it belongs to.
      await expect(access.assertLead(as(admin), l.id)).resolves.toBeUndefined();
    });
  });
});

describe('what the person a lead was assigned to may change', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  /** The identity fields, read from the service so the test cannot drift from the rule. */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LeadsService } = require('../leads/leads.service');
  const locked = (): Record<string, string> =>
    (LeadsService as unknown as { LOCKED_FIELDS: Record<string, string> }).LOCKED_FIELDS
    ?? (Object.getOwnPropertyDescriptor(LeadsService, 'LOCKED_FIELDS')?.value as Record<string, string>);

  it('locks who the lead IS, and nothing else', () => {
    const fields = Object.keys(locked() ?? {}).sort();
    // Exactly the brokerage's list: name, email, phone, plus where it came from and whose desk it
    // is on. Notes, tasks, calls and status are deliberately absent — that is the work, and both
    // people are supposed to be doing it.
    expect(fields).toEqual(['assigned_to', 'email', 'lead_source', 'name', 'phone']);
  });
});

describe('campaign templates are the author\'s, and the built-ins are nobody\'s', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CampaignTemplatesService } = require('../campaigns/campaign-templates.service');
  // The audience service is only used to list the {{tokens}} a template mentions, which has
  // nothing to do with ownership.
  const svc = (tx: PrismaService) => new CampaignTemplatesService(tx, { extractTokens: () => [] } as never);

  async function template(tx: PrismaService, userId: number | null, name: string) {
    const now = new Date();
    return tx.campaign_templates.create({
      data: { name, subject: 's', content: 'c', category: 'general', user_id: userId, created_by: userId ? 'agent' : 'System', company_id: 1, created_at: now, updated_at: now },
    });
  }

  it('shows an agent the built-ins and their own, and nobody else\'s', async () => {
    await inRollback(async (tx) => {
      const { owner, colleague } = await people(tx);
      const mine = await template(tx, owner.id, `mine ${seq}`);
      const theirs = await template(tx, colleague.id, `theirs ${seq}`);

      const list = await svc(tx).list(undefined, as(owner)) as { id: number; name: string }[];
      const ids = list.map((t) => t.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      // The six that ship with the application are visible to everyone.
      expect(list.filter((t) => [1, 2, 3, 4, 5, 6].includes(t.id)).length).toBeGreaterThan(0);
    });
  });

  it('lets an agent change and delete their own', async () => {
    await inRollback(async (tx) => {
      const { owner } = await people(tx);
      const mine = await template(tx, owner.id, `mine ${seq}`);
      await expect(svc(tx).update(mine.id, { name: 'renamed', subject: 's', content: 'c' }, as(owner))).resolves.toBeDefined();
      await expect(svc(tx).remove(mine.id, as(owner))).resolves.toMatchObject({ deleted: true });
    });
  });

  it('refuses to let an agent change or delete a built-in', async () => {
    await inRollback(async (tx) => {
      const { owner } = await people(tx);
      const builtIn = await template(tx, null, `built-in ${seq}`);
      await expect(svc(tx).update(builtIn.id, { name: 'x', subject: 's', content: 'c' }, as(owner))).rejects.toThrow(/built-in/);
      await expect(svc(tx).remove(builtIn.id, as(owner))).rejects.toThrow(/built-in/);
    });
  });

  it('refuses to let an agent touch a colleague\'s', async () => {
    await inRollback(async (tx) => {
      const { owner, colleague } = await people(tx);
      const theirs = await template(tx, colleague.id, `theirs ${seq}`);
      // Not visible, so it reads as missing rather than forbidden — the agent has no way to learn
      // that it exists.
      await expect(svc(tx).remove(theirs.id, as(owner))).rejects.toThrow(/not found/i);
    });
  });

  it('leaves the brokerage able to manage everything', async () => {
    await inRollback(async (tx) => {
      const { colleague, admin } = await people(tx);
      const theirs = await template(tx, colleague.id, `theirs ${seq}`);
      const builtIn = await template(tx, null, `built-in ${seq}`);
      await expect(svc(tx).update(theirs.id, { name: 'x', subject: 's', content: 'c' }, as(admin))).resolves.toBeDefined();
      await expect(svc(tx).update(builtIn.id, { name: 'y', subject: 's', content: 'c' }, as(admin))).resolves.toBeDefined();
    });
  });
});
