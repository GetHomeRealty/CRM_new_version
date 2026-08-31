import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-012: the Delete button must not be offered where the server will refuse it.
 *
 * TWO RULES FOR ONE QUESTION, which is the whole defect. The leads list hid Delete when a lead had
 * an OWNER who was somebody else. `remove()` refuses whenever the agent is not the owner. Those
 * differ precisely on a lead owned by NOBODY - and on this brokerage's data every lead is owned by
 * nobody, so the list's test never fired and the server's always did. An agent was shown a Delete
 * button on every lead and refused on every one of them, 403.
 *
 * IT FAILED SAFE, and that is why this is Low rather than a data-loss defect: the server is the
 * authority and it held. What it cost was confidence - a refusal message and a moment of wondering
 * whether something had just been destroyed.
 *
 * SO THE ASSERTION IS AGREEMENT, not the flag's value in isolation. `can_delete` is checked against
 * what `remove()` actually does for the same user and the same lead: a flag that is merely
 * plausible would reproduce the defect in a new place.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

const AGENT = { id: 4242, name: 'Sai Ramesh', role: 'agent' } as unknown as AuthUserRecord;
const ADMIN = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;

function leadsFor(tx: PrismaService) {
  return new LeadsService(tx, new LeadAuditService(tx), new LeadNotificationService(tx, null as never));
}

async function makeLead(tx: PrismaService, over: Record<string, unknown>) {
  const t = tag();
  const now = new Date();
  return tx.leads.create({
    data: {
      name: `ZZ CanDelete ${t}`, email: `zz-candel-${t}@probe.test`, phone: '4165550000',
      lead_status: 'warm', created_at: now, updated_at: now, ...over,
    },
  });
}

/** What `remove()` really does, reduced to allowed / refused. */
async function reallyDeletable(tx: PrismaService, id: number, user: AuthUserRecord): Promise<boolean> {
  try {
    await leadsFor(tx).remove(id, user);
    return true;
  } catch {
    return false;
  }
}

describe('the Delete button is offered exactly when the delete would work', () => {
  it('agrees with the server on a lead owned by nobody', async () => {
    // THE DEFECT'S OWN CASE. Every lead in this brokerage looks like this.
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { owner_user_id: null, assigned_to: AGENT.id });
      const row = await leadsFor(tx).get(lead.id, AGENT) as { can_delete: boolean };

      expect(row.can_delete).toBe(false);
      expect(await reallyDeletable(tx, lead.id, AGENT)).toBe(false);
    });
  });

  it('agrees on a lead the agent created themselves', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { owner_user_id: AGENT.id, assigned_to: AGENT.id });
      const row = await leadsFor(tx).get(lead.id, AGENT) as { can_delete: boolean };

      expect(row.can_delete).toBe(true);
      expect(await reallyDeletable(tx, lead.id, AGENT)).toBe(true);
    });
  });

  it('agrees for an administrator, who may delete either', async () => {
    await inRollback(async (tx) => {
      const orphan = await makeLead(tx, { owner_user_id: null, assigned_to: ADMIN.id });
      const row = await leadsFor(tx).get(orphan.id, ADMIN) as { can_delete: boolean };

      expect(row.can_delete).toBe(true);
      expect(await reallyDeletable(tx, orphan.id, ADMIN)).toBe(true);
    });
  });

  it('sends the flag on the LIST as well, which is where the button lives', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { owner_user_id: null, assigned_to: AGENT.id });
      const res = await leadsFor(tx).list(AGENT, { limit: '200' } as never) as { data: { id: number; can_delete: boolean }[] };

      const mine = res.data.find((r) => r.id === lead.id);
      // Jest expect takes no message argument - the assertion below names the case instead.
      expect(mine).toBeTruthy();
      expect(mine!.can_delete).toBe(false);
    });
  });
});
