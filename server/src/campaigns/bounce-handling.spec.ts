import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { MAX_SOFT_RETRIES } from './bounce-classifier';

/**
 * What the classifier's verdict actually does to the database.
 *
 * bounce-classifier.spec.ts proves the reading of an SMTP reply. This proves the consequence, which
 * is the part that is expensive to get wrong: a hard bounce must reach the suppression list (or the
 * next campaign makes the same dead-mailbox attempt, which is what costs a sender their reputation),
 * a soft one must stay queued rather than be written off, and a fault at our end must leave the
 * address completely alone.
 *
 * Against the real schema, inside a transaction that is rolled back.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

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

/** The service with everything outside the send loop stubbed out. `reply` decides each address's fate. */
function serviceFor(tx: PrismaService, reply: (to: string) => void) {
  return new CampaignsService(
    tx,
    new CampaignAudienceService(tx),
    { attachmentsForSend: async () => [] } as never,
    // The domain check passes: this suite is about what the receiving SERVER says, not DNS.
    { domainCanReceiveMail: async () => true } as never,
    { sendDirect: async (to: string) => { reply(to); } } as never,
  );
}

/**
 * A campaign mid-send with one recipient per address.
 *
 * Every address is on its own domain deliberately — the send loop spaces consecutive messages to
 * the SAME domain by SEND_DELAY_MS, which would otherwise make this test sleep for no reason.
 */
async function campaignWith(tx: PrismaService, emails: string[]): Promise<number> {
  seq += 1;
  const now = new Date();
  const c = await tx.campaigns.create({
    data: {
      name: `Bounce test ${Date.now()}-${seq}`,
      subject: 'Subject', content: '<p>Body</p>',
      status: 'sending', total: emails.length,
      tracking_base_url: '',      created_at: now, updated_at: now,
      recipients: {
        create: emails.map((email, i) => ({
          email, name: `Lead ${i}`, token: `tok-${Date.now()}-${seq}-${i}`,
          status: 'pending', created_at: now, updated_at: now,
        })),
      },
    },
  });
  return c.id;
}

const recipientFor = (tx: PrismaService, campaignId: number, email: string) =>
  tx.campaign_recipients.findFirstOrThrow({ where: { campaign_id: campaignId, email } });

const suppressionFor = (tx: PrismaService, email: string) =>
  tx.email_suppressions.findUnique({ where: { email } });

describe('bounce handling', () => {
  it('suppresses a hard-bounced address and leaves a soft-bounced one queued', async () => {
    await inRollback(async (tx) => {
      const dead = `dead-${Date.now()}@hard-example.test`;
      const full = `full-${Date.now()}@soft-example.test`;
      const fine = `fine-${Date.now()}@good-example.test`;
      const id = await campaignWith(tx, [dead, full, fine]);

      await serviceFor(tx, (to) => {
        if (to === dead) throw new Error('550 5.1.1 The email account that you tried to reach does not exist');
        if (to === full) throw new Error('452 4.2.2 Mailbox full, try again later');
      }).resume(id);

      const hard = await recipientFor(tx, id, dead);
      expect(hard.status).toBe('failed');
      expect(hard.bounced).toBe(true);
      expect(hard.bounce_type).toBe('hard');
      // The whole point: the next campaign must not try this address again.
      expect(await suppressionFor(tx, dead)).toMatchObject({ reason: 'hard_bounce', campaign_id: id });

      const soft = await recipientFor(tx, id, full);
      expect(soft.status).toBe('pending');          // still ours to deliver
      expect(soft.bounced).toBe(false);             // a full mailbox is not a dead one
      expect(soft.bounce_type).toBe('soft');
      expect(soft.retry_count).toBe(1);
      expect(soft.next_retry_at!.getTime()).toBeGreaterThan(Date.now());
      // Suppressing a mailbox that was merely full would silently stop the brokerage emailing a
      // real client, with no bounce-back to notice.
      expect(await suppressionFor(tx, full)).toBeNull();

      const ok = await recipientFor(tx, id, fine);
      expect(ok.status).toBe('sent');
      expect(ok.bounce_type).toBeNull();

      const campaign = await tx.campaigns.findUniqueOrThrow({ where: { id } });
      expect(campaign.sent).toBe(1);
      expect(campaign.failed).toBe(1);
      expect(campaign.bounced).toBe(1);   // the hard bounce only
      // Someone is still queued, so the campaign is not finished — and `sending` is what the
      // retry sweep looks for. Settling it here would strand them.
      expect(campaign.status).toBe('sending');
    });
  });

  /**
   * The failure that made this necessary. An expired app password rejects every recipient with a
   * 5xx; read as hard bounces, one bad afternoon would put a sender's entire audience on the
   * suppression list — and nothing in the product removes them in bulk.
   */
  it('never suppresses an address over a fault at our end', async () => {
    await inRollback(async (tx) => {
      const a = `victim-a-${Date.now()}@example.test`;
      const b = `victim-b-${Date.now()}@other-example.test`;
      const id = await campaignWith(tx, [a, b]);

      await serviceFor(tx, () => { throw new Error('535-5.7.8 Username and Password not accepted. BadCredentials'); }).resume(id);

      for (const email of [a, b]) {
        const r = await recipientFor(tx, id, email);
        expect(r.status).toBe('failed');
        expect(r.bounce_type).toBe('unknown');
        expect(r.bounced).toBe(false);   // bounce rate is what providers judge a sender on
        expect(await suppressionFor(tx, email)).toBeNull();
      }

      const campaign = await tx.campaigns.findUniqueOrThrow({ where: { id } });
      expect(campaign.bounced).toBe(0);
      expect(campaign.status).toBe('failed');
    });
  });

  it('retries a soft bounce until the attempts run out, then gives up without suppressing', async () => {
    await inRollback(async (tx) => {
      const email = `greylisted-${Date.now()}@example.test`;
      const id = await campaignWith(tx, [email]);
      const svc = serviceFor(tx, () => { throw new Error('450 4.7.1 Greylisted, please try again later'); });

      // Each pass is one attempt. The backoff is cleared between them so the sweep's job — being
      // called once the wait has expired — does not have to be simulated in real time.
      for (let attempt = 1; attempt <= MAX_SOFT_RETRIES; attempt++) {
        await svc.resume(id);
        const r = await recipientFor(tx, id, email);
        expect(r.retry_count).toBe(attempt);
        expect(r.status).toBe('pending');
        await tx.campaign_recipients.update({ where: { id: r.id }, data: { next_retry_at: null } });
      }

      // One more refusal past the last allowed attempt: now it is written off.
      await svc.resume(id);
      const done = await recipientFor(tx, id, email);
      expect(done.status).toBe('failed');
      expect(done.bounce_type).toBe('soft');
      expect(done.next_retry_at).toBeNull();
      expect(done.error).toMatch(/gave up/i);
      // Still not a hard bounce: a server that deferred us all day has not said the mailbox is gone.
      expect(done.bounced).toBe(false);
      expect(await suppressionFor(tx, email)).toBeNull();

      const campaign = await tx.campaigns.findUniqueOrThrow({ where: { id } });
      expect(campaign.bounced).toBe(0);
      expect(campaign.status).toBe('failed');
    });
  });

  /** A recipient inside its backoff is not due, and a pass that finds nothing due must send nothing. */
  it('leaves a deferred recipient alone until its retry time arrives', async () => {
    await inRollback(async (tx) => {
      const email = `waiting-${Date.now()}@example.test`;
      const id = await campaignWith(tx, [email]);
      let attempts = 0;
      const svc = serviceFor(tx, () => { attempts++; throw new Error('451 4.7.1 Try again later'); });

      await svc.resume(id);
      expect(attempts).toBe(1);

      await svc.resume(id);   // backoff has not expired
      expect(attempts).toBe(1);

      const r = await recipientFor(tx, id, email);
      expect(r.retry_count).toBe(1);
    });
  });

  /**
   * A retry pass is handed only the recipients still outstanding. Counting that pass from zero
   * would write its handful of results over the totals from the rest of the send — a campaign that
   * reached 480 people and retried 3 would report 3.
   */
  it('continues the campaign counters across passes instead of restarting them', async () => {
    await inRollback(async (tx) => {
      const first = `first-${Date.now()}@a-example.test`;
      const later = `later-${Date.now()}@b-example.test`;
      const id = await campaignWith(tx, [first, later]);

      let refuse = true;
      const svc = serviceFor(tx, (to) => { if (to === later && refuse) throw new Error('452 4.2.2 Mailbox full'); });

      await svc.resume(id);
      expect(await tx.campaigns.findUniqueOrThrow({ where: { id } }).then((c) => c.sent)).toBe(1);

      // The deferred one comes good on its next attempt.
      refuse = false;
      const deferred = await recipientFor(tx, id, later);
      await tx.campaign_recipients.update({ where: { id: deferred.id }, data: { next_retry_at: null } });
      await svc.resume(id);

      const campaign = await tx.campaigns.findUniqueOrThrow({ where: { id } });
      expect(campaign.sent).toBe(2);
      expect(campaign.failed).toBe(0);
      expect(campaign.status).toBe('completed');
    });
  });

  afterAll(async () => { await prisma.$disconnect(); });
});
