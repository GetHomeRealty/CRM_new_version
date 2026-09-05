import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AgentsService } from '../agents/agents.service';
import { RecycleBinService } from '../recycle-bin/recycle-bin.service';
import { TransactionsWriteService, clearSwitchedOffSections } from './transactions-write.service';

/**
 * TD-111 — a section of the Adjustment panel switched off does not keep what it held.
 *
 * THE DEFECT. Each section is a Yes/No toggle over a list. Setting the toggle back to No hid the
 * rows and released the money — that part was right — but the rows stayed in the stored record,
 * invisible from every screen, and would be applied again the moment anybody set the toggle back to
 * Yes. A user who switches a section off has every reason to believe the entry is gone.
 *
 * WHICH WAY IT WAS DECIDED, AND WHY IT IS NOT A COIN TOSS. The entry says either clearing the rows
 * or keeping them visibly is defensible. This panel had already decided: its fourth section, the
 * external referral, has always treated its toggle going off as a REMOVAL — `captureRemovedRows`
 * files it in the Recycle Bin — and `restoreRowItem` puts a restored row back by switching its
 * section on again. That restore was written for a record where a switched-off section holds
 * nothing. The three lists were the ones not keeping to the rule, so they were brought to it.
 *
 * NOTHING IS DESTROYED, which is the whole reason clearing is safe here: the clearing runs before
 * the capture, so every row lands in the Recycle Bin exactly as if it had been deleted with its own
 * bin button. The restore test below is that promise, tested end to end on real rows.
 *
 * AND IT WAS NOT ONLY A FUTURE RISK. The entry says nothing acts on a dormant row today. One thing
 * did: `AgentsService.loans` was the single consumer of `adjustment_rows` that never asked whether
 * the section was on, so a switched-off loan repayment went on repaying the agent's loan — and
 * disagreed with the Agent Financial report, which does ask. Last describe block.
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
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

describe('the rule: a switched-off section holds nothing (TD-111)', () => {
  const row = { agent: 'Sai Ramesh', amount: -1500, status: 'Yet to Adjust', remarks: 'typo', is_loan: false };
  const clear = (adj: Record<string, unknown>) => clearSwitchedOffSections(adj) as Record<string, unknown>;

  it('empties the list behind a toggle set to No — the reported case', () => {
    expect(clear({ agent_adjust: 'No', adjustment_rows: [row] }).adjustment_rows).toEqual([]);
  });

  it('empties it when the toggle is absent altogether, which reads as No everywhere else', () => {
    expect(clear({ adjustment_rows: [row] }).adjustment_rows).toEqual([]);
  });

  it('leaves a section that is ON completely alone', () => {
    expect(clear({ agent_adjust: 'Yes', adjustment_rows: [row] }).adjustment_rows).toEqual([row]);
  });

  it('applies to all three lists, not only the one the defect was filed against', () => {
    // The same toggle over the same kind of list. A fix for one of three would be re-filed twice.
    const out = clear({
      agent_adjust: 'No', adjustment_rows: [row],
      advance_payment: 'No', advance_rows: [{ agent: 'A', amount: 500 }],
      client_referral: 'Yes', client_rows: [{ client_name: 'C', amount: 250 }],
    });
    expect(out.adjustment_rows).toEqual([]);
    expect(out.advance_rows).toEqual([]);
    expect(out.client_rows).toHaveLength(1); // still on
  });

  it('clears an external referral left behind its own toggle', () => {
    expect(clear({ ext_referral: 'No', ext: { brokerage: 'Other Co', amount: 2000 } }).ext).toEqual({});
  });

  it('does NOT touch the blank external referral the form posts on every deal', () => {
    /*
     * The form sends the referral as a full set of empty strings whether or not anybody filled it
     * in, with 'No' and 'N/A' as its select defaults. Treating that as content would file an empty
     * Recycle Bin entry on every save of every deal that has ever opened this panel.
     */
    const blank = { agent_name: '', brokerage: '', amount: '', invoice_received: 'No', hst_no: '', paid_type: 'N/A', paid_date: '', batch_no: '', paid_status: '' };
    expect(clear({ ext_referral: 'No', ext: blank }).ext).toBe(blank);
  });

  it('leaves anything that is not an adjustments object exactly as it found it', () => {
    expect(clearSwitchedOffSections(null)).toBeNull();
    expect(clearSwitchedOffSections('{"agent_adjust":"No"}')).toBe('{"agent_adjust":"No"}');
  });

  it('keeps the rest of the blob — it empties sections, it does not rewrite the record', () => {
    const out = clear({ agent_adjust: 'No', adjustment_rows: [row], something_else: { kept: true } });
    expect(out.something_else).toEqual({ kept: true });
  });
});

// ---------------------------------------------------------------------------
// The save: cleared AND filed in the Recycle Bin, in one request
// ---------------------------------------------------------------------------

interface SaveResult { stored: Record<string, unknown>; binned: { kind: string; label: string; data: Record<string, unknown> }[] }

/**
 * One PUT through the real write path, with Prisma stubbed.
 *
 * What matters here is what reaches the write and what is filed on the way — both happen before the
 * stubs give out, and the ordering between them is the point: the capture must see the rows the
 * clearing removed, or clearing would destroy them.
 */
const save = async (storedAdjustments: Record<string, unknown>, sent: Record<string, unknown>): Promise<SaveResult> => {
  const txn = {
    id: 1838, trade_no: '201838', type: 'Residential Buying', deleted_at: null,
    price: 500_000, deposit: 0, agent: 'Sai Ramesh', agent_user_id: 7, property: '1 Test Road', version: 1,
    offer_date: null, closing_date: null, listing_expiry_date: null, comm_paid_status: null,
    admin_activities: null, activity_tracker: null, adjustments: JSON.stringify(storedAdjustments),
    updated_at: new Date('2026-09-01T10:00:00.000Z'),
  };
  const written: Record<string, unknown>[] = [];
  const binned: SaveResult['binned'] = [];
  const tx = {
    transactions: {
      update: async (a: { data: Record<string, unknown> }) => { written.push(a.data); return txn; },
      updateMany: async (a: { data: Record<string, unknown> }) => { written.push(a.data); return { count: 1 }; },
      findUnique: async () => txn,
    },
    trashed_row_items: {
      create: async (a: { data: { kind: string; label: string; data: string } }) => {
        binned.push({ kind: a.data.kind, label: a.data.label, data: JSON.parse(a.data.data) as Record<string, unknown> });
        return { id: binned.length };
      },
    },
  };
  const prismaStub = {
    transactions: { findFirst: async () => txn, findUnique: async () => txn },
    transaction_statuses: { findMany: async () => [] },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as never;
  const audit = { snapshot: async () => ({}), record: async () => undefined, recordChanges: async () => [] } as never;
  const svc = new TransactionsWriteService(
    ...([prismaStub, {}, audit, ...Array.from({ length: 7 }, () => ({}))] as unknown as ConstructorParameters<typeof TransactionsWriteService>),
  );
  // Past the write and into the stubs' limits: everything under test has already happened.
  try { await svc.update({ id: 1, name: 'QA', role: 'admin' } as never, 1838, sent); } catch { /* see above */ }

  const adjustments = written.map((w) => w.adjustments).filter((v) => typeof v === 'string').pop();
  return { stored: JSON.parse(String(adjustments ?? '{}')) as Record<string, unknown>, binned };
};

describe('saving with a section switched off (TD-111)', () => {
  const row = { agent: 'Sai Ramesh', amount: -1500, status: 'Yet to Adjust', remarks: 'entered by mistake', is_loan: false };

  it('stores the section empty', async () => {
    const { stored } = await save(
      { agent_adjust: 'Yes', adjustment_rows: [row] },
      { adjustments: { agent_adjust: 'No', adjustment_rows: [row] } },
    );
    expect(stored.adjustment_rows).toEqual([]);
    expect(stored.agent_adjust).toBe('No');
  });

  it('files the row in the Recycle Bin, so switching a section off never destroys an entry', async () => {
    const { binned } = await save(
      { agent_adjust: 'Yes', adjustment_rows: [row] },
      { adjustments: { agent_adjust: 'No', adjustment_rows: [row] } },
    );
    expect(binned).toHaveLength(1);
    expect(binned[0].kind).toBe('adjustment_row');
    expect(binned[0].label).toBe('Adjustment Details — Sai Ramesh');
    expect(binned[0].data.amount).toBe(-1500);
    expect(binned[0].data.remarks).toBe('entered by mistake');
  });

  it('clears rows a save that predates this fix left dormant, even though the toggle is not moving', async () => {
    // The toggle is already No on both sides; the rows are still there from before. They go, and
    // they go to the bin.
    const { stored, binned } = await save(
      { agent_adjust: 'No', adjustment_rows: [row] },
      { adjustments: { agent_adjust: 'No', adjustment_rows: [row] } },
    );
    expect(stored.adjustment_rows).toEqual([]);
    expect(binned.map((b) => b.kind)).toEqual(['adjustment_row']);
  });

  it('leaves a section that is on untouched, and files nothing', async () => {
    const { stored, binned } = await save(
      { agent_adjust: 'Yes', adjustment_rows: [row] },
      { adjustments: { agent_adjust: 'Yes', adjustment_rows: [row] } },
    );
    expect(stored.adjustment_rows).toHaveLength(1);
    expect(binned).toHaveLength(0);
  });

  it('does the same for advance payments and client referrals', async () => {
    const advance = { agent: 'Sai Ramesh', amount: 800, paid_type: 'Cheque', paid_date: '2026-08-01' };
    const client = { client_name: 'A Buyer', amount: 250, void_cheque: 'Yes' };
    const { stored, binned } = await save(
      { advance_payment: 'Yes', advance_rows: [advance], client_referral: 'Yes', client_rows: [client] },
      { adjustments: { advance_payment: 'No', advance_rows: [advance], client_referral: 'No', client_rows: [client] } },
    );
    expect(stored.advance_rows).toEqual([]);
    expect(stored.client_rows).toEqual([]);
    expect(binned.map((b) => b.kind).sort()).toEqual(['advance_row', 'client_row']);
  });

  it('files an external referral once and then stays quiet', async () => {
    // Filing one on every subsequent save would bury the real entries under empty ones.
    const ext = { agent_name: 'R Agent', brokerage: 'Other Co', amount: 2000, invoice_received: 'No', paid_type: 'N/A' };
    const first = await save({ ext_referral: 'Yes', ext }, { adjustments: { ext_referral: 'No', ext } });
    // `[]`, not `{}` — every JSON column on this model is written through `phpJsonNormalize`, which
    // encodes an empty object the way PHP does. That is the shape the rest of the app already reads.
    expect(first.stored.ext).toEqual([]);
    expect(first.binned.map((b) => b.kind)).toEqual(['ext_referral']);

    const second = await save({ ext_referral: 'No', ext: {} }, { adjustments: { ext_referral: 'No', ext: {} } });
    expect(second.binned).toHaveLength(0);
  });

  it('saves that do not mention adjustments are not touched by any of this', async () => {
    const { stored, binned } = await save({ agent_adjust: 'No', adjustment_rows: [row] }, { property: '2 New Road' });
    expect(stored).toEqual({}); // nothing written to the column at all
    expect(binned).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The promise the warning makes
// ---------------------------------------------------------------------------

describe('a cleared row comes back from the Recycle Bin (TD-111)', () => {
  jest.setTimeout(120_000);

  const binFor = (tx: PrismaService) =>
    new RecycleBinService(tx, { record: async () => undefined } as never, {} as never, {} as never);

  it('restores the row AND switches the section back on', async () => {
    /*
     * Why this belongs to this defect: the clearing is only safe because the row is recoverable, and
     * it is only USEFUL if restoring it turns the section back on — a row restored into a section
     * that reads No would be exactly the dormant entry this fix removes.
     */
    await inRollback(async (tx) => {
      const now = new Date();
      const n = ++seq;
      const deal = await tx.transactions.create({
        data: {
          trade_no: `TD111-${Date.now()}-${n}`, type: 'Residential Buying', property: '1 Test Road',
          agent: 'Sai Ramesh', adjustments: JSON.stringify({ agent_adjust: 'No', adjustment_rows: [] }),
          admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
        },
      });
      const item = await tx.trashed_row_items.create({
        data: {
          transaction_id: deal.id, module: 'adjustments', kind: 'adjustment_row', agent: 'Sai Ramesh',
          label: 'Adjustment Details — Sai Ramesh', data: JSON.stringify({ agent: 'Sai Ramesh', amount: -1500, remarks: 'entered by mistake' }),
          who: 'QA', user_id: 1, created_at: now, updated_at: now,
        },
      });

      await binFor(tx).restoreRowItem({ id: 1, name: 'A Super Admin', role: 'admin' } as never, item.id);

      const after = await tx.transactions.findUnique({ where: { id: deal.id }, select: { adjustments: true } });
      const adj = JSON.parse(String(after?.adjustments)) as Record<string, unknown>;
      expect(adj.agent_adjust).toBe('Yes');
      expect(adj.adjustment_rows).toHaveLength(1);
      expect((adj.adjustment_rows as { amount: number }[])[0].amount).toBe(-1500);
    });
  });
});

// ---------------------------------------------------------------------------
// The one consumer that was applying dormant rows
// ---------------------------------------------------------------------------

describe('a loan repayment counts only while its section is on (TD-111)', () => {
  jest.setTimeout(120_000);

  const withLoanRow = async (tx: PrismaService, toggle: string) => {
    const now = new Date();
    const n = ++seq;
    const name = `TD111 Borrower ${Date.now()}-${n}`;
    await tx.users.create({
      data: {
        name, email: `td111-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', status: 'Active',
        profile: JSON.stringify({ has_loan: '1', loan_amount: 10_000 }), created_at: now, updated_at: now,
      },
    });
    await tx.transactions.create({
      data: {
        trade_no: `TD111L-${Date.now()}-${n}`, type: 'Residential Buying', property: '1 Loan Road', agent: name,
        adjustments: JSON.stringify({ agent_adjust: toggle, adjustment_rows: [{ agent: name, amount: 2500, is_loan: true }] }),
        admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
      },
    });
    return { name, loans: await new AgentsService(tx).loans(null) };
  };

  it('counts it while the section is ON', async () => {
    await inRollback(async (tx) => {
      const { name, loans } = await withLoanRow(tx, 'Yes');
      expect(loans[name].loan_repaid).toBe(2500);
      expect(loans[name].loan_balance).toBe(7500);
    });
  });

  it('does NOT count it while the section is off — the defect, on today\'s money', async () => {
    /*
     * This is the part of TD-111 that was not a future risk. Every other reader of
     * `adjustment_rows` gates on the toggle; this one did not, so a repayment somebody switched off
     * kept reducing the agent's outstanding loan, and `/api/agent-loans` and the Agent Financial
     * report gave two different answers about the same loan.
     */
    await inRollback(async (tx) => {
      const { name, loans } = await withLoanRow(tx, 'No');
      expect(loans[name].loan_repaid).toBe(0);
      expect(loans[name].loan_balance).toBe(10_000);
    });
  });
});

// ---------------------------------------------------------------------------
// The half the user sees
// ---------------------------------------------------------------------------

describe('the panel says what switching a section off will do (TD-111)', () => {
  const source = readFileSync(join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'AdjustmentModal.tsx'), 'utf8');

  it('asks before emptying a section that holds something', () => {
    // "Expected: turning a section off should either clear what it holds or tell the user plainly
    // that the entry is being kept." It clears — so it says so first, and says where it went.
    expect(source).toContain('switchSectionOff');
    expect(source).toContain('will be removed from this transaction when you Save');
    expect(source).toContain('from the Recycle Bin');
  });

  it('routes every one of the four toggles through it', () => {
    for (const call of [
      "switchSectionOff('agent_adjust', 'adjustment_rows', 'Agent Adjust')",
      "switchSectionOff('advance_payment', 'advance_rows', 'Advance Payment')",
      "switchSectionOff('client_referral', 'client_rows', 'Client Referral')",
      'switchExtOff()',
    ]) expect(source).toContain(call);
  });

  it('does not warn about the blank row the panel adds by itself', () => {
    // Warning about losing something nobody typed is how people learn to click through warnings.
    expect(source).toContain('const hasContent =');
    expect(source).toContain('if (filled === 0) { clear(); return; }');
  });
});
