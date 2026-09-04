import { PrismaClient } from '@prisma/client';
import { UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { QuickSendService } from './quick-send.service';

/**
 * TD-035 — the Deposit Receipt follows the DEPOSIT, not the deal type.
 *
 * THE DEFECT. The button was offered on `isListingFinancialType(type)` — a question about which
 * side of the trade this is — and on nothing else. So a Residential Buying deal holding a real
 * $28,000 deposit could not produce a receipt for it, while a Residential Sale Listing sitting at
 * $0 offered to write a receipt for nothing.
 *
 * WHAT IS PINNED HERE. The visibility rule lives in the page, but hiding a button is not a rule —
 * the send endpoint composed and mailed the receipt itself, so a direct POST to a $0 deal would
 * still have emailed a document reading "Deposit: $0.00" with the trade number, the property
 * address and a Cc list of the caller's choosing. These assert the API's half: a deposit of zero,
 * absent, or negative is refused and mails NOTHING, and a real deposit still sends — on a BUYING
 * deal, which is exactly the type the old rule locked out.
 *
 * Real rows in a rolled-back transaction: what counts as a deposit is a question about the stored
 * column (null, 0, a negative legacy value), which a stub cannot stand in for.
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

/** The service with a mailer that records instead of sending, so "sent nothing" is assertable. */
function services(tx: PrismaService) {
  const sent: { to: unknown }[] = [];
  const quick = new QuickSendService(
    tx,
    { record: async () => undefined, log: async () => undefined } as never,
    { send: async (_t: unknown, _v: unknown, to: unknown) => { sent.push({ to }); } } as never,
    { current: async () => ({ name: 'Test Brokerage' }) } as never,
    new ResourceAccessService(tx),
  );
  return { quick, sent };
}

const ADMIN = { id: 990000, name: 'An Admin', role: 'admin' } as never;

async function deal(tx: PrismaService, type: string, deposit: number) {
  const now = new Date();
  const n = ++seq;
  return tx.transactions.create({
    data: {
      agent: null, trade_no: `TD035-${Date.now()}-${n}`, type, property: `${n} Deposit St`,
      deposit, created_at: now, updated_at: now,
    },
  });
}

const attempt = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try { await fn(); return null; } catch (e) { return e; }
};

describe('a Deposit Receipt needs a deposit, whatever the transaction type (TD-035)', () => {
  it('refuses a listing with no deposit — and mails nothing while refusing', async () => {
    await inRollback(async (tx) => {
      // The reported row: a Sale Listing at $0 that used to offer the receipt purely on its type.
      const zero = await deal(tx, 'Residential Sale Listing', 0);
      const { quick, sent } = services(tx);

      const err = await attempt(() => quick.depositReceipt(ADMIN, zero.id, { email: 'client@example.test' }));
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(String((err as { response?: { message?: string } }).response?.message)).toContain('no deposit');
      // A refusal that still mailed would be no fix: the endpoint composes the mail itself.
      expect(sent).toHaveLength(0);
    });
  });

  it('refuses a NEGATIVE deposit too — a receipt for minus eight hundred dollars is not a document', async () => {
    await inRollback(async (tx) => {
      const { quick, sent } = services(tx);
      // The column is NOT NULL DEFAULT 0.00, so "nobody entered one" already arrives as the 0
      // above; what a stored row can still be is negative — the API refuses to write one now
      // (TD-055) but older rows predate that, and nothing about them is money taken from anybody.
      const d = await deal(tx, 'Residential Sale Listing', -800);
      expect(await attempt(() => quick.depositReceipt(ADMIN, d.id, { email: 'client@example.test' })))
        .toBeInstanceOf(UnprocessableEntityException);
      expect(sent).toHaveLength(0);
    });
  });

  it('sends for a BUYING deal that holds a deposit — the case the type rule locked out', async () => {
    await inRollback(async (tx) => {
      const buying = await deal(tx, 'Residential Buying', 28000);
      const { quick, sent } = services(tx);

      const res = await quick.depositReceipt(ADMIN, buying.id, { email: 'client@example.test' });
      expect(res).toMatchObject({ ok: true, email: 'client@example.test' });
      expect(sent).toHaveLength(1);
    });
  });

  it('answers the deal before the payload — a $0 deal is refused for the deposit, not the email', async () => {
    // Ordering matters: if email validation ran first, the caller would be told to fix their
    // address on a deal that can never produce this document at all.
    await inRollback(async (tx) => {
      const zero = await deal(tx, 'Residential Buying', 0);
      const { quick } = services(tx);

      const err = await attempt(() => quick.depositReceipt(ADMIN, zero.id, {}));
      expect(String((err as { response?: { message?: string } }).response?.message)).toContain('no deposit');
    });
  });
});
