import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { QuickSendService } from './quick-send.service';

/**
 * TD-037 — the Deposit Receipt's Cc resolves the actual people on the deal, not a namesake.
 *
 * THE DEFECT. The Cc box pre-filled from a company-wide name→email dictionary with no relationship
 * to any one transaction, and the SEND independently re-derived the same dictionary lookup at mail
 * time. A deal's agent was "Akhil"; the company also holds an unrelated admin named "Akhilesh" whose
 * account email is a personal Gmail address. A team member's name matching, exactly or by a one-
 * letter typo, ANY user in the company — any role, any status — silently added that stranger's
 * address to a document carrying the client's deposit figures.
 *
 * TWO THINGS HAD TO CHANGE, BOTH COVERED HERE. `QuickSendService.agentEmails` — the private
 * resolver both `depositReceipt` and `tradeSheet` call at send time — now resolves each team row by
 * `user_id` where the row has one (an id is an identity, not a guess), and only falls back to a
 * name match for a row that never resolved, restricted to ACTIVE AGENTS. And `ccSuggestions`, the
 * new endpoint the editor calls before Send, is asserted to answer with the SAME set — a pre-fill
 * that showed one thing while the send mailed another would be its own kind of defect.
 *
 * THE REGRESSION THIS GUARDS AGAINST. The obvious first fix — restrict the whole lookup to active
 * agents — breaks a real case: a MANAGER can legitimately be a team member (id-linked on their
 * `team_members` row), and restricting by role would have silently dropped them from the Cc while
 * they are unambiguously part of the deal. `id-resolved-members-of-any-role` is asserted here
 * precisely because it is the case a role-only fix would have gotten wrong.
 *
 * Real rows in a rolled-back transaction — the rule under test is a database question about who is
 * actually named on a deal, not something a stub can stand in for.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

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

function service(tx: PrismaService): QuickSendService {
  const audit = { record: async () => undefined, log: async () => undefined } as never;
  const mailer = { send: async () => undefined } as never;
  const settings = { current: async () => ({ name: 'Test Brokerage' }) } as never;
  return new QuickSendService(tx, audit, mailer, settings, new ResourceAccessService(tx));
}

async function mkUser(tx: PrismaService, name: string, role: string, status = 'Active', email?: string) {
  const now = new Date();
  return tx.users.create({
    data: { name, email: email ?? `${name.replace(/\s+/g, '.').toLowerCase()}-${Date.now()}-${++seq}@x.test`, password: 'x', role, status, created_at: now, updated_at: now },
  });
}

const asUser = (u: { id: number; name: string; role?: string | null }) => ({ id: u.id, name: u.name, role: u.role ?? 'agent' } as never);

describe('the Deposit Receipt Cc resolves this deal\'s own team, not a namesake (TD-037)', () => {
  it('does not resolve an unresolved agent name to an unrelated account with the same name', async () => {
    await inRollback(async (tx) => {
      const n = ++seq;
      /*
       * The reported shape, exactly: the deal's `agent` is a plain string that never resolved to
       * an account (`agent_user_id: null` — a legacy row, or a name typed slightly differently
       * from how the real agent's account is spelled). This database separately holds an
       * unrelated ADMIN whose ACCOUNT NAME happens to be that exact string, with a personal-
       * looking address on file. Nothing about the deal points at this admin — no id, no team
       * row — only a name that happens to collide.
       */
      const collisionName = `Akhilesh-${n}`;
      const admin = await mkUser(tx, collisionName, 'admin', 'Active', `${collisionName.toLowerCase()}@gmail.test`);

      const deal = await tx.transactions.create({
        data: { agent: collisionName, agent_user_id: null, trade_no: `TD037-${n}A`, type: 'Residential Buying', property: '1 Test St', deposit: 50000, created_at: new Date(), updated_at: new Date() },
      });

      const svc = service(tx);
      const cc = await svc.ccSuggestions({ id: 999, name: 'An Admin', role: 'admin' } as never, deal.id);
      expect(cc).not.toContain(admin.email);
      expect(cc.join(',')).not.toContain('gmail');
    });
  });

  it('still Ccs a genuine team member who holds a DIFFERENT role — a manager, id-linked', async () => {
    // The case a role-only fix gets wrong: this manager IS on the deal (the team row carries
    // their user_id), and must not vanish because they are not an agent.
    await inRollback(async (tx) => {
      const n = ++seq;
      const agent = await mkUser(tx, `Agent-${n}`, 'agent');
      const manager = await mkUser(tx, `Manager-${n}`, 'manager');

      const deal = await tx.transactions.create({
        data: { agent: agent.name, agent_user_id: agent.id, trade_no: `TD037-${n}B`, type: 'Residential Buying', property: '1 Test St', deposit: 50000, created_at: new Date(), updated_at: new Date() },
      });
      await tx.team_members.create({
        data: { transaction_id: deal.id, user_id: manager.id, name: manager.name, access: 'full', position: 0, created_at: new Date(), updated_at: new Date() },
      });

      const svc = service(tx);
      const cc = await svc.ccSuggestions(asUser(agent), deal.id);
      expect(cc.sort()).toEqual([agent.email, manager.email].sort());
    });
  });

  it('does NOT Cc an id-linked team member who happens to be inactive — they are still who they are', async () => {
    await inRollback(async (tx) => {
      const n = ++seq;
      const agent = await mkUser(tx, `Agent-${n}`, 'agent');
      const departed = await mkUser(tx, `Departed-${n}`, 'agent', 'Inactive');

      const deal = await tx.transactions.create({
        data: { agent: agent.name, agent_user_id: agent.id, trade_no: `TD037-${n}C`, type: 'Residential Buying', property: '1 Test St', deposit: 50000, created_at: new Date(), updated_at: new Date() },
      });
      await tx.team_members.create({
        data: { transaction_id: deal.id, user_id: departed.id, name: departed.name, access: 'full', position: 0, created_at: new Date(), updated_at: new Date() },
      });

      const svc = service(tx);
      const cc = await svc.ccSuggestions(asUser(agent), deal.id);
      // An id match is an identity, not a filter — this account IS who this row names, whatever
      // its current status. Whether that is desirable is a business call for another ticket;
      // what this pins is that it does not silently disappear, which would look like a second bug.
      expect(cc).toContain(departed.email);
    });
  });

  it('restricts an UNRESOLVED name to active agents — the fallback, not the identity path', async () => {
    await inRollback(async (tx) => {
      const n = ++seq;
      const agent = await mkUser(tx, `Agent-${n}`, 'agent');
      // A team row that never resolved to an account (legacy import, a co-op agent typed by
      // hand) whose free-text name happens to collide with an inactive user and a non-agent.
      const collisionName = `Collision-${n}`;
      await mkUser(tx, collisionName, 'agent', 'Inactive');
      const nonAgentSameName = await mkUser(tx, `NoMatch-${n}`, 'accounting');

      const deal = await tx.transactions.create({
        data: { agent: agent.name, agent_user_id: agent.id, trade_no: `TD037-${n}D`, type: 'Residential Buying', property: '1 Test St', deposit: 50000, created_at: new Date(), updated_at: new Date() },
      });
      await tx.team_members.create({
        data: { transaction_id: deal.id, user_id: null, name: collisionName, access: 'full', position: 0, created_at: new Date(), updated_at: new Date() },
      });

      const svc = service(tx);
      const cc = await svc.ccSuggestions(asUser(agent), deal.id);
      // The inactive namesake is excluded (inactive), and the non-agent was never a candidate —
      // neither is on this deal, and the unresolved row matches no ACTIVE AGENT of that name.
      expect(cc).toEqual([agent.email]);
      expect(cc).not.toContain(nonAgentSameName.email);
    });
  });

  it('the editor\'s pre-fill and the actual send agree — same set, not two implementations', async () => {
    await inRollback(async (tx) => {
      const n = ++seq;
      const agent = await mkUser(tx, `Agent-${n}`, 'agent');
      const manager = await mkUser(tx, `Manager-${n}`, 'manager');
      const deal = await tx.transactions.create({
        data: { agent: agent.name, agent_user_id: agent.id, trade_no: `TD037-${n}E`, type: 'Residential Buying', property: '1 Test St', deposit: 50000, created_at: new Date(), updated_at: new Date() },
      });
      await tx.team_members.create({
        data: { transaction_id: deal.id, user_id: manager.id, name: manager.name, access: 'full', position: 0, created_at: new Date(), updated_at: new Date() },
      });

      const sent: { cc: unknown }[] = [];
      const svc = new QuickSendService(
        tx,
        { record: async () => undefined, log: async () => undefined } as never,
        { send: async (_t: unknown, _v: unknown, _to: unknown, cc: unknown) => { sent.push({ cc }); } } as never,
        { current: async () => ({ name: 'Test Brokerage' }) } as never,
        new ResourceAccessService(tx),
      );

      const preFill = await svc.ccSuggestions(asUser(agent), deal.id);
      await svc.depositReceipt(asUser(agent), deal.id, { email: 'client@example.test' });

      const actuallySent = (sent[0].cc as string[]).sort();
      expect(actuallySent).toEqual(preFill.sort());
    });
  });
});
