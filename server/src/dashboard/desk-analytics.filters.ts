import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TRANSACTION_TYPES, statusOptionsFor } from '../reference/transaction.constants';
import { isAgent } from '../core/authz';
import type { ScopedUser } from '../common/transaction-scope';

/**
 * The Analytics screen's filters — validated, and validated on the SERVER.
 *
 * Every one of these narrows a database aggregate, so a value that reaches the SQL unchecked is
 * either an error the user cannot understand or a way to ask a question they are not allowed to
 * ask. Two rules run this file:
 *
 *   A FILTER THAT CANNOT BE HONOURED IS REFUSED, NOT DROPPED. `?type=Nonsense` returning the
 *   brokerage's whole book — more than was asked for, presented as the answer — is the failure mode
 *   this codebase has already fixed twice (the inbox's lead filter, the audit trail's). An unknown
 *   type, an unknown status or a malformed date is a 400 naming the value.
 *
 *   THE AGENT SELECTOR IS AN AUTHORIZATION BOUNDARY, not a convenience. An agent asking for another
 *   agent's figures is refused here, by user id, before any query is built. The frontend hides the
 *   control; that is presentation, and presentation is not what stops this.
 */

/** What a caller may ask Analytics to narrow by. All optional; absent means "everything in scope". */
export interface AnalyticsFilters {
  /** Inclusive `YYYY-MM-DD` bounds on the deal's Analytics date. See `ANALYTICS_DATE_SQL`. */
  from?: string;
  to?: string;
  /** A single agent, BY USER ID. Never by name — see `parseAnalyticsFilters`. */
  agent_user_id?: number;
  /** One of `TRANSACTION_TYPES`. */
  type?: string;
  /** One status from the application's existing vocabulary. */
  status?: string;
}

/**
 * THE DATE ANALYTICS COUNTS A DEAL BY — closing date, falling back to the offer date.
 *
 * This is not a new basis chosen for the filter: it is the expression `by_month` already groups on,
 * so a deal appears in the January column exactly when it falls inside a January range. Filtering on
 * `closing_date` alone would have been a second, quieter definition — deals with no closing date
 * would vanish from a date range while still appearing in a month bucket, and the chart would
 * disagree with the filter that produced it.
 *
 * Exported so the service and this validator cannot drift on which date they mean.
 */
export const ANALYTICS_DATE_SQL = 'COALESCE(t.closing_date, t.offer_date)';

/** Every status any transaction type may hold — the union of the per-type vocabularies. */
export const ALL_STATUSES: string[] = [
  ...new Set(TRANSACTION_TYPES.flatMap((t) => statusOptionsFor(t))),
].sort();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (field: string, message: string): never => {
  throw new BadRequestException({ message, errors: { [field]: [message] } });
};

/**
 * Turn raw query values into checked filters, and settle the agent question.
 *
 * `user` is the caller. For an agent the result is forced to their own id whatever they asked for —
 * and asking for somebody else is refused rather than silently rewritten, because a screen that
 * quietly shows you your own numbers under another person's name is its own kind of wrong.
 */
export function parseAnalyticsFilters(raw: Record<string, unknown>, user: ScopedUser | null): AnalyticsFilters {
  const str = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s === '' ? undefined : s;
  };

  const from = str(raw.from);
  const to = str(raw.to);
  if (from !== undefined && !DATE.test(from)) bad('from', `"${from}" is not a date. Use YYYY-MM-DD.`);
  if (to !== undefined && !DATE.test(to)) bad('to', `"${to}" is not a date. Use YYYY-MM-DD.`);
  // Compared as strings, which is exact for `YYYY-MM-DD` and needs no timezone to be right.
  if (from !== undefined && to !== undefined && from > to) {
    bad('to', `The end date (${to}) is before the start date (${from}).`);
  }

  const type = str(raw.type);
  if (type !== undefined && !(TRANSACTION_TYPES as readonly string[]).includes(type)) {
    bad('type', `"${type}" is not a transaction type.`);
  }

  const status = str(raw.status);
  if (status !== undefined && !ALL_STATUSES.includes(status)) {
    bad('status', `"${status}" is not a transaction status.`);
  }

  /*
   * THE AGENT SELECTOR.
   *
   * Office roles may name any agent. An agent may name only themselves — and the check is on the
   * USER ID, not the name, because this brokerage has two active accounts sharing one. A name-based
   * check would let either Akhil read the other's figures by typing their own name.
   */
  const rawAgent = raw.agent_user_id;
  let agentUserId: number | undefined;
  if (rawAgent !== undefined && rawAgent !== null && rawAgent !== '') {
    const n = Number(rawAgent);
    if (!Number.isSafeInteger(n) || n < 1) bad('agent_user_id', `"${String(rawAgent)}" is not an agent id.`);
    agentUserId = n;
  }

  if (isAgent(user)) {
    const own = typeof user?.id === 'number' ? user.id : undefined;
    if (agentUserId !== undefined && agentUserId !== own) {
      throw new ForbiddenException({ message: 'You can only view your own analytics.' });
    }
    // Locked to themselves whether or not they asked. The scope predicate already restricts the
    // rows; this makes the response say plainly whose figures these are.
    agentUserId = own;
  }

  return { from, to, agent_user_id: agentUserId, type, status };
}
