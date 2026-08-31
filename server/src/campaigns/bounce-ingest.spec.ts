import { BounceIngestService } from './bounce-ingest.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Applying an emailed bounce to the campaign recipient it belongs to.
 *
 * The reported case end to end: a campaign to `karishma@gmail.co` recorded `sent`, was later
 * counted as `opened`, and the delivery report sitting in the sender's inbox was never read. These
 * tests drive that exact sequence and assert the correction — including that the false open is
 * REVERSED rather than merely prevented from recurring, because the number on the results screen is
 * a claim about how many people read the message.
 */

const NDR = {
  id: 1,
  from_email: 'mailer-daemon@googlemail.com',
  subject: 'Delivery Status Notification (Failure)',
  body_text: "Your message wasn't delivered to karishma@gmail.co because the address couldn't be found.\n550 5.1.1 The email account that you tried to reach does not exist.",
  body_html: null,
  received_at: new Date('2026-08-22T10:00:00Z'),
};

function harness(recipients: { id: number; campaign_id: number; opened: boolean }[], inbound = [NDR]) {
  const recipientUpdates: Record<string, unknown>[] = [];
  const campaignUpdates: Record<string, unknown>[] = [];
  const suppressed: Record<string, unknown>[] = [];

  const prisma = {
    inbound_emails: { findMany: async () => inbound },
    campaign_recipients: {
      findMany: async () => recipients,
      update: async (args: Record<string, unknown>) => { recipientUpdates.push(args); return args; },
    },
    campaigns: { update: async (args: Record<string, unknown>) => { campaignUpdates.push(args); return args; } },
    email_suppressions: { upsert: async (args: Record<string, unknown>) => { suppressed.push(args); return args; } },
    // The service batches its writes; the stub just resolves whatever it was handed.
    $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  } as unknown as PrismaService;

  return { svc: new BounceIngestService(prisma), recipientUpdates, campaignUpdates, suppressed };
}

describe('an emailed bounce reaches the recipient it names', () => {
  it('marks a recipient bounced and failed, not sent', async () => {
    const { svc, recipientUpdates } = harness([{ id: 7, campaign_id: 3, opened: false }]);
    const r = await svc.sweep();

    expect(r.reports).toBe(1);
    expect(r.bounced).toBe(1);
    const data = recipientUpdates[0].data as Record<string, unknown>;
    expect(data.bounced).toBe(true);
    expect(data.bounce_type).toBe('hard');
    // `sent` beside `bounced: true` would let the two columns disagree about one recipient.
    expect(data.status).toBe('failed');
    expect(String(data.error)).toMatch(/does not exist|permanently/i);
  });

  it('REVERSES a false open, and takes it off the campaign total', async () => {
    // The reported symptom: "Sent → Opened" on an address that never received anything.
    const { svc, recipientUpdates, campaignUpdates } = harness([{ id: 7, campaign_id: 3, opened: true }]);
    const r = await svc.sweep();

    expect(r.opensReversed).toBe(1);
    const data = recipientUpdates[0].data as Record<string, unknown>;
    expect(data.opened).toBe(false);
    expect(data.opened_at).toBeNull();
    expect(campaignUpdates).toHaveLength(1);
    expect((campaignUpdates[0].data as { opened: { decrement: number } }).opened).toEqual({ decrement: 1 });
  });

  it('leaves the OPEN counter alone when there was no open to reverse', async () => {
    /*
     * This asserted `campaignUpdates` was EMPTY, which encoded the gap rather than a rule: the
     * campaign row was touched only to reverse a false open, so a bounce with no open moved none of
     * the campaign's counters and the results card went on reporting the message as delivered.
     *
     * The campaign is now always corrected; what must stay untouched is `opened` specifically,
     * because decrementing a counter that was never incremented would drive it negative.
     */
    const { svc, campaignUpdates } = harness([{ id: 7, campaign_id: 3, opened: false }]);
    await svc.sweep();
    expect(campaignUpdates).toHaveLength(1);
    expect(campaignUpdates[0].data as Record<string, unknown>).not.toHaveProperty('opened');
  });

  it('suppresses a hard-bounced address with the vocabulary the table expects', async () => {
    const { svc, suppressed } = harness([{ id: 7, campaign_id: 3, opened: false }]);
    await svc.sweep();
    expect(suppressed).toHaveLength(1);
    // `reason` is a 64-char vocabulary — 'unsubscribe' | 'hard_bounce' — not the provider's prose.
    expect((suppressed[0].create as { reason: string }).reason).toBe('hard_bounce');
  });

  it('does NOT suppress on a soft bounce — the address is fine, the moment was not', async () => {
    const soft = {
      ...NDR,
      subject: 'Delivery Status Notification (Delay)',
      body_text: 'Final-Recipient: rfc822; busy@example.net\n452 4.2.2 over quota',
    };
    const { svc, suppressed, recipientUpdates } = harness([{ id: 8, campaign_id: 3, opened: false }], [soft]);
    await svc.sweep();
    expect(suppressed).toHaveLength(0);
    expect((recipientUpdates[0].data as { bounce_type: string }).bounce_type).toBe('soft');
  });

  it('is idempotent: a report about recipients already bounced changes nothing', async () => {
    // The query asks only for `bounced: false`, so a second pass finds nothing to do — which is
    // why this needs no "processed" flag on the inbound message and no migration.
    const { svc, recipientUpdates, campaignUpdates } = harness([]);
    const r = await svc.sweep();
    expect(r.bounced).toBe(0);
    expect(recipientUpdates).toHaveLength(0);
    expect(campaignUpdates).toHaveLength(0);
  });

  it('ignores an inbox message that is not a delivery report', async () => {
    const ordinary = {
      ...NDR, from_email: 'client@example.com', subject: 'Re: Your property search',
      body_text: 'Sounds good, see you Saturday.',
    };
    const { svc, recipientUpdates } = harness([{ id: 7, campaign_id: 3, opened: false }], [ordinary]);
    const r = await svc.sweep();
    expect(r.reports).toBe(0);
    expect(recipientUpdates).toHaveLength(0);
  });
});

describe('the campaign card follows the recipient', () => {
  /**
   * THE DEFECT. The results card does not aggregate recipients — it reads denormalised columns on
   * the `campaigns` row. So marking a recipient bounced and stopping left the card unchanged: the
   * campaign still reported the message delivered and `bounced` stayed where the send had left it.
   * Every ASYNCHRONOUS bounce — which is most of them, because a relay accepts first and reports
   * minutes later — was invisible on the screen that exists to show it.
   */
  const campaignData = (updates: Record<string, unknown>[]) =>
    updates.map((u) => (u as { data: Record<string, unknown> }).data);

  it('moves the message out of sent and into failed and bounced', async () => {
    const h = harness([{ id: 11, campaign_id: 900, opened: false }]);

    await h.svc.sweep(new Date('2026-08-22T12:00:00Z'));

    const data = campaignData(h.campaignUpdates);
    expect(data).toHaveLength(1);
    /*
     * All three move together. The query only selects rows that are `sent` and not yet bounced, so
     * each one was counted in `sent` when the campaign ran — leaving it there would overstate
     * delivery for ever, and `sent + failed` would stop equalling the audience.
     */
    expect(data[0]).toMatchObject({
      sent: { decrement: 1 },
      failed: { increment: 1 },
      bounced: { increment: 1 },
    });
  });

  it('reverses a false open in the SAME correction', async () => {
    const h = harness([{ id: 12, campaign_id: 901, opened: true }]);

    await h.svc.sweep(new Date('2026-08-22T12:00:00Z'));

    const data = campaignData(h.campaignUpdates);
    // One write per recipient, carrying the whole correction — not a bounce update and a separate
    // open update that could half-apply.
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      sent: { decrement: 1 },
      failed: { increment: 1 },
      bounced: { increment: 1 },
      opened: { decrement: 1 },
    });
  });

  it('does not touch opened when the message was never opened', async () => {
    const h = harness([{ id: 13, campaign_id: 902, opened: false }]);

    await h.svc.sweep(new Date('2026-08-22T12:00:00Z'));

    // Decrementing a counter that was never incremented would drive it negative.
    expect(campaignData(h.campaignUpdates)[0]).not.toHaveProperty('opened');
  });

  it('corrects every campaign the address was on, once each', async () => {
    const h = harness([
      { id: 21, campaign_id: 910, opened: false },
      { id: 22, campaign_id: 911, opened: true },
    ]);

    await h.svc.sweep(new Date('2026-08-22T12:00:00Z'));

    const updates = h.campaignUpdates as { where: { id: number } }[];
    expect(updates.map((u) => u.where.id).sort()).toEqual([910, 911]);
  });
});
