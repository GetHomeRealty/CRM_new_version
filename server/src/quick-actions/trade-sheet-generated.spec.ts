import { PrismaClient } from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { AuditService } from '../audit/audit.service';
import { QuickSendService } from './quick-send.service';

/**
 * TD-088 — the deal records that its Trade Record Sheet was produced.
 *
 * THE GAP. The sheet is a RECO trade record, and a brokerage under audit has to show it was
 * produced for a file. It generated on demand — a real 177 KB PDF — and left nothing behind: no
 * flag, no date, no entry. `trade_sheet_sent_at` exists but answers a different question, and is
 * null on every sheet handed over in person or filed rather than emailed.
 *
 * WHY THE BROWSER HAS TO SAY SO. The sheet is filled client-side, `pdf-lib` writing the deal's
 * values into a static OREA Form 640, so the server never learns of a production unless it is
 * told. `tradeSheetGenerated` is that call.
 *
 * BOTH HALVES ARE ASSERTED. The COLUMN carries the latest production, for the pill on the sheet
 * and anything that reports on it; the AUDIT TRAIL carries every one of them with the actor, which
 * is the "by whom" the entry asks for. And the action goes through the same ownership loader as
 * every other quick action (TD-012) — a marker that a stranger could write would be worse evidence
 * than none.
 *
 * Real rows in a rolled-back transaction: what is under test is what the deal ends up holding.
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
    }, { timeout: 30000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const service = (tx: PrismaService): QuickSendService => new QuickSendService(
  tx,
  new AuditService(tx),
  { send: async () => undefined } as never,
  { current: async () => ({ name: 'Test Brokerage' }) } as never,
  new ResourceAccessService(tx),
);

const asUser = (u: { id: number; name: string }, role = 'agent') => ({ id: u.id, name: u.name, role } as never);
const ADMIN = { id: 990_000, name: 'An Admin', role: 'admin' } as never;

async function scene(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const mk = async (label: string) => tx.users.create({
    data: {
      name: `${label} ${Date.now()}-${n}`, email: `${label}-${Date.now()}-${n}@x.test`, password: 'x',
      role: 'agent', status: 'Active', created_at: now, updated_at: now,
    },
  });
  const owner = await mk('TD088Owner');
  const stranger = await mk('TD088Stranger');
  const deal = await tx.transactions.create({
    data: {
      trade_no: `TD088-${Date.now()}-${n}`, type: 'Residential Buying', property: '1 Trade Record Road',
      agent: owner.name, agent_user_id: owner.id,
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
    },
  });
  return { owner, stranger, deal };
}

const auditRows = (tx: PrismaService, txnId: number) =>
  tx.audit_logs.findMany({ where: { transaction_id: txnId }, orderBy: { id: 'asc' } });

describe('producing a Trade Record Sheet leaves a record on the deal (TD-088)', () => {
  it('stamps the deal and writes who produced it', async () => {
    await inRollback(async (tx) => {
      const { owner, deal } = await scene(tx);
      const before = await tx.transactions.findUnique({ where: { id: deal.id }, select: { trade_sheet_generated_at: true } });
      expect(before?.trade_sheet_generated_at).toBeNull();

      const res = await service(tx).tradeSheetGenerated(asUser(owner), deal.id);
      expect(res).toMatchObject({ ok: true });
      expect(typeof res.generated_at).toBe('string');

      const after = await tx.transactions.findUnique({ where: { id: deal.id }, select: { trade_sheet_generated_at: true } });
      expect(after?.trade_sheet_generated_at).not.toBeNull();

      const rows = await auditRows(tx, deal.id);
      const entry = rows.find((r) => r.field === 'Trade Record Sheet');
      expect(entry?.action).toBe('Generated');
      // "By whom" is the point of the entry: an unattributed date is not evidence.
      expect(entry?.who).toBe(owner.name);
    });
  });

  it('records every production, and calls the later ones what they are', async () => {
    await inRollback(async (tx) => {
      const { owner, deal } = await scene(tx);
      const svc = service(tx);

      await svc.tradeSheetGenerated(asUser(owner), deal.id);
      await svc.tradeSheetGenerated(asUser(owner), deal.id);

      const actions = (await auditRows(tx, deal.id))
        .filter((r) => r.field === 'Trade Record Sheet')
        .map((r) => r.action);
      expect(actions).toEqual(['Generated', 'Regenerated']);
    });
  });

  it('does not touch the SENT date, which answers a different question', async () => {
    // A sheet produced and handed over in person was never emailed; conflating the two would make
    // the send date a lie on exactly the deals this defect is about.
    await inRollback(async (tx) => {
      const { owner, deal } = await scene(tx);
      await service(tx).tradeSheetGenerated(asUser(owner), deal.id);

      const after = await tx.transactions.findUnique({
        where: { id: deal.id }, select: { trade_sheet_sent_at: true, trade_sheet_generated_at: true },
      });
      expect(after?.trade_sheet_sent_at).toBeNull();
      expect(after?.trade_sheet_generated_at).not.toBeNull();
    });
  });

  it('refuses a deal the caller has no part in, and marks nothing (TD-012)', async () => {
    await inRollback(async (tx) => {
      const { stranger, deal } = await scene(tx);

      await expect(service(tx).tradeSheetGenerated(asUser(stranger), deal.id)).rejects.toBeInstanceOf(ForbiddenException);

      const after = await tx.transactions.findUnique({ where: { id: deal.id }, select: { trade_sheet_generated_at: true } });
      expect(after?.trade_sheet_generated_at).toBeNull();
      expect(await auditRows(tx, deal.id)).toHaveLength(0);
    });
  });

  it('answers 404 for a deal that does not exist', async () => {
    await inRollback(async (tx) => {
      await expect(service(tx).tradeSheetGenerated(ADMIN, 2_000_000_000)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
