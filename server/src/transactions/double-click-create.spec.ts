import { UnprocessableEntityException } from '@nestjs/common';
import { TransactionsWriteService } from './transactions-write.service';

/**
 * TD-076 — a double-click creates one deal and shows no error.
 *
 * WHERE THIS ENTRY GOT TO. Two identical creates arriving together answered 500. An advisory lock on
 * the duplicate key closed that race, and the loser then got the SAME 422 the sequential path
 * gives: "Transaction already exists — Trade #NNN". The brokerage rejected that on the user's
 * behalf on 2026-09-06 and were right: a double-click is ONE submission that arrived twice, the
 * user's deal DID save, and telling them it already exists implies somebody else created it or that
 * theirs failed. They then go looking for a record they believe is not theirs — wrong, rather than
 * merely unhelpful.
 *
 * THE AGREED BEHAVIOUR, and what these tests pin:
 *   · the second click returns the deal the first one created, with no error and no warning;
 *   · a GENUINE duplicate — a separate attempt at a deal the system already holds — still gets the
 *     422, unchanged;
 *   · the two are told apart by a TOKEN the form mints when it opens, not by how close together the
 *     requests arrived. Timing would be a rule nobody could state and every slow connection would
 *     break.
 *
 * Prisma is stubbed. The replay decision, the lock it is taken under and the follow-on work it
 * skips all happen in the service, which is what is under test here; the unique index behind it is
 * a database guarantee and is asserted by the migration rather than by this file.
 */

interface Call { sql: string }

const ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 501, trade_no: '200501', type: 'Residential Buying', property: '9 Oak Road',
  price: 750_000, offer_date: new Date('2026-04-01T00:00:00.000Z'), agent: 'Sai Ramesh',
  deleted_at: null, client_token: null, ...over,
});

/** A create that gets as far as the write, with the collaborators it reaches recorded. */
const drive = async (body: Record<string, unknown>, opts: {
  priorByToken?: Record<string, unknown> | null;
  duplicates?: Record<string, unknown>[];
} = {}) => {
  const locks: Call[] = [];
  /** What the create did, in order — the ordering is the assertion, not the count. */
  const events: string[] = [];
  const created: Record<string, unknown>[] = [];
  let invoiced = 0;
  let loaded: number | null = null;

  const tx = {
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      locks.push({ sql: `${sql}|${args.join(',')}` });
      events.push('lock');
      return 1;
    },
    transactions: {
      findFirst: async (a: { where?: Record<string, unknown> }) => {
        if (a?.where && 'client_token' in a.where) { events.push('token-lookup'); return opts.priorByToken ?? null; }
        return null;
      },
      findMany: async () => opts.duplicates ?? [],
      create: async (a: { data: Record<string, unknown> }) => { created.push(a.data); return ROW({ id: 900 }); },
      update: async () => ROW(),
      count: async () => 0,
    },
    transaction_statuses: { create: async () => ({ id: 1 }), findMany: async () => [] },
    clients: { create: async () => ({ id: 1 }) },
    team_members: { create: async () => ({ id: 1 }), findMany: async () => [] },
  };

  const prisma = {
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    transactions: { findFirst: async () => ROW(), findUnique: async () => ROW() },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
  };

  const svc = new TransactionsWriteService(
    ...([
      prisma,
      { resolve: async () => null, resolveMany: async () => [] },    // people
      { snapshot: async () => ({}), record: async () => undefined, recordChanges: async () => [] },
      {},                                                            // commission
      { next: async () => '200900' },                                // tradeNumbers
      { generate: async () => { invoiced += 1; } },                  // txnInvoices
      { maybeRemind: async () => undefined },                        // lawyerReminder
      {}, {}, {}, {},
    ] as unknown as ConstructorParameters<typeof TransactionsWriteService>),
  );
  // The resource load is the last thing store() does and needs the whole include; the id it is
  // asked for is the answer under test, so it is captured and the load short-circuited.
  (svc as unknown as { loadResource: (id: number) => Promise<unknown> }).loadResource =
    async (id: number) => { loaded = id; return { data: { id } }; };

  let refusal: Refusal | null = null;
  try {
    await svc.store({ id: 7, name: 'Sai Ramesh', role: 'agent' } as never, body);
  } catch (e) {
    if (!(e instanceof UnprocessableEntityException)) throw e;
    refusal = e.getResponse() as Refusal;
  }
  return { locks, events, created, invoiced, loaded, refusal };
};

interface Refusal { message: string }

const DEAL = {
  type: 'Residential Buying', property: '9 Oak Road', status: 'Secured Firm',
  price: 750_000, offer_date: '2026-04-01', closing_date: '2026-06-30',
  comm_type: '%', comm_value: 2.5,
};

describe('the second click of a double-click (TD-076)', () => {
  it('returns the deal the first click created, and says nothing', async () => {
    const r = await drive({ ...DEAL, client_token: 'tok-abc' }, { priorByToken: ROW({ id: 501 }) });

    expect(r.refusal).toBeNull();          // not the 422 the brokerage rejected
    expect(r.loaded).toBe(501);            // the deal the first click made
    expect(r.created).toHaveLength(0);     // and no second row
  });

  it('does not repeat the work the first click already did', async () => {
    // The invoice and the lawyer nudge belong to the submission, not to the request. Running them
    // again would bill twice and email twice for one deal.
    const r = await drive({ ...DEAL, client_token: 'tok-abc' }, { priorByToken: ROW({ id: 501 }) });
    expect(r.invoiced).toBe(0);
  });

  it('takes the lock BEFORE it looks the token up', async () => {
    /*
     * The whole defect one level down. A plain read-then-write check has both clicks find nothing
     * and both insert — which is how two identical deals got written before the duplicate key was
     * serialised. The ORDER is the assertion: a lookup that happens before the lock proves nothing,
     * because two racing clicks would both reach it.
     */
    const r = await drive({ ...DEAL, client_token: 'tok-abc' }, { priorByToken: ROW({ id: 501 }) });

    expect(r.events).toEqual(['lock', 'token-lookup']);
    expect(r.locks[0].sql).toContain('pg_advisory_xact_lock');
  });
});

describe('everything else about creating a deal is unchanged (TD-076)', () => {
  it('stores the token on a first submission, so the second can find it', async () => {
    const r = await drive({ ...DEAL, client_token: 'tok-new' }, { priorByToken: null });

    expect(r.refusal).toBeNull();
    expect(r.created).toHaveLength(1);
    expect(r.created[0].client_token).toBe('tok-new');
  });

  it('still refuses a GENUINE duplicate with the message it always gave', async () => {
    // A separate attempt at a deal the system holds: a different token, so no replay, and the
    // duplicate guard speaks exactly as before. This is the half the brokerage asked not to change.
    const r = await drive(
      { ...DEAL, client_token: 'tok-different' },
      { priorByToken: null, duplicates: [ROW({ id: 42, trade_no: '200042', agent: 'Aswini' })] },
    );

    expect(r.refusal?.message).toContain('Transaction already exists');
    expect(r.refusal?.message).toContain('Trade #200042');
    expect(r.created).toHaveLength(0);
  });

  it('creates normally when no token is sent at all', async () => {
    // The importer, the API and any client older than this column send none, and must behave
    // exactly as they did before.
    const r = await drive({ ...DEAL }, { priorByToken: ROW({ id: 501 }) });

    expect(r.refusal).toBeNull();
    expect(r.created).toHaveLength(1);
    expect(r.created[0].client_token).toBeNull();
    // No prior was consulted, so the row it would have returned is not the one loaded.
    expect(r.loaded).not.toBe(501);
  });
});
