/*
 * India desk, stage 1 (16 Oct 2026) - THE WALL BETWEEN CANADA AND INDIA.
 *
 * An India deal must never reach somebody working in Canada, by list or by id, and a Canadian deal
 * must never reach somebody working in India. Somebody who was not given India access works in
 * Canada whatever they ask for. Canada itself must behave exactly as before.
 */
jest.mock('../common/archive', () => ({ createZip: () => ({}) }));

import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { allowedMarkets, invoiceMarketWhere, marketOf, marketSql, resolveMarket } from './market';
import { dealInMarket, ownsTransaction, transactionOwnerWhere, transactionScopeWhere } from './transaction-scope';

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';

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

afterAll(async () => { await prisma.$disconnect(); });

describe('which countries a person may work in', () => {
  it('is Canada, India or both - and never none', () => {
    expect(allowedMarkets('CA')).toEqual(['CA']);
    expect(allowedMarkets('CA,IN')).toEqual(['CA', 'IN']);
    expect(allowedMarkets(' in , ca ')).toEqual(['CA', 'IN']);
    // India only (Sai, 17 Oct 2026), and unknown codes are dropped.
    expect(allowedMarkets('IN')).toEqual(['IN']);
    expect(allowedMarkets('IN,XX')).toEqual(['IN']);
    // Nothing usable = Canada, what every account had before countries existed.
    expect(allowedMarkets('XX')).toEqual(['CA']);
    expect(allowedMarkets('')).toEqual(['CA']);
    expect(allowedMarkets(null)).toEqual(['CA']);
  });

  it('works in India only when they asked for it AND were given it', () => {
    expect(resolveMarket('IN', 'CA,IN')).toBe('IN');
    expect(resolveMarket('IN', 'CA')).toBe('CA');       // asked, not given
    expect(resolveMarket(undefined, 'CA,IN')).toBe('CA'); // given, not asked
    expect(resolveMarket('US', 'CA,IN')).toBe('CA');    // no such country here
    // An India-only person always works in India, and can never be put in Canada.
    expect(resolveMarket(undefined, 'IN')).toBe('IN');
    expect(resolveMarket('CA', 'IN')).toBe('IN');
  });

  it('treats a record that never carried a country as Canada', () => {
    expect(marketOf(null)).toBe('CA');
    expect(marketOf({})).toBe('CA');
    expect(marketOf({ market: 'IN' })).toBe('IN');
    expect(marketOf({ market: "IN' OR 1=1 --" })).toBe('CA');
    expect(marketSql({ market: 'IN' })).toBe("t.market = 'IN'");
    expect(marketSql({ market: "x'; drop table users; --" })).toBe("t.market = 'CA'");
  });
});

describe('the wall, against the database', () => {
  jest.setTimeout(60_000);

  async function fixture(tx: PrismaService) {
    const now = new Date();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const agent = await tx.users.create({
      data: { name: `Wall Agent ${stamp}`, email: `wall-${stamp}@x.test`, password: 'x', role: 'agent', markets: 'CA,IN', created_at: now, updated_at: now },
    });
    const mk = (market: string, n: string) => tx.transactions.create({
      data: {
        trade_no: `WALL-${n}-${stamp}`, type: 'Residential Buying', market, agent: agent.name, agent_user_id: agent.id,
        price: 500000, comm_type: '%', comm_value: 2.5, created_at: now, updated_at: now,
      },
    });
    const ca = await mk('CA', 'CA');
    const ind = await mk('IN', 'IN');
    return { agent, ca, ind };
  }

  const ids = async (tx: PrismaService, where: object, only: number[]) =>
    (await tx.transactions.findMany({ where: { AND: [where, { id: { in: only } }] }, select: { id: true } })).map((r) => r.id).sort();

  it('a staff list in Canada has the Canadian deal and not the Indian one - and the other way round', async () => {
    await inRollback(async (tx) => {
      const { ca, ind } = await fixture(tx);
      const both = [ca.id, ind.id];
      for (const role of ['admin', 'manager', 'accounting', 'documentation']) {
        expect(await ids(tx, transactionScopeWhere({ id: 1, name: 'Staff', role }), both)).toEqual([ca.id]);
        expect(await ids(tx, transactionScopeWhere({ id: 1, name: 'Staff', role, market: 'CA' }), both)).toEqual([ca.id]);
        expect(await ids(tx, transactionScopeWhere({ id: 1, name: 'Staff', role, market: 'IN' }), both)).toEqual([ind.id]);
      }
    });
  });

  it('an agent sees only their own deals, and only in the country they are working in', async () => {
    await inRollback(async (tx) => {
      const { agent, ca, ind } = await fixture(tx);
      const both = [ca.id, ind.id];
      const me = { id: agent.id, name: agent.name, role: 'agent' };
      expect(await ids(tx, transactionScopeWhere(me), both)).toEqual([ca.id]);
      expect(await ids(tx, transactionScopeWhere({ ...me, market: 'IN' }), both)).toEqual([ind.id]);
      expect(await ids(tx, transactionOwnerWhere({ ...me, market: 'IN' }), both)).toEqual([ind.id]);
      // Somebody else's deals stay invisible in either country.
      expect(await ids(tx, transactionScopeWhere({ id: -5, name: 'Nobody', role: 'agent', market: 'IN' }), both)).toEqual([]);
    });
  });

  it('opening an India deal by its id from Canada is "not found", for every role', async () => {
    await inRollback(async (tx) => {
      const { agent, ca, ind } = await fixture(tx);
      const access = new ResourceAccessService(tx);
      for (const role of ['admin', 'accounting', 'documentation']) {
        await expect(access.assertTransaction({ id: 1, name: 'Staff', role }, ind.id)).rejects.toBeInstanceOf(NotFoundException);
        await expect(access.assertTransaction({ id: 1, name: 'Staff', role, market: 'IN' }, ca.id)).rejects.toBeInstanceOf(NotFoundException);
        await expect(access.assertTransaction({ id: 1, name: 'Staff', role }, ca.id)).resolves.toBeUndefined();
        await expect(access.assertTransaction({ id: 1, name: 'Staff', role, market: 'IN' }, ind.id)).resolves.toBeUndefined();
      }
      // The agent on the India deal, working in Canada, cannot open it either.
      await expect(access.assertTransaction({ id: agent.id, name: agent.name, role: 'agent' }, ind.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(ownsTransaction({ id: agent.id, name: agent.name, role: 'agent' }, { ...ind })).toBe(false);
      expect(ownsTransaction({ id: agent.id, name: agent.name, role: 'agent', market: 'IN' }, { ...ind })).toBe(true);
    });
  });

  it('somebody @mentioned is judged by the countries they were given', () => {
    expect(dealInMarket({ markets: 'CA,IN' }, { market: 'IN' })).toBe(true);
    expect(dealInMarket({ markets: 'CA' }, { market: 'IN' })).toBe(false);
    expect(dealInMarket({ markets: 'CA' }, { market: 'CA' })).toBe(true);
    expect(dealInMarket({ markets: 'IN' }, { market: 'CA' })).toBe(false);
    expect(dealInMarket({ markets: 'IN' }, { market: 'IN' })).toBe(true);
    expect(dealInMarket({}, { market: 'IN' })).toBe(false);
  });

  it('invoices follow their deal; an invoice with no deal is Canada\'s', async () => {
    await inRollback(async (tx) => {
      const { ca, ind } = await fixture(tx);
      const now = new Date();
      const inv = (transaction_id: number | null, n: string) => tx.invoices.create({
        data: { invoice_no: `WALL-INV-${n}-${Date.now()}`, transaction_id, invoice_date: now, due_date: now, created_at: now, updated_at: now } as never,
      });
      const a = await inv(ca.id, 'CA');
      const b = await inv(ind.id, 'IN');
      const c = await inv(null, 'NONE');
      const pick = async (m: string) => (await tx.invoices.findMany({ where: { AND: [invoiceMarketWhere(m), { id: { in: [a.id, b.id, c.id] } }] }, select: { id: true } })).map((r) => r.id).sort((x, y) => x - y);
      expect(await pick('CA')).toEqual([a.id, c.id].sort((x, y) => x - y));
      expect(await pick('IN')).toEqual([b.id]);
    });
  });

  it('every existing deal and person is Canada', async () => {
    const [deals, people] = await Promise.all([
      prisma.transactions.count({ where: { NOT: { market: 'CA' } } }),
      prisma.users.count({ where: { NOT: { markets: 'CA' } } }),
    ]);
    expect(deals).toBe(0);
    expect(people).toBe(0);
  });
});
