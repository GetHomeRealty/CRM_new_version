import { readFileSync } from 'fs';
import * as path from 'path';
import { TransactionsWriteService } from '../transactions/transactions-write.service';

/*
 * 2026-10-08 - THE BULK IMPORT SAVES DEALS QUIETLY.
 *
 * Saving a deal can email its agent at once: the lawyer-details nudge (create and every edit) and
 * the "deal status changed" notice (an edit that enters a new status). On 2026-09-13 the master-sheet
 * import sent 267 lawyer emails from that first path (TD-188). TD-188 then skipped finished deals,
 * but a DFT, Secured or Open buying deal still sends one - and the next import is the brokerage's
 * 2021-2024 history. Sai, 2026-10-08: "no need of any mails for the agents as they are of old deals".
 *
 * So the import tells the save it is an import, and the save skips those two instant messages. A
 * save made by a person is unchanged, and that half is asserted too. A live deal that arrives by
 * import is still chased by the nightly sweep once it is within 30 days of closing.
 */

const ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 501, trade_no: '000501', type: 'Residential Buying', property: '9 Oak Road',
  price: 750_000, offer_date: new Date('2022-04-01T00:00:00.000Z'), agent: 'Sai Ramesh',
  deleted_at: null, client_token: null, ...over,
});

const store = async (opts?: { quiet?: boolean }) => {
  let reminded = 0;
  const tx = {
    $executeRawUnsafe: async () => 1,
    transactions: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => ROW({ id: 900 }),
      update: async () => ROW(),
      count: async () => 0,
    },
    transaction_statuses: { create: async () => ({ id: 1 }), findMany: async () => [] },
    clients: { create: async () => ({ id: 1 }) },
    team_members: { create: async () => ({ id: 1 }), findMany: async () => [] },
    documents: { createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }) },
  };
  const prisma = {
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    transactions: { findFirst: async () => ROW(), findUnique: async () => ROW() },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
  };
  const svc = new TransactionsWriteService(
    ...([
      prisma,
      { resolve: async () => null, resolveMany: async () => [] },
      { snapshot: async () => ({}), record: async () => undefined, recordChanges: async () => [] },
      {},
      { next: async () => '000900' },
      { generate: async () => undefined },
      { maybeRemind: async () => { reminded += 1; } },
      {}, {}, {}, {},
    ] as unknown as ConstructorParameters<typeof TransactionsWriteService>),
  );
  (svc as unknown as { loadResource: (id: number) => Promise<unknown> }).loadResource = async (id: number) => ({ data: { id } });
  const body = {
    type: 'Residential Buying', property: '9 Oak Road', status: 'DFT', price: 750_000,
    offer_date: '2022-04-01', closing_date: '2022-06-30', comm_type: '%', comm_value: 2.5,
  };
  await (svc.store as (u: unknown, b: unknown, o?: unknown) => Promise<unknown>)({ id: 7, name: 'Akhil', role: 'admin' }, body, opts);
  return reminded;
};

describe('a deal saved by the bulk import sends no instant email', () => {
  it('a person creating a deal still gets the lawyer-details check', async () => {
    expect(await store()).toBe(1);
  });

  it('the import creating the same deal does not', async () => {
    expect(await store({ quiet: true })).toBe(0);
  });

  const WRITE = readFileSync(path.join(__dirname, '../transactions/transactions-write.service.ts'), 'utf8');
  const IMPORT = readFileSync(path.join(__dirname, 'transaction-import.service.ts'), 'utf8');

  it('an edit made by the import skips the lawyer email and the status-changed notice', () => {
    const upd = WRITE.slice(WRITE.indexOf('  async update('));
    const lawyer = upd.indexOf('this.lawyerReminder.maybeRemind(txnId)');
    const status = upd.indexOf('this.reminders.statusChanged(txnId');
    expect(lawyer).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(-1);
    expect(upd.slice(Math.max(0, lawyer - 80), lawyer)).toMatch(/if \(!opts\.quiet\)/);
    expect(upd.slice(Math.max(0, status - 80), status)).toMatch(/!opts\.quiet/);
  });

  it('every save the import makes asks to be quiet', () => {
    const calls = IMPORT.match(/this\.write\.(store|update)\([^;]*\);/g) ?? [];
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c).toContain('{ quiet: true }');
  });
});
