import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CampaignResumeService } from './campaign-resume.service';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';

/**
 * PRIORITY 7 — schedule execution and restart recovery, driven through the real sweeps.
 *
 * The register recorded scheduled sends as "STILL NOT TESTED", then later as "what IS correct" from
 * a code read. These run them: `dispatchDue` and `resumeAll` are the two methods the timers call, so
 * they are the two called here — the timers themselves are gated off in tests and are not the
 * interesting part.
 *
 * REAL ROWS, not the rolled-back fixture. `CampaignsService` commits counter updates with
 * `prisma.$transaction([...])`, which an interactive transaction client does not expose, so inside a
 * transaction the delivery paths throw and are swallowed — everything would appear not to send. Same
 * trap as `tracking-attribution.spec.ts`. Everything created is prefixed `ZZSCHED` and removed in a
 * `finally`.
 */

const prisma = new PrismaClient();
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function withCleanup(fn: (db: PrismaService) => Promise<void>) {
  try {
    await fn(prisma as unknown as PrismaService);
  } finally {
    const rows = await prisma.campaigns.findMany({ where: { name: { startsWith: 'ZZSCHED' } }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await prisma.campaign_recipients.deleteMany({ where: { campaign_id: { in: ids } } }).catch(() => undefined);
      await prisma.campaign_links.deleteMany({ where: { campaign_id: { in: ids } } }).catch(() => undefined);
      await prisma.campaigns.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
  }
}

/** The two services, with the mail layer replaced by a counter and DNS forced to succeed. */
function services(db: PrismaService, sent: string[], behave: 'ok' | 'throw' = 'ok') {
  const audience = new CampaignAudienceService(db);
  const campaigns = new CampaignsService(
    db, audience, new CampaignTemplatesService(db, audience),
    { domainCanReceiveMail: async () => true } as never,
    {
      sendDirect: async (to: string) => {
        sent.push(to);
        if (behave === 'throw') throw new Error('smtp down');
        return { ok: true };
      },
    } as never,
  );
  return { campaigns, resume: new CampaignResumeService(db, campaigns) };
}

async function campaignWith(db: PrismaService, over: Record<string, unknown>, recipients = 1) {
  const now = new Date();
  const t = tag();
  const campaign = await db.campaigns.create({
    data: {
      name: `ZZSCHED ${t}`, subject: 'S', content: '<p>Hi</p>',
      created_by: 'ZZ Prober', tracking_base_url: '',
      sent: 0, failed: 0, created_at: now, updated_at: now, ...over,
    },
  });
  for (let i = 0; i < recipients; i += 1) {
    await db.campaign_recipients.create({
      data: {
        campaign_id: campaign.id, email: `zz-sched-${t}-${i}@probe.test`, name: 'Probe',
        token: `tok-sched-${t}-${i}`, status: 'pending', created_at: now, updated_at: now,
      },
    });
  }
  return campaign;
}

const statusOf = (db: PrismaService, id: number) =>
  db.campaigns.findUnique({ where: { id }, select: { status: true, sent: true, failed: true } });

describe('a scheduled campaign goes out when it is due', () => {
  it('one that is due is sent, and stops being scheduled', async () => {
    await withCleanup(async (db) => {
      const sent: string[] = [];
      const c = await campaignWith(db, { status: 'scheduled', scheduled_for: new Date(Date.now() - 60_000) });

      await services(db, sent).resume.dispatchDue();

      expect(sent).toHaveLength(1);
      expect((await statusOf(db, c.id))?.status).not.toBe('scheduled');
    });
  }, 60000);

  it('one that is NOT yet due is left alone', async () => {
    // The whole point of scheduling: an announcement set for Monday must not go out on Friday.
    await withCleanup(async (db) => {
      const sent: string[] = [];
      const c = await campaignWith(db, { status: 'scheduled', scheduled_for: new Date(Date.now() + 60 * 60 * 1000) });

      await services(db, sent).resume.dispatchDue();

      expect(sent).toHaveLength(0);
      expect((await statusOf(db, c.id))?.status).toBe('scheduled');
    });
  }, 60000);

  it('a due campaign is not sent twice by two ticks', async () => {
    /*
     * The sweep runs on a timer, so "did it already go?" is asked once a minute for ever. The status
     * moving off `scheduled` is what stops the second tick finding it — a campaign that stayed
     * `scheduled` while sending would be re-dispatched every minute until it finished.
     */
    await withCleanup(async (db) => {
      const sent: string[] = [];
      await campaignWith(db, { status: 'scheduled', scheduled_for: new Date(Date.now() - 60_000) });
      const svc = services(db, sent);

      await svc.resume.dispatchDue();
      await svc.resume.dispatchDue();

      expect(sent).toHaveLength(1);
    });
  }, 60000);

  it('a send that cannot start is left visibly stopped, not retried every minute', async () => {
    /*
     * The service's own reasoning, worth pinning: *"retrying on the next tick would hammer a broken
     * send every minute, and a campaign nobody can explain is worse than one that visibly stopped."*
     * A campaign with no recipients at all cannot start.
     */
    await withCleanup(async (db) => {
      const sent: string[] = [];
      const c = await campaignWith(db, { status: 'scheduled', scheduled_for: new Date(Date.now() - 60_000) }, 0);

      await services(db, sent).resume.dispatchDue();

      const after = await statusOf(db, c.id);
      expect(after?.status).not.toBe('scheduled');
      expect(sent).toHaveLength(0);
    });
  }, 60000);
});

describe('recovery after a restart', () => {
  it('a campaign left mid-send finishes the recipients it never reached', async () => {
    /*
     * THE RESTART CASE. Delivery runs detached from the request, so a deploy or a crash leaves the
     * campaign `sending` with some recipients still `pending` and nothing alive to finish them.
     * `resumeAll` is what boot calls.
     */
    await withCleanup(async (db) => {
      const sent: string[] = [];
      const c = await campaignWith(db, { status: 'sending', sent: 2 }, 2);

      await services(db, sent).resume.resumeAll();

      expect(sent).toHaveLength(2);
      const after = await statusOf(db, c.id);
      expect(after?.status).not.toBe('sending');
      // The counters continue from where the interrupted run reached rather than restarting at zero.
      expect(after?.sent).toBe(4);
    });
  }, 60000);

  it('a campaign interrupted AFTER its last recipient is settled from its counts, not re-sent', async () => {
    /*
     * Interrupted between the final send and the closing update. There is nothing left to deliver,
     * so this is bookkeeping — and starting a send would be worse than useless, it would be a second
     * copy to whoever was already done.
     */
    await withCleanup(async (db) => {
      const sent: string[] = [];
      const c = await campaignWith(db, { status: 'sending', sent: 3, failed: 0 }, 0);

      await services(db, sent).resume.resumeAll();

      expect(sent).toHaveLength(0);
      expect((await statusOf(db, c.id))?.status).toBe('completed');
    });
  }, 60000);

  it('…and one that reached nobody is recorded as failed, not completed', async () => {
    await withCleanup(async (db) => {
      const sent: string[] = [];
      const c = await campaignWith(db, { status: 'sending', sent: 0, failed: 2 }, 0);
      await services(db, sent).resume.resumeAll();
      expect((await statusOf(db, c.id))?.status).toBe('failed');
    });
  }, 60000);

  it('a recipient waiting out a soft-bounce backoff is not retried early', async () => {
    /*
     * `pending` means two different things — never attempted, and deferred after a soft bounce — and
     * only `next_retry_at` separates them. Retrying a full mailbox or a greylisting server the
     * instant it refused us is indistinguishable from hammering it.
     */
    await withCleanup(async (db) => {
      const sent: string[] = [];
      const c = await campaignWith(db, { status: 'sending' }, 1);
      await db.campaign_recipients.updateMany({
        where: { campaign_id: c.id },
        data: { next_retry_at: new Date(Date.now() + 60 * 60 * 1000), retry_count: 1 },
      });

      await services(db, sent).resume.resumeAll();

      expect(sent).toHaveLength(0);
      // Still open, because somebody is still owed an attempt.
      expect((await statusOf(db, c.id))?.status).toBe('sending');
    });
  }, 60000);

  it('…and IS retried once the backoff has expired', async () => {
    await withCleanup(async (db) => {
      const sent: string[] = [];
      const c = await campaignWith(db, { status: 'sending' }, 1);
      await db.campaign_recipients.updateMany({
        where: { campaign_id: c.id },
        data: { next_retry_at: new Date(Date.now() - 1000), retry_count: 1 },
      });

      await services(db, sent).resume.retryDeferred();

      expect(sent).toHaveLength(1);
    });
  }, 60000);

  it('a completed campaign is never resumed', async () => {
    // The guard rail: every test above would also pass if `resumeAll` simply sent everything.
    await withCleanup(async (db) => {
      const sent: string[] = [];
      await campaignWith(db, { status: 'completed', sent: 1 }, 1);
      await services(db, sent).resume.resumeAll();
      expect(sent).toHaveLength(0);
    });
  }, 60000);
});
