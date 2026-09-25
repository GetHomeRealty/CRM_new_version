import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { syncChecklistToStatus } from './document-checklist-sync';
import { checklistFor, statusesDefinedFor } from './checklist-definitions';

/*
 * TD-159 slice 4 - A STATUS CHANGE BRINGS THE CHECKLIST UP TO DATE AND REMOVES NOTHING.
 *
 * The brokerage ruled on 2026-09-25, in their own words: "remain on list but as non-mandatory.
 * even if any document already exists, those items remain as is & do not remove item as well as
 * document. any document should not be deleted by default without approvals."
 *
 * The additions are the easy half. THE REFUSALS ARE THE POINT: a document somebody added by hand,
 * a condition's document, a flag a Super Admin set, and any file already uploaded must all come
 * through a status change untouched - and the number of documents on a deal must never fall.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const TYPE = 'Residential Buying';
const STATUSES = statusesDefinedFor(TYPE);

async function deal(tx: PrismaService) {
  const now = new Date();
  return tx.transactions.create({
    data: {
      trade_no: `TD159S4-${Date.now()}-${++seq}`, type: TYPE, property: '3 Checklist Close',
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
      created_at: now, updated_at: now,
    },
    select: { id: true },
  });
}

const docs = (tx: PrismaService, txnId: number) =>
  tx.documents.findMany({
    where: { transaction_id: txnId, deleted_at: null },
    orderBy: { id: 'asc' },
    select: { id: true, title: true, mandatory: true, manual: true, is_condition: true, file_path: true },
  });

describe('the checklist definitions this slice stands on', () => {
  it('defines several statuses for a Residential Buying deal, each with documents', () => {
    // Without this the tests below could all pass against an empty list and prove nothing.
    expect(STATUSES.length).toBeGreaterThan(1);
    expect(checklistFor(TYPE, STATUSES[0]).length).toBeGreaterThan(0);
  });
});

describe('bringing a deal up to its status (TD-159 slice 4)', () => {
  it('adds the documents that status asks for, and says how many', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const wanted = checklistFor(TYPE, STATUSES[0]);

      const r = await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);

      expect(r.added).toBe(wanted.length);
      expect((await docs(tx, t.id)).map((d) => d.title).sort())
        .toEqual(wanted.map((w) => w.title).sort());
    });
  }, 60000);

  it('is silent the second time - the same status adds nothing twice', async () => {
    // Called on every status change, so a deal saved twice must not grow a second copy of its list.
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);

      expect(await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]))
        .toEqual({ added: 0, flagged: 0, relaxed: 0 });
    });
  }, 60000);

  it('corrects a Mandatory flag the checklist disagrees with', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);
      const one = (await docs(tx, t.id))[0];
      await tx.documents.update({ where: { id: one.id }, data: { mandatory: !one.mandatory } });

      const r = await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);

      expect(r.flagged).toBe(1);
      expect((await tx.documents.findUniqueOrThrow({ where: { id: one.id } })).mandatory)
        .toBe(one.mandatory);
    });
  }, 60000);

  it('KEEPS a document the status does not ask for, and only stops requiring it', async () => {
    // The brokerage's whole ruling, in one case: the row stays, it simply stops counting.
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const now = new Date();
      await tx.documents.create({
        data: {
          transaction_id: t.id, title: 'ZZ Not On Any List', mandatory: true,
          position: 0, created_at: now, updated_at: now,
        },
      });

      const r = await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);

      expect(r.relaxed).toBe(1);
      const kept = (await docs(tx, t.id)).find((d) => d.title === 'ZZ Not On Any List');
      expect(kept).toBeDefined();
      expect(kept?.mandatory).toBe(false);
    });
  }, 60000);
});

describe('what a status change must never touch (TD-159 slice 4)', () => {
  const extra = (txnId: number, title: string, over: Record<string, unknown> = {}) => {
    const now = new Date();
    return { transaction_id: txnId, title, mandatory: true, position: 0, created_at: now, updated_at: now, ...over };
  };

  it('leaves a document somebody added by hand exactly as it was', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await tx.documents.create({ data: extra(t.id, 'ZZ Added By The Office', { manual: true }) });

      const r = await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);

      expect(r.relaxed).toBe(0);
      const kept = (await docs(tx, t.id)).find((d) => d.title === 'ZZ Added By The Office');
      expect(kept?.mandatory).toBe(true);
    });
  }, 60000);

  it("leaves a condition's document alone", async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await tx.documents.create({ data: extra(t.id, 'ZZ Condition Paperwork', { is_condition: true }) });

      const r = await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);

      expect(r.relaxed).toBe(0);
      expect((await docs(tx, t.id)).find((d) => d.title === 'ZZ Condition Paperwork')?.mandatory).toBe(true);
    });
  }, 60000);

  it('leaves a flag a Super Admin set, even where the checklist disagrees', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);
      const one = (await docs(tx, t.id))[0];
      await tx.documents.update({
        where: { id: one.id },
        data: { mandatory: !one.mandatory, mandatory_override: true },
      });

      const r = await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);

      expect(r.flagged).toBe(0);
      expect((await tx.documents.findUniqueOrThrow({ where: { id: one.id } })).mandatory).toBe(!one.mandatory);
    });
  }, 60000);

  it('leaves an uploaded FILE alone, on a document the new list does not ask for', async () => {
    // Trade 400118 is exactly this on the live system, and the brokerage's answer was explicit:
    // the row stays, the file stays, it simply stops being required.
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await tx.documents.create({
        data: extra(t.id, 'ZZ Holds A File', { file_path: 'uploads/zz/real.pdf', file_name: 'real.pdf' }),
      });

      await syncChecklistToStatus(tx as never, t.id, TYPE, STATUSES[0]);

      const kept = (await docs(tx, t.id)).find((d) => d.title === 'ZZ Holds A File');
      expect(kept?.file_path).toBe('uploads/zz/real.pdf');
      expect(kept?.mandatory).toBe(false);
    });
  }, 60000);

  it('never lets the number of documents fall, through every status in turn', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      let seen = 0;
      for (const s of STATUSES) {
        await syncChecklistToStatus(tx as never, t.id, TYPE, s);
        const n = (await docs(tx, t.id)).length;
        expect(n).toBeGreaterThanOrEqual(seen);
        seen = n;
      }
      expect(seen).toBeGreaterThan(0);
    });
  }, 60000);

  it('does nothing at all for a pairing it has no checklist for', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await tx.documents.create({ data: extra(t.id, 'ZZ Untouched') });

      expect(await syncChecklistToStatus(tx as never, t.id, 'ZZ Nonexistent Type', 'Whatever'))
        .toEqual({ added: 0, flagged: 0, relaxed: 0 });
      expect((await docs(tx, t.id)).find((d) => d.title === 'ZZ Untouched')?.mandatory).toBe(true);
    });
  }, 60000);
});
