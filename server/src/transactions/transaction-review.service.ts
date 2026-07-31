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
