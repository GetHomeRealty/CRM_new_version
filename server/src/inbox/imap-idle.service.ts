import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ImapFlow } from 'imapflow';
import { PrismaService } from '../prisma/prisma.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { ImapSyncService } from './imap-sync.service';
import { InboxEventsService } from './inbox-events.service';

/**
 * Holds an IMAP connection open per mailbox so new mail is noticed as it arrives.
 *
 * WHAT IT REPLACES. The Inbox was fed by a sixty-second poll: connect, LOGIN, SELECT, SEARCH,
 * LOGOUT, per account, per minute. Measured at ~4.5-5.6 s per account even with nothing to fetch,
 * so a message waited on average half a minute and at worst a minute plus a sync — and the cost of
 * shortening that was more of the same handshakes, not fewer.
 *
 * IDLE inverts it. The connection stays open and the SERVER speaks first: RFC 2177 lets it push an
 * untagged EXISTS the moment a message lands. ImapFlow enters IDLE on its own once a mailbox is
 * selected and no command is running, and raises `exists` when the count changes — so the work here
 * is not the IDLE command itself but everything around it: which mailboxes to hold, what to do when
 * one drops, and how not to become a connection leak.
 *
 * ================================================================================================
 * IT DOES NOT FETCH ANYTHING. On `exists` it calls `ImapSyncService.syncAccount`, the same method
 * the poll and the "Sync now" button call, over a separate short-lived connection. So there is ONE
 * implementation of what a sync means — dedupe on (account, UID), `last_uid` advancement, lead
 * matching, attachment storage, the notification — and this only decides WHEN it runs.
 *
 * That also makes the failure mode benign: if this service is wrong about when, the poll still runs
 * underneath and mail still arrives on the old schedule.
 * ================================================================================================
 *
 * THE POLL IS NOT REMOVED, and that is a decision rather than an oversight. IDLE connections drop
 * silently — a NAT timeout, a proxy, a server that caps connection age — and a dropped connection
 * that nobody notices is a mailbox that has quietly stopped delivering. The poll is the floor: it
 * catches anything IDLE missed, and it is what makes a bug in this file cost latency instead of
 * mail. Its interval can be lengthened once IDLE has been watched in production; it should not be
 * removed.
 *
 * SINGLE INSTANCE, LIKE EVERY OTHER SCHEDULER HERE. Gated on `schedulersEnabled()`, so exactly one
 * process holds these connections — two would mean two connections per mailbox and two syncs racing
 * on the same UIDs, which is the failure `syncAccount`'s own guard exists to prevent within a
 * process and cannot prevent across them.
 */

/** How often the supervisor reconciles connections against the account list. */
const RECONCILE_MS = Math.max(30, Number(process.env.IMAP_IDLE_RECONCILE_SECONDS ?? 120)) * 1000;

/**
 * The most mailboxes to hold open at once.
 *
 * Each is a live TCP connection and a file descriptor on both ends, and mail servers cap concurrent
 * connections per account and per IP — Gmail allows 15 per account. A brokerage with more accounts
 * than this keeps the rest on the poll, which is what they have today; the cap fails safe rather
 * than opening as many as it can and being throttled into a reconnect storm.
 */
const MAX_CONNECTIONS = Math.max(1, Number(process.env.IMAP_IDLE_MAX ?? 20));

/**
 * How long a connection may sit before it is recycled.
 *
 * RFC 2177 requires a client to re-issue IDLE at least every 29 minutes, and middleboxes drop idle
 * TCP long before that. ImapFlow re-issues on its own; this is the belt to that braces — a
 * connection the server has silently stopped feeding looks identical to a quiet mailbox, and the
 * only way to tell them apart is to replace it periodically and see.
 */
const RECYCLE_MS = Math.max(5, Number(process.env.IMAP_IDLE_RECYCLE_MINUTES ?? 25)) * 60_000;

/** A short wait after `exists` before syncing, so a burst of arrivals becomes one sync. */
const DEBOUNCE_MS = 1_500;

/** Backoff between reconnect attempts for one mailbox: 5s, 10s, 20s … capped. */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

type AccountRow = {
  id: number; user_id: number | null; username: string | null; from_email: string;
  password: string | null; encryption: string | null; imap_host: string | null; imap_port: number | null;
  imap_encryption: string | null; last_uid: number | null; is_default: boolean;
};

/** One mailbox's live connection and the state needed to look after it. */
interface Held {
  client: ImapFlow;
  accountId: number;
  openedAt: number;
  /** Set while a sync triggered by this connection is in flight, so bursts collapse. */
  pending: ReturnType<typeof setTimeout> | null;
  closing: boolean;
}

@Injectable()
export class ImapIdleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ImapIdleService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private stopped = false;

  /** Live connections by account id. The only place a connection is remembered. */
  private readonly held = new Map<number, Held>();
  /** Consecutive failures per account, for the backoff. Cleared on a successful connect. */
  private readonly failures = new Map<number, number>();
  /** When an account may next be attempted, by account id. */
  private readonly nextAttempt = new Map<number, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: ImapSyncService,
    private readonly events: InboxEventsService,
  ) {}

  onModuleInit(): void {
    /*
     * The same three gates the poller uses, plus one of its own.
     *
     * `IMAP_POLL_DISABLED` turns this off too: it is the switch a test run and a second instance
     * already set to mean "do not open real IMAP connections", and honouring only the poll would
     * have made this the one thing that ignored it.
     */
    if (!schedulersEnabled() || process.env.IMAP_POLL_DISABLED === '1' || process.env.IMAP_IDLE_DISABLED === '1') {
      this.log.log(
        `IMAP IDLE not started (${process.env.IMAP_IDLE_DISABLED === '1' ? 'IMAP_IDLE_DISABLED=1'
          : process.env.IMAP_POLL_DISABLED === '1' ? 'IMAP_POLL_DISABLED=1' : schedulerSkipReason()}). Polling still runs.`,
      );
      return;
    }

    // Reconcile shortly after boot, then on a timer. The delay lets the first poll go first, so a
    // restart catches up through the path that is known to work before this one opens anything.
    const first = setTimeout(() => { void this.reconcile(); }, 20_000);
    if (typeof first.unref === 'function') first.unref();

    this.timer = setInterval(() => { void this.reconcile(); }, RECONCILE_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log.log(`IMAP IDLE supervising up to ${MAX_CONNECTIONS} mailboxes (reconcile every ${RECONCILE_MS / 1000}s).`);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.held.keys()].map((id) => this.drop(id, 'shutting down')));
  }

  /** Open connections, for the health endpoint. */
  connectionCount(): number {
    return this.held.size;
  }

  /**
   * Bring the set of held connections in line with the accounts that want one.
   *
   * Runs on a timer rather than reacting to account changes, because the things that make an
   * account eligible — inbound sync switched on, credentials present, the account still active —
   * are edited on several screens and a missed hook would leave a mailbox silently unwatched.
   * Reconciling is cheap and cannot drift.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    try {
      const accounts = await this.prisma.mail_accounts.findMany({
        where: { inbound_enabled: true, is_active: true, imap_host: { not: null } },
        orderBy: [{ is_default: 'desc' }, { id: 'asc' }],
      }) as unknown as AccountRow[];

      const eligible = new Map(accounts.map((a) => [a.id, a]));

      // Drop connections whose account no longer qualifies, and recycle the ones that are old.
      for (const [id, h] of [...this.held]) {
        if (!eligible.has(id)) { await this.drop(id, 'account no longer syncs'); continue; }
        if (Date.now() - h.openedAt > RECYCLE_MS) await this.drop(id, 'recycling');
      }

      /*
       * The primary mailboxes first — that ordering is why `orderBy` names `is_default`.
       *
       * When there are more accounts than connections, the cap has to fall on somebody, and the
       * mailbox somebody actually works from is the one where the delay is felt. The rest keep the
       * poll, which is what every mailbox had before this existed.
       */
      const now = Date.now();
      for (const account of accounts) {
        if (this.held.size >= MAX_CONNECTIONS) break;
        if (this.held.has(account.id)) continue;
        if ((this.nextAttempt.get(account.id) ?? 0) > now) continue;
        await this.open(account);
      }
    } catch (err) {
      this.log.warn(`IMAP IDLE reconcile failed: ${(err as Error).message}`);
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Open and hold one mailbox.
   *
   * `socketTimeout` is deliberately long here — an idle connection is SUPPOSED to sit silent, and
   * the poll's twenty seconds would tear it down every twenty seconds. The recycle timer is what
   * bounds a connection's life instead.
   */
  private async open(account: AccountRow): Promise<void> {
    if (!account.imap_host) return;

    const resolved = await this.sync.resolveAuth(account);
    if ('error' in resolved) {
      /*
       * A credential problem is not retried on the short backoff. It will not fix itself, the poll
       * records it against the account for the user to see, and hammering a mail server with a
       * password it has already rejected is how an IP gets blocked.
       */
      this.penalise(account.id, true);
      this.log.warn(`IMAP IDLE cannot hold account #${account.id}: ${resolved.error}`);
      return;
    }

    const client = this.sync.connectionFor(account as AccountRow & { imap_host: string }, resolved.auth, RECYCLE_MS + 60_000);
    const held: Held = { client, accountId: account.id, openedAt: Date.now(), pending: null, closing: false };

    /*
     * ImapFlow emits 'error' asynchronously, separately from the connect() rejection. With no
     * listener Node treats it as uncaught and kills the process — the same trap the poller
     * documents. Here it also means the connection is gone, so it schedules a reconnect.
     */
    client.on('error', (err: Error) => {
      this.log.warn(`IMAP IDLE connection error on account #${account.id}: ${err.message}`);
      void this.drop(account.id, 'connection error');
    });
    client.on('close', () => {
      if (!held.closing) void this.drop(account.id, 'connection closed');
    });

    /*
     * THE POINT OF THE WHOLE SERVICE. `exists` fires when the mailbox's message count changes,
     * which for INBOX means mail arrived. Debounced, because a delivery of several messages emits
     * several events and one sync collects them all.
     */
    client.on('exists', () => {
      if (held.pending) clearTimeout(held.pending);
      held.pending = setTimeout(() => { held.pending = null; void this.syncNow(account); }, DEBOUNCE_MS);
      if (typeof held.pending.unref === 'function') held.pending.unref();
    });

    try {
      await client.connect();
      // Selecting the mailbox is what makes the connection idle-able; ImapFlow takes it from there.
      await client.mailboxOpen('INBOX');
      this.held.set(account.id, held);
      this.failures.delete(account.id);
      this.nextAttempt.delete(account.id);
      this.log.log(`IMAP IDLE holding ${account.from_email} (account #${account.id}).`);
    } catch (err) {
      this.penalise(account.id, false);
      this.log.warn(`IMAP IDLE could not open account #${account.id}: ${(err as Error).message}`);
      try { await client.logout(); } catch { /* already gone */ }
    }
  }

  /**
   * A message arrived — run the ordinary sync and tell the browser.
   *
   * `syncAccount` refuses a second concurrent run for the same mailbox and returns a quiet no-op, so
   * an `exists` landing while the poll is working that account is harmless.
   */
  private async syncNow(account: AccountRow): Promise<void> {
    try {
      const fresh = await this.prisma.mail_accounts.findUnique({ where: { id: account.id } });
      if (!fresh) return;
      const result = await this.sync.syncAccount(fresh as never);
      if (result.fetched > 0) {
        this.log.log(`IMAP IDLE pulled ${result.fetched} message(s) for account #${account.id}.`);
        this.events.newMail(fresh.user_id, fresh.id, result.fetched);
      }
    } catch (err) {
      this.log.warn(`IMAP IDLE sync failed for account #${account.id}: ${(err as Error).message}`);
    }
  }

  /** Close a held connection and forget it. Safe to call for an account that is not held. */
  private async drop(accountId: number, why: string): Promise<void> {
    const held = this.held.get(accountId);
    if (!held) return;
    held.closing = true;
    if (held.pending) clearTimeout(held.pending);
    this.held.delete(accountId);
    try { await held.client.logout(); } catch { /* the connection is already gone */ }
    this.log.log(`IMAP IDLE released account #${accountId} (${why}).`);
  }

  /**
   * Record a failed attempt and decide when to try again.
   *
   * Exponential from five seconds, capped at five minutes — a mail server that is down comes back,
   * and a client that retries every five seconds for an hour is indistinguishable from an attack.
   * A credential failure waits the maximum immediately: it needs a person, not a retry.
   */
  private penalise(accountId: number, terminal: boolean): void {
    const n = (this.failures.get(accountId) ?? 0) + 1;
    this.failures.set(accountId, n);
    const wait = terminal ? BACKOFF_MAX_MS : Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
    this.nextAttempt.set(accountId, Date.now() + wait);
  }
}
