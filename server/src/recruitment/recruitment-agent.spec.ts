import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentAgentService } from './recruitment-agent.service';

/**
 * TURNING A CANDIDATE INTO SOMEBODY WHO CAN SIGN IN — the one irreversible step in the module.
 *
 * THE RACE THIS FILE EXISTS FOR. Two administrators press the button at the same moment. Both read
 * a candidate whose `agent_user_id` is NULL, both find the email free, and both proceed — the read
 * told neither of them what the other was doing. A check in the service cannot settle that; only
 * the UNIQUE index can, and only because it is enforced at commit rather than at read.
 *
 * So the test runs them genuinely CONCURRENTLY, against the real database, in separate transactions.
 * Serialising them would prove nothing: the bug only exists when the reads overlap.
 *
 * These tests COMMIT. Everything they write is removed in `afterEach`, because a rolled-back
 * transaction cannot demonstrate a conflict between two transactions.
 */

const prisma = new PrismaClient();
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

const ADMIN: AuthUserRecord = { id: 1, name: 'ZZ Admin', role: 'admin' } as unknown as AuthUserRecord;
const RECRUITER: AuthUserRecord = { id: 2, name: 'ZZ Recruiter', role: 'recruiter' } as unknown as AuthUserRecord;

const passwords = { hashPassword: async (p: string) => `hashed:${p}` } as never;

/**
 * What the administrator typed. Long enough and odd enough to pass the shared policy — see
 * `password-policy.ts`, which refuses `Admin@123` and anything built on the brokerage's own name.
 *
 * EVERY CALL MUST CARRY ONE NOW. The service used to invent a password when none was given, which
 * made `{}` a valid request; it no longer is, and these tests say so by passing one everywhere.
 */
const PW = 'quiet-harbour-lantern-41';
const WITH_PW = { password: PW, password_confirmation: PW };
const service = new RecruitmentService(prisma as unknown as PrismaService);
const agents = new RecruitmentAgentService(prisma as unknown as PrismaService, passwords, service);

const made: { candidates: number[]; users: number[] } = { candidates: [], users: [] };

async function candidate(status = 'approved', over: Record<string, unknown> = {}) {
  const t = tag();
  const row = await prisma.recruitment_candidates.create({
    data: {
      name: `ZZ Candidate ${t}`,
      email: `zz-cand-${t}@probe.test`,
      status,
      created_at: new Date(),
      updated_at: new Date(),
      ...over,
    },
  });
  made.candidates.push(row.id);
  return row;
}

afterEach(async () => {
  // Children cascade from the candidate; the user must go after, because the FK is RESTRICT.
  if (made.candidates.length) {
    await prisma.recruitment_candidates.updateMany({ where: { id: { in: made.candidates } }, data: { agent_user_id: null } });
    await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made.candidates } } });
  }
  if (made.users.length) await prisma.users.deleteMany({ where: { id: { in: made.users } } });
  made.candidates = [];
  made.users = [];
});

afterAll(async () => { await prisma.$disconnect(); });

// ---------------------------------------------------------------- forcing an overlap

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
};

/** Run inside one conversion's transaction, just before the named write. */
type Pause = (tx: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }) => Promise<void>;
type Hooks = { beforeUserCreate?: Pause; beforeLink?: Pause };

/**
 * The real service over the real database, except that the transaction client it is handed pauses at
 * the named step. Hooks are given out in the order the conversions open their transactions. Nothing
 * else about the transaction changes — not its isolation, not its statements.
 */
function instrumentedAgents(hooksByCall: Hooks[]): RecruitmentAgentService {
  let calls = 0;
  const db = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
        const hooks = hooksByCall[calls++] ?? {};
        return target.$transaction(async (tx) => fn(new Proxy(tx, {
          get(t, p) {
            const v = Reflect.get(t, p);
            if (p === 'users' || p === 'recruitment_candidates') {
              return new Proxy(v as object, {
                get(m, k) {
                  const f = Reflect.get(m, k) as unknown;
                  const call = (...a: unknown[]) => (f as (...x: unknown[]) => unknown).apply(m, a);
                  if (p === 'users' && k === 'create') return async (...a: unknown[]) => { await hooks.beforeUserCreate?.(tx); return call(...a); };
                  if (p === 'recruitment_candidates' && k === 'update') return async (...a: unknown[]) => { await hooks.beforeLink?.(tx); return call(...a); };
                  return typeof f === 'function' ? (f as (...x: unknown[]) => unknown).bind(m) : f;
                },
              });
            }
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
          },
        })), opts as never);
      };
    },
  });
  const svc = db as unknown as PrismaService;
  return new RecruitmentAgentService(svc, passwords, new RecruitmentService(svc));
}

/**
 * True once some connection is waiting for the candidate row lock — seen from OUTSIDE, so the test
 * knows the second conversion really is blocked rather than merely started. Bounded, so a service
 * that takes no such lock fails the test instead of hanging it.
 */
async function seenWaitingForCandidateLock(): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%recruitment_candidates%' AND query ILIKE '%FOR UPDATE%'`,
    );
    if (rows[0].n > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/** One account for the address, the candidate linked to it and Active, one history event. */
async function expectOneAccountLinked(c: { id: number; email: string }) {
  const users = await prisma.users.findMany({ where: { email: { equals: c.email, mode: 'insensitive' } }, select: { id: true } });
  made.users.push(...users.map((u) => u.id));
  expect(users).toHaveLength(1);
  const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
  expect(after.agent_user_id).toBe(users[0].id);
  expect(after.status).toBe('active');
  expect(after.activated_at).not.toBeNull();
  expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id, action: 'agent_created' } })).toBe(1);
}

/** The losing candidate, exactly as it was: no link, still approved, no history of a conversion. */
async function expectUntouched(c: { id: number }) {
  const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
  expect(after.agent_user_id).toBeNull();
  expect(after.status).toBe('approved');
  expect(after.activated_at).toBeNull();
  expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id, action: 'agent_created' } })).toBe(0);
}

/**
 * Request 1 converts and stops at `step`, inside its transaction. Request 2 converts the same
 * candidate. Request 1 is released only once request 2 is seen waiting for the candidate lock — or
 * after two seconds if it never is, which then fails the test rather than hanging it.
 */
async function expectLoserWaitsAndIsToldTheTruth(step: keyof Hooks) {
  const c = await candidate();
  const paused = gate();
  const release = gate();
  const svc = instrumentedAgents([{ [step]: async () => { paused.open(); await release.promise; } }, {}]);

  const first = svc.createAgent(ADMIN, c.id, WITH_PW);
  await paused.promise;
  const second = svc.createAgent({ ...ADMIN, id: 3, name: 'ZZ Admin Two' } as AuthUserRecord, c.id, WITH_PW);
  let waited = false;
  try {
    waited = await seenWaitingForCandidateLock();
  } finally {
    release.open();
  }
  const [r1, r2] = await Promise.allSettled([first, second]);

  expect(waited).toBe(true);
  expect(r1.status).toBe('fulfilled');
  expect(r2.status).toBe('rejected');
  expect((r2 as PromiseRejectedResult).reason.response?.message).toBe('An Agent account already exists for this candidate.');
  await expectOneAccountLinked(c);
}

describe('creating the agent account', () => {
  it('creates one account, links it, and marks the candidate Active', async () => {
    const c = await candidate();

    const res = await agents.createAgent(ADMIN, c.id, WITH_PW) as {
      candidate: { agent_user_id: number | null; status: string; activated_at: Date | null };
      user: { id: number; email: string };
    };
    made.users.push(res.user.id);

    expect(res.candidate.agent_user_id).toBe(res.user.id);
    expect(res.candidate.status).toBe('active');
    expect(res.candidate.activated_at).not.toBeNull();
    expect(res.user.email).toBe(c.email);

    /*
     * THE RESPONSE CARRIES NO PASSWORD. It used to — the service generated one and returned it —
     * which put the plaintext of a working account into a response body, a browser's memory and
     * anything between. The administrator typed it, so the response is the one copy not needed.
     */
    expect(res).not.toHaveProperty('password');
    expect(JSON.stringify(res)).not.toContain(PW);

    // What IS stored is the hash of what the administrator typed, and nothing resembling it.
    const stored = await prisma.users.findUniqueOrThrow({ where: { id: res.user.id }, select: { password: true } });
    expect(stored.password).toBe(`hashed:${PW}`);
    expect(stored.password).not.toBe(PW);
  });

  describe('the password the administrator supplies', () => {
    /*
     * ALL FOUR REFUSALS HAPPEN BEFORE ANY ROW IS WRITTEN, which each case checks by counting users
     * for the address afterwards. A password refused after the account was made would be the worst
     * of both: an account exists, and nobody knows its password.
     */
    it('is required', async () => {
      const c = await candidate();
      await expect(agents.createAgent(ADMIN, c.id, {}))
        .rejects.toMatchObject({ response: { message: expect.stringContaining('Enter an initial password') } });
      expect(await prisma.users.count({ where: { email: c.email } })).toBe(0);
    });

    it('must be confirmed, and the confirmation must match exactly', async () => {
      const c = await candidate();
      for (const confirmation of ['', `${PW} `, PW.toUpperCase(), 'something else entirely']) {
        await expect(agents.createAgent(ADMIN, c.id, { password: PW, password_confirmation: confirmation }))
          .rejects.toMatchObject({ response: { message: 'The password confirmation does not match.' } });
      }
      expect(await prisma.users.count({ where: { email: c.email } })).toBe(0);
    });

    it('is held to the same policy as the Users screen', async () => {
      const c = await candidate();
      /*
       * `Admin@123` is the one a production audit found on a Super Admin account, and
       * `GetHomeRealty1` is what somebody picks when told to add a capital and a digit. Both are
       * refused here for the same reason they are refused there: it is the same function.
       */
      for (const weak of ['short', 'Admin@123', 'GetHomeRealty1', '123456789012', 'aaaaaaaaaaaaaa']) {
        await expect(agents.createAgent(ADMIN, c.id, { password: weak, password_confirmation: weak }))
          .rejects.toMatchObject({ response: { message: expect.stringMatching(/password/i) } });
      }
      expect(await prisma.users.count({ where: { email: c.email } })).toBe(0);
    });

    it('is refused past the 72 bytes bcrypt actually reads', async () => {
      const c = await candidate();
      const tooLong = `${PW}-${'x'.repeat(72)}`;
      await expect(agents.createAgent(ADMIN, c.id, { password: tooLong, password_confirmation: tooLong }))
        .rejects.toMatchObject({ response: { message: expect.stringContaining('72 bytes') } });
      expect(await prisma.users.count({ where: { email: c.email } })).toBe(0);
    });

    it('keeps a leading or trailing space, because that space is part of the password', async () => {
      /*
       * Trimming here and not at sign-in would lock somebody out of the account just made. So the
       * password is taken exactly as given — and the hash proves the spaces survived.
       */
      const c = await candidate();
      const spaced = ` ${PW} `;
      const res = await agents.createAgent(ADMIN, c.id, { password: spaced, password_confirmation: spaced }) as {
        user: { id: number };
      };
      made.users.push(res.user.id);
      const stored = await prisma.users.findUniqueOrThrow({ where: { id: res.user.id }, select: { password: true } });
      expect(stored.password).toBe(`hashed:${spaced}`);
    });
  });

  it('records it in the candidate’s history', async () => {
    const c = await candidate();
    const res = await agents.createAgent(ADMIN, c.id, WITH_PW) as { user: { id: number } };
    made.users.push(res.user.id);

    const events = await prisma.recruitment_events.findMany({ where: { candidate_id: c.id, action: 'agent_created' } });
    expect(events).toHaveLength(1);
    expect(events[0].actor_name).toBe('ZZ Admin');
  });

  it('TWO ADMINISTRATORS AT ONCE CREATE ONE ACCOUNT, NOT TWO', async () => {
    /*
     * The reason the UNIQUE index exists. Both calls start before either finishes, so both see a
     * candidate with no account — exactly the window a service-level check cannot close.
     */
    const c = await candidate();

    const results = await Promise.allSettled([
      agents.createAgent(ADMIN, c.id, WITH_PW),
      agents.createAgent({ ...ADMIN, id: 3, name: 'ZZ Admin Two' } as AuthUserRecord, c.id, WITH_PW),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const created = (won[0] as PromiseFulfilledResult<{ user: { id: number } }>).value;
    made.users.push(created.user.id);

    // The loser is told what is true, not shown a constraint name.
    const err = (lost[0] as PromiseRejectedResult).reason as { response?: { message?: string }; message?: string };
    const text = err.response?.message ?? err.message ?? '';
    expect(text).toContain('An Agent account already exists for this candidate.');
    expect(text).not.toMatch(/agent_user_id|P2002|constraint/i);

    // And exactly one account exists for that address.
    expect(await prisma.users.count({ where: { email: c.email } })).toBe(1);
  });

  /*
   * ================================================================================================
   * THE SAME RACE, WITH THE OVERLAP FORCED RATHER THAN HOPED FOR.
   *
   * The test above starts both calls together, but alone it almost always runs them one after the
   * other, so it saw the overlap only under full-gate load — and then failed, because the loser was
   * told "a user with that email address was created a moment ago", or even to "link or rename" the
   * account just made for this very candidate. These hold request 1 open at a chosen step, start
   * request 2, and release request 1 only once request 2 is SEEN waiting on the candidate lock, so
   * every run exercises the overlap.
   * ================================================================================================
   */
  describe('two conversions of one candidate, overlapping on purpose', () => {
    it('the second, arriving before the first has created the user, waits and is told the account exists', async () => {
      await expectLoserWaitsAndIsToldTheTruth('beforeUserCreate');
    });

    it('the second, arriving after the user is created but before the link, waits and is told the account exists', async () => {
      await expectLoserWaitsAndIsToldTheTruth('beforeLink');
    });

    it('runs at READ COMMITTED, which is what lets the waiting conversion see the committed link', async () => {
      /*
       * The lock serialises the two; it is READ COMMITTED that makes the second one's read, once the
       * lock is granted, return the row as the first committed it. Under REPEATABLE READ the same wait
       * would end in a serialization failure instead of the sentence above. This pins the assumption.
       */
      const c = await candidate();
      let level = '';
      const svc = instrumentedAgents([{
        beforeUserCreate: async (tx) => {
          const rows = await tx.$queryRawUnsafe(`SELECT current_setting('transaction_isolation') AS level`) as { level: string }[];
          level = rows[0].level;
        },
      }]);
      const res = await svc.createAgent(ADMIN, c.id, WITH_PW) as { user: { id: number } };
      made.users.push(res.user.id);
      expect(level).toBe('read committed');
    });
  });

  describe('two DIFFERENT candidates who share an address', () => {
    /*
     * The candidate lock must not reach this case: these are two rows, so nothing serialises them,
     * and the address is what clashes. The loser keeps the email-conflict answer, because here it is
     * true — somebody else took the address — and the losing candidate is left exactly as it was.
     */
    it('converted at the same moment: one account, and the other is told the address was just taken', async () => {
      const first = await candidate();
      const second = await candidate('approved', { email: first.email });

      // Both pass every check before either inserts, so the users.email index is what decides.
      const bothChecked = gate();
      let arrived = 0;
      const atInsert = async () => { arrived += 1; if (arrived === 2) bothChecked.open(); await bothChecked.promise; };
      const svc = instrumentedAgents([{ beforeUserCreate: atInsert }, { beforeUserCreate: atInsert }]);

      const results = await Promise.allSettled([
        svc.createAgent(ADMIN, first.id, WITH_PW),
        svc.createAgent({ ...ADMIN, id: 3, name: 'ZZ Admin Two' } as AuthUserRecord, second.id, WITH_PW),
      ]);
      const wonIndex = results.findIndex((r) => r.status === 'fulfilled');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason.response?.message)
        .toBe('A user with that email address was created a moment ago. Refresh and check before trying again.');

      const [winner, loser] = wonIndex === 0 ? [first, second] : [second, first];
      await expectOneAccountLinked(winner);
      await expectUntouched(loser);
    });

    it('converted one after the other: the second is told whose address it is', async () => {
      const first = await candidate();
      const second = await candidate('approved', { email: first.email });
      const res = await agents.createAgent(ADMIN, first.id, WITH_PW) as { user: { id: number } };
      made.users.push(res.user.id);

      await expect(agents.createAgent(ADMIN, second.id, WITH_PW))
        .rejects.toMatchObject({ response: { message: expect.stringContaining(`A user already exists with the address ${first.email}`) } });
      await expectOneAccountLinked(first);
      await expectUntouched(second);
    });
  });

  it('refuses a second attempt afterwards, in the same words', async () => {
    const c = await candidate();
    const res = await agents.createAgent(ADMIN, c.id, WITH_PW) as { user: { id: number } };
    made.users.push(res.user.id);

    await expect(agents.createAgent(ADMIN, c.id, WITH_PW))
      .rejects.toMatchObject({ response: { message: 'An Agent account already exists for this candidate.' } });
  });

  it('refuses a candidate the brokerage has not approved', async () => {
    for (const status of ['new', 'contacted', 'interview', 'hold', 'not_selected']) {
      const c = await candidate(status);
      await expect(agents.createAgent(ADMIN, c.id, WITH_PW))
        .rejects.toMatchObject({ response: { message: expect.stringContaining('has not been approved') } });
      expect(await prisma.users.count({ where: { email: c.email } })).toBe(0);
    }
  });

  it('accepts a candidate already in onboarding, which follows approval', async () => {
    const c = await candidate('onboarding');
    const res = await agents.createAgent(ADMIN, c.id, WITH_PW) as { user: { id: number } };
    made.users.push(res.user.id);
    expect(res.user.id).toBeGreaterThan(0);
  });

  it('refuses when the address already belongs to somebody, and says whose', async () => {
    /*
     * `users.email` is unique, so this would be refused anyway. The point of asking first is to
     * return a sentence an administrator can act on instead of a constraint they cannot.
     */
    const t = tag();
    const existing = await prisma.users.create({
      data: {
        name: `ZZ Existing ${t}`, email: `zz-taken-${t}@probe.test`, password: 'x',
        role: 'agent', status: 'Active', created_at: new Date(), updated_at: new Date(),
      },
    });
    made.users.push(existing.id);
    const c = await candidate('approved', { email: existing.email });

    await expect(agents.createAgent(ADMIN, c.id, WITH_PW))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('A user already exists') } });

    const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.agent_user_id).toBeNull();
    expect(after.status).toBe('approved');
  });

  it('a recruiter cannot create an account, however approved the candidate is', async () => {
    const c = await candidate('approved');
    await expect(agents.createAgent(RECRUITER, c.id, WITH_PW))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('Only an administrator') } });
    expect(await prisma.users.count({ where: { email: c.email } })).toBe(0);
  });

  it('leaves nothing behind when it refuses', async () => {
    /*
     * The transaction's job. A failure after the user row is written would otherwise leave an
     * account nobody can trace to an application.
     */
    const t = tag();
    const existing = await prisma.users.create({
      data: {
        name: `ZZ Blocker ${t}`, email: `zz-block-${t}@probe.test`, password: 'x',
        role: 'agent', status: 'Active', created_at: new Date(), updated_at: new Date(),
      },
    });
    made.users.push(existing.id);
    const c = await candidate('approved', { email: existing.email });

    const before = await prisma.users.count();
    await expect(agents.createAgent(ADMIN, c.id, WITH_PW)).rejects.toBeDefined();
    expect(await prisma.users.count()).toBe(before);
    expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id, action: 'agent_created' } })).toBe(0);
  });
});
