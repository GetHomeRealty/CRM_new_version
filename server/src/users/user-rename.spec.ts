import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PaymentCacheService } from '../transactions/payment-cache.service';
import { UserRenameService } from './user-rename.service';

/**
 * TD-190 - renaming a user carries the new name onto the deals linked to that account.
 *
 * Measured 2026-09-16: 'Sai Ramesh Gollu' was renamed 'Ramesh Gollu' and his dashboard showed 26
 * deals and $0.00 on every one, because the figures read the agent by the name on the deal.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
afterAll(async () => { await prisma.$disconnect(); });

/** A transaction client has no `$transaction`; the service opens one per deal, so it is run inline. */
function nested(tx: object): PrismaService {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === '$transaction') return async (fn: (t: unknown) => Promise<unknown>) => fn(target);
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as PrismaService;
}

async function inRollback(fn: (tx: PrismaService) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(nested(tx)); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function makeUser(tx: PrismaService, name: string): Promise<number> {
  const t = tag(), now = new Date();
  const u = await tx.users.create({
    data: { name, email: `zz-td190-${t}@example.test`, username: `zztd190${t.replace(/-/g, '')}`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
    select: { id: true },
  });
  return u.id;
}

async function makeDeal(tx: PrismaService, agent: string, agentUserId: number | null, extra: { admin?: unknown; commissionAgent?: string } = {}): Promise<number> {
  const now = new Date();
  const d = await tx.transactions.create({
    data: {
      trade_no: `TD190-${tag()}`, type: 'Residential Buying', property: '1 Rename Way', agent, agent_user_id: agentUserId,
      commission_agent: extra.commissionAgent ?? null,
      admin_activities: extra.admin === undefined ? null : JSON.stringify(extra.admin),
      created_at: now, updated_at: now,
    },
  });
  return d.id;
}

async function addMember(tx: PrismaService, dealId: number, name: string, userId: number | null): Promise<number> {
  const m = await tx.team_members.create({ data: { transaction_id: dealId, name, user_id: userId, created_at: new Date(), updated_at: new Date() } });
  return m.id;
}

function serviceFor(tx: PrismaService): { svc: UserRenameService; refreshed: number[] } {
  const refreshed: number[] = [];
  const cache = { recompute: async (ids: number[]) => { refreshed.push(...ids); return ids.length; } } as unknown as PaymentCacheService;
  return { svc: new UserRenameService(tx, cache), refreshed };
}

const paid = { payments: [{ paid_type: 'TDB-EFT', paid_status: 'Paid', paid_date: '2026-01-22', batch_no: '42026', t4a_year: '2026' }], cta: [] };

describe('a renamed user\'s deals carry the new name (TD-190)', () => {
  it('renames the agent, the team row, the Admin Activities entries and the commission agent on a linked deal', async () => {
    await inRollback(async (tx) => {
      const newName = `ZZ New ${tag()}`, oldName = `zz old ${tag()}`;
      const uid = await makeUser(tx, newName);
      const deal = await makeDeal(tx, oldName, uid, {
        commissionAgent: oldName,
        admin: { agents: { 'ZZ Other': paid, [oldName]: paid }, term_admin: { 1: { agents: { [oldName]: paid }, remarks: 'kept' } }, deposits: [{ date: '2026-01-01' }] },
      });
      await addMember(tx, deal, oldName, uid);
      await addMember(tx, deal, 'ZZ Other', null);
      const { svc, refreshed } = serviceFor(tx);

      const r = await svc.syncNameToDeals(uid);

      const t = await tx.transactions.findUniqueOrThrow({ where: { id: deal }, select: { agent: true, commission_agent: true, admin_activities: true } });
      const a = JSON.parse(t.admin_activities!);
      expect(t.agent).toBe(newName);
      expect(t.commission_agent).toBe(newName);
      expect(Object.keys(a.agents)).toEqual(['ZZ Other', newName]);
      expect(a.agents[newName]).toEqual(paid);
      expect(Object.keys(a.term_admin['1'].agents)).toEqual([newName]);
      expect(a.term_admin['1'].remarks).toBe('kept');
      expect(a.deposits).toEqual([{ date: '2026-01-01' }]);
      const names = (await tx.team_members.findMany({ where: { transaction_id: deal }, orderBy: { id: 'asc' } })).map((m) => m.name);
      expect(names).toEqual([newName, 'ZZ Other']);
      expect(r).toMatchObject({ deals: 1, agentRows: 1, teamRows: 1, adminKeys: 2, commissionAgent: 1, skipped: [] });
      expect(refreshed).toEqual([deal]);
    });
  }, 60000);

  it('reaches a deal where the person is only a team member', async () => {
    await inRollback(async (tx) => {
      const newName = `ZZ Member ${tag()}`, oldName = `zz member old ${tag()}`;
      const uid = await makeUser(tx, newName);
      const deal = await makeDeal(tx, 'ZZ Primary', null, { admin: { agents: { [oldName]: paid } } });
      await addMember(tx, deal, oldName, uid);

      await serviceFor(tx).svc.syncNameToDeals(uid);

      const t = await tx.transactions.findUniqueOrThrow({ where: { id: deal } });
      expect(t.agent).toBe('ZZ Primary');
      expect(Object.keys(JSON.parse(t.admin_activities!).agents)).toEqual([newName]);
    });
  }, 60000);

  it('leaves a deal alone that only SPELLS the old name but is not linked to the account', async () => {
    await inRollback(async (tx) => {
      const oldName = `zz shared ${tag()}`;
      const uid = await makeUser(tx, `ZZ Renamed ${tag()}`);
      const other = await makeDeal(tx, oldName, null, { admin: { agents: { [oldName]: paid } } });
      await addMember(tx, other, oldName, null);

      const r = await serviceFor(tx).svc.syncNameToDeals(uid);

      const t = await tx.transactions.findUniqueOrThrow({ where: { id: other } });
      expect(t.agent).toBe(oldName);
      expect(Object.keys(JSON.parse(t.admin_activities!).agents)).toEqual([oldName]);
      expect(r.deals).toBe(0);
    });
  }, 60000);

  it('does not merge two real payout histories - both are kept and the deal is reported', async () => {
    await inRollback(async (tx) => {
      const newName = `ZZ Both ${tag()}`, oldName = `zz both old ${tag()}`;
      const uid = await makeUser(tx, newName);
      const deal = await makeDeal(tx, oldName, uid, { admin: { agents: { [oldName]: paid, [newName]: paid } } });

      const r = await serviceFor(tx).svc.syncNameToDeals(uid);

      const t = await tx.transactions.findUniqueOrThrow({ where: { id: deal } });
      expect(t.agent).toBe(newName);
      expect(Object.keys(JSON.parse(t.admin_activities!).agents).sort()).toEqual([newName, oldName].sort());
      expect(r.skipped.join(' ')).toContain(`deal ${deal}`);
    });
  }, 60000);

  it('replaces an empty entry under the new name with the real one under the old name', async () => {
    await inRollback(async (tx) => {
      const newName = `ZZ Empty ${tag()}`, oldName = `zz empty old ${tag()}`;
      const uid = await makeUser(tx, newName);
      const empty = { invoice_received: 'N/A', payments: [], cta: [{ cta: 'No', date: '', batch_no: '' }] };
      const deal = await makeDeal(tx, oldName, uid, { admin: { agents: { [newName]: empty, [oldName]: paid } } });

      await serviceFor(tx).svc.syncNameToDeals(uid);

      const a = JSON.parse((await tx.transactions.findUniqueOrThrow({ where: { id: deal } })).admin_activities!);
      expect(a.agents).toEqual({ [newName]: paid });
    });
  }, 60000);

  it('writes nothing on a dry run, and a second real run finds nothing left to do', async () => {
    await inRollback(async (tx) => {
      const newName = `ZZ Dry ${tag()}`, oldName = `zz dry old ${tag()}`;
      const uid = await makeUser(tx, newName);
      const deal = await makeDeal(tx, oldName, uid);
      const { svc, refreshed } = serviceFor(tx);

      const dry = await svc.syncNameToDeals(uid, { dryRun: true });
      expect(dry.deals).toBe(1);
      expect((await tx.transactions.findUniqueOrThrow({ where: { id: deal } })).agent).toBe(oldName);
      expect(refreshed).toEqual([]);

      await svc.syncNameToDeals(uid);
      const again = await svc.syncNameToDeals(uid);
      expect(again.deals).toBe(0);
      expect(refreshed).toEqual([deal]);
    });
  }, 60000);
});
