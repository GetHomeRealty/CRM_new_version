import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { META_BUDGET_PER_WINDOW, META_BUDGET_WINDOW_MS } from './meta.constants';

export interface BudgetVerdict {
  allowed: boolean;
  /** Calls spent in this window after the attempt. */
  spent: number;
  limit: number;
  /** Seconds until the window rolls over, so a caller can say when to try again. */
  resetInSeconds: number;
}

/**
 * A ceiling on Graph calls that everybody shares.
 *
 * WHY A PER-USER LIMIT IS NOT ENOUGH. `META_SYNC_LIMIT` throttles one person's presses of Sync, and
 * that closes the runaway case — but Meta enforces its rate limits **per app**, and this CRM is one
 * app. Twenty agents each within their personal allowance still add up to twenty times the traffic,
 * and when the app hits Meta's ceiling every agent starts seeing failures, none of which are
 * attributable to the person who caused them. A collective limit has to be counted collectively.
 *
 * WHY IT IS IN THE DATABASE. The same reason the OAuth nonces are: an in-memory counter is empty
 * after a restart and is not shared between instances, so on two app servers it would permit twice
 * the budget while reporting that it had not.
 *
 * THE INCREMENT IS THE CHECK. `INSERT … ON CONFLICT DO UPDATE … WHERE calls < limit` performs the
 * comparison and the increment in one statement, so two syncs arriving in the same millisecond
 * cannot both read "under budget" and both proceed. A read followed by a write has a gap; this does
 * not.
 *
 * WHAT IT COUNTS. One unit per lead form a sync will read, charged before the fan-out rather than
 * per HTTP request. That is an approximation — a form whose backlog spans several cursor pages
 * costs more than one call — chosen deliberately: it is one database round trip per sync instead of
 * one per Graph request, and the quantity that scales with the number of agents is the fan-out, not
 * the page depth. `META_BUDGET_PER_WINDOW` is sized with that in mind.
 */
@Injectable()
export class MetaApiBudgetService {
  private readonly log = new Logger(MetaApiBudgetService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Start of the window `at` falls in, as epoch MILLISECONDS, so every instance agrees.
   *
   * A number rather than a Date on purpose. The column is an integer bucket because a
   * `timestamp without time zone` is written by the raw driver in local time and read back by
   * Prisma's model API as UTC — the same window then resolved to two different rows, the counter
   * never incremented, and the budget silently did nothing while reporting that it had.
   */
  private windowStart(at: number): bigint {
    return BigInt(Math.floor(at / META_BUDGET_WINDOW_MS) * META_BUDGET_WINDOW_MS);
  }

  /**
   * Try to spend `cost` calls. Returns whether it was allowed and what remains.
   *
   * FAILS OPEN, deliberately, and this is the opposite of the OAuth nonce decision. If the counter
   * itself cannot be reached, refusing would stop lead collection brokerage-wide over a bookkeeping
   * table — trading a certain loss of leads against a possible Graph throttle that Meta itself
   * would apply anyway, and which the sync already handles as a retryable error. A replay of an
   * OAuth state is a security boundary; this is a budget.
   */
  async consume(cost: number): Promise<BudgetVerdict> {
    const units = Math.max(1, Math.floor(cost));
    const start = this.windowStart(Date.now());
    const resetInSeconds = Math.max(1, Math.ceil((Number(start) + META_BUDGET_WINDOW_MS - Date.now()) / 1000));

    try {
      const rows = await this.prisma.$queryRaw<{ calls: number }[]>`
        INSERT INTO meta_api_budget (window_start, calls)
        VALUES (${start}, ${units})
        ON CONFLICT (window_start) DO UPDATE
          SET calls = meta_api_budget.calls + ${units}
          WHERE meta_api_budget.calls + ${units} <= ${META_BUDGET_PER_WINDOW}
        RETURNING calls
      `;

      // No row back means the WHERE guard refused the update: the window is already spent.
      if (!rows.length) {
        const current = await this.prisma.meta_api_budget.findUnique({
          where: { window_start: start }, select: { calls: true },
        });
        return { allowed: false, spent: current?.calls ?? META_BUDGET_PER_WINDOW, limit: META_BUDGET_PER_WINDOW, resetInSeconds };
      }

      await this.sweep(start);
      return { allowed: true, spent: rows[0].calls, limit: META_BUDGET_PER_WINDOW, resetInSeconds };
    } catch (e) {
      this.log.error(`Meta API budget could not be recorded, allowing the call: ${(e as Error).message}`);
      return { allowed: true, spent: 0, limit: META_BUDGET_PER_WINDOW, resetInSeconds };
    }
  }

  /** What is left in the current window, without spending any of it. */
  async remaining(): Promise<number> {
    const row = await this.prisma.meta_api_budget.findUnique({
      where: { window_start: this.windowStart(Date.now()) }, select: { calls: true },
    });
    return Math.max(0, META_BUDGET_PER_WINDOW - (row?.calls ?? 0));
  }

  /** Windows that have rolled over are of no further interest. Errors here are not worth raising. */
  private async sweep(currentStart: bigint): Promise<void> {
    try {
      await this.prisma.meta_api_budget.deleteMany({ where: { window_start: { lt: currentStart } } });
    } catch {
      /* housekeeping only */
    }
  }
}
