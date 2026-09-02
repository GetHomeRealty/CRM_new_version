import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as fs from 'fs/promises';
import * as path from 'path';
import { STORAGE_ROOT } from '../config/storage';
import { threadKeyFor } from './mailbox';
import { PrismaService } from '../prisma/prisma.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { GoogleAuthError, GoogleService, isPermanentAuthFailure } from '../google/google.service';
// Which OAuth client minted this token — the one fact that tells a real revocation apart from a
// token being presented to the wrong Google client.
import { mailClientId } from '../google/google.constants';
// One-way fingerprint, so a log can prove WHICH credential was used without disclosing it.
import { tokenFingerprint } from '../common/token-fingerprint';

import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
/** How often the poller pulls new mail for every sync-enabled account. */
/**
 * How often connected mailboxes are polled for new mail.
 *
 * Mail is expected to turn up in the Inbox on its own, so this is a minute rather than the
 * five it used to be — long enough not to hammer the IMAP server, short enough that a
 * message does not feel like it needs the "Sync now" button. Override with
 * IMAP_POLL_SECONDS; the floor stops a stray 0 or 1 from turning it into a hot loop.
 */
const POLL_INTERVAL_MS = Math.max(15, Number(process.env.IMAP_POLL_SECONDS ?? 60)) * 1000;
/** A first pass shortly after boot, so a restart does not leave a silent gap until the first tick. */
/** Mailboxes synced at once. Enough to overlap the waiting, few enough to stay polite. */
const POLL_CONCURRENCY = Math.max(1, Number(process.env.IMAP_POLL_CONCURRENCY ?? 4));
const FIRST_POLL_DELAY_MS = 8 * 1000;
/** Most messages to pull in a single sync, so a long-neglected mailbox can't stall a poll. */
const MAX_PER_SYNC = 50;
/** How far back the very first sync of an account reaches. */
const FIRST_SYNC_DAYS = 14;

export interface SyncResult {
  fetched: number;
  matched: number;
  error: string | null;
}

/** Make parsed email text safe for Prisma's JSON protocol and PostgreSQL text columns. */
export function normalizeInboundText(value: string, maxLength?: number): string {
  const clean = (input: string): string => {
    let output = '';
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      if (code === 0) continue;
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          output += input[i] + input[i + 1];
          i += 1;
        } else {
          output += '\ufffd';
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        output += '\ufffd';
      } else {
        output += input[i];
      }
    }
    return output;
  };

  const cleaned = clean(value);
  return maxLength === undefined ? cleaned : clean(cleaned.slice(0, maxLength));
}

/**
 * Which of the UIDs a SEARCH returned to pull on this pass.
 *
 * Extracted so it can be tested directly: the bug it replaces lost mail silently, and a silent
 * loss is not something a passing suite should ever be able to hide again.
 *
 * Strictly newer than `lastUid`, ascending, capped at `max` — and the cap keeps the OLDEST of
 * them. That last part is the whole point. Taking the newest, as this once did, meant `last_uid`
 * jumped to the top of the mailbox and every message under the window was skipped for good.
 * Oldest-first drains a backlog a batch per poll instead of discarding it.
 */
export function selectSyncBatch(found: number[] | false | null | undefined, lastUid: number | null, max: number): number[] {
  return countNewUids(found, lastUid).sort((a, b) => a - b).slice(0, max);
}

/**
 * Every UID newer than `lastUid`, unsorted and uncapped — what the batch was taken from.
 *
 * `false` is in the input type because ImapFlow's `search()` returns it when the mailbox rejects
 * the query, which is why `||` is used below rather than `??`: nullish coalescing would let
 * `false` straight through.
 */
export function countNewUids(found: number[] | false | null | undefined, lastUid: number | null): number[] {
  const floor = lastUid ?? 0;
  return (found || []).filter((u) => u > floor);
}

/**
 * Whether a completed sync should raise a "you have new mail" notification.
 *
 * Extracted for the same reason as `selectSyncBatch`: the alternative is a boolean buried inside a
 * method that cannot run without a live IMAP server, which means the rule would go untested and
 * the next person to widen it would not hear about it.
 *
 * Three things must all hold, and each rules out a real case:
 *   `fetched`        nothing new arrived, so there is nothing to say
 *   `userId`         a brokerage mailbox belongs to nobody in particular; there is no one to tell
 *   `isPrimary`      the mailbox is the owner's primary one
 *
 * That last is the point of this function. A person may have several addresses syncing — one they
 * work from, a shared enquiries box, an old address kept for archive — and notifying for all of
 * them buried the line that mattered under the ones they only keep for reference. The other
 * mailboxes still sync and their mail still arrives in the Inbox; what stops is the interruption.
 */
/**
 * Where the "new mail" notification should take the reader.
 *
 * STRAIGHT TO THE MESSAGE when there is exactly one. This always pointed at `/crm/inbox`, which
 * opened the mailbox and left them to find the message the notification was about — easy with one
 * new mail, steadily less so once the list has moved on, which is the moment the notification was
 * most worth following.
 *
 * A BATCH KEEPS THE PLAIN LINK, deliberately. "You have 3 new emails" has no single message to
 * open, and picking one of the three would be a guess presented as a destination.
 *
 * Exported and pure for the same reason `shouldNotifyNewMail` is: it is a decision worth asserting
 * directly rather than through a mailbox, an IMAP connection and a dispatcher.
 */
export function newMailLink(fetched: number, savedId: number | null): string {
  return fetched === 1 && savedId !== null && Number.isInteger(savedId) && savedId > 0
    ? `/crm/inbox?message=${savedId}`
    : '/crm/inbox';
}

export function shouldNotifyNewMail(
  account: { user_id: number | null; is_default: boolean },
  fetched: number,
): boolean {
  return fetched > 0 && account.user_id !== null && account.is_default === true;
}

type AccountRow = {
  id: number; user_id: number | null; username: string | null; from_email: string;
  password: string | null; encryption: string | null; imap_host: string | null; imap_port: number | null;
  imap_encryption: string | null; last_uid: number | null;
  /** Whether this is the owner's primary mailbox. Only that one raises a new-mail notification. */
  is_default: boolean;
  /** When the stored credential was last written. Logged on refresh failure so a token can be
   *  tied back to the reconnect that produced it. Optional: the rows are selected whole, but
   *  callers constructing this type by hand should not be forced to supply it. */
  updated_at?: Date | null;
};

/**
 * Pulls received mail from users' connected mailboxes over IMAP.
 *
 * Everything is per-account and per-user: a sync only ever touches the one mailbox it was given
 * credentials for, and stored messages carry the account owner's id so no inbox query can cross
 * users. Nothing is sent here — this is strictly inbound.
 *
 * The poll is incremental. Each account remembers the highest IMAP UID it has fetched, so a poll
 * asks the server only for messages newer than that; the first-ever sync reaches back a couple of
 * weeks. Re-fetching is harmless anyway — messages are deduped on (account, UID).
 */
/** What ImapFlow needs to authenticate: a user plus either a password or an OAuth access token. */
export interface ImapAuth { user: string; pass?: string; accessToken?: string }

@Injectable()
export class ImapSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ImapSyncService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  /**
   * Accounts currently being synced. The background poller guards itself with `polling`, but
   * the manual "Sync now" button reaches syncAccount directly — so a click landing while the
   * poller was working the same mailbox ran two syncs at once. Both would look up a UID, both
   * would find nothing, and both would insert: one won, the other died on the
   * (account_id, uid) unique index. Worse, that thrown error skipped the code that advances
   * `last_uid`, so every later poll re-fetched the same range and failed the same way — the
   * mailbox stopped pulling new mail permanently.
   */
  private readonly syncing = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypt: LaravelCryptService,
    private readonly google: GoogleService,
    // Only used to decide whether THIS process should run a given pass — see `clusterTick`.
    private readonly redis: RedisService,
    private readonly cache: CacheService,
    /** Optional so existing constructions — including this service's specs — keep working. */
    private readonly dispatcher?: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    // A background poll on top of the manual "Sync now" button. Skipped in tests, when this
    // process is not the scheduler owner, and when disabled outright — so a test run never opens
    // real network connections, and a second instance never races this one on the same mailbox.
    if (!schedulersEnabled() || process.env.IMAP_POLL_DISABLED === '1') {
      this.log.log(`IMAP polling not started (${process.env.IMAP_POLL_DISABLED === '1' ? 'IMAP_POLL_DISABLED=1' : schedulerSkipReason()}). "Sync now" still works.`);
      return;
    }

    // setInterval alone means the first poll is a whole interval away, so every restart left a
    // window where nothing synced and mail only appeared if someone pressed "Sync now". Kick
    // one off shortly after boot instead — delayed a little so it does not compete with startup.
    this.first = setTimeout(() => { void this.pollAll(); }, FIRST_POLL_DELAY_MS);
    if (typeof this.first.unref === 'function') this.first.unref();

    registerWorker('imap-sync', POLL_INTERVAL_MS);
    /*
     * `clusterTick`, not `trackedTick`: two processes polling one mailbox race on the same messages.
     * With Redis exactly one process polls per pass; without it, unchanged from before.
     */
    this.timer = setInterval(
      clusterTick({ redis: this.redis, cache: this.cache }, 'imap-sync', () => this.pollAll()),
      POLL_INTERVAL_MS,
    );
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log.log(`IMAP polling every ${POLL_INTERVAL_MS / 1000}s (first pass in ${FIRST_POLL_DELAY_MS / 1000}s)`);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** Sync every account that has inbound sync switched on. Never overlaps with itself. */
  async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const accounts = await this.prisma.mail_accounts.findMany({
        where: { inbound_enabled: true, is_active: true, imap_host: { not: null } },
      });

      /*
       * Mailboxes are synced side by side rather than one after another.
       *
       * Almost all of the time here is waiting, not working: minting a Google access token, the
       * TLS handshake, LOGIN, SELECT, SEARCH, LOGOUT. Measured at ~4.5-5.6 s per account even
       * when there is nothing new to fetch, so three accounts took 15.5 s in sequence — and that
       * whole time sits between a message arriving and it appearing in the Inbox. Overlapping
       * them makes a round take about as long as the slowest single mailbox.
       *
       * Concurrency is capped rather than unbounded: each sync is a live IMAP connection, and a
       * brokerage with twenty accounts opening twenty at once would be rude to the mail server
       * and heavy on this one. Accounts are independent, and syncAccount already refuses to run
       * two syncs for the same mailbox, so nothing here can race.
       */
      const queue = [...accounts];
      const worker = async (): Promise<void> => {
        for (;;) {
          const a = queue.shift();
          if (!a) return;
          try { await this.syncAccount(a as AccountRow); }
          catch (ex) { this.log.warn(`IMAP poll failed for account #${a.id}: ${(ex as Error).message}`); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, accounts.length) }, worker));
    } finally {
      this.polling = false;
    }
  }

  /**
   * Sync one account, confirmed to belong to the user. Used by the manual "Sync now" button.
   *
   * BOTH REFUSALS ARE TYPED, because both were bare `Error`s and therefore 500s.
   *
   * The first is the ownership check — the one that actually decides, since the controller's own
   * lookup is a convenience. The second is reachable by an ordinary user with an SMTP-only account:
   * pressing "Sync now" on it produced an Internal Server Error carrying a perfectly good
   * explanation that nothing would ever render as one.
   *
   * `NotFound` rather than `Forbidden` for the ownership case, matching the Calendar and the
   * message reads: the reply must not distinguish "not yours" from "does not exist".
   */
  async syncForUser(userId: number, accountId: number): Promise<SyncResult> {
    const account = await this.prisma.mail_accounts.findFirst({ where: { id: accountId, user_id: userId } });
    if (!account) throw new NotFoundException({ message: 'That email account no longer exists.' });
    if (!account.imap_host) {
      throw new BadRequestException({
        message: 'This account has no IMAP server configured, so there is nothing to sync.',
      });
    }
    return this.syncAccount(account as AccountRow);
  }

  /**
   * Connect, pull new messages, store them, and record the outcome on the account. A failure is
   * caught and written to `sync_error` rather than thrown, so one bad mailbox never stops a poll.
   */
  async syncAccount(account: AccountRow): Promise<SyncResult> {
    if (!account.imap_host) {
      const error = 'No IMAP server configured.';
      await this.recordOutcome(account.id, error);
      return { fetched: 0, matched: 0, error };
    }
    // Already running for this mailbox — joining in would only duplicate the work and race
    // the insert. Reported as a quiet no-op, not an error: pressing "Sync now" while the
    // poller happens to be busy is normal, and the poll in flight is doing the job anyway.
    if (this.syncing.has(account.id)) {
      return { fetched: 0, matched: 0, error: null };
    }
    this.syncing.add(account.id);
    try {
      return await this.runSync(account as AccountRow & { imap_host: string });
    } finally {
      this.syncing.delete(account.id);
    }
  }

  /**
   * The actual sync, guarded by syncAccount so only one runs per mailbox at a time.
   * The `imap_host` narrowing is in the signature rather than re-checked here, so the
   * caller's guard is what makes this callable at all.
   */
  /**
   * The credentials for one mailbox, or the reason there are none.
   *
   * EXTRACTED SO THE IDLE SUPERVISOR SHARES IT. `ImapIdleService` opens a long-lived connection to
   * the same mailboxes with the same credentials; a second copy of this would be a second place for
   * the Gmail refresh, the "Testing mode expires in 7 days" explanation and the encryption defaults
   * to drift. The behaviour here is unchanged — the caller records the outcome exactly as before.
   *
   * Returns the error as a STRING rather than throwing, because both callers write it to
   * `sync_error` on the account, which is what the Inbox screen shows the user.
   */
  async resolveAuth(account: AccountRow): Promise<{ auth: ImapAuth } | { error: string }> {
    // OAuth (Gmail) accounts authenticate with a short-lived access token minted from the stored
    // refresh token; password accounts decrypt their stored password. Either yields an ImapFlow auth.
    const user = account.username || account.from_email;
    const auth: ImapAuth = { user };
    if (account.encryption === 'oauth') {
      const refresh = this.crypt.decryptString(account.password);
      if (!refresh) return { error: 'No Google token stored for this account — reconnect it.' };
      try {
        // 'mail': this token was minted by the Gmail connect, which may run on its own Google
        // project. Refreshing it against the calendar client would fail permanently.
        const tok = await this.google.refresh(refresh, 'mail');
        auth.accessToken = tok.access_token;
      } catch (ex) {
        /*
         * DECIDED ON GOOGLE'S CODE, AND WHAT GOOGLE ACTUALLY SAID IS RECORDED.
         *
         * This regex-matched Google's English (`/invalid_grant|expired or revoked/`) and replaced
         * it with a fixed sentence blaming a seven-day Testing-mode expiry. Both halves were wrong
         * in the way that costs days:
         *
         *   THE DECISION. `tokenRequest` already raises a `GoogleAuthError` carrying a
         *   machine-readable `code`, precisely so nobody has to pattern-match prose — the comment
         *   there says so. This path threw the code away and matched the sentence anyway, which is
         *   the same bug in a second place.
         *
         *   THE EXPLANATION. It asserted a cause rather than reporting one. Once the OAuth app is
         *   Internal there is no seven-day expiry at all, so the message confidently named a
         *   mechanism that could not be operating and sent the investigation after it. An account
         *   failing seconds after a fresh authorisation was still told it had "expired".
         *
         * The underlying Google answer is now logged with enough context to tell two mailboxes on
         * the SAME client apart — which is the comparison that identifies an account-specific
         * revocation. Deliberately no token, no secret, no authorisation code: the error code and
         * Google's own description are what carry the diagnosis.
         */
        const code = ex instanceof GoogleAuthError ? ex.code : 'unknown';
        const detail = (ex as Error).message;
        /*
         * The fingerprint is the point of this line. Compare it with the `refresh_fingerprint` on
         * the "Gmail credential SAVED" line from the reconnect: if they MATCH, this row is using
         * the credential the latest grant produced and Google is genuinely refusing it. If they
         * DIFFER, the row is still holding a pre-revocation token and the reconnect never reached
         * it — two different problems with two different fixes.
         */
        this.log.warn(
          `Google token refresh FAILED — operation=imap.resolveAuth account=#${account.id} email=${account.from_email} `
          + `oauth_client_project=${(mailClientId().split('-')[0] || 'unknown')} google_error=${code} `
          + `google_description="${detail}" refresh_fingerprint=${tokenFingerprint(refresh)} `
          + `credential_updated_at=${account.updated_at ? new Date(account.updated_at).toISOString() : 'unknown'} `
          + `at=${new Date().toISOString()}`,
        );
        return {
          error: isPermanentAuthFailure(ex)
            // Says what happened and what to do, without inventing why it happened.
            ? `Google refused this mailbox's saved authorisation (${code}). Reconnect it under Email Accounts. `
              + 'If it fails again within a day, the cause is on the Google account rather than in this application.'
            : `Google token refresh failed: ${detail}`,
        };
      }
    } else {
      const password = this.crypt.decryptString(account.password);
      if (!password) return { error: 'No password stored for this account.' };
      auth.pass = password;
    }
    return { auth };
  }

  /**
   * The connection settings for one mailbox. Shared with the IDLE supervisor for the same reason
   * `resolveAuth` is: one definition of how this application talks to a mail server.
   *
   * `socketTimeout` is the caller's, because the two have opposite needs — a poll must fail fast
   * rather than hang, and an idle connection is SUPPOSED to sit silent for minutes at a time.
   */
  connectionFor(account: AccountRow & { imap_host: string }, auth: ImapAuth, socketTimeout: number): ImapFlow {
    const port = account.imap_port ?? 993;
    // ssl / 993 => implicit TLS; tls / 143 => STARTTLS. Matches the SMTP encryption field.
    const secure = account.imap_encryption ? account.imap_encryption === 'ssl' : port === 993;
    return new ImapFlow({ host: account.imap_host, port, secure, auth, logger: false, socketTimeout });
  }

  private async runSync(account: AccountRow & { imap_host: string }): Promise<SyncResult> {
    const resolved = await this.resolveAuth(account);
    if ('error' in resolved) {
      await this.recordOutcome(account.id, resolved.error);
      return { fetched: 0, matched: 0, error: resolved.error };
    }

    // Fail fast rather than hang a poll on an unreachable server.
    const client = this.connectionFor(account, resolved.auth, 20000);

    // ImapFlow is an EventEmitter that emits an asynchronous 'error' event on auth/connection
    // failure — separately from the connect() promise rejection the try/catch below handles.
    // With no listener, Node treats that emitted error as uncaught and kills the whole process
    // (a bad-credential mailbox would crash the entire API). Swallow it here: the catch block
    // already records the real outcome, so this only needs to stop the process from dying.
    client.on('error', (err: Error) => {
      this.log.warn(`IMAP client error for account #${account.id}: ${err.message}`);
    });

    let fetched = 0, matched = 0, maxUid = account.last_uid ?? 0;
    /** The id of the last message stored this run, so a one-message batch can link to it. */
    let savedId: number | null = null;
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Ask the server for the UIDs to consider: everything newer than what we last fetched, or
        // the last couple of weeks on the very first sync. `${last+1}:*` always includes at least
        // the final message even when none are new, so filter to strictly-newer UIDs.
        const search = account.last_uid
          ? { uid: `${account.last_uid + 1}:*` }
          : { since: new Date(Date.now() - FIRST_SYNC_DAYS * 86400000) };
        const found = await client.search(search, { uid: true });
        // Oldest-first and capped — see selectSyncBatch for why the direction matters.
        const newCount = countNewUids(found, account.last_uid).length;
        const batch = selectSyncBatch(found, account.last_uid, MAX_PER_SYNC);
        if (newCount > batch.length) {
          this.log.log(
            `Account #${account.id}: ${newCount} new messages, taking the oldest ${batch.length} `
            + `this pass; the remainder follows on the next poll.`,
          );
        }

        for (const uid of batch) {
          // Deduped on (account, uid): a re-poll that re-sees a message skips it, and never
          // re-downloads its body.
          const already = await this.prisma.inbound_emails.findUnique({
            where: { account_id_uid: { account_id: account.id, uid } }, select: { id: true },
          });
          if (already) { maxUid = Math.max(maxUid, uid); continue; }

          const record = await this.fetchOne(client, uid);
          if (!record) {
            /*
             * The server listed this UID in SEARCH but returned nothing for it — almost always a
             * message deleted or moved between the two calls, so there is nothing left to fetch and
             * advancing past it loses nothing. Logged rather than passed over in silence, because
             * the alternative reading (the fetch genuinely failed) would mean a real message is
             * being stepped over, and that must never be invisible. A real transport error throws
             * instead, and the catch below records it without advancing last_uid at all.
             */
            this.log.warn(`Account #${account.id}: UID ${uid} was listed but could not be fetched — skipping (likely deleted on the server).`);
            maxUid = Math.max(maxUid, uid);
            continue;
          }

          const leadId = await this.matchLead(account.user_id, record.from_email);
          if (leadId) matched++;

          // The check above is an optimisation — it avoids re-downloading a body we already
          // have — not a guarantee. Between that read and this write another worker (a second
          // app instance, say, where the in-memory guard cannot reach) may have stored the
          // same UID. Losing the whole sync to that is the wrong trade: the row we wanted
          // exists either way, so a duplicate is treated as success and the loop carries on
          // to advance last_uid.
          try {
            const saved = await this.prisma.inbound_emails.create({
              data: {
                user_id: account.user_id ?? -1, account_id: account.id, uid,
                message_id: record.message_id, from_email: record.from_email, from_name: record.from_name,
                to_email: record.to_email, subject: record.subject, snippet: record.snippet,
                body_text: record.body_text, body_html: record.body_html,
                received_at: record.received_at, lead_id: leadId, created_at: new Date(),
                in_reply_to: record.in_reply_to,
                references_header: record.references_header,
                // A message that starts a conversation is its own thread, so this is never null for
                // a message that has an id — see `threadKeyFor`.
                thread_key: record.thread_key,
                has_attachments: record.attachments.length > 0,
              },
              select: { id: true },
            });
            // Written AFTER the row exists, so an attachment can never be orphaned by a failed
            // insert — and failing to store one does not lose the message itself.
            if (record.attachments.length) await this.storeAttachments(saved.id, record.attachments);
            fetched++;
            // Only meaningful when `fetched === 1`; a larger batch has no single message to open.
            savedId = saved.id;
          } catch (ex) {
            // P2002 = unique violation on (account_id, uid): someone else got there first.
            if ((ex as { code?: string }).code !== 'P2002') throw ex;
            if (leadId) matched--;   // it was not this run that matched it
          }

          /*
           * Only now, with the row committed (or confirmed already present), does the window move.
           * It used to advance at the top of the loop, before the message had been fetched or
           * stored, so anything that dropped out in between was stepped over and never retried.
           * A throw above skips this entirely and leaves last_uid where it was, so the whole batch
           * is re-attempted on the next poll — re-fetching is cheap and deduped, losing mail is not.
           */
          maxUid = Math.max(maxUid, uid);
        }
      } finally {
        lock.release();
      }
      await this.recordOutcome(account.id, null, maxUid);

      /*
       * ONE notification per poll, not one per message.
       *
       * A quiet mailbox that receives forty messages overnight would otherwise produce forty
       * notifications, which is worse than none: the person stops reading them and the useful ones
       * are lost in the noise. The summary is what somebody actually wants — "you have new mail" —
       * and the Inbox screen is where the detail lives.
       *
       * Best-effort, outside everything that matters: mail has already been stored, and the sync
       * must not be marked failed because a notification could not be delivered.
       */
      /*
       * AND ONLY FOR THE PRIMARY MAILBOX — see `shouldNotifyNewMail` for which cases that rules
       * out and why.
       *
       * The read side enforces the same rule a second time, in `primaryMailboxOnly` in
       * notification-center.service.ts, and that is not redundancy. This check governs only what is
       * CREATED, and creation happens once: somebody who makes a different address primary tomorrow
       * should stop seeing yesterday's lines from the old one, and nothing decided here can reach
       * back and do that.
       */
      if (this.dispatcher && shouldNotifyNewMail(account, fetched)) {
        await this.dispatcher.dispatch({
          category: 'inbox_new_mail',
          // Non-null by `shouldNotifyNewMail`, which the compiler cannot see across the call.
          userId: account.user_id as number,
          title: fetched === 1 ? 'You have a new email' : `You have ${fetched} new emails`,
          body: account.from_email || undefined,
          link: newMailLink(fetched, savedId),
          /*
           * Keyed to the account and the highest UID in this batch, so a poll that runs twice over
           * the same window — a retry, or a second process before the cluster lock was added — does
           * not leave two copies of the same news.
           */
          dedupeKey: `inbox-${account.id}-${maxUid}`,
          // Email is `unsupported` for this category, so only these two are meaningful.
          channels: ['in_app', 'push'],
        }).catch(() => {});
      }

      return { fetched, matched, error: null };
    } catch (ex) {
      const error = this.explain((ex as Error).message);
      await this.recordOutcome(account.id, error);
      return { fetched, matched, error };
    } finally {
      try { await client.logout(); } catch { /* already closed */ }
    }
  }

  /** Fetch and parse a single message into the shape we store. */
  private async fetchOne(client: ImapFlow, uid: number): Promise<{
    message_id: string | null; from_email: string | null; from_name: string | null; to_email: string | null;
    subject: string | null; snippet: string | null; body_text: string | null; body_html: string | null;
    received_at: Date;
    /** RFC 5322 threading, so a reply from this mailbox joins the conversation. */
    in_reply_to: string | null; references_header: string | null; thread_key: string | null;
    /** Attachment PARTS, not their bytes — see `storeAttachments`. */
    attachments: { filename: string; mime: string; contentId: string | null; content: Buffer }[];
  } | null> {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const p = await simpleParser(msg.source);
    const fromAddr = p.from?.value?.[0];
    const toText = Array.isArray(p.to) ? p.to.map((t) => t.text).join(', ') : p.to?.text ?? null;
    const text = normalizeInboundText((p.text ?? '').trim());

    /*
     * THREADING AND ATTACHMENTS ARE READ HERE BECAUSE THE PARSE ALREADY HAPPENED.
     *
     * `simpleParser` has the whole message in hand; taking `inReplyTo`, `references` and
     * `attachments` from it costs nothing extra, and re-fetching the source later to get them would
     * mean a second round trip per message against the mail server.
     *
     * `references` arrives as a string or an array depending on the sender, so both are normalised
     * to one space-separated string.
     */
    const rawReferences = Array.isArray(p.references) ? p.references.join(' ') : (p.references ?? null);
    const references = rawReferences ? normalizeInboundText(rawReferences) : null;
    const inReplyTo = p.inReplyTo ? normalizeInboundText(p.inReplyTo, 512) : null;
    const attachments = (p.attachments ?? [])
      .filter((a) => a.content && Buffer.isBuffer(a.content))
      .map((a) => ({
        filename: normalizeInboundText(String(a.filename ?? 'attachment').replace(/[\\/:*?"<>|]+/g, ' ').trim(), 255) || 'attachment',
        mime: normalizeInboundText(String(a.contentType ?? 'application/octet-stream'), 255),
        contentId: a.cid ? normalizeInboundText(`<${String(a.cid).replace(/^<|>$/g, '')}>`, 255) : null,
        content: a.content as Buffer,
      }));

    return {
      in_reply_to: inReplyTo,
      references_header: references,
      thread_key: threadKeyFor({ references, inReplyTo, messageId: p.messageId ?? null }),
      attachments,
      message_id: p.messageId ? normalizeInboundText(p.messageId, 512) : null,
      from_email: fromAddr?.address ? normalizeInboundText(fromAddr.address.toLowerCase(), 320) : null,
      from_name: fromAddr?.name ? normalizeInboundText(fromAddr.name, 255) : null,
      to_email: toText ? normalizeInboundText(toText, 320) : null,
      subject: p.subject ? normalizeInboundText(p.subject, 998) : null,
      snippet: text ? normalizeInboundText(text.replace(/\s+/g, ' '), 300) : null,
      body_text: text || null,
      body_html: typeof p.html === 'string' ? normalizeInboundText(p.html) : null,
      received_at: p.date ?? new Date(),
    };
  }

  /**
   * Write a message's attachments to disk and record their metadata.
   *
   * THE BYTES DO NOT GO IN THE DATABASE. They live under STORAGE_ROOT beside transaction documents,
   * because a ten-megabyte attachment in a column is read into memory every time the row is touched
   * — including by a list query that wanted a subject line — and it lands in every backup of the
   * mail table.
   *
   * A failure here is logged and swallowed: the MESSAGE is the thing that must not be lost, and a
   * mail sync that aborts because one attachment could not be written would leave the mailbox
   * stuck on that UID for ever.
   */
  private async storeAttachments(
    emailId: number,
    parts: { filename: string; mime: string; contentId: string | null; content: Buffer }[],
  ): Promise<void> {
    const rel = path.join('mail', 'inbound', String(emailId));
    try {
      await fs.mkdir(path.join(STORAGE_ROOT, rel), { recursive: true });
      let n = 0;
      for (const a of parts) {
        n += 1;
        const relFile = path.join(rel, `${n}-${a.filename}`);
        await fs.writeFile(path.join(STORAGE_ROOT, relFile), a.content);
        await this.prisma.inbound_email_attachments.create({
          data: {
            email_id: emailId, filename: a.filename, mime: a.mime,
            size_bytes: a.content.length, content_id: a.contentId,
            storage_path: relFile.split(path.sep).join('/'), created_at: new Date(),
          },
        });
      }
    } catch (err) {
      this.log.warn(`Could not store attachments for message #${emailId}: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  /**
   * Match a message to a lead by sender address, scoped to the account owner's own leads — the
   * same ownership rule the rest of the CRM uses, so a match can only ever be one of the user's
   * own leads.
   */
  private async matchLead(userId: number | null, fromEmail: string | null): Promise<number | null> {
    if (!userId || !fromEmail) return null;
    const lead = await this.prisma.leads.findFirst({
      where: {
        deleted_at: null,
        email: { equals: fromEmail, mode: 'insensitive' },
        OR: [{ assigned_to: userId }, { owner_user_id: userId }],
      },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    return lead?.id ?? null;
  }

  /**
   * `updateMany`, not `update`, because the account may be gone by the time we write the outcome.
   *
   * A poll cycle takes seconds; deleting a mail account takes one click. Delete one mid-cycle and
   * `update({ where: { id } })` throws P2025 — "No record was found for an update" — which the
   * caller logged as `IMAP poll failed for account #<id>`, and the screen showed as a mail
   * SYNCHRONISATION error. So removing an account produced a scary message about the sync being
   * broken, pointing the reader at credentials and ports that were never the problem. Observed
   * exactly that way: a DELETE of account #24857 at 11:12:40, this failure at 11:12:42.
   *
   * `updateMany` matches zero rows and returns `{ count: 0 }` rather than throwing, which is the
   * honest outcome: there is no account left to record anything against.
   */
  private async recordOutcome(accountId: number, error: string | null, maxUid?: number): Promise<void> {
    await this.prisma.mail_accounts.updateMany({
      where: { id: accountId },
      data: {
        last_synced_at: new Date(),
        sync_error: error ? error.slice(0, 500) : null,
        ...(error ? {} : maxUid ? { last_uid: maxUid } : {}),
      },
    });
  }

  /** Turn a raw IMAP/library error into something an agent can act on. */
  private explain(message: string): string {
    const m = message.toLowerCase();
    if (m.includes('auth') || m.includes('credentials') || m.includes('login')) {
      return 'Sign-in was rejected. Check the username and password — Gmail and most providers need an app-specific password, not your normal login.';
    }
    if (m.includes('timeout') || m.includes('econnrefused') || m.includes('enotfound') || m.includes('getaddrinfo')) {
      return 'Could not reach the IMAP server. Check the host and port.';
    }
    if (m.includes('certificate') || m.includes('tls') || m.includes('ssl')) {
      return 'The secure connection failed. Try switching between SSL (port 993) and STARTTLS (port 143).';
    }
    return `Sync failed: ${message}`.slice(0, 500);
  }
}
