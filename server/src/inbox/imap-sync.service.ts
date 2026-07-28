import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { PrismaService } from '../prisma/prisma.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { GoogleService } from '../google/google.service';

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

type AccountRow = {
  id: number; user_id: number | null; username: string | null; from_email: string;
  password: string | null; encryption: string | null; imap_host: string | null; imap_port: number | null;
  imap_encryption: string | null; last_uid: number | null;
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
  ) {}

  onModuleInit(): void {
    // A background poll on top of the manual "Sync now" button. Disabled in tests and when the
    // interval is set to 0, so a test run never opens real network connections on its own.
    if (process.env.NODE_ENV === 'test' || process.env.IMAP_POLL_DISABLED === '1') return;

    // setInterval alone means the first poll is a whole interval away, so every restart left a
    // window where nothing synced and mail only appeared if someone pressed "Sync now". Kick
    // one off shortly after boot instead — delayed a little so it does not compete with startup.
    this.first = setTimeout(() => { void this.pollAll(); }, FIRST_POLL_DELAY_MS);
    if (typeof this.first.unref === 'function') this.first.unref();

    this.timer = setInterval(() => { void this.pollAll(); }, POLL_INTERVAL_MS);
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
      for (const a of accounts) {
        try { await this.syncAccount(a as AccountRow); }
        catch (ex) { this.log.warn(`IMAP poll failed for account #${a.id}: ${(ex as Error).message}`); }
      }
    } finally {
      this.polling = false;
    }
  }

  /** Sync one account, confirmed to belong to the user. Used by the manual "Sync now" button. */
  async syncForUser(userId: number, accountId: number): Promise<SyncResult> {
    const account = await this.prisma.mail_accounts.findFirst({ where: { id: accountId, user_id: userId } });
    if (!account) throw new Error('Mail account not found.');
    if (!account.imap_host) throw new Error('This account has no IMAP server configured, so there is nothing to sync.');
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
  private async runSync(account: AccountRow & { imap_host: string }): Promise<SyncResult> {

    // OAuth (Gmail) accounts authenticate with a short-lived access token minted from the stored
    // refresh token; password accounts decrypt their stored password. Either yields an ImapFlow auth.
    const user = account.username || account.from_email;
    const auth: { user: string; pass?: string; accessToken?: string } = { user };
    if (account.encryption === 'oauth') {
      const refresh = this.crypt.decryptString(account.password);
      if (!refresh) {
        const error = 'No Google token stored for this account — reconnect it.';
        await this.recordOutcome(account.id, error);
        return { fetched: 0, matched: 0, error };
      }
      try {
        const tok = await this.google.refresh(refresh);
        auth.accessToken = tok.access_token;
      } catch (ex) {
        const error = `Google token refresh failed: ${(ex as Error).message}`;
        await this.recordOutcome(account.id, error);
        return { fetched: 0, matched: 0, error };
      }
    } else {
      const password = this.crypt.decryptString(account.password);
      if (!password) {
        const error = 'No password stored for this account.';
        await this.recordOutcome(account.id, error);
        return { fetched: 0, matched: 0, error };
      }
      auth.pass = password;
    }

    const port = account.imap_port ?? 993;
    // ssl / 993 => implicit TLS; tls / 143 => STARTTLS. Matches the SMTP encryption field.
    const secure = account.imap_encryption ? account.imap_encryption === 'ssl' : port === 993;
    const client = new ImapFlow({
      host: account.imap_host, port, secure,
      auth,
      logger: false,
      // Fail fast rather than hang a poll on an unreachable server.
      socketTimeout: 20000,
    });

    // ImapFlow is an EventEmitter that emits an asynchronous 'error' event on auth/connection
    // failure — separately from the connect() promise rejection the try/catch below handles.
    // With no listener, Node treats that emitted error as uncaught and kills the whole process
    // (a bad-credential mailbox would crash the entire API). Swallow it here: the catch block
    // already records the real outcome, so this only needs to stop the process from dying.
    client.on('error', (err: Error) => {
      this.log.warn(`IMAP client error for account #${account.id}: ${err.message}`);
    });

    let fetched = 0, matched = 0, maxUid = account.last_uid ?? 0;
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
        const uids = (found || [])
          .filter((u) => u > (account.last_uid ?? 0))
          .sort((a, b) => a - b);
        // Cap to the most recent, so a long-neglected mailbox can't stall a single poll.
        const recent = uids.slice(-MAX_PER_SYNC);

        for (const uid of recent) {
          maxUid = Math.max(maxUid, uid);
          // Deduped on (account, uid): a re-poll that re-sees a message skips it, and never
          // re-downloads its body.
          const already = await this.prisma.inbound_emails.findUnique({
            where: { account_id_uid: { account_id: account.id, uid } }, select: { id: true },
          });
          if (already) continue;

          const record = await this.fetchOne(client, uid);
          if (!record) continue;

          const leadId = await this.matchLead(account.user_id, record.from_email);
          if (leadId) matched++;

          // The check above is an optimisation — it avoids re-downloading a body we already
          // have — not a guarantee. Between that read and this write another worker (a second
          // app instance, say, where the in-memory guard cannot reach) may have stored the
          // same UID. Losing the whole sync to that is the wrong trade: the row we wanted
          // exists either way, so a duplicate is treated as success and the loop carries on
          // to advance last_uid.
          try {
            await this.prisma.inbound_emails.create({
              data: {
                user_id: account.user_id ?? -1, account_id: account.id, uid,
                message_id: record.message_id, from_email: record.from_email, from_name: record.from_name,
                to_email: record.to_email, subject: record.subject, snippet: record.snippet,
                body_text: record.body_text, body_html: record.body_html,
                received_at: record.received_at, lead_id: leadId, created_at: new Date(),
              },
            });
            fetched++;
          } catch (ex) {
            // P2002 = unique violation on (account_id, uid): someone else got there first.
            if ((ex as { code?: string }).code !== 'P2002') throw ex;
            if (leadId) matched--;   // it was not this run that matched it
          }
        }
      } finally {
        lock.release();
      }
      await this.recordOutcome(account.id, null, maxUid);
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
  } | null> {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const p = await simpleParser(msg.source);
    const fromAddr = p.from?.value?.[0];
    const toText = Array.isArray(p.to) ? p.to.map((t) => t.text).join(', ') : p.to?.text ?? null;
    const text = (p.text ?? '').trim();
    return {
      message_id: p.messageId ? p.messageId.slice(0, 512) : null,
      from_email: fromAddr?.address ? fromAddr.address.toLowerCase().slice(0, 320) : null,
      from_name: fromAddr?.name ? fromAddr.name.slice(0, 255) : null,
      to_email: toText ? toText.slice(0, 320) : null,
      subject: p.subject ? p.subject.slice(0, 998) : null,
      snippet: text ? text.replace(/\s+/g, ' ').slice(0, 300) : null,
      body_text: text || null,
      body_html: typeof p.html === 'string' ? p.html : null,
      received_at: p.date ?? new Date(),
    };
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

  private async recordOutcome(accountId: number, error: string | null, maxUid?: number): Promise<void> {
    await this.prisma.mail_accounts.update({
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
