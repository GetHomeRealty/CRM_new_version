import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseNdr } from './ndr-parser';

/** How far back a sweep looks for bounce reports it has not yet applied. */
const LOOKBACK_HOURS = 72;
/** How recently a recipient must have been sent to be matched to a report. */
const MATCH_WINDOW_DAYS = 14;
/** Reports read per pass. A backlog drains over several passes rather than in one long transaction. */
const BATCH = 200;

/**
 * Applies bounces that arrive as EMAIL to the campaign recipients they belong to.
 *
 * THE GAP THIS FILLS. Bounce handling existed only for a refusal made during the SMTP conversation
 * — `classifyBounce` on the exception thrown while sending. That is the minority of real bounces.
 * A relay which accepts the message answers `250 OK`, finds the mailbox missing on delivery, and
 * reports it minutes later as a Non-Delivery Report to the sender. Nothing read those, so:
 *
 *   1. the recipient stayed `sent` for ever — never `bounced`, so the results screen was wrong; and
 *   2. because `recordOpen` only refuses a recipient already marked bounced, the guard that should
 *      have stopped "opened" had nothing to act on, and a later pixel fetch counted as a read of a
 *      message that was never delivered.
 *
 * That second point is the reported symptom: `karishma@gmail.co` showing "Sent → Opened". The open
 * guard was never broken; it was starved.
 *
 * A FALSE OPEN IS UNDONE, not merely prevented from here on. A recipient found to have bounced has
 * its `opened` flag cleared and the campaign's counter decremented, because the number on the
 * results screen is a claim about how many people read the message and that one did not.
 *
 * IDEMPOTENT WITHOUT A NEW COLUMN. The sweep only ever acts on recipients that are not already
 * bounced, so reading the same report twice changes nothing the second time. That is why this needs
 * no migration and no "processed" flag on the inbound message.
 */
@Injectable()
export class BounceIngestService {
  private readonly log = new Logger(BounceIngestService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One pass: read recent delivery reports and mark whoever they name.
   *
   * Returns what it did so the caller — a scheduler, or a test — can assert on it rather than on
   * log output.
   */
  async sweep(now: Date = new Date()): Promise<{ reports: number; bounced: number; opensReversed: number }> {
    const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000);

    /*
     * Candidate reports are narrowed in SQL before anything is parsed. A brokerage's inbox holds
     * far more ordinary mail than bounces, and `parseNdr` on every message of the last three days
     * would be work done to discard almost all of it.
     */
    const candidates = await this.prisma.inbound_emails.findMany({
      where: {
        received_at: { gte: since },
        OR: [
          { from_email: { contains: 'mailer-daemon', mode: 'insensitive' } },
          { from_email: { contains: 'postmaster', mode: 'insensitive' } },
          { subject: { contains: 'delivery status notification', mode: 'insensitive' } },
          { subject: { contains: 'undeliverable', mode: 'insensitive' } },
          { subject: { contains: 'returned mail', mode: 'insensitive' } },
          { subject: { contains: 'delivery failure', mode: 'insensitive' } },
          { subject: { contains: 'failure notice', mode: 'insensitive' } },
        ],
      },
      select: { id: true, from_email: true, subject: true, body_text: true, body_html: true, received_at: true },
      orderBy: { id: 'desc' },
      take: BATCH,
    });

    let reports = 0;
    let bounced = 0;
    let opensReversed = 0;

    for (const msg of candidates) {
      const verdict = parseNdr({
        from: msg.from_email, subject: msg.subject, text: msg.body_text, html: msg.body_html,
      });
      if (!verdict.isNdr) continue;
      reports += 1;

      for (const address of verdict.addresses) {
        const applied = await this.applyTo(address, verdict.type, verdict.reason, msg.received_at ?? now);
        bounced += applied.bounced;
        opensReversed += applied.opensReversed;
      }
    }

    if (reports) {
      this.log.log(
        `Campaign bounce ingest: ${reports} delivery report(s) read, ${bounced} recipient(s) marked bounced`
        + `${opensReversed ? `, ${opensReversed} false open(s) reversed` : ''}.`,
      );
    }
    return { reports, bounced, opensReversed };
  }

  /**
   * Mark every campaign recipient at this address that the report could plausibly be about.
   *
   * BOUNDED BY TIME, not by address alone. The same person may be on a campaign from last year and
   * one from this morning; a report can only be about a message actually sent to them recently, and
   * rewriting a year-old campaign's results because of today's bounce would be falsifying history.
   *
   * Only rows still marked `sent` are touched — a recipient already bounced needs nothing, and one
   * that is `pending` or `failed` was never accepted by a relay, so no report can be about it.
   */
  private async applyTo(
    address: string, type: 'hard' | 'soft' | 'unknown', reason: string, reportedAt: Date,
  ): Promise<{ bounced: number; opensReversed: number }> {
    const window = new Date(reportedAt.getTime() - MATCH_WINDOW_DAYS * 86400_000);

    const rows = await this.prisma.campaign_recipients.findMany({
      where: {
        email: { equals: address, mode: 'insensitive' },
        status: 'sent',
        bounced: false,
        updated_at: { gte: window },
      },
      select: { id: true, campaign_id: true, opened: true },
    });
    if (!rows.length) return { bounced: 0, opensReversed: 0 };

    let opensReversed = 0;
    const now = new Date();

    for (const r of rows) {
      /*
       * `failed`, not `sent`, once a report says it never arrived. The status column is what the
       * results screen reads, and leaving it `sent` beside `bounced = true` would let the two
       * disagree about the same recipient.
       */
      const writes: unknown[] = [
        this.prisma.campaign_recipients.update({
          where: { id: r.id },
          data: {
            status: 'failed', bounced: true, bounce_type: type === 'unknown' ? null : type,
            error: reason.slice(0, 500),
            // A message that never arrived was never read. Clearing this is what corrects the
            // "Sent → Opened" the results screen showed.
            ...(r.opened ? { opened: false, opened_at: null } : {}),
            updated_at: now,
          },
        }),
      ];
      if (r.opened) {
        opensReversed += 1;
        writes.push(this.prisma.campaigns.update({
          where: { id: r.campaign_id },
          data: { opened: { decrement: 1 }, updated_at: now },
        }));
      }
      await this.prisma.$transaction(writes as never);
    }

    /*
     * A hard bounce suppresses the address, exactly as the send-time path does. The mailbox is
     * gone; continuing to mail it damages the brokerage's sending reputation and cannot ever work.
     * A soft bounce does NOT suppress — the address is fine and the moment was not.
     */
    if (type === 'hard') {
      /*
       * `reason` is a VOCABULARY — `unsubscribe | hard_bounce` — not free text, and the column is
       * 64 characters. Writing the provider's sentence here would overflow it and, worse, break the
       * one question this table is asked: did this person opt out, or is the mailbox gone? The
       * human-readable reason belongs on the recipient row, where it was written above.
       *
       * `update: {}` matches the send-time path: an address already suppressed keeps its original
       * record rather than having the date moved every time another report mentions it.
       */
      await this.prisma.email_suppressions.upsert({
        where: { email: address },
        create: { email: address, reason: 'hard_bounce', campaign_id: rows[0].campaign_id, created_at: now, updated_at: now },
        update: {},
      }).catch(() => undefined);
    }

    return { bounced: rows.length, opensReversed };
  }
}
