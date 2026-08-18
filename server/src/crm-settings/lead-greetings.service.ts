import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { schedulerSkipReason, schedulersEnabled } from '../common/schedulers';
import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { CrmAdvancedEmailService } from './crm-advanced-email.service';
import type { AuthUserRecord } from '../auth/auth.types';

/** Hourly. The greeting is owed on a DAY, so this is about surviving a restart, not precision. */
const POLL_INTERVAL_MS = 60 * 60 * 1000;
/** A delay after boot, so a restart does not sweep before the application has settled. */
const FIRST_PASS_MS = 90 * 1000;
/** One pass never emails more than this, so a bad date import cannot become an unbounded send. */
const MAX_PER_PASS = 200;

type Greeting = 'birthday' | 'anniversary';

/**
 * Birthday and wedding-anniversary greetings, sent on the day.
 *
 * WHY A SWEEP AND NOT A TIMER PER LEAD. A date can be edited, corrected or cleared at any time, and
 * a timer scheduled when the lead was saved would have to be cancelled and rebuilt on every edit —
 * and would not survive a restart. Asking "whose date is today?" on a schedule needs no bookkeeping,
 * is correct after any outage, and automatically uses the CURRENT value of the field: editing a DOB
 * changes who is greeted tomorrow with no other machinery involved. That is also why editing a date
 * sends nothing at the moment of the edit — the sweep is the only thing that sends.
 *
 * MONTH AND DAY, NOT THE DATE. `date_of_birth` and `marriage_day` carry a year that is in the past;
 * matching on the whole value would greet nobody, ever. Prisma cannot express "extract(month) =" in
 * its query builder, so the match is a raw query returning ids only, and every field that ends up in
 * an email is then read through Prisma as usual.
 *
 * WHO IT SENDS AS. The lead's own agent — owner first, then assignee. `CrmAdvancedEmailService`
 * refuses an address that is not one of the caller's leads, so sending as anybody else would be
 * refused by that rule, correctly. A lead with neither is skipped rather than sent from a stand-in
 * account: an unattributed lead has no agent whose name belongs at the bottom of the email.
 *
 * IDEMPOTENT BY YEAR, using `crm_email_log` — the table `dispatch` already writes for every CRM
 * email. A greeting of this kind, to this address, already logged this calendar year means the
 * person has had it. No new table, no new column, no migration: the record of "we sent this" is the
 * record that prevents sending it twice. So the hourly cadence sends once, a restart mid-pass sends
 * nobody twice, and next year is a different year and does send.
 *
 * OFF UNLESS ASKED FOR. Both triggers default to false — see `crm-settings.constants.ts` for why a
 * timer-driven send earns a different default from a button-driven one.
 */
@Injectable()
export class LeadGreetingsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LeadGreetingsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: CrmAdvancedEmailService,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.LEAD_GREETINGS_DISABLED === '1') {
      this.log.log(
        `Lead birthday/anniversary greetings not scheduled (${process.env.LEAD_GREETINGS_DISABLED === '1'
          ? 'LEAD_GREETINGS_DISABLED=1' : schedulerSkipReason()}).`,
      );
      return;
    }

    registerWorker('lead-greetings', POLL_INTERVAL_MS);
    /*
     * `clusterTick`, like every sweep here that reaches a real person. Two processes running this
     * would mean two greetings — and the `crm_email_log` check is a read-then-write, so two passes
     * genuinely overlapping could both see "not sent yet". The lock is what makes that impossible
     * with Redis; without it, behaviour is a single-instance deployment's, unchanged.
     */
    const tick = clusterTick({ redis: this.redis, cache: this.cache }, 'lead-greetings', () => this.sweep());
    setTimeout(tick, FIRST_PASS_MS).unref?.();
    this.timer = setInterval(tick, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.log.log(`Lead birthday/anniversary greetings hourly (first pass in ${FIRST_PASS_MS / 1000}s).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. `today` is injectable so a test can sit on a date rather than wait for one.
   *
   * Returns what it did rather than nothing, so the caller — and the test — can assert on sends and
   * skips instead of on log lines.
   */
  async sweep(today: Date = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
    const month = today.getMonth() + 1;
    const day = today.getDate();

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const kind of ['birthday', 'anniversary'] as Greeting[]) {
      const column = kind === 'birthday' ? 'date_of_birth' : 'marriage_day';
      /*
       * Raw, because `extract(...)` has no Prisma query-builder equivalent. The two interpolations
       * are numbers this method computed from a Date — never request input — and `column` is chosen
       * by a literal switch above, not passed in.
       */
      /*
       * ============================================================================================
       * THE ALREADY-GREETED EXCLUSION IS IN THE QUERY, NOT IN THE LOOP BELOW. THIS IS THE WHOLE
       * POINT OF THE `NOT EXISTS` AND IT MUST NOT BE MOVED OUT AGAIN.
       *
       * It used to select the first 200 eligible leads and THEN ask, per lead, whether a greeting
       * had already gone. Those two hundred stayed eligible for the rest of the day, so every later
       * pass fetched the same two hundred, discovered all of them were done, and stopped. A
       * brokerage with 201 birthdays on one date greeted two hundred people and silently never
       * reached the two hundred and first — and the day ended, so it never reached them at all.
       *
       * Raising the limit does not fix that; it moves the cliff. Excluding the processed rows BEFORE
       * the limit does fix it: each pass sees only the work that is left, so the set drains.
       * ============================================================================================
       *
       * THE PREDICATE IS `alreadyGreeted` TRANSLITERATED, and the two must stay in step — that
       * method is still called in the loop and is what stops two lead rows sharing one address both
       * being greeted in a single pass. Same kind, same case-insensitive address, same
       * calendar-year floor. `lower()` on both sides matches Prisma's `mode: 'insensitive'` and is
       * what the supporting index is built on.
       */
      const yearStart = new Date(today.getFullYear(), 0, 1, 0, 0, 0, 0);
      const rows = await this.prisma.$queryRawUnsafe<{ id: number }[]>(
        `SELECT l.id FROM leads l
          WHERE l.deleted_at IS NULL
            AND l.unsubscribed = false
            AND l.email IS NOT NULL AND l.email <> ''
            AND l.${column} IS NOT NULL
            AND EXTRACT(MONTH FROM l.${column}) = $1
            AND EXTRACT(DAY   FROM l.${column}) = $2
            AND NOT EXISTS (
              SELECT 1 FROM crm_email_log g
               WHERE g.kind = $3
                 AND lower(g.recipient) = lower(l.email)
                 AND g.created_at >= $4
            )
          ORDER BY l.id
          LIMIT ${MAX_PER_PASS}`,
        month,
        day,
        kind,
        yearStart,
      );
      if (rows.length === 0) continue;

      const leads = await this.prisma.leads.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        select: { id: true, name: true, email: true, owner_user_id: true, assigned_to: true },
      });

      for (const lead of leads) {
        const address = (lead.email ?? '').trim();
        if (!address) { skipped += 1; continue; }

        if (await this.alreadyGreeted(kind, address, today)) { skipped += 1; continue; }

        const agent = await this.agentFor(lead.owner_user_id, lead.assigned_to);
        if (!agent) {
          this.log.warn(`No agent on lead #${lead.id}; ${kind} greeting skipped.`);
          skipped += 1;
          continue;
        }

        try {
          const outcome = kind === 'birthday'
            ? await this.email.sendBirthdayWishes(lead.name ?? '', address, agent)
            : await this.email.sendAnniversaryWishes(lead.name ?? '', address, agent);
          // A refusal is a real answer, not an error: the trigger is off, the master switch is off,
          // or the address has opted out. `dispatch` has already logged why.
          if (outcome.success) sent += 1; else skipped += 1;
        } catch (err) {
          failed += 1;
          this.log.warn(`${kind} greeting to lead #${lead.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (sent || failed) this.log.log(`Lead greetings: ${sent} sent, ${skipped} skipped, ${failed} failed.`);
    return { sent, skipped, failed };
  }

  /**
   * Has this address already had this greeting this calendar year?
   *
   * ANY logged attempt counts, not just a successful one. Sending a second birthday email because
   * the first failed at the SMTP layer is the failure people notice and complain about; missing one
   * is visible in the CRM email log and can be sent by hand. Given the two, duplicates are the worse
   * outcome, and avoiding them is what was asked for.
   */
  private async alreadyGreeted(kind: Greeting, recipient: string, today: Date): Promise<boolean> {
    const yearStart = new Date(today.getFullYear(), 0, 1, 0, 0, 0, 0);
    const found = await this.prisma.crm_email_log.findFirst({
      where: {
        kind,
        recipient: { equals: recipient, mode: 'insensitive' },
        created_at: { gte: yearStart },
      },
      select: { id: true },
    });
    return found !== null;
  }

  /** The lead's own agent: whoever owns it, else whoever it is assigned to. */
  private async agentFor(ownerId: number | null, assignedTo: number | null): Promise<AuthUserRecord | null> {
    const id = ownerId ?? assignedTo;
    if (!id) return null;
    const user = await this.prisma.users.findFirst({
      where: { id, status: 'Active' },
      include: { user_permissions: true },
    });
    return (user as AuthUserRecord | null) ?? null;
  }
}
