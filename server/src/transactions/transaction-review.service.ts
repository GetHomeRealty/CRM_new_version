import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, transaction_reviews } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { MessagesService } from './messages.service';
import { isAdminOrAbove, isAgent } from '../core/authz';
import { toDateTimeString } from '../common/serialize';
import { areaPath } from '../common/domain';
import type { AuthUserRecord } from '../auth/auth.types';
import type { ResourceUser } from './transaction.resource';

/**
 * The review record — what an administrator decided about an agent's change, and what became of it.
 *
 * WHY A TABLE OF ITS OWN. The audit trail already says a value changed; it cannot say that somebody
 * looked at it, refused it, gave a reason, and that the agent then put it right. Those are decisions
 * ABOUT history rather than more history, they have a life of their own — Open, Corrected, Resolved
 * — and the whole point is that they survive every later edit to the deal. Every column describing
 * the change is therefore a snapshot: re-reading the live transaction would let a review quietly
 * rewrite what it once said.
 *
 * WHAT NEVER HAPPENS HERE. Nothing is deleted, and no decision is edited after the fact. The only
 * columns that move are the lifecycle ones, and they only ever move forwards.
 */

export const DECISIONS = ['Reviewed', 'Rejected'] as const;
export type Decision = (typeof DECISIONS)[number];

export const RESOLUTIONS = ['Open', 'Corrected', 'Resolved'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** Said on the record itself, so a reader never has to guess why nothing was put back. */
export const REVERT_OK = 'Auto reverted successfully.';
export const REVERT_UNSUPPORTED = 'This field cannot be automatically reverted. Please update the transaction and resubmit.';

/**
 * When an open rejection starts counting as overdue.
 *
 * The same 24 hours as the first rung of the reminder ladder, so the dashboard's "overdue" figure
 * and the agent's first nudge describe the same moment. Two different thresholds would mean the
 * office chasing items the system had not yet mentioned.
 */
export const OVERDUE_HOURS = 24;

export interface ReviewFilters {
  resolution?: string;
  decision?: string;
  reviewer?: string;
  agent?: string;
  field?: string;
  from?: string;
  to?: string;
  page?: number;
  per_page?: number;
}

const clip = (value: unknown, max = 4000): string | null => {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return [...s].length > max ? [...s].slice(0, max).join('') + '…' : s;
};

@Injectable()
export class TransactionReviewService {
  private readonly log = new Logger(TransactionReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
    private readonly messages: MessagesService,
  ) {}

  // ------------------------------------------------------------------ writing

  /**
   * Record a rejection.
   *
   * The reason is required — a rejection without one tells the agent that something is wrong and
   * nothing about what. Whether the old value could be put back is a separate matter, recorded
   * beside the decision rather than allowed to prevent it: refusing to register a rejection because
   * a field happens to be un-revertable is how the old behaviour lost decisions entirely.
   */
  async recordRejection(input: {
    txnId: number;
    actor: AuthUserRecord | null;
    auditLogId: number | null;
    reason: string;
    fieldLabel: string | null;
    oldValue: string | null;
    newValue: string | null;
    agentName: string | null;
    autoReverted: boolean;
  }): Promise<transaction_reviews> {
    const reason = String(input.reason ?? '').trim();
    if (!reason) {
      throw new BadRequestException({
        message: 'A reason is required to reject a change.',
        errors: { reason: ['Say why this is being rejected.'] },
      });
    }

    const review = await this.create({
      transaction_id: input.txnId,
      audit_log_id: input.auditLogId,
      decision: 'Rejected',
      reason,
      field_label: input.fieldLabel,
      old_value: clip(input.oldValue),
      new_value: clip(input.newValue),
      agent_name: input.agentName,
      actor_name: input.actor?.name ?? null,
      auto_reverted: input.autoReverted,
      auto_revert_result: input.autoReverted ? REVERT_OK : REVERT_UNSUPPORTED,
      resolution_status: 'Open',
    });

    await this.announce(review, input.txnId, input.actor);
    return review;
  }

  /**
   * Record a batch "Mark reviewed", with an optional note.
   *
   * The same act also closes the loop on anything the agent has already corrected: those records are
   * what the administrator is looking at when they accept the deal as it now stands, so leaving them
   * at Corrected would mean nothing ever reached Resolved without a second, invented button.
   */
  async recordReviewed(txnId: number, actor: AuthUserRecord | null, note: string | null, agentName: string | null): Promise<transaction_reviews> {
    const trimmed = String(note ?? '').trim();
    const resolved = await this.resolveCorrected(txnId, actor, trimmed);

    const review = await this.create({
      transaction_id: txnId,
      audit_log_id: null,
      decision: 'Reviewed',
      reason: trimmed || null,
      field_label: null,
      old_value: null,
      new_value: null,
      agent_name: agentName,
      actor_name: actor?.name ?? null,
      auto_reverted: false,
      auto_revert_result: null,
      // A review is a statement about what was seen, not an issue anyone has to chase.
      resolution_status: 'Resolved',
      resolved_at: new Date(),
      resolved_by: actor?.name ?? null,
    });

    await this.announce(review, txnId, actor, resolved);
    return review;
  }

  /**
   * Approve what the agent corrected: every Corrected record on this deal becomes Resolved.
   *
   * Returns how many, so the chat line can say "and 2 corrections approved" rather than leaving the
   * agent to work out whether their fix landed.
   */
  private async resolveCorrected(txnId: number, actor: AuthUserRecord | null, note: string): Promise<number> {
    const now = new Date();
    const done = await this.prisma.transaction_reviews.updateMany({
      where: { transaction_id: txnId, decision: 'Rejected', resolution_status: 'Corrected' },
      data: {
        resolution_status: 'Resolved',
        resolved_at: now,
        resolved_by: actor?.name ?? null,
        // Kept alongside the original reason rather than replacing it: the record has to keep saying
        // what was wrong as well as that it is now right.
        auto_revert_result: note ? `Approved after correction. ${note}` : 'Approved after correction.',
        updated_at: now,
      },
    });
    return done.count;
  }

  /**
   * An agent has edited fields again — mark any rejection of those same fields as Corrected.
   *
   * Called after an agent's own save, with the labels the audit trail just recorded. Matching is by
   * the field label the rejection was filed under, which is the only thing the two acts have in
   * common: the audit row that was rejected is long since handled, and the new edit writes its own.
   *
   * Deliberately updates the ORIGINAL record instead of opening a second one, so an issue is one
   * row from beginning to end rather than a pile of disconnected events.
   */
  async markCorrected(txnId: number, actorName: string | null, fieldLabels: string[]): Promise<number> {
    const labels = [...new Set(fieldLabels.filter(Boolean))];
    if (labels.length === 0) return 0;

    const now = new Date();
    const done = await this.prisma.transaction_reviews.updateMany({
      where: {
        transaction_id: txnId,
        decision: 'Rejected',
        resolution_status: 'Open',
        field_label: { in: labels },
      },
      data: { resolution_status: 'Corrected', corrected_at: now, corrected_by: actorName, updated_at: now },
    });
    return done.count;
  }

  private async create(data: Prisma.transaction_reviewsUncheckedCreateInput): Promise<transaction_reviews> {
    const now = new Date();
    return this.prisma.transaction_reviews.create({ data: { ...data, created_at: now, updated_at: now } });
  }

  // ------------------------------------------------------------------ telling people

  /**
   * Post the decision to the deal's chat and email the agent.
   *
   * Both are best-effort and deliberately after the record is written: the decision is the thing
   * that must survive, and a mail server that is briefly down should not undo it. Failures are
   * logged rather than raised.
   */
  private async announce(review: transaction_reviews, txnId: number, actor: AuthUserRecord | null, resolvedCount = 0): Promise<void> {
    try {
      await this.postToChat(review, txnId, actor, resolvedCount);
    } catch (err) {
      this.log.error(`Review ${review.id}: could not post to the transaction chat — ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await this.emailAgent(review, txnId);
    } catch (err) {
      this.log.error(`Review ${review.id}: could not email the agent — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The decision in the conversation the team already reads. */
  private async postToChat(review: transaction_reviews, txnId: number, actor: AuthUserRecord | null, resolvedCount: number): Promise<void> {
    const who: ResourceUser | null = actor ? { id: actor.id, role: actor.role, name: actor.name } : null;
    const lines: string[] = [];

    if (review.decision === 'Rejected') {
      lines.push(`${review.field_label ?? 'A change'} rejected.`);
      lines.push(`Reason: ${review.reason}`);
      if (!review.auto_reverted) lines.push(REVERT_UNSUPPORTED);
    } else {
      lines.push('Agent changes reviewed.');
      if (review.reason) lines.push(review.reason);
      if (resolvedCount > 0) {
        lines.push(`${resolvedCount} earlier rejection${resolvedCount === 1 ? '' : 's'} approved after correction.`);
      }
    }

    await this.messages.post(txnId, who, lines.join('\n'));
  }

  /** The agent gets the decision by email, with a link straight back to the deal. */
  private async emailAgent(review: transaction_reviews, txnId: number): Promise<void> {
    const txn = await this.prisma.transactions.findFirst({
      where: { id: txnId, deleted_at: null },
      select: { id: true, trade_no: true, property: true, agent: true },
    });
    if (!txn) return;

    const name = (review.agent_name ?? txn.agent ?? '').trim();
    if (!name) return;
    const user = await this.prisma.users.findFirst({ where: { name, status: 'Active' }, select: { email: true } });
    const to = (user?.email ?? '').trim();
    if (!to) {
      this.log.warn(`Review ${review.id}: no email on file for "${name}" — nothing sent.`);
      return;
    }

    const company = (await this.settings.current()).name;
    const base = (process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
    const link = base ? `${base}${areaPath('desk', `transactions/${txnId}`)}` : '';

    await this.mailer.send('transaction.review_decision', {
      agent_name: name,
      deal_number: txn.trade_no ?? String(txn.id),
      property_address: txn.property ?? '—',
      decision: review.decision,
      field_label: review.field_label ?? 'Your changes',
      old_value: review.old_value ?? '—',
      new_value: review.new_value ?? '—',
      reason: review.reason ?? '—',
      reviewer: review.actor_name ?? 'the office',
      decided_at: toDateTimeString(review.created_at) ?? '',
      revert_note: review.auto_revert_result ?? '',
      // Empty when FRONTEND_URL is unset; the template drops the button rather than linking nowhere.
      transaction_button: link
        ? `<p style="margin:18px 0"><a href="${link}" style="background:#1f3b73;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;display:inline-block">Open the transaction</a></p>`
        : '',
      company_name: company,
    }, redirectTo() ?? to);
  }

  // ------------------------------------------------------------------ bulk

  /**
   * Reject several of an agent's changes under one reason.
   *
   * One reason for the batch rather than one each: an administrator rejecting five fields at once is
   * making a single judgement ("none of this matches the APS"), and asking them to retype it five
   * times produces five copies of the same sentence or five worse ones. Each item still becomes its
   * own record with its own lifecycle — the reason is shared, the issues are not.
   *
   * Returns what happened per id, so a change somebody else handled in the meantime is reported
   * rather than silently dropped.
   */
  async bulkReject(
    user: AuthUserRecord | null,
    auditIds: number[],
    reason: string,
    rejectOne: (auditId: number, reason: string) => Promise<void>,
  ): Promise<{ rejected: number; skipped: { audit_id: number; reason: string }[] }> {
    this.assertMayDecide(user);
    if (!String(reason ?? '').trim()) {
      throw new BadRequestException({
        message: 'A reason is required to reject a change.',
        errors: { reason: ['Say why these are being rejected.'] },
      });
    }

    const skipped: { audit_id: number; reason: string }[] = [];
    let rejected = 0;
    for (const id of [...new Set(auditIds)]) {
      try {
        await rejectOne(id, reason);
        rejected++;
      } catch (err) {
        skipped.push({ audit_id: id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { rejected, skipped };
  }

  /**
   * Approve corrections in bulk: named records move from Corrected to Resolved.
   *
   * Only Corrected ones. An Open item has not been fixed yet and approving it would close an issue
   * nobody addressed; a Resolved one is already closed. Both are reported back rather than quietly
   * counted as successes.
   */
  async bulkResolve(user: AuthUserRecord | null, txnId: number, reviewIds: number[], note: string | null): Promise<{ resolved: number; skipped: number }> {
    this.assertMayDecide(user);
    const ids = [...new Set(reviewIds)].filter((n) => Number.isFinite(n));
    if (ids.length === 0) return { resolved: 0, skipped: 0 };

    const rows = await this.prisma.transaction_reviews.findMany({
      where: { id: { in: ids }, transaction_id: txnId },
      select: { id: true, resolution_status: true, field_label: true },
    });
    const eligible = rows.filter((r) => r.resolution_status === 'Corrected');
    const trimmed = String(note ?? '').trim();
    const now = new Date();

    if (eligible.length) {
      await this.prisma.transaction_reviews.updateMany({
        where: { id: { in: eligible.map((r) => r.id) } },
        data: {
          resolution_status: 'Resolved',
          resolved_at: now,
          resolved_by: user?.name ?? null,
          auto_revert_result: trimmed ? `Approved after correction. ${trimmed}` : 'Approved after correction.',
          updated_at: now,
        },
      });

      try {
        const names = eligible.map((r) => r.field_label ?? 'a change').join(', ');
        await this.messages.post(
          txnId,
          user ? { id: user.id, role: user.role, name: user.name } : null,
          [`${eligible.length} correction${eligible.length === 1 ? '' : 's'} approved: ${names}.`, trimmed].filter(Boolean).join('\n'),
        );
      } catch (err) {
        this.log.error(`Bulk approve on ${txnId}: could not post to the chat — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { resolved: eligible.length, skipped: ids.length - eligible.length };
  }

  private assertMayDecide(user: AuthUserRecord | null): void {
    if (!isAdminOrAbove(user)) throw new ForbiddenException({ message: 'Administrator access required.' });
  }

  // ------------------------------------------------------------------ reading

  /**
   * One transaction's review history, newest first.
   *
   * Loaded on its own endpoint rather than inside the transaction payload: the deal screen is
   * already heavy, this list only grows, and nobody reading a transaction needs it before the page
   * can render.
   */
  async list(user: AuthUserRecord | null, txnId: number, filters: ReviewFilters): Promise<Record<string, unknown>> {
    await this.assertMayRead(user, txnId);

    const where: Prisma.transaction_reviewsWhereInput = { transaction_id: txnId };
    if (filters.resolution && (RESOLUTIONS as readonly string[]).includes(filters.resolution)) {
      where.resolution_status = filters.resolution;
    }
    if (filters.decision && (DECISIONS as readonly string[]).includes(filters.decision)) {
      where.decision = filters.decision;
    }
    if (filters.reviewer) where.actor_name = { contains: filters.reviewer, mode: 'insensitive' };
    if (filters.agent) where.agent_name = { contains: filters.agent, mode: 'insensitive' };
    if (filters.field) where.field_label = { contains: filters.field, mode: 'insensitive' };
    const from = this.day(filters.from);
    const to = this.day(filters.to, true);
    if (from || to) where.created_at = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

    const perPage = Math.min(Math.max(Number(filters.per_page) || 25, 1), 100);
    const page = Math.max(Number(filters.page) || 1, 1);

    const [total, rows, openCount] = await Promise.all([
      this.prisma.transaction_reviews.count({ where }),
      this.prisma.transaction_reviews.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.transaction_reviews.count({ where: { transaction_id: txnId, resolution_status: 'Open' } }),
    ]);

    return {
      data: rows.map((r) => this.resource(r)),
      meta: {
        total,
        page,
        per_page: perPage,
        last_page: Math.max(1, Math.ceil(total / perPage)),
        open_count: openCount,
        // The screen shows or hides its controls from this rather than re-deriving the rule.
        can_decide: isAdminOrAbove(user),
      },
    };
  }

  /**
   * The figures behind the dashboard widgets.
   *
   * An agent sees their own; everyone above sees the brokerage. Counted in the database rather than
   * by pulling rows and reducing in JavaScript — this grows with every decision ever made, and the
   * answer is five numbers.
   */
  async stats(user: AuthUserRecord | null): Promise<Record<string, unknown>> {
    const mine = user && isAgent(user) ? { agent_name: user.name ?? '' } : {};
    const overdueBefore = new Date(Date.now() - OVERDUE_HOURS * 3600_000);

    const [open, corrected, overdue, byAgent, byStaff, resolvedRows] = await Promise.all([
      this.prisma.transaction_reviews.count({ where: { ...mine, resolution_status: 'Open' } }),
      this.prisma.transaction_reviews.count({ where: { ...mine, resolution_status: 'Corrected' } }),
      this.prisma.transaction_reviews.count({ where: { ...mine, resolution_status: 'Open', created_at: { lt: overdueBefore } } }),
      this.prisma.transaction_reviews.groupBy({
        by: ['agent_name'],
        where: { ...mine, resolution_status: { in: ['Open', 'Corrected'] } },
        _count: { _all: true },
      }),
      this.prisma.transaction_reviews.groupBy({
        by: ['actor_name'],
        where: { ...mine, decision: 'Rejected' },
        _count: { _all: true },
      }),
      // Only what actually completed a lifecycle can time one.
      this.prisma.transaction_reviews.findMany({
        where: { ...mine, decision: 'Rejected', resolution_status: 'Resolved', resolved_at: { not: null }, created_at: { not: null } },
        select: { created_at: true, resolved_at: true },
        orderBy: { resolved_at: 'desc' },
        take: 200,
      }),
    ]);

    const spans = resolvedRows
      .map((r) => (r.resolved_at!.getTime() - r.created_at!.getTime()) / 3600_000)
      .filter((h) => h >= 0);
    const averageHours = spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null;

    const rank = (rows: { _count: { _all: number } }[], key: 'agent_name' | 'actor_name') =>
      rows
        .map((r) => ({ name: (r as unknown as Record<string, string | null>)[key] ?? '—', count: r._count._all }))
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

    return {
      open,
      corrected,
      overdue,
      overdue_after_hours: OVERDUE_HOURS,
      // Averaged over the last 200 resolved items: a figure from three years ago describes an
      // office that no longer exists, and the whole table would have to be read to include it.
      average_resolution_hours: averageHours === null ? null : Math.round(averageHours * 10) / 10,
      resolved_sampled: spans.length,
      by_agent: rank(byAgent, 'agent_name'),
      by_staff: rank(byStaff, 'actor_name'),
      scope: user && isAgent(user) ? 'own' : 'brokerage',
    };
  }

  /**
   * Per-transaction counters for the deal list, for the ids on the page only.
   *
   * One grouped query for the whole page rather than one per row: the list already paginates, and a
   * counter per row is how a list screen quietly becomes N+1 queries.
   */
  async countsFor(txnIds: number[]): Promise<Record<number, { open: number; corrected: number; resolved: number }>> {
    const ids = [...new Set(txnIds)].filter((n) => Number.isFinite(n));
    if (ids.length === 0) return {};

    const rows = await this.prisma.transaction_reviews.groupBy({
      by: ['transaction_id', 'resolution_status'],
      where: { transaction_id: { in: ids } },
      _count: { _all: true },
    });

    const out: Record<number, { open: number; corrected: number; resolved: number }> = {};
    for (const r of rows) {
      const bucket = (out[r.transaction_id] ??= { open: 0, corrected: 0, resolved: 0 });
      if (r.resolution_status === 'Open') bucket.open += r._count._all;
      else if (r.resolution_status === 'Corrected') bucket.corrected += r._count._all;
      else bucket.resolved += r._count._all;
    }
    return out;
  }

  /** The same list behind an access check, for the screen to read before offering to close. */
  async openSummary(user: AuthUserRecord | null, txnId: number): Promise<Record<string, unknown>> {
    await this.assertMayRead(user, txnId);
    const items = await this.openItems(txnId);
    return {
      data: items,
      meta: {
        total: items.length,
        open: items.filter((i) => i.resolution_status === 'Open').length,
        corrected: items.filter((i) => i.resolution_status === 'Corrected').length,
        blocks_closing: items.length > 0,
      },
    };
  }

  /** What is still unresolved on a deal — the question asked before it can be closed. */
  async openItems(txnId: number): Promise<{ id: number; field_label: string | null; reason: string | null; resolution_status: string; created_at: string | null }[]> {
    const rows = await this.prisma.transaction_reviews.findMany({
      where: { transaction_id: txnId, decision: 'Rejected', resolution_status: { in: ['Open', 'Corrected'] } },
      orderBy: [{ created_at: 'asc' }],
      select: { id: true, field_label: true, reason: true, resolution_status: true, created_at: true },
    });
    return rows.map((r) => ({ ...r, created_at: toDateTimeString(r.created_at) }));
  }

  /** Everything the agent has not seen yet, for their notification bell. */
  async notifications(user: ResourceUser | null): Promise<{ count: number; items: Record<string, unknown>[] }> {
    if (!user || !isAgent(user)) return { count: 0, items: [] };

    const rows = await this.prisma.transaction_reviews.findMany({
      where: { agent_name: user.name, agent_seen_at: null },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 40,
      include: { transactions: { select: { id: true, trade_no: true, property: true, deleted_at: true } } },
    });

    const items = rows
      .filter((r) => r.transactions && !r.transactions.deleted_at)
      .map((r) => ({
        id: r.transactions.id,
        trade_no: r.transactions.trade_no,
        property: r.transactions.property,
        summary: r.decision === 'Rejected'
          ? `${r.field_label ?? 'A change'} rejected — ${r.reason ?? ''}`.trim()
          : `Your changes were reviewed${r.reason ? ` — ${r.reason}` : ''}`,
        unread: true,
        at: toDateTimeString(r.created_at),
      }));
    return { count: items.length, items };
  }

  /** Opening the deal is what clears the agent's review notifications for it. */
  async markSeen(user: ResourceUser | null, txnId: number): Promise<{ ok: boolean }> {
    if (!user || !isAgent(user)) return { ok: true };
    await this.prisma.transaction_reviews.updateMany({
      where: { transaction_id: txnId, agent_name: user.name, agent_seen_at: null },
      data: { agent_seen_at: new Date() },
    });
    return { ok: true };
  }

  /**
   * Who may read a deal's review history: anyone above agent, and the agent the deal belongs to.
   *
   * An agent reads it because that is where they find out what to fix — but only their own deal, and
   * only ever as a reader. There is no endpoint that edits or deletes a review record for anyone.
   */
  private async assertMayRead(user: AuthUserRecord | null, txnId: number): Promise<void> {
    const txn = await this.prisma.transactions.findFirst({
      where: { id: txnId, deleted_at: null },
      select: { id: true, agent: true },
    });
    if (!txn) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });
    if (!user || !isAgent(user)) return;

    const name = user.name ?? '';
    const allowed =
      txn.agent === name ||
      (await this.prisma.team_members.findFirst({ where: { transaction_id: txnId, name } })) !== null;
    if (!allowed) throw new ForbiddenException({ message: 'You do not have access to this transaction.' });
  }

  private day(value: string | undefined, endOfDay = false): Date | null {
    const v = String(value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    return new Date(`${v}T${endOfDay ? '23:59:59' : '00:00:00'}`);
  }

  private resource(r: transaction_reviews): Record<string, unknown> {
    return {
      id: r.id,
      audit_log_id: r.audit_log_id,
      decision: r.decision,
      reason: r.reason,
      field_label: r.field_label,
      old_value: r.old_value,
      new_value: r.new_value,
      agent_name: r.agent_name,
      actor_name: r.actor_name,
      auto_reverted: r.auto_reverted,
      auto_revert_result: r.auto_revert_result,
      resolution_status: r.resolution_status,
      corrected_at: toDateTimeString(r.corrected_at),
      corrected_by: r.corrected_by,
      resolved_at: toDateTimeString(r.resolved_at),
      resolved_by: r.resolved_by,
      agent_seen_at: toDateTimeString(r.agent_seen_at),
      created_at: toDateTimeString(r.created_at),
    };
  }
}

/** Diverts every message when set, so a test environment cannot mail a real agent. */
const redirectTo = (): string | null => {
  const v = (process.env.MAIL_REDIRECT_TO ?? '').trim();
  return v === '' ? null : v;
};
