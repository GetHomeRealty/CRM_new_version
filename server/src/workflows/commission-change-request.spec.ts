import { UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EditRequestsService, COMMISSION_SCOPE, COMMISSION_PROPOSABLE } from './edit-requests.service';
import { AuditService } from '../audit/audit.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * A COMMISSION CHANGE REQUEST — proposing numbers, and an approval that applies them.
 *
 * The distinction this whole feature turns on: the old workflow APPROVES PERMISSION TO EDIT, and
 * this one APPROVES A CHANGE. So the tests that matter most are the ones about what moves and
 * when — nothing on submission, the proposed values on approval, nothing on rejection — and the
 * two ways that could go wrong quietly: a duplicate request, and a stale one applied over somebody
 * else's newer figures.
 *
 * The write service is recorded rather than executed. What belongs here is WHETHER the proposal is
 * handed to it and with what; that it then validates and recalculates correctly is its own
 * module's business and already its own tests.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

/**
 * A transaction client that also answers `$transaction`, by running the callback on itself.
 *
 * The service now wraps an approval in its own transaction, and a Prisma transaction client has
 * no `$transaction` of its own — so without this every test below dies on "not a function". Run
 * inline, which is what a nested transaction means here anyway.
 *
 * IT MAKES THESE TESTS USELESS FOR PROVING ROLLBACK, deliberately and explicitly: a throw inside
 * an inlined callback undoes nothing. Atomicity is proved separately, against a real transaction,
 * at the bottom of this file.
 */
const joinable = (tx: unknown): PrismaService => new Proxy(tx as Record<string, unknown>, {
  get(t, prop, r) {
    if (prop === '$transaction') return (fn: (c: unknown) => Promise<unknown>) => fn(t);
    return Reflect.get(t, prop, r);
  },
}) as unknown as PrismaService;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(joinable(tx)); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

type Applied = { user: AuthUserRecord; txnId: number; body: Record<string, unknown> };

/** Records what approval hands the write service, instead of writing. */
function writeRecorder() {
  const applied: Applied[] = [];
  const writes = {
    update: async (user: AuthUserRecord, txnId: number, body: Record<string, unknown>) => {
      applied.push({ user, txnId, body });
      return {};
    },
  } as unknown as TransactionsWriteService;
  return { applied, writes };
}

type Sent = { userId: number; request: Record<string, unknown> };
function dispatchRecorder() {
  const sent: Sent[] = [];
  const dispatcher = {
    dispatch: async (request: Record<string, unknown>) => { sent.push({ userId: request.userId as number, request }); return {}; },
    dispatchMany: async (ids: number[], request: Record<string, unknown>) => {
      for (const id of ids) sent.push({ userId: id, request });
      return [];
    },
  } as unknown as NotificationDispatcher;
  return { sent, dispatcher };
}

const svc = (
  tx: PrismaService,
  opts: { writes?: TransactionsWriteService; dispatcher?: NotificationDispatcher } = {},
) => new EditRequestsService(tx, new AuditService(tx), opts.dispatcher, opts.writes);

const asUser = (role: string, id: number, name: string) =>
  ({ id, name, role, user_permissions: [] } as unknown as AuthUserRecord);

async function user(tx: PrismaService, role: string, label: string) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ ${label} ${t}`, email: `zz-${label}-${t}@probe.test`, role, status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true },
  });
}

/** A deal with a commission and a two-agent split, so there is something to propose against. */
async function deal(tx: PrismaService): Promise<number> {
  const now = new Date();
  const t = tag();
  const row = await tx.transactions.create({
    data: {
      trade_no: `ZZ${t}`.slice(0, 20), type: 'Residential Buying', property: `ZZ Commission Road ${t}`,
      price: 500000, comm_pct: 2.5, comm_amt: 12500, created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  await tx.team_members.createMany({
    data: [
      { transaction_id: row.id, name: 'ZZ Agent One', split: 60, agent_pct: 80, brok_pct: 20, created_at: now, updated_at: now },
      { transaction_id: row.id, name: 'ZZ Agent Two', split: 40, agent_pct: 70, brok_pct: 30, created_at: now, updated_at: now },
    ],
  });
  return row.id;
}

/** The snapshot a mutation test compares against — everything a commission change could touch. */
const snapshot = async (tx: PrismaService, id: number) => ({
  txn: await tx.transactions.findUniqueOrThrow({
    where: { id },
    select: { comm_pct: true, comm_amt: true, price: true, comm_status: true, valid_status: true },
  }),
  team: await tx.team_members.findMany({
    where: { transaction_id: id }, orderBy: { id: 'asc' },
    select: { name: true, split: true, agent_pct: true, brok_pct: true },
  }),
  invoices: await tx.invoices.count({ where: { transaction_id: id } }),
});

describe('submitting a commission change request', () => {
  it('CHANGES NOTHING — not the deal, not the totals, not the invoices', async () => {
    /*
     * The headline promise. A proposal is a piece of paper, not an edit: until somebody approves
     * it the deal must read exactly as it did.
     */
    await inRollback(async (tx) => {
      await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const before = await snapshot(tx, id);

      const { applied, writes } = writeRecorder();
      await svc(tx, { writes }).store(
        asUser('documentation', doc.id, doc.name), id, 'The split was agreed at 3%',
        COMMISSION_SCOPE, { comm_pct: 3, comm_amt: 15000 },
      );

      expect(await snapshot(tx, id)).toEqual(before);
      // And nothing was handed to the write service, which is the only thing that could change it.
      expect(applied).toHaveLength(0);
      expect(await tx.transaction_edit_requests.count({ where: { transaction_id: id, status: 'pending' } })).toBe(1);
    });
  });

  it('RECORDS BOTH THE PROPOSAL AND WHAT IT WAS PROPOSED FROM', async () => {
    await inRollback(async (tx) => {
      await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);

      await svc(tx).store(asUser('documentation', doc.id, doc.name), id, 'Agreed at 3%', COMMISSION_SCOPE, { comm_pct: 3 });

      const req = await tx.transaction_edit_requests.findFirstOrThrow({ where: { transaction_id: id } });
      expect(req.scope).toBe(COMMISSION_SCOPE);
      expect(req.proposed).toEqual({ comm_pct: 3 });
      // The baseline is the live value at the time, so the reviewer sees the comparison that was made.
      expect(req.baseline).toEqual({ comm_pct: 2.5 });
      expect(req.requested_by_name).toBe(doc.name);
      expect(req.reason).toBe('Agreed at 3%');
    });
  });

  it('refuses an empty proposal, an unproposable field, and a missing reason', async () => {
    await inRollback(async (tx) => {
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const me = asUser('documentation', doc.id, doc.name);

      // Nothing proposed — a reviewer would be asked to approve no change.
      await expect(svc(tx).store(me, id, 'why', COMMISSION_SCOPE, {})).rejects.toBeInstanceOf(UnprocessableEntityException);

      // Not a commission field. Price in particular has its own gate and is not this workflow's.
      await expect(svc(tx).store(me, id, 'why', COMMISSION_SCOPE, { price: 1 })).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(svc(tx).store(me, id, 'why', COMMISSION_SCOPE, { valid_status: 'Valid' })).rejects.toBeInstanceOf(UnprocessableEntityException);

      // A reason is the reviewer's only context for a number.
      await expect(svc(tx).store(me, id, '   ', COMMISSION_SCOPE, { comm_pct: 3 })).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(await tx.transaction_edit_requests.count({ where: { transaction_id: id } })).toBe(0);
    });
  });

  it('PREVENTS A DUPLICATE: one open commission proposal per deal', async () => {
    await inRollback(async (tx) => {
      await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const me = asUser('documentation', doc.id, doc.name);

      await svc(tx).store(me, id, 'first', COMMISSION_SCOPE, { comm_pct: 3 });
      await expect(svc(tx).store(me, id, 'again', COMMISSION_SCOPE, { comm_pct: 4 }))
        .rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(await tx.transaction_edit_requests.count({ where: { transaction_id: id, status: 'pending' } })).toBe(1);
      // The scope is what separates them, so an ordinary unlock request is still possible beside it.
      await expect(svc(tx).store(me, id, 'unrelated', 'financial', null)).resolves.toBeDefined();
    });
  });

  it('a Super Admin is told to change it directly rather than queue a request to themselves', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const id = await deal(tx);
      await expect(svc(tx).store(asUser('admin', sup.id, sup.name), id, 'why', COMMISSION_SCOPE, { comm_pct: 3 }))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('the proposable fields are commission only — never price or deposit', () => {
    for (const k of ['comm_pct', 'comm_amt', 'precon_comm_pct', 'precon_comm_amt_manual', 'precon_comm_bonus', 'precon_terms', 'team']) {
      expect(COMMISSION_PROPOSABLE.has(k)).toBe(true);
    }
    for (const k of ['price', 'deposit', 'valid_status', 'comm_status', 'statuses', 'clients']) {
      expect(COMMISSION_PROPOSABLE.has(k)).toBe(false);
    }
  });
});

describe('deciding a commission change request', () => {
  it('APPROVAL APPLIES THE PROPOSAL through the write service, as the reviewer', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });

      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'Agreed at 3%', COMMISSION_SCOPE,
        { comm_pct: 3, comm_amt: 15000 }) as { id: number };
      await s.approve(asUser('admin', sup.id, sup.name), req.id);

      // Handed to the one service that validates and recalculates — not written around it.
      expect(applied).toHaveLength(1);
      expect(applied[0].txnId).toBe(id);
      // `toMatchObject`, because the body also carries the version token the write is locked to.
      expect(applied[0].body).toMatchObject({ comm_pct: 3, comm_amt: 15000 });
      expect(applied[0].body.version).toEqual(expect.any(Number));
      // As the approver, whose authority the change rests on.
      expect(applied[0].user.id).toBe(sup.id);

      const after = await tx.transaction_edit_requests.findUniqueOrThrow({ where: { id: req.id } });
      expect(after.status).toBe('approved');
      expect(after.reviewed_by).toBe(sup.id);
    });
  });

  it('REJECTION APPLIES NOTHING and leaves the values as they are', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const before = await snapshot(tx, id);
      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });

      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'Agreed at 3%', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };
      await s.reject(asUser('admin', sup.id, sup.name), req.id);

      expect(applied).toHaveLength(0);
      expect(await snapshot(tx, id)).toEqual(before);
      expect((await tx.transaction_edit_requests.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('rejected');
    });
  });

  it('A STALE REQUEST IS REFUSED rather than reverting a newer change', async () => {
    /*
     * The case that would be worst in silence. Somebody raises a proposal from 2.5%; before it is
     * reviewed, a Super Admin sets it to 2.75% for another reason. Approving the old proposal
     * would quietly undo that. It is refused, the request stays pending, and nothing is written.
     */
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });

      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'Agreed at 3%', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };

      // Somebody else moves it in the meantime.
      await tx.transactions.update({ where: { id }, data: { comm_pct: 2.75 } });

      await expect(s.approve(asUser('admin', sup.id, sup.name), req.id)).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(applied).toHaveLength(0);
      /*
       * `inRollback` inlines the service's transaction, so the claim is not undone here — the
       * status reads 'approving' rather than 'pending'. What this test proves is that the change
       * was NOT applied and the request was NOT decided; that a real transaction puts the status
       * back is proved against one, in "a failed approval rolls the whole thing back" below.
       */
      const after = await tx.transaction_edit_requests.findUniqueOrThrow({ where: { id: req.id } });
      expect(after.status).not.toBe('approved');
      expect(after.reviewed_by).toBeNull();
      // And the newer figure survived.
      expect(Number((await tx.transactions.findUniqueOrThrow({ where: { id }, select: { comm_pct: true } })).comm_pct)).toBe(2.75);
    });
  });

  it('a change to a DIFFERENT field does not make a proposal stale', async () => {
    // The staleness check is about the keys being proposed, not about the deal in general — or
    // every edit anywhere would invalidate every pending request.
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });

      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };
      await tx.transactions.update({ where: { id }, data: { property: 'ZZ Renamed Road' } });

      await expect(s.approve(asUser('admin', sup.id, sup.name), req.id)).resolves.toBeDefined();
      expect(applied).toHaveLength(1);
    });
  });

  it('an ordinary unlock request still only unlocks — it applies nothing', async () => {
    // The pre-existing workflow is untouched: no proposal, so nothing is handed to the writer.
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const mgr = await user(tx, 'manager', 'asker');
      const id = await deal(tx);
      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });

      const req = await s.store(asUser('manager', mgr.id, mgr.name), id, 'need to fix', 'financial', null) as { id: number };
      await s.approve(asUser('admin', sup.id, sup.name), req.id);

      expect(applied).toHaveLength(0);
      expect((await tx.transaction_edit_requests.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('approved');
    });
  });
});

describe('who hears about it', () => {
  it('the reviewers on submission, and THE REQUESTER on the decision', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const { sent, dispatcher } = dispatchRecorder();
      const { writes } = writeRecorder();
      const s = svc(tx, { writes, dispatcher });

      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'Agreed at 3%', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };

      // Submission: the existing approval-request notification, to the Super Admins.
      expect(sent.filter((x) => x.request.category === 'approval_requested').map((x) => x.userId)).toContain(sup.id);

      sent.length = 0;
      await s.approve(asUser('admin', sup.id, sup.name), req.id);

      // Decision: the existing OUTCOME notification, to whoever asked — and to nobody else.
      const outcome = sent.filter((x) => x.request.category === 'transaction_approvals');
      expect(outcome).toHaveLength(1);
      expect(outcome[0].userId).toBe(doc.id);
      expect(String(outcome[0].request.title)).toMatch(/approved/i);
      expect(outcome[0].request.dedupeKey).toBe(`edit-request-decision:${req.id}:approved`);
    });
  });

  it('a rejection tells the requester the values are unchanged', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const { sent, dispatcher } = dispatchRecorder();
      const s = svc(tx, { dispatcher });

      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };
      sent.length = 0;
      await s.reject(asUser('admin', sup.id, sup.name), req.id);

      const outcome = sent.filter((x) => x.request.category === 'transaction_approvals');
      expect(outcome).toHaveLength(1);
      expect(outcome[0].userId).toBe(doc.id);
      expect(String(outcome[0].request.title)).toMatch(/rejected/i);
      expect(String(outcome[0].request.body)).toMatch(/unchanged/i);
    });
  });

  it('a stale refusal tells nobody it was decided, because it was not', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'coordinator');
      const id = await deal(tx);
      const { sent, dispatcher } = dispatchRecorder();
      const { writes } = writeRecorder();
      const s = svc(tx, { writes, dispatcher });

      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };
      await tx.transactions.update({ where: { id }, data: { comm_pct: 2.75 } });
      sent.length = 0;

      await expect(s.approve(asUser('admin', sup.id, sup.name), req.id)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(sent.filter((x) => x.request.category === 'transaction_approvals')).toHaveLength(0);
    });
  });
});

describe('a proposal may carry commission and nothing else', () => {
  const nested = async (tx: PrismaService, team?: unknown[], terms?: unknown[]) => {
    const doc = await user(tx, 'documentation', 'nested');
    const id = await deal(tx);
    const body: Record<string, unknown> = {};
    if (team) body.team = team;
    if (terms) body.precon_terms = terms;
    return svc(tx).store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE, body);
  };

  it('REFUSES AN AGENT ACCESS LEVEL SMUGGLED INSIDE team', async () => {
    /*
     * The disclosure this guard exists for. `scope` and `access` decide what an agent can SEE of
     * a deal; a reviewer shown "85% instead of 80%" is not agreeing to hand somebody the file.
     */
    await inRollback(async (tx) => {
      await expect(nested(tx, [{ name: 'ZZ Agent One', agent_pct: 85, scope: 'Entire' }]))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(nested(tx, [{ name: 'ZZ Agent One', agent_pct: 85, access: 'full' }]))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('refuses payment, invoice and identity metadata inside team', async () => {
    await inRollback(async (tx) => {
      for (const row of [
        { name: 'ZZ Agent One', agent_pct: 85, id: 1 },
        { name: 'ZZ Agent One', agent_pct: 85, paid_status: 'Paid' },
        { name: 'ZZ Agent One', agent_pct: 85, batch_no: 'B-1' },
        { name: 'ZZ Agent One', agent_pct: 85, invoice_no: 'INV-1' },
        { name: 'ZZ Agent One', agent_pct: 85, position: 0 },
      ]) {
        await expect(nested(tx, [row])).rejects.toBeInstanceOf(UnprocessableEntityException);
      }
    });
  });

  it('refuses anything but the term and its commission inside precon_terms', async () => {
    await inRollback(async (tx) => {
      await expect(nested(tx, undefined, [{ term_no: 1, pct: 3, closing_date: '2026-12-01' }]))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(nested(tx, undefined, [{ term_no: 1, pct: 3, id: 9 }]))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('accepts the commission keys, and refuses a shape that is not a list of objects', async () => {
    await inRollback(async (tx) => {
      await expect(nested(tx, [{ name: 'ZZ Agent One', agent_pct: 85, brok_pct: 15, split: 60 }])).resolves.toBeDefined();
      await expect(nested(tx, undefined, [{ term_no: 1, pct: 3, amt: 1000 }])).resolves.toBeDefined();
      await expect(nested(tx, 'not-a-list' as unknown as unknown[])).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(nested(tx, [42 as unknown as object])).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('APPLYING A TEAM PROPOSAL CHANGES ONLY THE COMMISSION, never access or scope', async () => {
    /*
     * Writing `team` REPLACES the rows, so a proposal carrying two keys would wipe the rest. The
     * service merges onto what is live instead — proved here by what reaches the write service.
     */
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'merge');
      const id = await deal(tx);
      await tx.team_members.updateMany({
        where: { transaction_id: id, name: 'ZZ Agent One' },
        data: { scope: 'Term 1', access: 'full' },
      });

      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });
      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE,
        { team: [{ name: 'ZZ Agent One', agent_pct: 85 }] }) as { id: number };
      await s.approve(asUser('admin', sup.id, sup.name), req.id);

      const team = (applied[0].body.team ?? []) as Record<string, unknown>[];
      // Both members travel, not just the one proposed — a partial list would delete the other.
      expect(team).toHaveLength(2);
      const one = team.find((m) => m.name === 'ZZ Agent One')!;
      const two = team.find((m) => m.name === 'ZZ Agent Two')!;
      expect(one.agent_pct).toBe(85);
      // Everything else on that row survives untouched.
      expect(one.scope).toBe('Term 1');
      expect(one.access).toBe('full');
      expect(one.brok_pct).toBe(20);
      expect(one.split).toBe(60);
      // And the member nobody proposed anything about is unchanged.
      expect(two).toMatchObject({ agent_pct: 70, brok_pct: 30, split: 40 });
    });
  });
});

describe('approval is all-or-nothing', () => {
  it('TWO SIMULTANEOUS APPROVALS: exactly one applies', async () => {
    /*
     * Both reviewers read a pending request and both press Approve. Without the claim both would
     * pass the baseline check and both would write — the second applying a proposal to figures
     * the first had already moved.
     */
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'race');
      const id = await deal(tx);
      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });
      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };

      const me = asUser('admin', sup.id, sup.name);
      const results = await Promise.allSettled([s.approve(me, req.id), s.approve(me, req.id)]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      // The write happened once, which is the thing that would otherwise cost money twice.
      expect(applied).toHaveLength(1);
      expect((await tx.transaction_edit_requests.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('approved');
    });
  });

  it('A FAILED WRITE LEAVES THE REQUEST PENDING, not stuck mid-decision', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'failed');
      const id = await deal(tx);
      const exploding = {
        update: async () => { throw new Error('the write was refused'); },
      } as unknown as TransactionsWriteService;
      const s = svc(tx, { writes: exploding });

      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };
      await expect(s.approve(asUser('admin', sup.id, sup.name), req.id)).rejects.toThrow('the write was refused');

      // Not decided, and nothing applied. See the note above about what this harness can show.
      const after = await tx.transaction_edit_requests.findUniqueOrThrow({ where: { id: req.id } });
      expect(after.status).not.toBe('approved');
      expect(after.reviewed_by).toBeNull();
      expect(after.reviewed_at).toBeNull();
      // And the deal is as it was.
      expect(Number((await tx.transactions.findUniqueOrThrow({ where: { id }, select: { comm_pct: true } })).comm_pct)).toBe(2.5);
    });
  });

  it('a stale proposal releases the claim too', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'stale2');
      const id = await deal(tx);
      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });
      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };

      await tx.transactions.update({ where: { id }, data: { comm_pct: 2.75 } });
      await expect(s.approve(asUser('admin', sup.id, sup.name), req.id)).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(applied).toHaveLength(0);
      expect((await tx.transaction_edit_requests.findUniqueOrThrow({ where: { id: req.id } })).status).not.toBe('approved');
    });
  });

  it('THE WRITE CARRIES THE VERSION TOKEN, which closes the check-to-write window', async () => {
    /*
     * The baseline check and the write are two separate reads. The version the deal had at check
     * time travels with the write, so a commission change landing in between is refused by the
     * write service's own optimistic lock rather than silently overwritten.
     */
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'version');
      const id = await deal(tx);
      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });
      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };
      await s.approve(asUser('admin', sup.id, sup.name), req.id);

      const live = await tx.transactions.findUniqueOrThrow({ where: { id }, select: { version: true } });
      expect(applied[0].body.version).toBe(live.version);
    });
  });

  it('a decided request cannot be approved a second time', async () => {
    await inRollback(async (tx) => {
      const sup = await user(tx, 'admin', 'super');
      const doc = await user(tx, 'documentation', 'twice');
      const id = await deal(tx);
      const { applied, writes } = writeRecorder();
      const s = svc(tx, { writes });
      const me = asUser('admin', sup.id, sup.name);
      const req = await s.store(asUser('documentation', doc.id, doc.name), id, 'why', COMMISSION_SCOPE,
        { comm_pct: 3 }) as { id: number };

      await s.approve(me, req.id);
      await expect(s.approve(me, req.id)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(applied).toHaveLength(1);
    });
  });
});

/* ===================================================================================================
 * THE ROLLBACK, PROVED AGAINST A REAL TRANSACTION.
 *
 * Every test above runs inside `inRollback`, whose client makes `$transaction` join inline — which
 * is right for asserting behaviour and useless for asserting ATOMICITY: a throw inside an inlined
 * callback rolls nothing back, so a broken implementation would pass.
 *
 * So this one commits for real and cleans up after itself. It forces the LAST write of the
 * approval — marking the request approved — to fail, at the point where the commission has
 * already been applied inside the same transaction, and then checks the database from outside:
 * the commission must be as it was, and the request must still be pending.
 * =================================================================================================== */

/**
 * A client that fails exactly one statement: the final `transaction_edit_requests.update`.
 *
 * `update` and not `updateMany`, which is what distinguishes the two writes — the claim uses
 * `updateMany`, so it still succeeds and the failure lands AFTER the commission write, which is
 * the ordering the test needs.
 */
function failFinalStatusWrite(real: PrismaClient): PrismaService {
  const poison = (tx: unknown): unknown => new Proxy(tx as Record<string, unknown>, {
    get(t, prop, r) {
      if (prop !== 'transaction_edit_requests') return Reflect.get(t, prop, r);
      const model = Reflect.get(t, prop, r) as Record<string, unknown>;
      return new Proxy(model, {
        get(m, p, r2) {
          if (p === 'update') return async () => { throw new Error('the status write failed'); };
          return Reflect.get(m, p, r2);
        },
      });
    },
  });
  return new Proxy(real as unknown as Record<string, unknown>, {
    get(t, prop, r) {
      if (prop !== '$transaction') return Reflect.get(t, prop, r);
      return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
        (real.$transaction as unknown as (f: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown>)(
          (tx) => fn(poison(tx)), opts,
        );
    },
  }) as unknown as PrismaService;
}

describe('a failed approval rolls the whole thing back', () => {
  it('THE COMMISSION AND THE REQUEST BOTH SURVIVE A FAILURE AFTER THE FINANCIAL WRITE', async () => {
    const now = new Date();
    const t = tag();
    const made: { txnId?: number; userIds: number[] } = { userIds: [] };
    try {
      const sup = await prisma.users.create({
        data: { name: `ZZ RB Super ${t}`, email: `zz-rb-sup-${t}@probe.test`, role: 'admin', status: 'Active', password: 'x', created_at: now, updated_at: now },
        select: { id: true, name: true },
      });
      const doc = await prisma.users.create({
        data: { name: `ZZ RB Doc ${t}`, email: `zz-rb-doc-${t}@probe.test`, role: 'documentation', status: 'Active', password: 'x', created_at: now, updated_at: now },
        select: { id: true, name: true },
      });
      made.userIds.push(sup.id, doc.id);

      const txn = await prisma.transactions.create({
        data: {
          trade_no: `ZZRB${t}`.slice(0, 20), type: 'Residential Buying', property: `ZZ Rollback Road ${t}`,
          price: 500000, comm_pct: 2.5, comm_amt: 12500, created_at: now, updated_at: now,
        },
        select: { id: true },
      });
      made.txnId = txn.id;

      const p = prisma as unknown as PrismaService;

      /*
       * A WRITE SERVICE THAT GENUINELY WRITES, through the client it is handed.
       *
       * The recorder used everywhere else would make this test vacuous: nothing would ever change
       * the commission, so finding it unchanged afterwards would prove nothing at all. This stub
       * performs a real update on `opts.tx`, so the figure actually moves inside the approval's
       * transaction — and is only still 2.5 at the end if that transaction was rolled back.
       *
       * It also asserts the client arrived: an implementation that called the write service
       * WITHOUT a transaction would fail here rather than quietly leaving the write committed.
       */
      let sawTx = false;
      const realWrites = {
        update: async (_u: unknown, id: number, bodyIn: Record<string, unknown>, o?: { tx?: { transactions: { update: (a: unknown) => Promise<unknown> } } }) => {
          if (!o?.tx) throw new Error('the approval did not pass its transaction to the write service');
          sawTx = true;
          await o.tx.transactions.update({ where: { id }, data: { comm_pct: Number(bodyIn.comm_pct) } });
          return {};
        },
      } as unknown as TransactionsWriteService;

      const req = await new EditRequestsService(p, new AuditService(p), undefined, realWrites)
        .store(asUser('documentation', doc.id, doc.name), txn.id, 'why', COMMISSION_SCOPE, { comm_pct: 3 }) as { id: number };

      // A poisoned client, so the status write that FOLLOWS the financial one throws.
      const broken = failFinalStatusWrite(prisma);
      const s = new EditRequestsService(broken, new AuditService(broken), undefined, realWrites);
      await expect(s.approve(asUser('admin', sup.id, sup.name), req.id)).rejects.toThrow('the status write failed');

      // The commission write genuinely happened, inside the transaction, before the failure.
      // Without this the test would pass on an implementation that never got that far.
      expect(sawTx).toBe(true);

      // Read from outside the rolled-back transaction.
      const after = await prisma.transactions.findUniqueOrThrow({ where: { id: txn.id }, select: { comm_pct: true, comm_amt: true } });
      expect(Number(after.comm_pct)).toBe(2.5);
      expect(Number(after.comm_amt)).toBe(12500);

      const reqAfter = await prisma.transaction_edit_requests.findUniqueOrThrow({ where: { id: req.id } });
      // Pending, not 'approved' and — the part that matters — not left committed as 'approving'.
      expect(reqAfter.status).toBe('pending');
      expect(reqAfter.status).not.toBe('approving');
      expect(reqAfter.reviewed_by).toBeNull();
      expect(reqAfter.reviewed_at).toBeNull();

      /*
       * No audit entry for a DECISION that did not happen. The request's own "Edit requested"
       * entry is expected and stays — it was written when the request was raised, outside this
       * transaction, and describes something that did occur.
       */
      const decisions = await prisma.audit_logs.count({
        where: { transaction_id: txn.id, field: 'Edit Request', action: { in: ['Edit approved', 'Edit rejected'] } },
      });
      expect(decisions).toBe(0);
    } finally {
      if (made.txnId) {
        await prisma.audit_logs.deleteMany({ where: { transaction_id: made.txnId } }).catch(() => undefined);
        await prisma.transaction_edit_requests.deleteMany({ where: { transaction_id: made.txnId } }).catch(() => undefined);
        await prisma.transactions.delete({ where: { id: made.txnId } }).catch(() => undefined);
      }
      if (made.userIds.length) await prisma.users.deleteMany({ where: { id: { in: made.userIds } } }).catch(() => undefined);
    }
  });
});
