import { PrismaClient } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DeskAnalyticsService } from './desk-analytics.service';
import { DeskAnalyticsExportService } from './desk-analytics-export.service';
import { ReportExportService } from '../reports/report-export.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { parseAnalyticsFilters } from './desk-analytics.filters';
import type { ScopedUser } from '../common/transaction-scope';

/**
 * THE ANALYTICS EXPORT IS THE SCREEN, IN A FILE.
 *
 * The risk an export carries is not that it renders badly — it is that it answers a DIFFERENT
 * question from the screen it was exported from, and nobody notices because the numbers look
 * plausible. Two ways that happens, and both are tested here by reading the produced workbook back:
 *
 *   IT IGNORES THE FILTERS. A file that quietly contains the unfiltered brokerage while the screen
 *   showed one month is worse than no export at all.
 *
 *   IT IGNORES THE CALLER. An agent's export must contain an agent's figures. This is the same
 *   authorization boundary as the screen, and an export that reached past it would be a data leak in
 *   an attachment.
 *
 * The workbook is parsed rather than trusted, so "the export respects X" is asserted against the
 * cells somebody would actually open.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000, isolationLevel: 'RepeatableRead' });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const exportFor = (tx: PrismaService) =>
  new DeskAnalyticsExportService(
    new DeskAnalyticsService(tx, new CommissionService(new PersonResolver(tx))),
    new ReportExportService(),
    // The audit collaborator is unused on this path: the export only READS the brokerage name.
    new CompanySettingsService(tx, null as never),
  );

const office: ScopedUser = { id: 1, name: 'Office Boss', role: 'admin' };

async function makeAgent(tx: PrismaService, name: string) {
  const stamp = `${Date.now()}-${++seq}`;
  return tx.users.create({
    data: {
      name, email: `ax-${stamp}@spec.test`, username: `ax-${stamp}`,
      role: 'agent', status: 'Active', password: 'x', profile: '{}',
      created_at: new Date(), updated_at: new Date(),
    },
    select: { id: true, name: true },
  });
}

async function makeDeal(tx: PrismaService, agent: { id: number; name: string }, closing: string, price = 800_000) {
  const now = new Date();
  return tx.transactions.create({
    data: {
      trade_no: `AX-${Date.now()}-${++seq}`, type: 'Residential Buying',
      agent: agent.name, agent_user_id: agent.id,
      price, deposit: 0, comm_type: '%', comm_value: 0, comm_pct: 2.5,
      comm_status: 'Pending', comm_paid_status: 'No',
      closing_date: new Date(`${closing}T00:00:00.000Z`),
      offer_date: new Date(`${closing}T00:00:00.000Z`),
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
      created_at: now, updated_at: now,
    },
    select: { id: true },
  });
}

/** Every numeric cell value in the workbook. */
async function numbersIn(buffer: Buffer): Promise<number[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: number[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'number') out.push(c.value); })));
  return out;
}

/** Every cell of the produced workbook as one lower-cased string, for "does it contain" checks. */
async function readAll(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => out.push(String(c.value ?? '')))));
  return out.join('\n').toLowerCase();
}

describe('the Analytics export contains the filtered result and nothing else', () => {
  it('states that commission figures are before HST', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Xp Basis');
      await makeDeal(tx, a, '2025-04-10');
      const { buffer, filename } = await exportFor(tx).xlsx(office, {});
      expect(filename).toMatch(/^Transaction Desk Analytics .*\.xlsx$/);
      expect(await readAll(buffer)).toContain('before hst');
    });
  });

  it('honours a date range — a deal outside it is not in the file', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Xp Range');
      await makeDeal(tx, a, '2025-04-10');
      await makeDeal(tx, a, '2025-11-20');

      const { buffer } = await exportFor(tx).xlsx(office, { from: '2025-04-01', to: '2025-04-30' });
      const text = await readAll(buffer);
      // The month blocks name the months present. November must be absent entirely.
      expect(text).toContain('2025-04');
      expect(text).not.toContain('2025-11');
      // …and the range is printed, so the file says what it is a view of.
      expect(text).toContain('2025-04-01');
    });
  });

  it('honours an agent filter — another agent\'s name is not in the file', async () => {
    await inRollback(async (tx) => {
      const mine = await makeAgent(tx, 'Xp Mine');
      const theirs = await makeAgent(tx, 'Xp Theirs');
      await makeDeal(tx, mine, '2025-05-10');
      await makeDeal(tx, theirs, '2025-05-11');

      const { buffer } = await exportFor(tx).xlsx(office, { agent_user_id: mine.id });
      const text = await readAll(buffer);
      expect(text).toContain('xp mine');
      expect(text).not.toContain('xp theirs');
    });
  });

  it('honours a type filter', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Xp Type');
      const d = await makeDeal(tx, a, '2025-06-10');
      await tx.transactions.update({ where: { id: d.id }, data: { type: 'Commercial Property Buying' } });
      await makeDeal(tx, a, '2025-06-11'); // Residential Buying

      const { buffer } = await exportFor(tx).xlsx(office, { type: 'Commercial Property Buying' });
      const text = await readAll(buffer);
      expect(text).toContain('commercial property buying');
      expect(text).not.toContain('residential buying');
    });
  });

  it('AN AGENT\'S EXPORT CONTAINS ONLY THEIR OWN FIGURES', async () => {
    await inRollback(async (tx) => {
      const me = await makeAgent(tx, 'Xp Agent');
      const other = await makeAgent(tx, 'Xp Other');
      await makeDeal(tx, me, '2025-07-10');
      await makeDeal(tx, other, '2025-07-11');

      const asAgent: ScopedUser = { id: me.id, name: me.name, role: 'agent' };
      // Through the same parser the endpoint uses, so the lock is exercised rather than assumed.
      const { buffer } = await exportFor(tx).xlsx(asAgent, parseAnalyticsFilters({}, asAgent));
      const text = await readAll(buffer);
      expect(text).toContain('xp agent');
      expect(text).not.toContain('xp other');
    });
  });

  it('an agent cannot export another agent by naming them — the parser refuses first', () => {
    const asAgent: ScopedUser = { id: 77, name: 'Xp Locked', role: 'agent' };
    expect(() => parseAnalyticsFilters({ agent_user_id: '78' }, asAgent)).toThrow(/only view your own/i);
  });

  it('an empty result still produces a readable file rather than failing', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Xp Empty');
      await makeDeal(tx, a, '2025-08-10');
      const { buffer } = await exportFor(tx).xlsx(office, { from: '2031-01-01', to: '2031-12-31' });
      const text = await readAll(buffer);
      expect(buffer.length).toBeGreaterThan(0);
      expect(text).toContain('transaction desk analytics');
    });
  });

  it('the figures in the file are the figures the screen returns', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Xp Match');
      await makeDeal(tx, a, '2025-09-10', 1_000_000);

      const filters = { from: '2025-09-01', to: '2025-09-30' };
      const screen = await new DeskAnalyticsService(tx, new CommissionService(new PersonResolver(tx))).summary(office, filters);
      const { buffer } = await exportFor(tx).xlsx(office, filters);

      /*
       * Compared as a NUMBER, not as formatted text.
       *
       * The renderer writes currency as a numeric cell with a display format, which is what makes
       * the file usable as a spreadsheet rather than a picture of one — so the cell holds 25000 and
       * shows "$25,000.00". Matching the rendered string would test the number format; matching the
       * value tests that the figure is the screen's.
       */
      expect(await numbersIn(buffer)).toContain(screen.totals.total);
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
