/*
 * India desk, stage 2b (17 Oct 2026) - India's own rules, and Canada untouched by them.
 */
import { PrismaClient } from '@prisma/client';
import { INDIA_TYPES, typeAllowedIn } from './market';
import { checklistFor, checklistKey } from '../documents/checklist-definitions';
import { TradeNumberService } from '../transactions/trade-number.service';

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });

describe('India deal types', () => {
  it('India takes pre-construction only; Canada keeps every type', () => {
    expect(INDIA_TYPES).toEqual(['Preconstruction']);
    expect(typeAllowedIn('IN', 'Preconstruction')).toBe(true);
    expect(typeAllowedIn('IN', 'Residential Buying')).toBe(false);
    expect(typeAllowedIn('CA', 'Residential Buying')).toBe(true);
    expect(typeAllowedIn(null, 'Business Sale')).toBe(true);
  });
});

describe('India checklist', () => {
  it('an India pre-construction deal asks for the builder agreement and deposit slips', () => {
    const list = checklistFor(checklistKey('Preconstruction', 'IN'), 'Secured Firm');
    expect(list.map((i) => [i.title, i.mandatory])).toEqual([['Builder Agreement', true], ['Deposit Slip', false]]);
    expect(checklistFor(checklistKey('Preconstruction', 'IN'), 'Void').map((i) => i.title)).toEqual(['Builder Agreement']);
  });

  it('a Canadian deal\'s checklist is exactly as before', () => {
    expect(checklistKey('Preconstruction', 'CA')).toBe('Preconstruction');
    expect(checklistKey('Preconstruction', null)).toBe('Preconstruction');
    const ca = checklistFor(checklistKey('Preconstruction', 'CA'), 'Secured Firm').map((i) => i.title);
    expect(ca).toContain('Agreement of Purchase and Sale (APS)');
    expect(ca).not.toContain('Builder Agreement');
  });
});

describe('India deal numbers', () => {
  jest.setTimeout(30_000);
  const ROLLBACK = '__rollback__';
  async function inRollback(fn: (tx: never) => Promise<void>) {
    try {
      await prisma.$transaction(async (tx) => { await fn(tx as never); throw new Error(ROLLBACK); });
    } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
  }

  it('India counts IN-000001 upward on its own; Canada\'s next number is not moved by it', async () => {
    await inRollback(async (tx) => {
      const svc = new TradeNumberService();
      const caBefore = await svc.next(tx, 'Preconstruction', 'CA');
      const in1 = await svc.next(tx, 'Preconstruction', 'IN');
      expect(in1).toMatch(/^IN-\d{6}$/);
      const now = new Date();
      await (tx as unknown as PrismaClient).transactions.create({ data: { trade_no: in1, type: 'Preconstruction', market: 'IN', created_at: now, updated_at: now } });
      const in2 = await svc.next(tx, 'Preconstruction', 'IN');
      expect(parseInt(in2.slice(3), 10)).toBe(parseInt(in1.slice(3), 10) + 1);
      expect(await svc.next(tx, 'Preconstruction', 'CA')).toBe(caBefore);
      expect(await svc.next(tx, 'Residential Buying')).toBe(caBefore);
    });
  });
});
