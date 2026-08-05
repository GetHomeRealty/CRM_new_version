import { PrismaClient } from '@prisma/client';
import { TENANT_ID } from '../core/tenant';

/**
 * CRM-CAMP-M02 — a crash mid-send must not deliver a second copy.
 *
 * The order is now claim (`sending`) → send → settle (`sent`). What makes that safe is the recovery
 * query: `deliverPending` selects `status: 'pending'` only, so a row claimed but never settled is
 * never picked up again. After a crash the outcome is one message POSSIBLY not delivered rather
 * than one DEFINITELY delivered twice — which is the trade this module already says it wants.
 *
 * These tests drive the recovery query against real rows in each state.
 *
 * WHAT THEY DO NOT PROVE. They exercise the RECOVERY half — that a `sending` row is never reloaded —
 * and that half was already correct before the fix, because the query always selected `pending`
 * only. Verified by reverting the claim to a comment: all seven still passed. What the fix added is
 * the CLAIM, and reaching it means running a real send through `deliverPending`, which is private.
 *
 * So: the safety property is test-verified here, and the write that produces it is verified in
 * `claim-observed.spec.ts` — see below.
 *
 * THE GAP IS NOW CLOSED, in `claim-observed.spec.ts` (2026-08-05). The approach was the one sketched
 * here: a mailer whose `sendDirect` reads the recipient's status from the database and records it,
 * driven through the public `resume()`.
 *
 * WHY THE FIRST ATTEMPT FAILED, since guessing cost a session. `resume()` returned without ever
 * attempting a send and the spy recorded nothing. Instrumenting `deliver()`'s entry — as this note
 * advised — found it: `deliverability.domainCanReceiveMail(r.email)` is consulted BEFORE the claim
 * and performs a real DNS lookup, so every `@probe.test` address was classified a hard bounce and
 * `continue`d past the claim, the send and the settle. The fixture was wrong, not the code.
 *
 * Reverting the claim now turns 2 of that file's 7 tests red, which is the check these seven could
 * never make.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = () => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaClient) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaClient); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/** A campaign with one recipient in the given state. Returns the recipient id. */
async function recipientInState(tx: PrismaClient, status: string): Promise<{ campaignId: number; id: number }> {
  const now = new Date();
  const c = await tx.campaigns.create({
    data: {
      name: `ZZM02 ${tag()}`, subject: 'S', content: 'C', status: 'sending',
      company_id: TENANT_ID, created_at: now, updated_at: now,
    },
  });
  const r = await tx.campaign_recipients.create({
    data: {
      campaign_id: c.id, email: `zz-${tag()}@probe.test`, name: 'Probe',
      token: `tok-${tag()}`, status, created_at: now, updated_at: now,
    },
  });
  return { campaignId: c.id, id: r.id };
}

/** Exactly the selection `deliverPending` performs when a campaign is resumed. */
function recoveryQuery(tx: PrismaClient, campaignId: number) {
  return tx.campaign_recipients.findMany({
    where: {
      campaign_id: campaignId,
      status: 'pending',
      OR: [{ next_retry_at: null }, { next_retry_at: { lte: new Date() } }],
    },
    orderBy: { id: 'asc' },
  });
}

describe('a crash between claiming and sending cannot cause a second copy', () => {
  it('does NOT reload a recipient left mid-send', async () => {
    /*
     * This is the whole finding. The process dies after the mail is accepted and before the row is
     * settled; the row is `sending`. Before the fix it would have been `pending` and the resume
     * would have sent again.
     */
    await inRollback(async (tx) => {
      const { campaignId } = await recipientInState(tx, 'sending');
      expect(await recoveryQuery(tx, campaignId)).toEqual([]);
    });
  });

  it('DOES reload one that was never claimed', async () => {
    // The counterpart: an interrupted campaign must still finish for everyone not yet attempted,
    // or the fix would have traded duplicates for silent non-delivery.
    await inRollback(async (tx) => {
      const { campaignId, id } = await recipientInState(tx, 'pending');
      const rows = await recoveryQuery(tx, campaignId);
      expect(rows.map((r) => r.id)).toEqual([id]);
    });
  });

  it.each(['sent', 'failed'])('does not reload a %s recipient', async (status) => {
    await inRollback(async (tx) => {
      const { campaignId } = await recipientInState(tx, status);
      expect(await recoveryQuery(tx, campaignId)).toEqual([]);
    });
  });

  it('a soft-bounced recipient waiting out its backoff is not reloaded early', async () => {
    // `sending` is not the only state that must be respected — the deferred one predates it.
    await inRollback(async (tx) => {
      const { campaignId, id } = await recipientInState(tx, 'pending');
      await tx.campaign_recipients.update({
        where: { id }, data: { next_retry_at: new Date(Date.now() + 60 * 60 * 1000) },
      });
      expect(await recoveryQuery(tx, campaignId)).toEqual([]);
    });
  });

  it('…and IS reloaded once its backoff has expired', async () => {
    await inRollback(async (tx) => {
      const { campaignId, id } = await recipientInState(tx, 'pending');
      await tx.campaign_recipients.update({
        where: { id }, data: { next_retry_at: new Date(Date.now() - 1000) },
      });
      expect((await recoveryQuery(tx, campaignId)).map((r) => r.id)).toEqual([id]);
    });
  });
});

describe('the ambiguity is visible rather than silent', () => {
  it('a claimed-but-unsettled recipient is still readable as `sending`', async () => {
    /*
     * The deliberate cost of preferring a miss over a duplicate is that somebody has to be able to
     * SEE the miss. The row keeps its `sending` status, and the campaign it belongs to is left
     * `sending` too — the finalising write at the end of the delivery loop never runs after a crash
     * — so neither reports as complete.
     */
    await inRollback(async (tx) => {
      const { campaignId, id } = await recipientInState(tx, 'sending');
      const r = await tx.campaign_recipients.findUnique({ where: { id } });
      const c = await tx.campaigns.findUnique({ where: { id: campaignId } });
      expect(r?.status).toBe('sending');
      expect(c?.status).toBe('sending');
    });
  });
});
