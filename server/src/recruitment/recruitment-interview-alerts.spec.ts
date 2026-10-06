import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { PermissionService } from '../auth/permission.service';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentInterviewNotifyService } from './recruitment-interview-notify.service';
import { RecruitmentInterviewReminderService } from './recruitment-interview-reminder.service';

/**
 * INTERVIEW ALERTS AND REMINDERS: who hears about an interview, and when.
 *
 * The dispatcher is a RECORDING STUB rather than the real one. What is under test is the decision —
 * who is told, what the message says, which occurrence a dedupe key names — and routing that
 * through real delivery would turn a test about recipients into a test about mail servers. The
 * dispatcher's own suite covers delivery and the uniqueness of the ledger; this covers the choice.
 *
 * It runs against the real database because the decisions read real rows: a user's role, a
 * candidate's recruiter, an interview's scheduled time. A mocked Prisma would let this file agree
 * with itself about a schema the database does not have.
 */

const prisma = new PrismaClient();

type Dispatched = {
  category: string; userId: number; title: string; body?: string; link?: string; dedupeKey?: string;
};

/** Records what it was asked to deliver, and claims every channel was delivered. */
function stubDispatcher() {
  const sent: Dispatched[] = [];
  return {
    sent,
    dispatch: async (r: Dispatched) => {
      sent.push(r);
      return { category: r.category, userId: r.userId, delivered: ['in_app'], skipped: [], failed: [] };
    },
  };
}

/**
 * A dispatcher that enforces the dedupe key the way the real one does.
 *
 * The production guarantee is a UNIQUE INDEX on the delivery ledger — a second claim of the same
 * (person, category, key) is refused and reported as delivering nothing. `stubDispatcher` above
 * records everything it is asked, which is right for testing WHAT is asked; it is the wrong stub
 * for asking whether two overlapping sweeps would actually notify somebody twice. This one answers
 * that, and deliberately does so with an `await` inside the claim so the two passes genuinely
 * interleave rather than running one after the other.
 */
function dedupingDispatcher() {
  const claimed = new Set<string>();
  const sent: Dispatched[] = [];
  return {
    sent,
    claimed,
    dispatch: async (r: Dispatched) => {
      const key = `${r.userId}:${r.category}:${r.dedupeKey ?? Math.random()}`;
      // Yield before checking, so an overlapping caller is genuinely in flight at the same moment.
      await Promise.resolve();
      if (claimed.has(key)) {
        return { category: r.category, userId: r.userId, delivered: [], skipped: [{ channel: 'in_app', reason: 'duplicate' }], failed: [] };
      }
      claimed.add(key);
      sent.push(r);
      return { category: r.category, userId: r.userId, delivered: ['in_app'], skipped: [], failed: [] };
    },
  };
}

const permissions = new PermissionService();

let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const made: { candidates: number[]; users: number[] } = { candidates: [], users: [] };

async function user(role: string, name: string): Promise<number> {
  const t = tag();
  const row = await prisma.users.create({
    data: {
      name: `${name} ${t}`, email: `zz-alert-${t}@probe.test`, role, status: 'Active',
      password: 'x', created_at: new Date(), updated_at: new Date(),
    },
  });
  made.users.push(row.id);
  return row.id;
}

async function candidate(recruiterId: number | null) {
  const t = tag();
  const row = await prisma.recruitment_candidates.create({
    data: {
      name: `ZZ Alert ${t}`, email: `zz-alert-cand-${t}@probe.test`, status: 'contacted',
      assigned_recruiter_id: recruiterId, created_at: new Date(), updated_at: new Date(),
    },
  });
  made.candidates.push(row.id);
  return row;
}

const ADMIN: AuthUserRecord = { id: 1, name: 'ZZ Admin', role: 'admin' } as unknown as AuthUserRecord;

afterEach(async () => {
  if (made.candidates.length) {
    await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made.candidates } } });
  }
  if (made.users.length) await prisma.users.deleteMany({ where: { id: { in: made.users } } });
  made.candidates = [];
  made.users = [];
});

afterAll(async () => { await prisma.$disconnect(); });

const DAY = 86_400_000;

describe('who is told about an interview', () => {
  it('tells the assigned recruiter and the interviewer, and not the person who did it', async () => {
    const stub = stubDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const service = new RecruitmentService(prisma as unknown as PrismaService, notify);

    const recruiter = await user('recruiter', 'ZZ Recruiter');
    const interviewer = await user('manager', 'ZZ Interviewer');
    const c = await candidate(recruiter);

    const actor: AuthUserRecord = { id: recruiter, name: 'ZZ Recruiter', role: 'recruiter' } as unknown as AuthUserRecord;
    await service.scheduleInterview(actor, c.id, {
      scheduled_at: new Date(Date.now() + 2 * DAY).toISOString(),
      interviewer_id: interviewer,
    });

    /*
     * The recruiter BOOKED it, so they are not told about it; the interviewer is. A notification
     * about your own action is noise, and noise is what teaches people to ignore the channel.
     */
    expect(stub.sent.map((s) => s.userId)).toEqual([interviewer]);
    expect(stub.sent[0].category).toBe('recruitment_interview');
    expect(stub.sent[0].title).toContain('Interview booked');
    expect(stub.sent[0].link).toBe(`/crm/recruitment/${c.id}?focus=interviews`);
  });

  it('names the candidate, the date, the time and the zone', async () => {
    const stub = stubDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const service = new RecruitmentService(prisma as unknown as PrismaService, notify);

    const recruiter = await user('recruiter', 'ZZ Recruiter');
    const c = await candidate(recruiter);
    await service.scheduleInterview(ADMIN, c.id, { scheduled_at: new Date(Date.now() + 2 * DAY).toISOString() });

    const body = stub.sent[0].body ?? '';
    expect(stub.sent[0].title).toContain(c.name);
    // A time without a zone is a guess for anybody reading it in another province.
    expect(body).toMatch(/\b(EST|EDT|GMT|UTC)\b/);
    expect(body).toMatch(/\d{1,2}:\d{2}/);
    expect(body).toMatch(/20\d\d/);
  });

  it('does not tell an interviewer who could not open the screen', async () => {
    /*
     * An agent can be named on the panel informally, and `RecruitmentNoAgentsGuard` refuses them
     * the screen whatever the matrix says. Notifying them would name a candidate, offer a link and
     * then shut the door — worse than silence.
     */
    const stub = stubDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const service = new RecruitmentService(prisma as unknown as PrismaService, notify);

    const recruiter = await user('recruiter', 'ZZ Recruiter');
    const agent = await user('agent', 'ZZ Agent');
    const c = await candidate(recruiter);

    await service.scheduleInterview(ADMIN, c.id, {
      scheduled_at: new Date(Date.now() + DAY).toISOString(),
      interviewer_id: agent,
    });

    expect(stub.sent.map((s) => s.userId)).toEqual([recruiter]);
    expect(stub.sent.map((s) => s.userId)).not.toContain(agent);
  });

  it('says it was moved when the time changes, and cancelled when it is called off', async () => {
    const stub = stubDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const service = new RecruitmentService(prisma as unknown as PrismaService, notify);

    const recruiter = await user('recruiter', 'ZZ Recruiter');
    const c = await candidate(recruiter);
    const booked = await service.scheduleInterview(ADMIN, c.id, {
      scheduled_at: new Date(Date.now() + DAY).toISOString(),
    }) as { data: { id: number } };
    stub.sent.length = 0;

    await service.updateInterview(ADMIN, c.id, booked.data.id, {
      scheduled_at: new Date(Date.now() + 3 * DAY).toISOString(),
    });
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].title).toContain('Interview moved');
    stub.sent.length = 0;

    await service.updateInterview(ADMIN, c.id, booked.data.id, { status: 'cancelled' });
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].title).toContain('Interview cancelled');
    expect(stub.sent[0].body).toContain('cancelled');
  });

  it('raises nothing when only feedback or an outcome is recorded', async () => {
    // The people who would hear about an outcome are the people who were in the room.
    const stub = stubDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const service = new RecruitmentService(prisma as unknown as PrismaService, notify);

    const recruiter = await user('recruiter', 'ZZ Recruiter');
    const c = await candidate(recruiter);
    const booked = await service.scheduleInterview(ADMIN, c.id, {
      scheduled_at: new Date(Date.now() + DAY).toISOString(),
    }) as { data: { id: number } };
    stub.sent.length = 0;

    await service.updateInterview(ADMIN, c.id, booked.data.id, { feedback: 'Went well.' });
    await service.updateInterview(ADMIN, c.id, booked.data.id, { status: 'completed' });
    expect(stub.sent).toHaveLength(0);
  });

  it('saving the interview still works when notifying fails', async () => {
    /*
     * Booking is the real work; telling people is a consequence. A dead push endpoint must not roll
     * back an interview that was correctly recorded.
     */
    const exploding = { dispatch: async () => { throw new Error('push gateway is down'); } };
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, exploding as never, permissions,
    );
    const service = new RecruitmentService(prisma as unknown as PrismaService, notify);

    const recruiter = await user('recruiter', 'ZZ Recruiter');
    const c = await candidate(recruiter);
    const booked = await service.scheduleInterview(ADMIN, c.id, {
      scheduled_at: new Date(Date.now() + DAY).toISOString(),
    }) as { data: { id: number } };

    expect(booked.data.id).toBeGreaterThan(0);
    expect(await prisma.recruitment_interviews.count({ where: { candidate_id: c.id } })).toBe(1);
  });
});

describe('a change that lands WHILE the sweep is running', () => {
  /*
   * ================================================================================================
   * THE PASS THAT IS ALREADY RUNNING IS THE ONE THAT MATTERS.
   *
   * A sweep selects its batch once, then dispatches them one at a time — resolving recipients and
   * writing to the ledger for each, which is hundreds of milliseconds per person. A batch of twenty
   * spans seconds. Anything a recruiter does during those seconds lands AFTER the batch was chosen
   * and BEFORE most of it has been sent.
   *
   * Proving that the NEXT pass behaves correctly proves nothing about this: by the next tick the
   * window has moved on and the wrong notification has already been delivered. So each test below
   * mutates the database from inside the dispatch of an EARLIER interview in the same batch, and
   * then asserts what the rest of that same pass did.
   *
   * Two interviews are always created. The first exists only to give the mutation somewhere to
   * happen from; the assertion is about the second.
   * ================================================================================================
   */

  /** A dispatcher that runs `during` the first time it is asked to deliver anything. */
  function mutatingDispatcher(during: () => Promise<void>) {
    const sent: Dispatched[] = [];
    let fired = false;
    return {
      sent,
      dispatch: async (r: Dispatched) => {
        if (!fired) { fired = true; await during(); }
        sent.push(r);
        return { category: r.category, userId: r.userId, delivered: ['in_app'], skipped: [], failed: [] };
      },
    };
  }

  /** Two interviews due in the same window, on two candidates, for one recruiter. */
  async function twoDue(recruiterId: number) {
    const first = await candidate(recruiterId);
    const second = await candidate(recruiterId);
    const at = () => new Date(Date.now() + 24 * 60 * 60_000 - 60_000);
    const a = await prisma.recruitment_interviews.create({
      data: { candidate_id: first.id, status: 'scheduled', scheduled_at: at(), created_at: new Date(), updated_at: new Date() },
    });
    const b = await prisma.recruitment_interviews.create({
      data: { candidate_id: second.id, status: 'scheduled', scheduled_at: at(), created_at: new Date(), updated_at: new Date() },
    });
    return { first, second, a, b };
  }

  const sweepWith = (stub: { dispatch: unknown }) => {
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    return new RecruitmentInterviewReminderService(prisma as unknown as PrismaService, notify);
  };

  it('AN INTERVIEW CANCELLED MID-PASS IS NOT REMINDED ABOUT BY THAT PASS', async () => {
    const who = await user('recruiter', 'ZZ Mid');
    const { second, b } = await twoDue(who);

    const stub = mutatingDispatcher(async () => {
      await prisma.recruitment_interviews.update({ where: { id: b.id }, data: { status: 'cancelled' } });
    });
    await sweepWith(stub).run();

    // The first went out; the second was called off before its turn came.
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].body).not.toContain(second.name);
  });

  it('an interview MOVED mid-pass is reminded with the new time, or not at all', async () => {
    const who = await user('recruiter', 'ZZ Mid');
    const { second, b } = await twoDue(who);

    // Moved a week out — no longer due in this window at all.
    const stub = mutatingDispatcher(async () => {
      await prisma.recruitment_interviews.update({
        where: { id: b.id }, data: { scheduled_at: new Date(Date.now() + 8 * 24 * 60 * 60_000) },
      });
    });
    await sweepWith(stub).run();

    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].body).not.toContain(second.name);
  });

  it('a candidate REMOVED mid-pass is not reminded about either', async () => {
    const who = await user('recruiter', 'ZZ Mid');
    const { second } = await twoDue(who);

    const stub = mutatingDispatcher(async () => {
      await prisma.recruitment_candidates.update({
        where: { id: second.id }, data: { deleted_at: new Date() },
      });
    });
    await sweepWith(stub).run();

    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].body).not.toContain(second.name);
  });

  it('ACCESS REMOVED MID-PASS stops the rest of that pass reaching them', async () => {
    /*
     * Recipients are resolved per interview, inside the dispatch — so somebody whose role changes
     * during a pass stops receiving its later notifications. A list captured when the batch was
     * chosen would keep posting to them for the rest of the run.
     */
    const who = await user('recruiter', 'ZZ Mid');
    await twoDue(who);

    const stub = mutatingDispatcher(async () => {
      // Moved to an agent role: `RecruitmentNoAgentsGuard` would now refuse them the screen.
      await prisma.users.update({ where: { id: who }, data: { role: 'agent' } });
    });
    await sweepWith(stub).run();

    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].userId).toBe(who);
  });

  it('a reassignment mid-pass sends the rest to the person now carrying the candidate', async () => {
    const first = await user('recruiter', 'ZZ Mid One');
    const second = await user('recruiter', 'ZZ Mid Two');
    const pair = await twoDue(first);

    const stub = mutatingDispatcher(async () => {
      await prisma.recruitment_candidates.update({
        where: { id: pair.second.id }, data: { assigned_recruiter_id: second },
      });
    });
    await sweepWith(stub).run();

    expect(stub.sent).toHaveLength(2);
    expect(stub.sent[0].userId).toBe(first);
    expect(stub.sent[1].userId).toBe(second);
  });

  it('an untouched interview in the same batch is still reminded about', async () => {
    // The control. A guard that skipped everything would pass every test above.
    const who = await user('recruiter', 'ZZ Mid');
    await twoDue(who);
    const stub = mutatingDispatcher(async () => { /* nothing changes */ });
    await sweepWith(stub).run();
    expect(stub.sent).toHaveLength(2);
  });
});

describe('reminders before an interview', () => {
  const sweepFor = (stub: ReturnType<typeof stubDispatcher>) => {
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    return new RecruitmentInterviewReminderService(prisma as unknown as PrismaService, notify);
  };

  async function booked(minutesAhead: number) {
    const recruiter = await user('recruiter', 'ZZ Recruiter');
    const c = await candidate(recruiter);
    const iv = await prisma.recruitment_interviews.create({
      data: {
        candidate_id: c.id, status: 'scheduled',
        scheduled_at: new Date(Date.now() + minutesAhead * 60_000),
        created_at: new Date(), updated_at: new Date(),
      },
    });
    return { recruiter, candidate: c, interview: iv };
  }

  it('sends one a day ahead and one an hour ahead', async () => {
    const stub = stubDispatcher();
    const sweep = sweepFor(stub);
    const { interview } = await booked(24 * 60);

    await sweep.run();
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].category).toBe('recruitment_interview_reminder');
    expect(stub.sent[0].title).toContain('Interview in 24 hours');

    // Move it to an hour away and the other reminder is the one that comes due.
    await prisma.recruitment_interviews.update({
      where: { id: interview.id }, data: { scheduled_at: new Date(Date.now() + 60 * 60_000) },
    });
    stub.sent.length = 0;
    await sweep.run();
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].title).toContain('Interview in 1 hour');
  });

  it('names the occurrence in the dedupe key, so a repeated sweep sends nothing extra', async () => {
    /*
     * The key is what makes the sweep safe to run often — and it has to carry the scheduled TIME,
     * not just the interview, or a rescheduled interview would be silently treated as already
     * reminded.
     */
    const stub = stubDispatcher();
    const sweep = sweepFor(stub);
    const { interview } = await booked(24 * 60);

    await sweep.run();
    await sweep.run();
    await sweep.run();

    const keys = stub.sent.map((s) => s.dedupeKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);               // the same occurrence every time
    expect(keys[0]).toContain(`:${interview.id}:`);   // this interview
    expect(keys[0]).toContain('1440');                // this lead time
    expect(keys[0]).toContain(new Date(interview.scheduled_at!).toISOString());
  });

  it('a rescheduled interview gets a NEW key, so its new reminder is not mistaken for the old one', async () => {
    const stub = stubDispatcher();
    const sweep = sweepFor(stub);
    const { interview } = await booked(24 * 60);

    await sweep.run();
    const before = stub.sent[0].dedupeKey;

    /*
     * Moved EARLIER, not later. A reschedule to 24h05 would leave the window entirely and send
     * nothing, which would make this pass for the wrong reason — the key would not have changed,
     * there simply would not be one. Ten minutes earlier is a different time that is still due.
     */
    await prisma.recruitment_interviews.update({
      where: { id: interview.id }, data: { scheduled_at: new Date(Date.now() + 24 * 60 * 60_000 - 10 * 60_000) },
    });
    stub.sent.length = 0;
    await sweep.run();

    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].dedupeKey).not.toBe(before);
  });

  it('reminds nobody about an interview that was moved out of the window', async () => {
    // The outdated reminder needs no cancelling: the query simply stops matching.
    const stub = stubDispatcher();
    const sweep = sweepFor(stub);
    const { interview } = await booked(24 * 60);

    await prisma.recruitment_interviews.update({
      where: { id: interview.id }, data: { scheduled_at: new Date(Date.now() + 9 * DAY) },
    });
    await sweep.run();
    expect(stub.sent).toHaveLength(0);
  });

  it('reminds nobody about a cancelled interview', async () => {
    const stub = stubDispatcher();
    const sweep = sweepFor(stub);
    const { interview } = await booked(60);

    await prisma.recruitment_interviews.update({ where: { id: interview.id }, data: { status: 'cancelled' } });
    await sweep.run();
    expect(stub.sent).toHaveLength(0);
  });

  it('reminds nobody about a completed interview, or one on a removed candidate', async () => {
    const stub = stubDispatcher();
    const sweep = sweepFor(stub);

    const done = await booked(60);
    await prisma.recruitment_interviews.update({ where: { id: done.interview.id }, data: { status: 'completed' } });

    const gone = await booked(60);
    await prisma.recruitment_candidates.update({
      where: { id: gone.candidate.id }, data: { deleted_at: new Date() },
    });

    await sweep.run();
    expect(stub.sent).toHaveLength(0);
  });

  it('two overlapping sweeps notify once, not twice', async () => {
    /*
     * The scheduler ticks every ten minutes and a slow pass can still be running when the next
     * begins — a restart mid-pass has the same shape. Both passes see the same interview in the
     * same window, so both ask; the key is what makes the second ask a no-op.
     */
    const stub = dedupingDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const sweep = new RecruitmentInterviewReminderService(prisma as unknown as PrismaService, notify);
    await booked(24 * 60);

    await Promise.all([sweep.run(), sweep.run(), sweep.run()]);

    expect(stub.sent).toHaveLength(1);
    expect(stub.claimed.size).toBe(1);
  });

  it('A RESCHEDULED INTERVIEW REMINDS WITH THE NEW TIME, never the old one', async () => {
    /*
     * The point of a stateless sweep. Nothing is stored at booking, so there is no snapshot of the
     * old time that could be sent after the interview moved — the body is built from the row as it
     * stands at the moment the reminder goes out.
     */
    const stub = dedupingDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const sweep = new RecruitmentInterviewReminderService(prisma as unknown as PrismaService, notify);
    const { interview } = await booked(24 * 60);

    const moved = new Date(Date.now() + 24 * 60 * 60_000 - 11 * 60_000);
    await prisma.recruitment_interviews.update({ where: { id: interview.id }, data: { scheduled_at: moved } });

    await sweep.run();
    expect(stub.sent).toHaveLength(1);

    // The minute in the body is the NEW one. Rendered in the brokerage's zone, as the notice is.
    const minute = new Intl.DateTimeFormat('en-CA', {
      hour: 'numeric', minute: '2-digit', timeZone: process.env.TZ || 'America/Toronto',
    }).format(moved);
    expect(stub.sent[0].body).toContain(minute);
  });

  it('a cancelled interview cannot be reminded about even if it is cancelled mid-window', async () => {
    const stub = dedupingDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const sweep = new RecruitmentInterviewReminderService(prisma as unknown as PrismaService, notify);
    const { interview } = await booked(60);

    await sweep.run();
    expect(stub.sent).toHaveLength(1);        // the 1-hour reminder went

    // Called off afterwards. Later passes must raise nothing more, for this or any lead time.
    await prisma.recruitment_interviews.update({ where: { id: interview.id }, data: { status: 'cancelled' } });
    stub.sent.length = 0;
    await sweep.run();
    await sweep.run();
    expect(stub.sent).toHaveLength(0);
  });

  it('REASSIGNING THE RECRUITER MOVES THE REMINDER with it', async () => {
    /*
     * The recipient is read from the candidate at reminder time, not captured when the interview
     * was booked. A candidate handed to somebody else mid-week must remind the person now carrying
     * them — and must stop reminding the one who no longer is.
     */
    const stub = dedupingDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const sweep = new RecruitmentInterviewReminderService(prisma as unknown as PrismaService, notify);

    const first = await user('recruiter', 'ZZ First');
    const second = await user('recruiter', 'ZZ Second');
    const c = await candidate(first);
    const iv = await prisma.recruitment_interviews.create({
      data: {
        candidate_id: c.id, status: 'scheduled',
        scheduled_at: new Date(Date.now() + 24 * 60 * 60_000),
        created_at: new Date(), updated_at: new Date(),
      },
    });

    await prisma.recruitment_candidates.update({
      where: { id: c.id }, data: { assigned_recruiter_id: second },
    });

    await sweep.run();
    expect(stub.sent.map((x) => x.userId)).toEqual([second]);
    expect(stub.sent.map((x) => x.userId)).not.toContain(first);
    expect(iv.id).toBeGreaterThan(0);
  });

  it('somebody whose access was removed stops being reminded', async () => {
    /*
     * Access is re-checked on every pass, so a recruiter moved to an agent role — or deactivated —
     * stops receiving notices about candidates they can no longer open. A recipient list captured
     * at booking time would keep telling them.
     */
    const stub = dedupingDispatcher();
    const notify = new RecruitmentInterviewNotifyService(
      prisma as unknown as PrismaService, stub as never, permissions,
    );
    const sweep = new RecruitmentInterviewReminderService(prisma as unknown as PrismaService, notify);

    const recruiter = await user('recruiter', 'ZZ Leaving');
    const c = await candidate(recruiter);
    await prisma.recruitment_interviews.create({
      data: {
        candidate_id: c.id, status: 'scheduled',
        scheduled_at: new Date(Date.now() + 24 * 60 * 60_000),
        created_at: new Date(), updated_at: new Date(),
      },
    });

    // Moved to an agent role: `RecruitmentNoAgentsGuard` would now refuse them the screen.
    await prisma.users.update({ where: { id: recruiter }, data: { role: 'agent' } });
    await sweep.run();
    expect(stub.sent).toHaveLength(0);

    // And the same for an account that has been deactivated.
    await prisma.users.update({ where: { id: recruiter }, data: { role: 'recruiter', status: 'Inactive' } });
    await sweep.run();
    expect(stub.sent).toHaveLength(0);
  });

  it('does not send both reminders for one interview in a single pass', async () => {
    // The windows are far enough apart that no interview can be due for both at once.
    const stub = stubDispatcher();
    const sweep = sweepFor(stub);
    await booked(24 * 60);
    await sweep.run();
    expect(stub.sent).toHaveLength(1);
  });
});
