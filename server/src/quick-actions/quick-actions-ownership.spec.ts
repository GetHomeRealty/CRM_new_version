import { PrismaClient } from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { NoticeOfSaleService } from './notice-of-sale.service';
import { QuickSendService } from './quick-send.service';

/**
 * TD-012 — the Quick Action routes belong to the deal, not to whoever asks.
 *
 * THE DEFECT. Not one authorization call existed in either of these services. Signed in as an agent
 * who gets 403 from `GET /api/transactions/3`, the audit found:
 *
 *   POST /transactions/3/deposit-receipt/send   → 200, and it MAILED the trade number, property
 *                                                 address and deposit amount to an attacker-chosen
 *                                                 address plus an attacker-chosen cc
 *   POST /transactions/4/deposit-receipt/send   → 200 on an unassigned, administrator-only deal
 *   PUT  /transactions/3/notice-of-sale         → 200, and PERSISTED the edit to another agent's deal
 *
 * The class-level `@Screen('transactions','edit')` is a SCREEN permission — which screens you may
 * open — and every agent holds it. The per-record question was simply never asked.
 *
 * WHAT THESE TESTS PIN. All five entry points refuse a stranger, on an owned deal and on an
 * unassigned one; the owner and an administrator still get through; and — the part that matters
 * most for the send routes — a refused call sends NO MAIL and writes NOTHING. A 403 that still
 * posted the email would be no fix at all.
 *
 * Real rows in a rolled-back transaction, in the style of `core/resource-access.spec.ts`, because
 * the rule under test is a database question about who is named on a deal.
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

/** Everything a Quick Action needs, with the outbound mail captured rather than sent. */
function services(tx: PrismaService) {
  const sent: { to: unknown; cc: unknown }[] = [];
  const mailer = { send: async (_t: unknown, _v: unknown, to: unknown, cc: unknown) => { sent.push({ to, cc }); } } as never;
  const audit = { record: async () => undefined, log: async () => undefined } as never;
  const settings = { current: async () => ({ name: 'Test Brokerage', default_tax_rate: 13 }) } as never;
  const access = new ResourceAccessService(tx);
  return {
    sent,
    notice: new NoticeOfSaleService(tx, audit, mailer, settings, access),
    quick: new QuickSendService(tx, audit, mailer, settings, access),
  };
}

/** Two agents, an administrator, a deal belonging to the first, and a deal belonging to nobody. */
async function scene(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const mk = async (label: string) => tx.users.create({
    data: { name: `${label} ${Date.now()}-${n}`, email: `${label}-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', status: 'Active', created_at: now, updated_at: now },
  });
  const owner = await mk('QAOwner');
  const stranger = await mk('QAStranger');
  const admin = { id: 999000 + n, name: 'An Admin', role: 'admin' };
  const deal = await tx.transactions.create({
    data: { agent: owner.name, agent_user_id: owner.id, trade_no: `QA${Date.now()}${n}A`, type: 'Residential Buying', property: '1 Test St', deposit: 50000, created_at: now, updated_at: now },
  });
  const unassigned = await tx.transactions.create({
    data: { agent: null, trade_no: `QA${Date.now()}${n}B`, type: 'Residential Buying', property: '2 Test St', deposit: 50000, created_at: now, updated_at: now },
  });
  return { owner, stranger, admin, deal, unassigned };
}

const asUser = (u: { id: number; name: string; role?: string | null }) => ({ id: u.id, name: u.name, role: u.role ?? 'agent' } as never);

/** Run a call and hand back whatever it threw, or null. */
const attempt = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try { await fn(); return null; } catch (e) { return e; }
};

/** The attacker's payload from the defect log, verbatim in spirit. */
const EVIL = { email: 'attacker@evil.test', cc: 'second@evil.test' };
const NOTICE_BODY = { buyers: ['B'], sellers: ['S'], agents: {} };

describe('Quick Actions refuse a deal the caller has no part in (TD-012)', () => {
  it('refuses all five entry points, and sends no mail while refusing', async () => {
    await inRollback(async (tx) => {
      const { stranger, deal } = await scene(tx);
      const { notice, quick, sent } = services(tx);
      const who = asUser(stranger);

      const calls: [string, () => Promise<unknown>][] = [
        ['GET  notice-of-sale', () => notice.show(who, deal.id)],
        ['PUT  notice-of-sale', () => notice.save(who, deal.id, NOTICE_BODY)],
        ['POST notice-of-sale/send', () => notice.send(who, deal.id, EVIL)],
        ['POST deposit-receipt/send', () => quick.depositReceipt(who, deal.id, EVIL)],
        ['POST trade-sheet/send', () => quick.tradeSheet(who, deal.id, EVIL)],
      ];
      for (const [label, call] of calls) {
        const err = await attempt(call);
        expect([label, err instanceof ForbiddenException]).toEqual([label, true]);
      }

      // The whole point of the deposit-receipt hole: a refusal that still mailed would be no fix.
      expect(sent).toHaveLength(0);
    });
  });

  it('does not persist a Notice of Sale written by a stranger', async () => {
    await inRollback(async (tx) => {
      const { stranger, deal } = await scene(tx);
      const { notice } = services(tx);

      await attempt(() => notice.save(asUser(stranger), deal.id, NOTICE_BODY));

      const after = await tx.transactions.findUnique({ where: { id: deal.id }, select: { notice_of_sale: true } });
      expect(after?.notice_of_sale ?? null).toBeNull();
    });
  });

  it('refuses an UNASSIGNED deal, which is administrators-only and belongs to no agent', async () => {
    await inRollback(async (tx) => {
      const { owner, stranger, unassigned } = await scene(tx);
      const { quick, sent } = services(tx);

      // Neither agent is on it — not even the one who owns the other deal.
      for (const person of [stranger, owner]) {
        const err = await attempt(() => quick.depositReceipt(asUser(person), unassigned.id, EVIL));
        expect(err).toBeInstanceOf(ForbiddenException);
      }
      expect(sent).toHaveLength(0);
    });
  });

  it('lets the agent on the deal through', async () => {
    await inRollback(async (tx) => {
      const { owner, deal } = await scene(tx);
      const { notice, quick } = services(tx);

      // Not asserting the happy path end to end — only that the OWNERSHIP gate opened. A refusal
      // here would be a 403; anything else means the call got past it and failed on its own terms.
      for (const call of [
        () => notice.show(asUser(owner), deal.id),
        () => notice.save(asUser(owner), deal.id, NOTICE_BODY),
        () => quick.depositReceipt(asUser(owner), deal.id, { email: 'client@example.test' }),
      ]) {
        expect(await attempt(call)).not.toBeInstanceOf(ForbiddenException);
      }
    });
  });

  it('lets an administrator through, including on the unassigned deal', async () => {
    await inRollback(async (tx) => {
      const { admin, deal, unassigned } = await scene(tx);
      const { notice, quick } = services(tx);

      expect(await attempt(() => notice.show(asUser(admin), deal.id))).toBeNull();
      expect(await attempt(() => notice.show(asUser(admin), unassigned.id))).toBeNull();
      expect(await attempt(() => quick.depositReceipt(asUser(admin), unassigned.id, { email: 'office@example.test' })))
        .not.toBeInstanceOf(ForbiddenException);
    });
  });

  it('answers 404 for a transaction that does not exist, whoever asks', async () => {
    // The reply must not depend on the caller, or the status code becomes a way to enumerate deals.
    await inRollback(async (tx) => {
      const { owner, stranger, admin } = await scene(tx);
      const { quick } = services(tx);
      for (const person of [owner, stranger, admin]) {
        const err = await attempt(() => quick.depositReceipt(asUser(person), 2_000_000_000, EVIL));
        expect(err).toBeInstanceOf(NotFoundException);
      }
    });
  });

  /*
   * TD-013 — the Trade Sheet's validation message named the deal's street address.
   *
   *   HTTP 422 "Buyer and seller lawyer details are required before the Trade Record Sheet can be
   *   sent for 5 Glenmount Court, Whitby, Ontario, L1N 6B1, Canada."
   *
   * — returned to an agent who gets 403 on the deal itself. The record was refused and its address
   * handed over anyway, by the error explaining the refusal.
   *
   * The defect log expects this to close as a side effect of TD-012, because the ownership check
   * now runs before the record is read. That is true, and it is exactly why it is worth a test of
   * its own: nothing about the lawyer-details validation says it must stay behind an authorization
   * check, so a later edit that moves it earlier — or a new endpoint that validates before
   * loading — would reopen the leak with every TD-012 test still green.
   *
   * The second case below is what keeps the first honest. If the message ever stops being produced
   * at all, "the stranger did not see the address" becomes vacuously true; asserting that the OWNER
   * still gets it proves the leaky path is real and merely unreachable.
   */
  describe('and disclose nothing about a deal in the reason for refusing it (TD-013)', () => {
    it('does not name the property in what a stranger gets back', async () => {
      await inRollback(async (tx) => {
        const { stranger, deal } = await scene(tx);
        const { quick } = services(tx);

        // A Buying deal with no lawyer details — precisely the state that produces the message.
        const err = await attempt(() => quick.tradeSheet(asUser(stranger), deal.id, { email: 'x@y.test' }));

        expect(err).toBeInstanceOf(ForbiddenException);
        const body = JSON.stringify((err as ForbiddenException).getResponse());
        expect(body).not.toContain('1 Test St');
        expect(body).not.toContain('lawyer');
        expect(body).not.toContain(deal.trade_no);
      });
    });

    it('still tells the agent who owns the deal what is missing, and names it', async () => {
      await inRollback(async (tx) => {
        const { owner, deal } = await scene(tx);
        const { quick } = services(tx);

        const err = await attempt(() => quick.tradeSheet(asUser(owner), deal.id, { email: 'x@y.test' }));

        expect(err).not.toBeInstanceOf(ForbiddenException);
        const body = JSON.stringify((err as { getResponse(): unknown }).getResponse());
        expect(body).toContain('lawyer details are required');
        expect(body).toContain('1 Test St');
      });
    });
  });

  it('lets a team member on the deal through, as the transaction list already does', async () => {
    await inRollback(async (tx) => {
      const { stranger, deal } = await scene(tx);
      const { notice } = services(tx);

      // Before: refused. The rule is "named on it, or split into it" — same as everywhere else.
      expect(await attempt(() => notice.show(asUser(stranger), deal.id))).toBeInstanceOf(ForbiddenException);

      await tx.team_members.create({
        data: { transaction_id: deal.id, user_id: stranger.id, name: stranger.name, access: 'full', position: 0, created_at: new Date(), updated_at: new Date() },
      });

      expect(await attempt(() => notice.show(asUser(stranger), deal.id))).toBeNull();
    });
  });
});
