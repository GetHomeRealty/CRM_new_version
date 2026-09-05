import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { TransactionReviewService } from './transaction-review.service';
import { TransactionsService } from './transactions.service';
import { filterClauses } from './transaction-filters';
import type { ResourceUser } from './transaction.resource';

/**
 * TD-090 — a deal is findable by the name of the client on it.
 *
 * THE GAP. The list's search box matched three columns on `transactions` — property, trade number,
 * agent — so a deal carrying two buyers named Nair returned NOTHING for "Nair", while "Oakridge"
 * and the trade number each returned it. That is the everyday journey: an agent takes a call from
 * a client and has to reach the file by the one thing they know for certain, who is on the phone.
 * The alternative is asking the caller for their own address.
 *
 * NOT A NEW CAPABILITY. The relational predicate already existed as the dedicated `client` filter;
 * the free-text box simply did not use it. This adds a fourth arm to the same OR.
 *
 * WHAT MUST NOT CHANGE, and is asserted below: the three original searches still return exactly
 * what they returned, a search still cannot reach a deal the caller may not see, and a deal with
 * NO clients is unaffected — a relational `some` must not accidentally exclude it from the other
 * three arms.
 *
 * Real rows in a rolled-back transaction: this is a query, and stubbing Prisma would test the
 * shape of the filter rather than what the database does with it.
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

const listFor = (tx: PrismaService) =>
  new TransactionsService(
    tx,
    new CommissionService(new PersonResolver(tx)),
    new TransactionReviewService(tx, new PersonResolver(tx), null as never, null as never, null as never),
    // The audit collaborator is unused on the list path, which only reads.
    null as never,
  );

const OFFICE: ResourceUser = { id: 1, name: 'An Admin', role: 'admin' } as unknown as ResourceUser;

async function fixture(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const stamp = `${Date.now()}-${n}`;
  const mk = async (property: string, agent: string, clients: string[]) => {
    const t = await tx.transactions.create({
      data: {
        trade_no: `TD090-${stamp}-${clients.length}${property.length}`, type: 'Residential Buying',
        property, agent, adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
        created_at: now, updated_at: now,
      },
    });
    let position = 0;
    for (const name of clients) {
      await tx.clients.create({ data: { transaction_id: t.id, name, position: position++, created_at: now, updated_at: now } });
    }
    return t;
  };

  // The run's stamp is inside EACH name part, so a single-word search ("Nair…") is still unique to
  // this fixture — the query runs against the whole database, not just these rows.
  const withClients = await mk(`${stamp} Oakridge Walk`, `Agent Alpha ${stamp}`, [
    `ZZ-TEST Priya${stamp} Nair${stamp}`,
    `ZZ-TEST Arun${stamp} Nair${stamp}`,
  ]);
  const noClients = await mk(`${stamp} Elmwood Lane`, `Agent Beta ${stamp}`, []);
  return { withClients, noClients, stamp };
}

const idsFor = async (tx: PrismaService, q: string): Promise<number[]> => {
  const res = await listFor(tx).index(OFFICE, { q } as never);
  return (res.data as { id: number }[]).map((t) => t.id);
};

describe('the transactions search finds a deal by its client (TD-090)', () => {
  jest.setTimeout(120_000);

  it('finds the deal by a client surname — the search that returned nothing', async () => {
    await inRollback(async (tx) => {
      const { withClients, noClients, stamp } = await fixture(tx);
      const found = await idsFor(tx, `Nair${stamp}`);
      expect(found).toContain(withClients.id);
      expect(found).not.toContain(noClients.id);
    });
  });

  it('finds it by a first name too, and by either of two clients on one deal', async () => {
    await inRollback(async (tx) => {
      const { withClients, stamp } = await fixture(tx);
      expect(await idsFor(tx, `Priya${stamp}`)).toEqual([withClients.id]);
      expect(await idsFor(tx, `Arun${stamp}`)).toEqual([withClients.id]);
    });
  });

  it('still finds a deal by property, trade number and agent', async () => {
    // The controls from the report: these worked and must go on working.
    await inRollback(async (tx) => {
      const { withClients, stamp } = await fixture(tx);
      expect(await idsFor(tx, `${stamp} Oakridge`)).toContain(withClients.id);
      expect(await idsFor(tx, withClients.trade_no)).toEqual([withClients.id]);
      expect(await idsFor(tx, `Agent Alpha ${stamp}`)).toContain(withClients.id);
    });
  });

  it('still finds a deal that has no clients at all', async () => {
    // A relational `some` inside an OR must widen the match, never narrow it.
    await inRollback(async (tx) => {
      const { noClients, stamp } = await fixture(tx);
      expect(await idsFor(tx, `${stamp} Elmwood`)).toContain(noClients.id);
      expect(await idsFor(tx, noClients.trade_no)).toEqual([noClients.id]);
    });
  });

  it('returns nothing for a name nobody on any deal has', async () => {
    await inRollback(async (tx) => {
      const { stamp } = await fixture(tx);
      expect(await idsFor(tx, `Nobody ${stamp}`)).toEqual([]);
    });
  });

  it('keeps the search as one OR term, so it cannot widen what an agent may see', () => {
    // The visibility rule is a separate AND term; a free-text search that leaked into it would be
    // a permission defect rather than a search one.
    const [clause] = filterClauses({ q: 'Nair' } as never);
    expect(Object.keys(clause)).toEqual(['OR']);
    expect((clause as { OR: unknown[] }).OR).toHaveLength(4);
  });
});
