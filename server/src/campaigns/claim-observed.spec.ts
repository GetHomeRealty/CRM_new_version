import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';

/**
 * CRM-CAMP-M02 — the half `claim-then-send.spec.ts` could not reach.
 *
 * That file tests the RECOVERY side: a row left `sending` is never reloaded. It is honest about its
 * limit — all seven of its tests still pass with the claim reverted to a comment, because the
 * recovery query always selected `pending` only. What was never observed is the CLAIM itself: that
 * the row really is `sending` at the moment the mail leaves.
 *
 * WHY THE FIRST ATTEMPT FAILED, since the register asked for this to be written down. `resume()`
 * returned without ever attempting a send and the spy recorded nothing. Instrumenting `deliver()`'s
 * entry, as that note suggested, found the guard: `deliverability.domainCanReceiveMail(r.email)` is
 * consulted BEFORE the claim, and it does a real DNS lookup. Every probe address is `@probe.test`,
 * which does not resolve, so every recipient was classified a hard bounce and `continue`d past the
 * claim, the send and the settle. The fixture was wrong, not the code.
 *
 * WHAT IS STUBBED, AND WHY ONLY THIS. `MailDeliverabilityService` — because a test may not depend on
 * DNS — and `MailerService`, which is the observation point. `CampaignAudienceService`,
 * `CampaignTemplatesService` and every Prisma call are REAL, and `resume()` is the public entry the
 * scheduler itself calls. The rule this module already recorded applies: exercise the entry point
 * the user reaches, never a reconstruction of it.
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

/** Every address resolves. The one thing a DNS-free test cannot ask the real service. */
const alwaysDeliverable = { domainCanReceiveMail: async () => true } as never;

/**
 * A campaign with one pending recipient, ready for `resume()`.
 *
 * `tracking_base_url` is left empty on purpose: link rewriting and open tracking are somebody else's
 * tests, and a base URL would drag them into this one.
 */
async function pendingCampaign(tx: PrismaService, email: string) {
  const now = new Date();
  const c = await tx.campaigns.create({
    data: {
      name: `ZZ claim ${tag()}`, subject: 'Hello {{leadName}}', content: '<p>Hi</p>',
      status: 'sending', created_by: 'ZZ Prober', created_by_id: null,
      tracking_base_url: '', created_at: now, updated_at: now,
    },
  });
  const r = await tx.campaign_recipients.create({
    data: {
      campaign_id: c.id, email, name: 'Probe', token: `tok-${tag()}`, status: 'pending',
      created_at: now, updated_at: now,
    },
  });
  return { campaignId: c.id, recipientId: r.id };
}

/** The service, with a mailer that reports what the recipient row said when the mail left. */
function serviceObserving(tx: PrismaService, observed: { status?: string }[], behave: 'ok' | 'throw' = 'ok') {
  const audience = new CampaignAudienceService(tx);
  const mailer = {
    resolveSenderInArea: async () => ({ id: 1, from_email: 'crm@test.local' }), sendFromAccount(this: { sendDirect: (t: string) => unknown }, _a: unknown, o: { to: string[] }) { return this.sendDirect(o.to[0]); }, sendDirect: async (to: string) => {
      const row = await tx.campaign_recipients.findFirst({
        where: { email: to }, orderBy: { id: 'desc' }, select: { status: true },
      });
      observed.push({ status: row?.status });
      if (behave === 'throw') throw new Error('smtp down');
      return { ok: true };
    },
  } as never;
  return new CampaignsService(
    tx, audience, new CampaignTemplatesService(tx, audience), alwaysDeliverable, mailer,
  );
}

describe('the recipient is claimed BEFORE the mail leaves', () => {
  it('is already `sending` at the moment sendDirect is called', async () => {
    /*
     * THIS IS THE ASSERTION THE OTHER FILE COULD NOT MAKE.
     *
     * Send-then-mark leaves the row `pending` for the whole duration of the SMTP round trip, so a
     * crash in that window loses the fact that the message went out — and the resume sends it again.
     * The observation is made from inside the mailer, which is the only place the two orderings
     * differ.
     */
    await inRollback(async (tx) => {
      const observed: { status?: string }[] = [];
      const { campaignId } = await pendingCampaign(tx, `zz-claim-${tag()}@probe.test`);

      await serviceObserving(tx, observed).resume(campaignId);

      expect(observed).toHaveLength(1);
      expect(observed[0].status).toBe('sending');
    });
  });

  it('and is `sent` once the mailer returns', async () => {
    await inRollback(async (tx) => {
      const observed: { status?: string }[] = [];
      const { campaignId, recipientId } = await pendingCampaign(tx, `zz-settle-${tag()}@probe.test`);

      await serviceObserving(tx, observed).resume(campaignId);

      const after = await tx.campaign_recipients.findUnique({ where: { id: recipientId }, select: { status: true } });
      expect(after?.status).toBe('sent');
    });
  });

  it('a send that throws leaves the row settled, not stuck on `sending`', async () => {
    /*
     * The claim is only safe if the ordinary failure path still settles. If a thrown send left the
     * row `sending`, every transient SMTP error would become a recipient nobody ever retries — the
     * fix trading duplicates for silent non-delivery, which is exactly what it must not do.
     */
    await inRollback(async (tx) => {
      const observed: { status?: string }[] = [];
      const { campaignId, recipientId } = await pendingCampaign(tx, `zz-throw-${tag()}@probe.test`);

      await serviceObserving(tx, observed, 'throw').resume(campaignId);

      const after = await tx.campaign_recipients.findUnique({
        where: { id: recipientId }, select: { status: true, error: true },
      });
      expect(observed[0].status).toBe('sending');
      expect(after?.status).not.toBe('sending');
      expect(['pending', 'failed']).toContain(after?.status);
      expect(after?.error ?? '').not.toBe('');
    });
  });

  it('the mail is attempted exactly once, not once per pass', async () => {
    // The claim would be worthless if `resume()` could be re-entered and re-send the same row. The
    // second call finds nothing `pending`, because the first settled it.
    await inRollback(async (tx) => {
      const observed: { status?: string }[] = [];
      const { campaignId } = await pendingCampaign(tx, `zz-once-${tag()}@probe.test`);
      const svc = serviceObserving(tx, observed);

      await svc.resume(campaignId);
      await svc.resume(campaignId);

      expect(observed).toHaveLength(1);
    });
  });
});

describe('CRM-CAMP-H02 — consent is re-checked on the real send path, not only in a rule', () => {
  /*
   * `consent-at-dispatch.spec.ts` pins the RULE and passes with the fix reverted, for the same
   * reason: it never reaches `resume()`. These two drive the address through the real path and
   * assert on whether the mailer was called at all.
   */
  it('a suppressed address is not mailed, and says why', async () => {
    await inRollback(async (tx) => {
      const observed: { status?: string }[] = [];
      const email = `zz-supp-${tag()}@probe.test`;
      const { campaignId, recipientId } = await pendingCampaign(tx, email);
      const now = new Date();
      await tx.email_suppressions.create({
        data: { email: email.toLowerCase(), reason: 'unsubscribe', created_at: now, updated_at: now },
      });

      await serviceObserving(tx, observed).resume(campaignId);

      expect(observed).toHaveLength(0);                 // nothing left the building
      const after = await tx.campaign_recipients.findUnique({
        where: { id: recipientId }, select: { status: true, unsubscribed: true, error: true },
      });
      expect(after?.status).toBe('failed');
      expect(after?.unsubscribed).toBe(true);
      // Marked rather than silently skipped, so "attempted" and "sent" differing is explained.
      expect(after?.error ?? '').toMatch(/opted out/i);
    });
  });

  it('a lead who unsubscribed after the campaign was built is not mailed either', async () => {
    // The second of the two independent sources. An address can be on either, and a check that
    // consults only the suppression list misses the flag on the lead record.
    await inRollback(async (tx) => {
      const observed: { status?: string }[] = [];
      const email = `zz-lead-opt-${tag()}@probe.test`;
      const { campaignId, recipientId } = await pendingCampaign(tx, email);
      const now = new Date();
      await tx.leads.create({
        data: {
          name: `ZZ Lead ${tag()}`, email, lead_status: 'New', unsubscribed: true,
          created_at: now, updated_at: now,
        },
      });

      await serviceObserving(tx, observed).resume(campaignId);

      expect(observed).toHaveLength(0);
      expect((await tx.campaign_recipients.findUnique({ where: { id: recipientId }, select: { status: true } }))?.status)
        .toBe('failed');
    });
  });

  it('…while an address on neither list still goes out — the guard is not just "refuse everyone"', async () => {
    await inRollback(async (tx) => {
      const observed: { status?: string }[] = [];
      const { campaignId } = await pendingCampaign(tx, `zz-allowed-${tag()}@probe.test`);
      await serviceObserving(tx, observed).resume(campaignId);
      expect(observed).toHaveLength(1);
    });
  });
});
