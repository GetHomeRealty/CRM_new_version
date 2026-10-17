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
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 20000 });
  } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
}
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

describe('agreement expiry reminders: from 15 days before, every 2 days', () => {
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
  it('still reminds on the expiry day, and stops after it', () => {
    expect(due('2026-11-30', '2026-11-28', '2026-11-30')).toBe(true);
    expect(due('2026-11-30', null, '2026-12-01')).toBe(false);
  });
  it('an agreement with no expiry date is never chased', () => {
    expect(BuilderAgreementReminderService.due({ expiry_date: null, last_reminder_at: null }, d('2026-11-30'))).toBe(false);
  });
});
