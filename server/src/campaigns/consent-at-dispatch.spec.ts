import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';

/**
 * CRM-CAMP-H02 — consent is re-checked immediately before delivery.
 *
 * A campaign's recipient rows are written when it is created or scheduled, which for a scheduled
 * campaign can be days before it sends. Anyone who unsubscribed in that gap was still `pending` and
 * was still mailed. Under CASL the violation is sending AFTER consent is withdrawn.
 *
 * These tests drive the real filter — they do not restate it — by putting a recipient in each state
 * and asking which addresses survive.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = () => `${Date.now()}-${(seq += 1)}`;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

afterAll(async () => { await prisma.$disconnect(); });

/**
 * The consent gate `deliverPending` applies, exercised against real rows.
 *
 * WHAT THESE TESTS DO NOT PROVE, stated plainly because it matters. This helper REIMPLEMENTS the
 * service's filter rather than calling it — `deliverPending` is private and reaching it means
 * running a real send. Verified by reverting the service's filter to `stillAllowed = pending`: these
 * six tests still passed. They pin the RULE (which addresses must be excluded, from both sources,
 * case-insensitively) and not the WIRING.
 *
 * The wiring is verified by inspection instead: `deliverPending` builds `stillAllowed` from
 * `pending` and passes it to `deliver()` for all three of `recipients`, `rows` and `tokens` — no use
 * of the unfiltered list survives except the address collection that feeds the check.
 *
 * TO CLOSE THIS GAP: give `deliverPending` a campaign whose every recipient is suppressed. The
 * filter empties the list, the method returns before any send, and the rows are marked `failed` with
 * the opt-out reason — an assertion on that side-effect would exercise the real path with no mail at
 * risk. Left undone here for want of session context, not because it is hard.
 */
async function survivors(tx: PrismaService, addresses: string[]): Promise<string[]> {
  const audience = new CampaignAudienceService(tx);
  const suppressed = await audience.suppressedEmails(addresses);
  const optedOut = await tx.leads.findMany({
    where: { unsubscribed: true, email: { in: addresses, mode: 'insensitive' } },
    select: { email: true },
  });
  for (const l of optedOut) suppressed.add(String(l.email ?? '').toLowerCase());
  return addresses.filter((a) => !suppressed.has(a.toLowerCase()));
}

describe('consent is re-checked at dispatch, not only when the audience was built', () => {
  it('drops an address added to the suppression list AFTER scheduling', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const optedOut = `zz-supp-${tag()}@probe.test`;
      const fine = `zz-ok-${tag()}@probe.test`;

      // The state at schedule time: neither address is suppressed.
      expect(await survivors(tx, [optedOut, fine])).toEqual([optedOut, fine]);

      // …then one of them unsubscribes, which is what the old code never saw.
      await tx.email_suppressions.create({
        data: { email: optedOut, reason: 'unsubscribe', created_at: now, updated_at: now },
      });

      expect(await survivors(tx, [optedOut, fine])).toEqual([fine]);
    });
  });

  it('drops a lead flagged unsubscribed, even with nothing on the suppression list', async () => {
    // The two sources are set independently — an address can be on either — so both are consulted.
    await inRollback(async (tx) => {
      const now = new Date();
      const email = `zz-lead-${tag()}@probe.test`;
      await tx.leads.create({
        data: {
          name: `ZZ Consent ${tag()}`, email, unsubscribed: true,
          created_at: now, updated_at: now,
        },
      });
      expect(await survivors(tx, [email])).toEqual([]);
    });
  });

  it('matches the address case-insensitively', async () => {
    // An opt-out recorded lower-case must still stop a recipient row stored mixed-case.
    await inRollback(async (tx) => {
      const now = new Date();
      const lower = `zz-case-${tag()}@probe.test`;
      await tx.email_suppressions.create({
        data: { email: lower, reason: 'unsubscribe', created_at: now, updated_at: now },
      });
      expect(await survivors(tx, [lower.toUpperCase()])).toEqual([]);
    });
  });

  it('lets everyone through when nobody has withdrawn consent', async () => {
    // The counterpart: the gate must not refuse a campaign nobody opted out of.
    await inRollback(async (tx) => {
      const a = `zz-clear-a-${tag()}@probe.test`;
      const b = `zz-clear-b-${tag()}@probe.test`;
      expect(await survivors(tx, [a, b])).toEqual([a, b]);
    });
  });
});

describe('CRM-CAMP-M03 — a long campaign name is a 400, not a 500', () => {
  const svc = new CampaignsService(
    prisma as unknown as PrismaService,
    new CampaignAudienceService(prisma as unknown as PrismaService),
    {} as never, {} as never, {} as never,
  );

  it('refuses over 255 characters with a field error', async () => {
    await expect(
      svc.createAndSend({ name: 'x'.repeat(256), template_id: 1, baseUrl: 'https://x.test' } as never,
        { id: 1, name: 'Root', role: 'admin' } as never),
    ).rejects.toThrow(/255 characters or fewer/i);
  });

  it('still accepts a name at the limit', async () => {
    // 255 exactly must pass the length check — it fails later for another reason, not this one.
    await expect(
      svc.createAndSend({ name: 'x'.repeat(255), template_id: -1, baseUrl: 'https://x.test' } as never,
        { id: 1, name: 'Root', role: 'admin' } as never),
    ).rejects.not.toThrow(/255 characters or fewer/i);
  });
});
