import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { schedulerSkipReason, schedulersEnabled } from '../common/schedulers';
import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { CrmAdvancedEmailService, type WelcomeSender } from './crm-advanced-email.service';
import type { AuthUserRecord } from '../auth/auth.types';

/** Often enough that a welcome is not stale, rarely enough that it is not a busy loop. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** A delay after boot, so a restart does not sweep before the application has settled. */
const FIRST_PASS_MS = 60 * 1000;
/** One pass never emails more than this, so a bulk import cannot become an unbounded send. */
const MAX_PER_PASS = 100;

/**
 * How far back a lead still counts as "newly received".
 *
 * THE REASON THERE IS A WINDOW AT ALL. Without one, "leads that have never had a welcome" is every
 * lead the brokerage has ever had — so the first pass after this feature shipped, or the first pass
 * after somebody switched the trigger on, would email the entire database. That is the kind of
 * mistake nobody gets to make twice, and a lead who arrived last spring is not owed a welcome now.
 * A day is generous for "we have just met" and survives an overnight outage.
 */
const NEW_LEAD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The welcome email a new lead gets, once, however they arrived.
 *
 * WHY A SWEEP RATHER THAN A CALL AT EACH CREATION SITE. Leads are created in at least three places
 * — the leads endpoint, the Meta sync, and the CSV import, which uses `createMany` and so has no
 * per-row hook at all — and the brief also asks for website and integration sources that do not
 * exist yet. Calling a send from each means every one of them has to remember, every new one has to
 * remember, and each is its own chance to send twice. Asking "who arrived recently and has not been
 * welcomed?" covers all of them, including the ones written next year, and puts the duplicate rule
 * in one place instead of four.
 *
 * ONCE PER PERSON, NOT ONCE PER ROW. The check is by email address against `crm_email_log`, with no
 * time bound: a welcome to that address ever means they have had it. So the same person imported
 * twice, a lead deleted and re-added, a retry, a second process, and a spreadsheet uploaded twice
 * by mistake all produce exactly one welcome. No new table and no new column — the record of "we
 * sent this" is the record that prevents sending it again.
 *
 * A CONFIGURATION PROBLEM DOES NOT SPEND THE ONE CHANCE. Because any logged welcome counts, a
 * refusal recorded while no mailbox was connected would permanently consume the welcome for every
 * lead who arrived first. So the three refusals that are about SETUP rather than about this lead —
 * master switch off, template switched off, no CRM mailbox — are checked before dispatch and cause
 * a quiet skip, leaving the lead eligible for the pass after somebody fixes it. Only a real attempt
 * to deliver spends it. See `welcomeBlockedReason`.
 *
 * OFF UNTIL ASKED FOR. `welcome` defaults to false, with the other two timer-driven sends.
 */
@Injectable()
export class LeadWelcomeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LeadWelcomeService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: CrmAdvancedEmailService,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.LEAD_WELCOME_DISABLED === '1') {
      this.log.log(
        `New-lead welcome emails not scheduled (${process.env.LEAD_WELCOME_DISABLED === '1'
          ? 'LEAD_WELCOME_DISABLED=1' : schedulerSkipReason()}).`,
      );
      return;
    }

    registerWorker('lead-welcome', POLL_INTERVAL_MS);
    /*
     * `clusterTick`, like every sweep here that reaches a real person. The "already welcomed?" check
     * is a read-then-write, so two processes genuinely overlapping could both see "not yet" and both
     * send. The lock is what makes that impossible with Redis; without it the behaviour is a
     * single-instance deployment's, unchanged.
     */
    const tick = clusterTick({ redis: this.redis, cache: this.cache }, 'lead-welcome', () => this.sweep());
    setTimeout(tick, FIRST_PASS_MS).unref?.();
    this.timer = setInterval(tick, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.log.log(`New-lead welcome emails every ${POLL_INTERVAL_MS / 60000} minutes (first pass in ${FIRST_PASS_MS / 1000}s).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. `now` is injectable so a test can place leads in time rather than wait.
   *
   * Returns what it did rather than nothing, so a caller — and a test — can assert on sends and
   * skips instead of on log lines.
   */
  async sweep(now: Date = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
    const since = new Date(now.getTime() - NEW_LEAD_WINDOW_MS);

    /*
     * ==============================================================================================
     * THE ALREADY-WELCOMED EXCLUSION HAPPENS IN THE DATABASE, BEFORE THE LIMIT.
     *
     * This was a Prisma `findMany` with `take: 100` and the "has this address had a welcome?" check
     * done afterwards, per lead, in the loop. The consequence was worse here than for the greetings,
     * because this window MOVES:
     *
     *   500 leads arrive. Pass one welcomes the oldest hundred. Pass two fetches the same hundred —
     *   they are still inside the 24-hour window and still the lowest ids — finds them all welcomed,
     *   and stops. Leads 101 to 500 are never fetched, and twenty-four hours later they fall out of
     *   the window entirely. They do not get a late welcome; they get none, and nothing reports it.
     *
     * Excluding welcomed addresses in the query is what makes the set drain: every pass sees only
     * what is left, so a hundred at a time clears five hundred in five passes, all well inside the
     * window. Raising the limit would only move the number at which the silence starts.
     * ==============================================================================================
     *
     * RAW, BECAUSE THE EXCLUSION IS NOT A RELATION. `crm_email_log` has no foreign key to `leads` —
     * it records an ADDRESS, deliberately, so that a person imported twice is welcomed once — and
     * Prisma cannot express `NOT EXISTS` against an unrelated table. The id list comes back here and
     * the fields are read through Prisma exactly as before.
     *
     * The predicate is `alreadyWelcomed` transliterated: kind `welcome`, case-insensitively on the
     * address, with no time floor — a welcome is once per address for ever, not once per year.
     * That method is still called below and still guards the case this cannot: two lead rows sharing
     * one address inside a single pass.
     */
    const eligible = await this.prisma.$queryRawUnsafe<{ id: number }[]>(
      `SELECT l.id FROM leads l
        WHERE l.deleted_at IS NULL
          AND l.unsubscribed = false
          AND l.created_at >= $1
          -- \`leads.email\` is NOT NULL, so the only absent address is the empty string — which the
          -- import writes for a row that had no email column. It is still not somewhere to send.
          AND l.email <> ''
          AND NOT EXISTS (
            SELECT 1 FROM crm_email_log w
             WHERE w.kind = 'welcome'
               AND lower(w.recipient) = lower(l.email)
          )
        ORDER BY l.id
        LIMIT ${MAX_PER_PASS}`,
      since,
    );

    const byId = new Map(
      (await this.prisma.leads.findMany({
        where: { id: { in: eligible.map((r) => r.id) } },
        select: {
          id: true, name: true, email: true, owner_user_id: true, assigned_to: true, created_at: true,
        },
      })).map((l) => [l.id, l]),
    );
    // Re-ordered to the query's order: `findMany` does not promise the order of an `in` list, and
    // the oldest-first sweep is what makes a backlog drain predictably rather than in id soup.
    const leads = eligible.map((r) => byId.get(r.id)).filter((l): l is NonNullable<typeof l> => !!l);

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    /*
     * Addresses welcomed during THIS pass.
     *
     * `alreadyWelcomed` reads `crm_email_log`, which the send itself writes — so within one pass the
     * second copy of a person is only caught because the first copy's log row landed first. That is
     * true today and it is a load-bearing accident: it depends on the write happening inside
     * `dispatch`, before this loop comes round again. Two rows for one client is normal (a referral,
     * a couple working with two agents, a reassignment done by creating a new row), so the case is
     * not hypothetical. Remembering it here makes the guarantee explicit and independent of when
     * anything is written.
     */
    const welcomedThisPass = new Set<string>();

    for (const lead of leads) {
      const address = (lead.email ?? '').trim();
      if (!address) { skipped += 1; continue; }

      const key = address.toLowerCase();
      if (welcomedThisPass.has(key)) { skipped += 1; continue; }
      if (await this.alreadyWelcomed(address)) { skipped += 1; continue; }

      const sender = await this.senderFor(lead.owner_user_id, lead.assigned_to);

      /*
       * Setup problems skip WITHOUT logging a welcome, so the lead stays eligible. Reported at warn
       * rather than swallowed: "no CRM email account is connected" is a thing somebody has to go and
       * fix, and a silent skip is how it stays broken for a month.
       */
      const blocked = await this.email.welcomeBlockedReason(sender.user.id ?? null);
      if (blocked) {
        this.log.warn(`Welcome email for lead #${lead.id} not sent — ${blocked}. It will be retried.`);
        skipped += 1;
        continue;
      }

      /*
       * Marked before the attempt, not after. A send that throws has still reached the mail layer,
       * and trying the other copy of the same person straight afterwards is how one failure becomes
       * two emails to somebody who was meant to get one.
       */
      welcomedThisPass.add(key);

      try {
        const outcome = await this.email.sendWelcomeEmail(
          { id: lead.id, name: lead.name, email: address },
          sender,
        );
        await this.recordOnLead(lead.id, address, sender, outcome);
        if (outcome.success) sent += 1; else skipped += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed += 1;
        this.log.warn(`Welcome email to lead #${lead.id} failed: ${message}`);
        await this.recordOnLead(lead.id, address, sender, { success: false, message });
      }
    }

    if (sent || failed) this.log.log(`New-lead welcomes: ${sent} sent, ${skipped} skipped, ${failed} failed.`);
    return { sent, skipped, failed };
  }

  /**
   * Has this ADDRESS ever had a welcome?
   *
   * By address rather than by lead id, and that is the whole of the import protection: a person
   * uploaded twice is two rows and one human being, and the second row must not produce a second
   * "welcome to the brokerage". Any logged attempt counts — see the class comment for why a setup
   * refusal never reaches the log in the first place.
   */
  private async alreadyWelcomed(recipient: string): Promise<boolean> {
    const found = await this.prisma.crm_email_log.findFirst({
      where: { kind: 'welcome', recipient: { equals: recipient, mode: 'insensitive' } },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Who this lead's welcome comes from: their own agent, else the brokerage.
   *
   * The agent is the owner, then the assignee — the same order the greetings use, so one lead never
   * has two different "their agent"s depending on which email is going out. An agent who is no
   * longer active is not used: their mailbox may be disconnected and their name should not be
   * introducing anybody. That falls through to the brokerage, which is a real sender, rather than
   * to nothing.
   */
  async senderFor(ownerId: number | null, assignedTo: number | null): Promise<WelcomeSender> {
    const brokerage = await this.brokerage();
    const id = ownerId ?? assignedTo;

    if (id) {
      const agent = await this.prisma.users.findFirst({
        where: { id, status: 'Active' },
        include: { user_permissions: true },
      });
      if (agent) {
        return {
          user: agent as unknown as AuthUserRecord,
          agentName: agent.name ?? brokerage.name,
          agentEmail: agent.email ?? brokerage.email,
          agentPhone: agent.phone ?? brokerage.phone,
          brokerageName: brokerage.name,
          brokerageContact: brokerage.contact,
        };
      }
    }

    /*
     * The brokerage's own leads. `id: null` is what makes `senderFor(null, 'crm')` fall through to
     * the brokerage's CRM mailbox, and it is the honest value: nobody is sending this.
     *
     * `agent*` carries the brokerage's details rather than empty strings, so the default template —
     * which introduces a person by name and gives an address to reply to — reads correctly for a
     * lead who has not been assigned to anybody yet.
     */
    return {
      user: { id: null, name: brokerage.name, role: 'system', user_permissions: [] } as unknown as AuthUserRecord,
      agentName: brokerage.name,
      agentEmail: brokerage.email,
      agentPhone: brokerage.phone,
      brokerageName: brokerage.name,
      brokerageContact: brokerage.contact,
    };
  }

  /** The brokerage's own name and contact details, from Company Settings. */
  private async brokerage(): Promise<{ name: string; email: string; phone: string; contact: string }> {
    const row = await this.prisma.company_settings.findFirst({ orderBy: { id: 'asc' } });
    const name = (row?.name ?? '').trim() || 'our brokerage';
    const email = (row?.email ?? '').trim();
    const phone = (row?.phone ?? '').trim();
    const address = (row?.address ?? '').trim();

    // Whatever is actually filled in, joined into one printable line. A template that prints
    // `{{ brokerage_contact }}` should never render a row of stray separators.
    const contact = [name, address, phone, email].filter(Boolean).join(' · ');
    return { name, email, phone, contact };
  }

  /**
   * Put the welcome in the lead's own communication history, where an agent looks.
   *
   * `crm_email_log` already records every CRM send, but that is the brokerage-wide log behind CRM
   * Settings — an agent opening the lead would see no sign that the brokerage had already written
   * to them, and would introduce themselves a second time. Failures are recorded too, with the
   * reason: a history that shows only successes is worse than none, which is the rule the manual
   * send on this same table already follows.
   */
  private async recordOnLead(
    leadId: number, recipient: string, sender: WelcomeSender, outcome: { success: boolean; message: string },
  ): Promise<void> {
    try {
      await this.prisma.lead_emails.create({
        data: {
          lead_id: leadId,
          recipient,
          subject: 'Welcome email',
          body: outcome.success
            ? 'Sent automatically when the lead was received.'
            : `Not sent automatically. ${outcome.message}`,
          status: outcome.success ? 'sent' : 'failed',
          error: outcome.success ? null : outcome.message.slice(0, 500),
          account_id: null,
          sent_by: sender.user.name ?? null,
          user_id: sender.user.id ?? null,
          sent_at: new Date(),
        },
      });
    } catch (err) {
      // The email is the thing that mattered and it has already happened. A history write that
      // fails is worth a line in the log, not an exception that would be counted as a send failure.
      this.log.warn(`Could not record the welcome on lead #${leadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
