import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';
import { clusterTick } from '../redis/cluster-tick';

/**
 * FOUR PROCESSES, ONE CAMPAIGN, ONE HUNDRED RECIPIENTS — EXACTLY ONE HUNDRED SENDS.
 *
 * Every other campaign spec in this directory runs one worker. `claim-observed` proves the row is
 * `sending` when the mail leaves; `claim-then-send` proves a crashed row is never reloaded. Both are
 * true and both are single-process, and single-process is precisely the assumption that stops being
 * true the day this deployment runs more than one Node instance to get past the login throughput
 * ceiling. Nothing in the suite would have noticed.
 *
 * WHAT WAS ACTUALLY WRONG. `dispatchScheduled` flipped the campaign with `where: { id }` and no
 * status condition, and `deliver` claimed each recipient with `update({ where: { id } })` — also
 * unconditional. Four processes ticking in the same second therefore all "succeeded" at both, and
 * all four sent. The result is four copies in every recipient's inbox: a deliverability problem, a
 * CASL problem, and the one failure this module elsewhere calls worse than not sending at all.
 *
 * WHY THIS FILE DOES NOT USE THE ROLLED-BACK TRANSACTION the neighbouring specs use. Concurrency is
 * the subject. Four workers inside one transaction are not four workers — they share a snapshot and
 * serialise, so the race can never occur and the test would pass against the broken code. These
 * tests therefore COMMIT, use four independent `PrismaClient`s so each "process" has its own
 * connection and its own pool, and clean up after themselves in `afterAll`.
 *
 * THE ASSERTION THAT MATTERS is not "no errors". It is that the number of messages that left equals
 * the number of recipients — 100, not 200, 300 or 400 — and that no single address received two.
 */

const WORKERS = 4;
const RECIPIENTS = 100;

/** One client per simulated process: separate connections, so the claims race for real. */
const clients = Array.from({ length: WORKERS }, () => new PrismaClient());
const admin = new PrismaClient();

let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;
/** Everything this file creates carries this, so cleanup can find it and nothing else. */
const MARK = `ZZCONC-${Date.now()}`;

afterAll(async () => {
  // Recipients go first: campaign_recipients.campaign_id is ON DELETE CASCADE, but being explicit
  // means a failed run still cleans up rather than leaving 100 rows behind for the next one to trip on.
  await admin.campaign_recipients.deleteMany({ where: { email: { contains: MARK.toLowerCase() } } });
  await admin.campaigns.deleteMany({ where: { name: { startsWith: MARK } } });
  await Promise.all([...clients.map((c) => c.$disconnect()), admin.$disconnect()]);
});

const alwaysDeliverable = { domainCanReceiveMail: async () => true } as never;

/**
 * A committed campaign with `n` pending recipients.
 *
 * THE STATUS MATTERS FOR TEST ISOLATION, not only for the code under test. `resumeStuck`
 * selects EVERY campaign with `status = 'sending'` — it is a recovery sweep, so it
 * has no campaign id to narrow by. These rows are committed, so any other spec in the suite whose
 * resume sweep runs at the same moment will pick this campaign up and deliver it through ITS mock
 * mailer. Measured: 83 sends in this file's ledger, 0 duplicates, and all 100 rows `sent` — the
 * missing 17 went out through a neighbouring suite.
 *
 * The delivery tests therefore park the campaign in a status the sweep ignores and call `resume`
 * directly, which is legitimate because `resume` never looks at the campaign's status — only at its
 * pending recipients. The claim being tested is unaffected; only the foreign traffic goes away.
 */
async function committedCampaign(
  status: 'scheduled' | 'sending' | 'draft',
  n: number,
  /**
   * `sent` creates recipients that are already settled, so the campaign has nothing deliverable.
   *
   * The campaign-claim tests need a claimable campaign, not a deliverable one — and claiming flips
   * it to `sending`, which is exactly the state `resumeStuck` sweeps for in every other spec
   * running in parallel. Measured: two of this fixture's five recipients went out through
   * `schedule-and-recovery`'s mailer and broke its count. With nothing pending there is nothing for
   * a foreign sweep to send, so the fixture can be visible and still inert.
   */
  recipientStatus: 'pending' | 'sent' = 'pending',
): Promise<number> {
  const now = new Date();
  // Per-campaign, because `campaign_recipients.token` is globally unique and several campaigns are
  // created in one run. Sharing the file-level mark alone collided on the second call.
  const run = tag();
  const c = await admin.campaigns.create({
    data: {
      name: `${MARK} ${run}`, subject: 'Hello', content: '<p>Hi</p>',
      status, created_by: 'ZZ Prober', created_by_id: null,
      // Empty on purpose: link rewriting and open tracking belong to other specs.
      tracking_base_url: '',
      /*
       * DUE IN THE FUTURE, deliberately. `dispatchDue` — which several other specs exercise —
       * selects every campaign that is `scheduled` AND due now, across the whole table. A fixture
       * dated in the past is therefore claimed by a neighbouring suite before this file's four
       * workers reach it, and the test sees zero winners instead of one. Dating it forward hides it
       * from that sweep; the tests here call `dispatchScheduled` directly, which claims on status
       * alone and never looks at `scheduled_for`.
       */
      scheduled_for: new Date(Date.now() + 86_400_000),
      created_at: now, updated_at: now,
    },
  });
  await admin.campaign_recipients.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      campaign_id: c.id,
      email: `${MARK.toLowerCase()}-${run}-${i}@probe.test`,
      name: `Probe ${i}`,
      token: `tok-${MARK}-${run}-${i}`,
      status: recipientStatus,
      created_at: now, updated_at: now,
    })),
  });
  return c.id;
}

/**
 * A service for one simulated process, sharing one send ledger with its siblings.
 *
 * The ledger counts per address rather than in total, because a total alone cannot tell "100 sent
 * once" from "50 sent twice" — and the second is the bug.
 */
function workerService(client: PrismaClient, ledger: Map<string, number>): CampaignsService {
  const tx = client as unknown as PrismaService;
  const audience = new CampaignAudienceService(tx);
  const mailer = {
    sendDirect: async (to: string) => {
      ledger.set(to, (ledger.get(to) ?? 0) + 1);
      return { ok: true };
    },
  } as never;
  return new CampaignsService(tx, audience, new CampaignTemplatesService(tx, audience), alwaysDeliverable, mailer);
}

const duplicates = (ledger: Map<string, number>) => [...ledger].filter(([, n]) => n > 1);

/**
 * Remove a fixture the moment its test is done, rather than in `afterAll`.
 *
 * Interference runs BOTH ways, and the second direction cost a full-suite run to find. A campaign
 * left `scheduled` or `sending` is visible to `resumeStuck` in every other spec running in
 * parallel — those sweeps select every campaign in that state, by design, because a recovery sweep
 * has no id to narrow by. Leaving these rows committed for the length of the file made
 * `schedule-and-recovery` fail while this file passed. Deleting on the way out shrinks the window
 * to the test itself.
 */
async function discard(campaignId: number): Promise<void> {
  await admin.campaign_recipients.deleteMany({ where: { campaign_id: campaignId } });
  await admin.campaigns.deleteMany({ where: { id: campaignId } });
}

// ============================================================ the claim on the campaign row

describe('four workers, one scheduled campaign', () => {
  it('exactly one worker wins the claim; the other three are told so rather than failing', async () => {
    const campaignId = await committedCampaign('scheduled', 5, 'sent');
    try {
      const ledger = new Map<string, number>();
      const services = clients.map((c) => workerService(c, ledger));

      const outcomes = await Promise.all(services.map((s) => s.dispatchScheduled(campaignId)));

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(outcomes.filter((o) => o === false)).toHaveLength(WORKERS - 1);

      /*
       * And losing is not an error. The campaign is `completed` — the winner claimed it, sent all
       * five and settled it within this call — NOT `partial`, which is what the resume sweep writes
       * when a dispatch throws. Three processes standing down must never look like three failures.
       */
      const after = await admin.campaigns.findUnique({ where: { id: campaignId }, select: { status: true } });
      expect(after?.status).not.toBe('partial');
      expect(['sending', 'completed']).toContain(after?.status);
    } finally { await discard(campaignId); }
  }, 120_000);

  it('a second dispatch of an already-started campaign claims nothing', async () => {
    // The idempotence that makes a retry safe: `scheduled` is the only claimable state.
    const campaignId = await committedCampaign('sending', 1, 'sent');
    try {
      const ledger = new Map<string, number>();
      expect(await workerService(clients[0], ledger).dispatchScheduled(campaignId)).toBe(false);
    } finally { await discard(campaignId); }
  }, 120_000);
});

// ============================================================ the claim on each recipient

describe(`${WORKERS} concurrent workers delivering one campaign of ${RECIPIENTS} recipients`, () => {
  it(`sends exactly ${RECIPIENTS} messages — not ${RECIPIENTS * 2}, ${RECIPIENTS * 3} or ${RECIPIENTS * WORKERS}`, async () => {
    const campaignId = await committedCampaign('draft', RECIPIENTS);
    try {
      const ledger = new Map<string, number>();
      const services = clients.map((c) => workerService(c, ledger));

      // All four enter `resume` on the same campaign at the same moment — the exact race a
      // multi-process deployment creates every time a tick lands on more than one instance.
      await Promise.all(services.map((s) => s.resume(campaignId)));

      const total = [...ledger.values()].reduce((a, b) => a + b, 0);

      expect(duplicates(ledger)).toEqual([]);        // no address twice — reported before the total,
      expect(ledger.size).toBe(RECIPIENTS);          // because it names WHICH address if it fails
      expect(total).toBe(RECIPIENTS);
    } finally { await discard(campaignId); }
  }, 300_000);

  it('every recipient row is settled exactly once, with none left claimed', async () => {
    const campaignId = await committedCampaign('draft', 25);
    try {
      const ledger = new Map<string, number>();
      await Promise.all(clients.map((c) => workerService(c, ledger).resume(campaignId)));

      const rows = await admin.campaign_recipients.groupBy({
        by: ['status'], where: { campaign_id: campaignId }, _count: { _all: true },
      });
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));

      expect(byStatus.sent).toBe(25);
      // Nothing stranded mid-claim: a `sending` left behind would be a message nobody will ever send.
      expect(byStatus.sending ?? 0).toBe(0);
      expect(byStatus.pending ?? 0).toBe(0);
    } finally { await discard(campaignId); }
  }, 300_000);

  it('a worker that arrives late finds nothing left to claim and sends nothing', async () => {
    const campaignId = await committedCampaign('draft', 10);
    try {
      const ledger = new Map<string, number>();

      await workerService(clients[0], ledger).resume(campaignId);
      const afterFirst = [...ledger.values()].reduce((a, b) => a + b, 0);

      await Promise.all(clients.slice(1).map((c) => workerService(c, ledger).resume(campaignId)));
      const afterRest = [...ledger.values()].reduce((a, b) => a + b, 0);

      expect(afterFirst).toBe(10);
      expect(afterRest).toBe(10);   // the late arrivals added nothing
      expect(duplicates(ledger)).toEqual([]);
    } finally { await discard(campaignId); }
  }, 300_000);
});

// ============================================================ consent, under concurrency

describe('the pre-send consent re-check survives the concurrency change', () => {
  it('a lead who unsubscribed after scheduling is not mailed by ANY of the four workers', async () => {
    /*
     * `consent-at-dispatch` and `claim-observed` already prove this for one worker. It is repeated
     * here because the claim now happens on the way to the same code path, and a guard that holds
     * for one worker but not four would be a regression this file is the only place to catch.
     */
    const campaignId = await committedCampaign('draft', 4);
    const victims = await admin.campaign_recipients.findMany({
      where: { campaign_id: campaignId }, orderBy: { id: 'asc' }, take: 2, select: { email: true },
    });
    await admin.email_suppressions.createMany({
      data: victims.map((v) => ({ email: v.email, reason: 'unsubscribe', created_at: new Date() })),
      skipDuplicates: true,
    });

    try {
      const ledger = new Map<string, number>();
      await Promise.all(clients.map((c) => workerService(c, ledger).resume(campaignId)));

      for (const v of victims) expect(ledger.get(v.email) ?? 0).toBe(0);
      expect([...ledger.values()].reduce((a, b) => a + b, 0)).toBe(2);

      // Marked, not silently skipped — the campaign's own results must explain the gap.
      const dropped = await admin.campaign_recipients.count({
        where: { campaign_id: campaignId, status: 'failed', unsubscribed: true },
      });
      expect(dropped).toBe(2);
    } finally {
      await admin.email_suppressions.deleteMany({ where: { email: { in: victims.map((v) => v.email) } } });
    }
  }, 300_000);
});

// ============================================================ clusterTick, both Redis states

describe('clusterTick — with Redis, and without it', () => {
  /** The whole surface `clusterTick` uses: one predicate and two lock calls. */
  const fakeRedis = (enabled: boolean) => ({ enabled: () => enabled }) as never;
  const fakeCache = (heldBy: { winner: string | null }) => ({
    acquireLock: async (key: string) => {
      if (heldBy.winner === null) { heldBy.winner = key; return true; }
      return false;
    },
    releaseLock: async () => { heldBy.winner = null; },
  }) as never;

  it('WITH Redis: only one of four processes runs the pass', async () => {
    let ran = 0;
    const held = { winner: null as string | null };
    // The lock is never released between these, which is the situation during a real overlapping
    // pass: one holder, three that must stand down.
    const cache = { ...(fakeCache(held) as object), releaseLock: async () => undefined } as never;

    const ticks = Array.from({ length: WORKERS }, () =>
      clusterTick({ redis: fakeRedis(true), cache }, 'concurrency-probe', async () => { ran += 1; }));
    await Promise.all(ticks.map((t) => t()));

    expect(ran).toBe(1);
  });

  it('WITHOUT Redis: all four run — the lock is NOT what makes this safe', async () => {
    /*
     * Deliberately asserting the unprotected behaviour, because it is the reason the database
     * claims exist. `clusterTick` runs the tick when Redis is absent — failing closed would
     * silently stop every scheduled job on every deployment that has none, which is all of them
     * today. So on a four-process deployment that forgot to provision Redis, four workers DO enter
     * the send path, and the only thing standing between the brokerage and four copies of every
     * campaign is the atomic claim proved above.
     *
     * If this test ever starts reporting 1, `clusterTick` has changed its failure mode and the
     * comment above it is now a lie.
     */
    let ran = 0;
    const ticks = Array.from({ length: WORKERS }, () =>
      clusterTick({ redis: fakeRedis(false), cache: fakeCache({ winner: null }) }, 'concurrency-probe-noredis', async () => { ran += 1; }));
    await Promise.all(ticks.map((t) => t()));

    expect(ran).toBe(WORKERS);
  });

  it('a process that cannot reach Redis stands down rather than risking a duplicate', async () => {
    let ran = 0;
    const unreachable = { acquireLock: async () => false, releaseLock: async () => undefined } as never;
    await clusterTick({ redis: fakeRedis(true), cache: unreachable }, 'concurrency-probe-down', async () => { ran += 1; })();
    expect(ran).toBe(0);
  });
});
