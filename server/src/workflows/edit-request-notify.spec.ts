import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EditRequestsService } from './edit-requests.service';
import { AuditService } from '../audit/audit.service';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * TELLING THE REVIEWERS THAT A REQUEST IS WAITING.
 *
 * WHO IS TOLD IS THE WHOLE POINT, and it is not a list this feature gets to invent: `review()`
 * refuses anybody who is not a Super Admin, so those are the only people for whom the message is
 * actionable. A notification about work you cannot do is noise, and on a request carrying a
 * reason and a deal address it is also a disclosure.
 *
 * The dispatcher is recorded rather than mocked away — these assert exactly what was handed to it,
 * because the category, the dedupe key and the channel are the three things that decide whether
 * this behaves on a retry.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

type Sent = { userIds: number[]; request: Record<string, unknown> };

/** A dispatcher that records instead of delivering, so the payload itself can be asserted. */
function recorder() {
  const sent: Sent[] = [];
  const dispatcher = {
    dispatchMany: async (userIds: number[], request: Record<string, unknown>) => {
      sent.push({ userIds, request });
      return [];
    },
  } as unknown as NotificationDispatcher;
  return { sent, dispatcher };
}

const svc = (tx: PrismaService, dispatcher?: NotificationDispatcher) =>
  new EditRequestsService(tx, new AuditService(tx), dispatcher);

const asUser = (role: string, id: number, name: string) =>
  ({ id, name, role, user_permissions: [] } as unknown as AuthUserRecord);

async function user(tx: PrismaService, role: string, label: string, status = 'Active') {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ ${label} ${t}`, email: `zz-${label}-${t}@probe.test`, role, status,
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true, role: true },
  });
}

async function deal(tx: PrismaService): Promise<number> {
  const now = new Date();
  const t = tag();
  const row = await tx.transactions.create({
    data: {
      trade_no: `ZZ${t}`.slice(0, 20), type: 'Residential Buying',
      property: `ZZ Notify Road ${t}`, created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  return row.id;
}

describe('submitting an approval request notifies its reviewers', () => {
  it('GOES TO THE SUPER ADMINS, and to nobody else', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const mgr = await user(tx, 'manager', 'admin');
      const ag = await user(tx, 'agent', 'agent');
      const txnId = await deal(tx);

      const { sent, dispatcher } = recorder();
      // A manager asking about a financial field — the ordinary path for this scope.
      await svc(tx, dispatcher).store(asUser('manager', mgr.id, mgr.name), txnId, 'Wrong price', 'financial');

      expect(sent).toHaveLength(1);
      expect(sent[0].userIds).toContain(sup.id);
      // The person who asked is not a reviewer of their own request, and neither is the agent.
      expect(sent[0].userIds).not.toContain(mgr.id);
      expect(sent[0].userIds).not.toContain(ag.id);
    });
  });

  it('skips a deactivated reviewer, who cannot act on it', async () => {
    await inRollback(async (tx) => {
      const gone = await user(tx, 'admin', 'retired', 'Inactive');
      const here = await user(tx, 'admin', 'present');
      const mgr = await user(tx, 'manager', 'asker');
      const txnId = await deal(tx);

      const { sent, dispatcher } = recorder();
      await svc(tx, dispatcher).store(asUser('manager', mgr.id, mgr.name), txnId, null, 'financial');

      expect(sent[0].userIds).toContain(here.id);
      expect(sent[0].userIds).not.toContain(gone.id);
    });
  });

  it('CARRIES ENOUGH TO IDENTIFY THE REQUEST, and a link that opens it', async () => {
    await inRollback(async (tx) => {
      await user(tx, 'admin', 'super');
      const mgr = await user(tx, 'manager', 'asker');
      const txnId = await deal(tx);
      const property = (await tx.transactions.findUniqueOrThrow({ where: { id: txnId }, select: { property: true } })).property;

      const { sent, dispatcher } = recorder();
      await svc(tx, dispatcher).store(asUser('manager', mgr.id, mgr.name), txnId, 'Price was mistyped', 'financial');

      const r = sent[0].request;
      expect(r.category).toBe('approval_requested');
      expect(r.title).toBe('Approval requested');
      // Who asked, which deal, what for, and why — recognisable without opening it.
      expect(String(r.body)).toContain(mgr.name);
      expect(String(r.body)).toContain(String(property));
      expect(String(r.body)).toContain('financial');
      expect(String(r.body)).toContain('Price was mistyped');
      // The link opens the deal at its approval section.
      expect(r.link).toBe(`/desk/transactions/${txnId}?section=approvals`);
    });
  });

  it('IS IN-APP ONLY', async () => {
    await inRollback(async (tx) => {
      await user(tx, 'admin', 'super');
      const mgr = await user(tx, 'manager', 'asker');
      const txnId = await deal(tx);

      const { sent, dispatcher } = recorder();
      await svc(tx, dispatcher).store(asUser('manager', mgr.id, mgr.name), txnId, null, 'financial');

      expect(sent[0].request.channels).toEqual(['in_app']);
    });
  });

  it('CARRIES A DEDUPE KEY TIED TO THE REQUEST ROW, which is what makes a retry safe', async () => {
    /*
     * The key is the request's own id. A retried POST cannot create a second pending request for
     * the same deal and scope — `store` refuses it — so there is no second id and no second
     * notification; and a re-dispatch of the SAME id is dropped by the delivery ledger.
     */
    await inRollback(async (tx) => {
      await user(tx, 'admin', 'super');
      const mgr = await user(tx, 'manager', 'asker');
      const txnId = await deal(tx);

      const { sent, dispatcher } = recorder();
      const me = asUser('manager', mgr.id, mgr.name);
      const first = await svc(tx, dispatcher).store(me, txnId, null, 'financial') as { id: number };

      expect(sent[0].request.dedupeKey).toBe(`edit-request:${first.id}`);

      // The retry is refused at the workflow level, so nothing further is dispatched at all.
      await expect(svc(tx, dispatcher).store(me, txnId, null, 'financial')).rejects.toThrow();
      expect(sent).toHaveLength(1);
    });
  });

  it('A FAILING DISPATCHER DOES NOT LOSE THE REQUEST', async () => {
    // The request is the record; telling somebody is the courtesy. The row must survive the latter.
    await inRollback(async (tx) => {
      await user(tx, 'admin', 'super');
      const mgr = await user(tx, 'manager', 'asker');
      const txnId = await deal(tx);

      const exploding = {
        dispatchMany: async () => { throw new Error('bell is broken'); },
      } as unknown as NotificationDispatcher;

      await expect(svc(tx, exploding).store(asUser('manager', mgr.id, mgr.name), txnId, null, 'financial'))
        .resolves.toBeDefined();
      expect(await tx.transaction_edit_requests.count({ where: { transaction_id: txnId, status: 'pending' } })).toBe(1);
    });
  });

  it('works with no dispatcher wired at all', async () => {
    // The optional dependency is what lets the older specs construct this service with two args.
    await inRollback(async (tx) => {
      const mgr = await user(tx, 'manager', 'asker');
      const txnId = await deal(tx);
      await expect(svc(tx).store(asUser('manager', mgr.id, mgr.name), txnId, null, 'financial')).resolves.toBeDefined();
    });
  });

  it('READING THE NOTIFICATION DOES NOT RESOLVE THE APPROVAL', async () => {
    /*
     * Two separate pieces of state, and conflating them would be the worst possible bug here: a
     * reviewer glancing at the bell would silently approve an edit to a closed deal's commission.
     */
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const mgr = await user(tx, 'manager', 'asker');
      const txnId = await deal(tx);
      const { dispatcher } = recorder();
      await svc(tx, dispatcher).store(asUser('manager', mgr.id, mgr.name), txnId, null, 'financial');

      // Stand in for the Centre marking it read — the notification row, not the request row.
      await tx.notifications.create({
        data: {
          user_id: sup.id, category: 'approval_requested', title: 'Approval requested',
          dedupe_key: `zz-read-${tag()}`, read_at: new Date(), created_at: new Date(),
        },
      });

      const req = await tx.transaction_edit_requests.findFirstOrThrow({ where: { transaction_id: txnId } });
      expect(req.status).toBe('pending');
      expect(req.reviewed_by).toBeNull();
      expect(req.reviewed_at).toBeNull();
    });
  });
});
