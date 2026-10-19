/*
 * India builder database (stage 3, 17 Oct 2026): who may open it, and when an agreement is chased.
 */
jest.mock('../common/archive', () => ({ createZip: () => ({}) }));

import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { BuildersService } from './builders.service';
import { BuilderAgreementReminderService } from './builder-agreement-reminder.service';
import type { AuthUserRecord } from '../auth/auth.types';

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
const ROLLBACK = '__rollback__';
async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000, maxWait: 30000 });
  } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
}
/** Inside the rollback a nested $transaction just runs on the same client (reads go straight to it). */
const nested = (tx: PrismaService): PrismaService =>
  new Proxy(tx, { get: (t, k) => (k === '$transaction' ? (fn: (c: PrismaService) => unknown) => fn(t) : Reflect.get(t, k, t)) }) as PrismaService;
const admin = (market: string) => ({ id: 1, name: 'A', role: 'admin', market, user_permissions: [] }) as unknown as AuthUserRecord;
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('who may open the builder database', () => {
  it('a Super Admin working in India - nobody else', async () => {
    await inRollback(async (tx) => {
      const svc = new BuildersService(tx);
      await expect(svc.list(admin('IN'))).resolves.toBeDefined();
      await expect(svc.list(admin('CA'))).rejects.toMatchObject({ status: 404 });
      await expect(svc.list({ ...admin('IN'), role: 'accounting' } as AuthUserRecord)).rejects.toMatchObject({ status: 403 });
      await expect(svc.list({ ...admin('IN'), role: 'agent' } as AuthUserRecord)).rejects.toMatchObject({ status: 403 });
    });
  });

  it('keeps a builder with its contacts and one agreement', async () => {
    await inRollback(async (tx) => {
      const svc = new BuildersService(tx);
      const { data } = await svc.create(admin('IN'), {
        name: 'Test Builder', contacts: [{ kind: 'Sales office', phone: '040 1234' }, { kind: 'Sales person', name: 'Ravi' }, { kind: 'Other' }],
        agreement: { start_date: '2026-01-01', expiry_date: '2026-12-31', commission_pct: '3' },
      });
      expect((data.contacts as unknown[]).length).toBe(2);                 // the blank row is dropped
      expect((data.agreement as Record<string, unknown>).commission_pct).toBe(3);
      await expect(svc.create(admin('IN'), { name: '' })).rejects.toBeDefined();
      await expect(svc.create(admin('IN'), { name: 'X', agreement: { start_date: '2026-05-01', expiry_date: '2026-01-01' } })).rejects.toBeDefined();
    });
  });
});

describe('agreement expiry reminders: the company-document rules (Sai, 19 Oct 2026)', () => {
  const due = (expiry: string, last: string | null, today: string) =>
    BuilderAgreementReminderService.due({ expiry_date: d(expiry), last_reminder_at: last ? d(last) : null }, d(today));

  it('starts 15 days before and not earlier', () => {
    expect(due('2026-11-30', null, '2026-11-14')).toBe(false); // 16 days out
    expect(due('2026-11-30', null, '2026-11-15')).toBe(true);  // 15 days out
  });
  it('repeats every 2 days, not every day', () => {
    expect(due('2026-11-30', '2026-11-15', '2026-11-16')).toBe(false);
    expect(due('2026-11-30', '2026-11-15', '2026-11-17')).toBe(true);
  });
  it('always reminds the day before and on the expiry day, then every 2 days until renewed', () => {
    expect(due('2026-11-30', '2026-11-28', '2026-11-29')).toBe(true);  // the day before, 1 day after the last
    expect(due('2026-11-30', '2026-11-29', '2026-11-30')).toBe(true);  // the expiry day, 1 day after the last
    expect(due('2026-11-30', '2026-11-30', '2026-12-01')).toBe(false); // after expiry: every 2 days
    expect(due('2026-11-30', '2026-11-30', '2026-12-02')).toBe(true);
  });
  it('a new agreement file after the first reminder counts as the renewal', () => {
    const s = { expiry_date: d('2026-11-30'), reminder_started_at: d('2026-11-15'), last_reminder_at: d('2026-11-17'), latest_file_at: d('2026-11-18') };
    expect(BuilderAgreementReminderService.due(s, d('2026-11-19'))).toBe(false);
    expect(BuilderAgreementReminderService.due({ ...s, latest_file_at: d('2026-01-01') }, d('2026-11-19'))).toBe(true);
  });
  it('an agreement with no expiry date is never chased', () => {
    expect(BuilderAgreementReminderService.due({ expiry_date: null, last_reminder_at: null }, d('2026-11-30'))).toBe(false);
  });
});

import { BuilderProjectsService } from './builder-projects.service';

describe('India builder projects (stage 3b)', () => {
  it('keeps a project with RERA, falls back to the builder\'s commission, and follows the newest price', async () => {
    await inRollback(async (tx) => {
      const builders = new BuildersService(tx);
      // Already inside a rollback transaction: nested $transaction just runs on the same client.
      const projects = new BuilderProjectsService(nested(tx));
      const b = (await builders.create(admin('IN'), { name: 'Proj Builder', agreement: { commission_pct: '3' } })).data;
      const p = (await projects.create(admin('IN'), {
        builder_id: b.id, name: 'Green Valley', status: 'Now Selling', home_types: ['Villa', 'Plot', 'Nonsense'],
        city: 'Hyderabad', starting_price: '75,00,000', rera: { number: 'P02400001234', approved_on: '2026-01-10', valid_until: '2028-01-09' },
      })).data;
      expect(p.home_types).toEqual(['Villa', 'Plot']);                 // unknown types dropped
      expect(p.starting_price).toBe(7500000);                          // Indian commas read
      expect(p.effective_commission_pct).toBe(3);                      // builder's % when the project has none
      expect((p.rera as Record<string, unknown>).number).toBe('P02400001234');
      const after = (await projects.addPrice(admin('IN'), p.id as number, { changed_on: '2026-10-01', starting_price: '8000000', note: 'Phase 2' }, undefined)).data;
      expect(after.starting_price).toBe(8000000);
      expect((after.prices as unknown[]).length).toBe(1);
      await expect(projects.create(admin('IN'), { builder_id: b.id, name: 'X', status: 'Weird' })).rejects.toBeDefined();
      await expect(projects.list(admin('CA'))).rejects.toMatchObject({ status: 404 });
      expect((await projects.pickList(admin('CA'))).data).toEqual([]);
    });
  });

  it('RERA valid-until is chased on the same rule as the agreement', () => {
    expect(BuilderAgreementReminderService.due({ expiry_date: d('2027-01-20'), last_reminder_at: null }, d('2027-01-05'))).toBe(true);
    expect(BuilderAgreementReminderService.due({ expiry_date: d('2027-01-20'), last_reminder_at: null }, d('2027-01-04'))).toBe(false);
  });
});

import { BuilderOffersService } from './builder-offers.service';

describe('builder offers (stage 4)', () => {
  jest.setTimeout(90_000);
  it('counts our units in order, leaves out deals that fell through, suggests, and confirms once', async () => {
    await inRollback(async (tx) => {
      const wrapped = nested(tx);
      const builders = new BuildersService(tx);
      const projects = new BuilderProjectsService(wrapped);
      const offers = new BuilderOffersService(wrapped);
      const b = (await builders.create(admin('IN'), { name: 'Offer Builder' })).data;
      const p = (await projects.create(admin('IN'), { builder_id: b.id, name: 'Offer Towers' })).data;
      const now = new Date();
      const mk = async (n: string, offer: string, dead = false) => {
        const t = await tx.transactions.create({ data: { trade_no: `OFFER-${n}-${Date.now()}`, type: 'Preconstruction', market: 'IN', builder_project_id: p.id as number, offer_date: d(offer), created_at: now, updated_at: now } });
        if (dead) await tx.transaction_statuses.create({ data: { transaction_id: t.id, status: 'Void', created_at: now, updated_at: now } });
        return t;
      };
      const u1 = await mk('A', '2026-01-10');
      await mk('VOID', '2026-02-01', true);           // fell through: not a unit
      const u2 = await mk('B', '2026-03-05');
      const u3 = await mk('C', '2026-04-20');
      await offers.create(admin('IN'), p.id as number, { title: '1% extra from the 3rd unit', kind: 'extra_percent', value: '1', from_unit: '3' });
      await offers.create(admin('IN'), p.id as number, { title: 'Diwali bonus', kind: 'fixed_bonus', value: '50000', starts_on: '2026-10-01', ends_on: '2026-11-15' });
      const list = await offers.listForProject(admin('IN'), p.id as number);
      expect(list.units_sold).toBe(3);

      const s1 = await offers.forDeal(admin('IN'), u1.id);
      expect(s1.unit_number).toBe(1);
      const extra = (x: typeof s1) => x.offers.find((o) => o.title.startsWith('1% extra'))!;
      expect(extra(s1).may_apply).toBe(false);          // unit 1 < 3
      const s3 = await offers.forDeal(admin('IN'), u3.id);
      expect(s3.unit_number).toBe(3);
      expect(extra(s3).may_apply).toBe(true);
      expect(s3.offers.find((o) => o.title === 'Diwali bonus')!.may_apply).toBe(false); // closed on 2026-04-20
      expect((await offers.forDeal(admin('IN'), u2.id)).unit_number).toBe(2);

      const after = await offers.apply(admin('IN'), u3.id, extra(s3).id, { agreed: '1% extra agreed with the builder on 20 Apr', agreed_value: '1' });
      expect(extra(after).applied?.unit_number).toBe(3);
      expect(extra(after).may_apply).toBe(false);
      await expect(offers.apply(admin('IN'), u3.id, extra(s3).id, { agreed: 'again' })).rejects.toBeDefined();
      await expect(offers.destroy(admin('IN'), extra(s3).id)).rejects.toBeDefined();      // confirmed: end it, don't remove
      expect(await tx.audit_logs.count({ where: { transaction_id: u3.id, section: 'Builder offers' } })).toBe(1);
      await expect(offers.forDeal(admin('CA'), u3.id)).rejects.toMatchObject({ status: 404 });
    });
  });
});
