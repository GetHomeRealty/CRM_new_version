import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { reviewScopeWhere } from '../common/transaction-scope';
import { toDateTimeString } from '../common/serialize';
import { isAgent } from '../core/authz';
import type { ResourceUser } from '../transactions/transaction.resource';
import { NotificationsService } from './notifications.service';
import { TransactionReviewService } from '../transactions/transaction-review.service';
import { ReminderSweepService } from '../transactions/reminder-sweep.service';

export type NotificationSource = 'agent-change' | 'doc-review' | 'review-decision' | 'reminder' | 'direct';

/**
 * The one direct category that is filtered by which mailbox it came from. Named here because both
 * the dispatch site and `primaryMailboxOnly` below have to agree on it.
 */
const MAIL_CATEGORY = 'inbox_new_mail';
export type NotificationFilter = 'all' | 'unread' | 'read';

export interface NotificationItem {
  /** Present only for 'direct' rows, which are individually addressable. */
  notification_id?: number;
  /**
   * A stable handle for one row of the Centre.
   *
   * `source:transaction_id`, because every one of the four underlying systems groups its
   * notifications BY TRANSACTION rather than storing them individually — a deal with six reviewed
   * documents is one line in the bell, not six. The key is what "mark this read" is addressed to.
   */
  key: string;
  source: NotificationSource;
  /** 0 for a 'direct' notification that is not about a deal. */
  transaction_id: number;
  trade_no: string | null;
  property: string | null;
  title: string;
  summary: string | null;
  unread: boolean;
  at: string | null;
  /** Where "open the related record" goes. Always a Transaction Desk deal — all four sources are. */
  link: string;
}

export interface NotificationFeed {
  items: NotificationItem[];
  total: number;
  unread: number;
  limit: number;
  offset: number;
  /**
   * Whether a source still had rows beyond what this page needed.
   *
   * Not an error and not the old bug: the next page will reach them. It exists so a caller can
   * tell "you have seen everything" from "there is more", without the API ever discarding rows
   * without saying so — which is precisely what the fixed 100-per-source cap used to do.
   */
  truncated?: boolean;
}

/**
 * The Notification Centre: one list over four systems that already existed.
 *
 * WHAT THIS DOES NOT DO, DELIBERATELY. It does not introduce a `notifications` table. Notifications
 * in this application are DERIVED — an admin reviewing a document, an agent editing a field, a
 * review decision, a scheduled reminder — and each source already records whether it has been seen:
 *
 *   agent-change     audit_logs (source 'Agent')      → `handled`
 *   doc-review       audit_logs (source 'DocReview')  → `handled`
 *   review-decision  transaction_reviews              → `agent_seen_at`
 *   reminder         transaction_reminders            → `seen_at`
 *
 * Adding a table would mean writing a second copy of every one of those events, keeping the two in
 * step forever, and backfilling history that is already sitting in the tables above. Reading them is
 * strictly less work and cannot drift.
 *
 * WHERE THE OWNERSHIP RULES COME FROM. The agent-change and doc-review feeds are reused from
 * `NotificationsService` verbatim, because their scoping is genuinely intricate — an agent sees a
 * deal they own OR are a team member on, an admin sees changes but not team-member or lawyer edits.
 * Re-deriving that here would be a second place for it to be wrong. Only the two simple feeds
 * (`recipient = me`, `agent_name = me`) are queried directly, and only because the existing methods
 * hard-code "unread only" and the Centre needs history.
 */
@Injectable()
export class NotificationCenterService {
  private readonly log = new Logger(NotificationCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly reviews: TransactionReviewService,
    private readonly reminders: ReminderSweepService,
  ) {}

  static readonly DEFAULT_LIMIT = 25;
  static readonly MAX_LIMIT = 100;

  // ========================================================================== reading

  /**
   * The merged, filtered, paginated feed.
   *
   * Sorted newest-first across all four sources, then paginated in memory. In memory is honest
   * rather than lazy: these are four different tables with different shapes and different ownership
   * rules, so there is no single SQL statement to page over, and the volumes are small — each source
   * is already bounded (40 rows for the two time-based ones, and the audit-log feeds are scoped to
   * one person's transactions). If a brokerage ever outgrows that, the fix is a materialised
   * notifications table, which is a deliberate change rather than a tweak.
   */
  async feed(
    user: ResourceUser | null,
    options: { filter?: NotificationFilter; source?: NotificationSource; search?: string; limit?: number; offset?: number } = {},
  ): Promise<NotificationFeed> {
    if (!user) return { items: [], total: 0, unread: 0, limit: 0, offset: 0 };

    const filter = options.filter ?? 'all';
    const limit = Math.min(Math.max(1, options.limit ?? NotificationCenterService.DEFAULT_LIMIT), NotificationCenterService.MAX_LIMIT);
    const offset = Math.max(0, options.offset ?? 0);

    /*
     * FETCH TO THE DEPTH THIS PAGE NEEDS, rather than to a fixed 100 per source.
     *
     * `offset + limit` is sufficient AND necessary: an item on the global page must sit within the
     * first `offset + limit` of its own source, because merging only ever pushes an item later in
     * the order. One extra row is taken so the response can say honestly whether anything was left
     * behind rather than dropping it silently, which is what the old fixed cap did.
     */
    const depth = offset + limit + 1;
    let items = await this.collect(user, filter !== 'unread', depth);
    const truncated = items.length > depth;

    if (options.source) items = items.filter((i) => i.source === options.source);
    if (filter === 'unread') items = items.filter((i) => i.unread);
    if (filter === 'read') items = items.filter((i) => !i.unread);

    const needle = (options.search ?? '').trim().toLowerCase();
    if (needle) {
      items = items.filter((i) => [i.title, i.summary, i.trade_no, i.property]
        .some((f) => (f ?? '').toLowerCase().includes(needle)));
    }

    // Newest first. Items with no timestamp sort last rather than first — an unknown date is not
    // "just now", and showing it at the top would push real news down.
    items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

    /*
     * THE COUNTS ARE NOT TAKEN FROM THIS PAGE. `unreadCount` reads every unread row uncapped, so a
     * person with 250 unread sees 250 while looking at a page of 25 — the number is a statement
     * about their mailbox, not about the slice on screen.
     */
    const counts = await this.unreadCount(user);

    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      unread: counts.unread,
      limit,
      offset,
      truncated,
    };
  }

  /**
   * The number on the bell.
   *
   * Counts UNREAD only, which is the only number a badge can honestly show — a badge that included
   * read items would never reach zero and people would stop looking at it.
   */
  async unreadCount(user: ResourceUser | null): Promise<{ unread: number; by_source: Record<NotificationSource, number> }> {
    if (!user) return { unread: 0, by_source: this.emptyCounts() };

    // No depth: a badge computed from a capped fetch under-reports the moment somebody passes the
    // cap, and a wrong badge is worse than a slow one. Unread sets are small by nature.
    const items = (await this.collect(user, false)).filter((i) => i.unread);
    const bySource = this.emptyCounts();
    for (const item of items) bySource[item.source] += 1;
    return { unread: items.length, by_source: bySource };
  }

  // ========================================================================== writing

  /**
   * Mark one line of the Centre read.
   *
   * Delegated to whichever system owns it, so the authorization and the exact semantics of "seen"
   * stay in one place. Each of those methods already refuses a transaction the caller may not see.
   */
  async markRead(user: ResourceUser | null, source: NotificationSource, transactionId: number): Promise<{ ok: boolean }> {
    if (!user) return { ok: false };

    switch (source) {
      case 'agent-change':
      case 'doc-review':
        // One method covers both directions; it clears whichever of the two the caller was shown.
        return this.notifications.markDocNotificationsSeen(user, transactionId);
      case 'review-decision':
        return this.reviews.markSeen(user, transactionId);
      case 'reminder':
        return this.reminders.markSeen(user.name, transactionId);
      case 'direct':
        /*
         * A direct row is addressed by its OWN id rather than a transaction's, so the caller passes
         * the notification id here. Scoped by `user_id` in the update itself, so guessing an id
         * belonging to somebody else clears nothing.
         */
        return this.prisma.notifications
          .updateMany({
            where: { id: transactionId, user_id: user.id, read_at: null },
            data: { read_at: new Date() },
          })
          .then((done) => ({ ok: done.count > 0 }));
      default:
        return { ok: false };
    }
  }

  /**
   * Put a notification back to unread.
   *
   * ONLY THE `direct` SOURCE CAN DO THIS, and the restriction is real rather than an omission.
   * The other four are PROJECTIONS: their read state is not a flag on a notification, it is a fact
   * recorded in the system they come from — `handled` on an audit-log row, `seen` on a transaction
   * reminder. Un-setting those would not "mark a notification unread", it would rewrite history to
   * say a document review was never looked at, and the audit trail is the one thing in this
   * application that must not be edited to suit a screen.
   *
   * So a projected item answers `supported: false` and the UI does not offer the action for it,
   * rather than the endpoint silently doing nothing and leaving somebody clicking a dead button.
   */
  async markUnread(user: ResourceUser | null, source: NotificationSource, id: number): Promise<{ ok: boolean; supported: boolean }> {
    if (!user) return { ok: false, supported: false };
    if (source !== 'direct') return { ok: false, supported: false };

    // Scoped by `user_id` in the update itself, so guessing another person's id changes nothing.
    const done = await this.prisma.notifications.updateMany({
      where: { id, user_id: user.id, read_at: { not: null } },
      data: { read_at: null },
    });
    return { ok: done.count > 0, supported: true };
  }

  /**
   * Remove one notification.
   *
   * THE DISTINCTION THIS METHOD EXISTS TO ENFORCE. A `direct` row lives in `notifications` and is
   * this application's own record of "we told somebody something" — deleting it loses nothing else.
   * The other four sources are windows onto `audit_logs`, `transaction_reminders` and the review
   * trail; those rows are the brokerage's history and are referenced by screens that have nothing
   * to do with notifications. Deleting one to tidy a list would destroy a record somebody may later
   * need to produce.
   *
   * So "delete" means delete only for `direct`. For everything else the honest equivalent is
   * "dismiss" — mark it handled/seen, which is what `markRead` already does, and which removes it
   * from the unread view without touching the underlying record. That is what this returns
   * `dismissed: true` to say.
   */
  async remove(user: ResourceUser | null, source: NotificationSource, id: number): Promise<{ ok: boolean; deleted: boolean; dismissed: boolean }> {
    if (!user) return { ok: false, deleted: false, dismissed: false };

    if (source === 'direct') {
      const done = await this.prisma.notifications.deleteMany({ where: { id, user_id: user.id } });
      return { ok: done.count > 0, deleted: done.count > 0, dismissed: false };
    }

    // A projection: dismissing is marking it handled in the system it belongs to. The source record
    // is left exactly as it is.
    const r = await this.markRead(user, source, id);
    return { ok: r.ok, deleted: false, dismissed: r.ok };
  }

  /**
   * Clear the list.
   *
   * DELETES ONLY THIS PERSON'S `direct` ROWS. Everything else is dismissed by being marked read,
   * for the reason above — a "Clear all" that quietly deleted audit-log rows would be the most
   * destructive button in the application, and it would look like housekeeping.
   *
   * Reports the two numbers separately so the screen can say what actually happened rather than
   * implying everything was thrown away.
   */
  async clearAll(user: ResourceUser | null): Promise<{ deleted: number; dismissed: number }> {
    if (!user) return { deleted: 0, dismissed: 0 };

    const removed = await this.prisma.notifications.deleteMany({ where: { user_id: user.id } });
    // Whatever remains visible belongs to another system; mark it handled instead.
    const rest = await this.markAllRead(user);
    return { deleted: removed.count, dismissed: rest.marked };
  }

  /**
   * Mark everything currently unread as read.
   *
   * Built on `markRead` per item rather than four blanket `updateMany`s. That is slower and
   * deliberate: the per-source methods carry the ownership checks, and a blanket update written here
   * would be a second, unchecked path to the same rows — the kind that clears somebody else's
   * notifications when a where-clause is one condition short.
   *
   * Failures are counted and reported rather than aborting: one transaction the caller can no longer
   * open must not stop the other twenty being cleared.
   */
  async markAllRead(user: ResourceUser | null): Promise<{ ok: boolean; marked: number; failed: number }> {
    if (!user) return { ok: false, marked: 0, failed: 0 };

    const unread = (await this.collect(user, false)).filter((i) => i.unread);
    let marked = 0;
    let failed = 0;

    for (const item of unread) {
      try {
        // A direct row is addressed by its own id; every other source by its transaction.
        const handle = item.source === 'direct' ? (item.notification_id ?? 0) : item.transaction_id;
        const result = await this.markRead(user, item.source, handle);
        if (result.ok) marked += 1; else failed += 1;
      } catch (err) {
        failed += 1;
        this.log.warn(`Could not clear ${item.key} for user #${user.id}: ${(err as Error).message}`);
      }
    }

    if (failed) this.log.warn(`Marked ${marked} notification(s) read for user #${user.id}; ${failed} could not be cleared.`);
    return { ok: true, marked, failed };
  }

  // ========================================================================== sources

  /** Every source, normalised. `includeRead` is false when only the unread count is wanted. */
  /**
   * Gather every source.
   *
   * `depth` is how many rows to take FROM EACH SOURCE, and passing it correctly is the whole of the
   * pagination fix. Each source was capped at a hard 100 before being merged, so a user with 150
   * items in one source could never reach the last 50 — they were dropped before the merge and
   * nothing said so.
   *
   * To render the global page [offset, offset+limit) it is sufficient, and necessary, to take
   * `offset + limit` from each source: any item on that page must be within the first
   * `offset + limit` of its own source, because the merge only ever moves an item LATER in the
   * order. So the fetch depth follows the page rather than a fixed ceiling, and no item on any
   * reachable page can be lost.
   *
   * `undefined` means NO cap, which is what the unread counter uses — a badge computed from a
   * capped fetch stops counting at the cap and quietly under-reports.
   */
  private async collect(user: ResourceUser, includeRead: boolean, depth?: number): Promise<NotificationItem[]> {
    const [agentChanges, docReviews, decisions, reminders, direct] = await Promise.all([
      this.notifications.agentChangeNotifications(user),
      this.notifications.docNotifications(user),
      this.reviewDecisions(user, includeRead, depth),
      this.reminderItems(user, includeRead, depth),
      this.directItems(user, includeRead, depth),
    ]);

    const out: NotificationItem[] = [];

    // The two audit-log feeds already return read AND unread, with an `unread` flag per row.
    for (const raw of agentChanges.items) {
      out.push(this.normalise('agent-change', raw, 'Agent changed a deal'));
    }
    for (const raw of docReviews.items) {
      out.push(this.normalise('doc-review', raw, 'Your documents were reviewed'));
    }
    out.push(...decisions, ...reminders, ...direct);

    return includeRead ? out : out.filter((i) => i.unread);
  }

  private normalise(source: NotificationSource, raw: Record<string, unknown>, title: string): NotificationItem {
    const transactionId = Number(raw.id);
    return {
      key: `${source}:${transactionId}`,
      source,
      transaction_id: transactionId,
      trade_no: (raw.trade_no as string) ?? null,
      property: (raw.property as string) ?? null,
      title,
      summary: (raw.summary as string) ?? null,
      unread: raw.unread === true,
      at: (raw.at as string) ?? null,
      link: `/desk/transactions/${transactionId}`,
    };
  }

  /**
   * Review decisions, including seen ones when history is wanted.
   *
   * Queried here rather than through `TransactionReviewService.notifications`, which hard-codes
   * `agent_seen_at: null` — correct for a bell, but it means a decision vanishes the moment it is
   * read, and the Centre has to be able to show it again. The ownership condition is the same one
   * that method uses (`agent_name` is the caller), so nothing is loosened.
   */
  private async reviewDecisions(user: ResourceUser, includeRead: boolean, depth?: number): Promise<NotificationItem[]> {
    if (!isAgent(user)) return [];

    const rows = await this.prisma.transaction_reviews.findMany({
      // By id where the row has one — the same rule `TransactionReviewService` applies. This fed a
      // namesake the other person's rejected fields, reasons and old/new values.
      where: { ...reviewScopeWhere(user), ...(includeRead ? {} : { agent_seen_at: null }) },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: depth,
      include: { transactions: { select: { id: true, trade_no: true, property: true, deleted_at: true } } },
    });

    return rows
      .filter((r) => r.transactions && !r.transactions.deleted_at)
      .map((r) => ({
        key: `review-decision:${r.transactions.id}`,
        source: 'review-decision' as const,
        transaction_id: r.transactions.id,
        trade_no: r.transactions.trade_no,
        property: r.transactions.property,
        title: r.decision === 'Rejected' ? 'A change was rejected' : 'Your changes were reviewed',
        summary: r.decision === 'Rejected'
          ? `${r.field_label ?? 'A change'} rejected — ${r.reason ?? ''}`.trim()
          : `Your changes were reviewed${r.reason ? ` — ${r.reason}` : ''}`,
        unread: r.agent_seen_at === null,
        at: toDateTimeString(r.created_at),
        link: `/desk/transactions/${r.transactions.id}`,
      }));
  }

  /** Scheduled reminders, including seen ones when history is wanted. Same shape of reasoning. */
  private async reminderItems(user: ResourceUser, includeRead: boolean, depth?: number): Promise<NotificationItem[]> {
    const name = (user.name ?? '').trim();
    if (!name) return [];

    const rows = await this.prisma.transaction_reminders.findMany({
      where: { recipient: name, delivery_method: 'in-app', ...(includeRead ? {} : { seen_at: null }) },
      orderBy: [{ scheduled_for: 'desc' }, { id: 'desc' }],
      take: depth,
      include: { transactions: { select: { id: true, trade_no: true, property: true, deleted_at: true } } },
    });

    return rows
      .filter((r) => r.transactions && !r.transactions.deleted_at)
      .map((r) => ({
        key: `reminder:${r.transactions.id}`,
        source: 'reminder' as const,
        transaction_id: r.transactions.id,
        trade_no: r.transactions.trade_no,
        property: r.transactions.property,
        title: 'Reminder',
        summary: r.subject ?? null,
        unread: r.seen_at === null,
        at: toDateTimeString(r.scheduled_for),
        link: `/desk/transactions/${r.transactions.id}`,
      }));
  }

  /**
   * Notifications the dispatcher delivered directly.
   *
   * The fifth source, and the only one that is STORED rather than derived — see
   * `notification-dispatcher.service.ts` for why both kinds exist. Scoped by `user_id`, which is the
   * whole of its ownership rule: a direct notification belongs to exactly the person it was sent to.
   */
  private async directItems(user: ResourceUser, includeRead: boolean, depth?: number): Promise<NotificationItem[]> {
    const rows = await this.prisma.notifications.findMany({
      where: { user_id: user.id, ...(includeRead ? {} : { read_at: null }) },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: depth,
    });

    const visible = await this.primaryMailboxOnly(user, rows);

    return visible.map((r: { id: number; title: string; body: string | null; link: string | null; read_at: Date | null; created_at: Date }) => ({
      key: `direct:${r.id}`,
      notification_id: r.id,
      source: 'direct' as const,
      // Direct notifications need not be about a deal at all.
      transaction_id: 0,
      trade_no: null,
      property: null,
      title: r.title,
      summary: r.body,
      unread: r.read_at === null,
      at: toDateTimeString(r.created_at),
      link: r.link ?? '',
    }));
  }

  /**
   * Drop new-mail lines that belong to a mailbox which is not the person's primary one.
   *
   * WHY THIS IS DONE AT READ TIME, when `imap-sync.service.ts` already refuses to create them.
   * That check governs what is written, and writing is a one-off: a line created last week while
   * `enquiries@` was primary is still sitting in the table today, after somebody made `sales@`
   * primary instead. Deciding it here means the answer is recomputed on every read, so changing
   * the primary address retires the old mailbox's history immediately, with nothing to migrate and
   * no rows to delete. Change it back and the old lines return — they were never destroyed.
   *
   * Both scopes count. A person may hold one primary in the CRM and another in the Transaction
   * Desk, and each is genuinely primary for its own area, so a line from either is kept.
   *
   * WHICH MAILBOX A LINE CAME FROM is read from the dedupe key the dispatch site sets,
   * `inbox-<account id>-<uid>`, because the notifications table stores no account column and
   * adding one would mean a migration for a question the existing key already answers. A row that
   * does not parse is treated as not-primary: every one the application creates carries that key,
   * so a row without it is older than this rule or came from somewhere that no longer exists, and
   * both are exactly what the person asked to stop seeing.
   *
   * Everything that is not a new-mail line passes through untouched — this narrows one category,
   * not the feed.
   */
  private async primaryMailboxOnly<T extends { category: string; dedupe_key: string | null }>(
    user: ResourceUser,
    rows: T[],
  ): Promise<T[]> {
    const mail = rows.filter((r) => r.category === MAIL_CATEGORY);
    if (mail.length === 0) return rows;   // nothing to decide; do not pay for the query

    const primaries = await this.prisma.mail_accounts.findMany({
      where: { user_id: user.id, is_default: true },
      select: { id: true },
    });
    const allowed = new Set(primaries.map((a: { id: number }) => a.id));

    return rows.filter((r) => {
      if (r.category !== MAIL_CATEGORY) return true;
      const from = /^inbox-(\d+)-/.exec(r.dedupe_key ?? '');
      return from ? allowed.has(Number(from[1])) : false;
    });
  }

  private emptyCounts(): Record<NotificationSource, number> {
    return { 'agent-change': 0, 'doc-review': 0, 'review-decision': 0, reminder: 0, direct: 0 };
  }
}
