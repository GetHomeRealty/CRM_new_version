import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from './commission.service';
import { commissionInclude, normalizeCommissionTxn } from './commission.loader';
import { parseJsonObject } from '../common/serialize';
import { agentCommission, agentLines, agentPaymentsPaid } from '../reports/report-financials';

/**
 * The derived agent-payment figures on `transactions`, recomputed from the blob.
 *
 * WHAT THIS IS FOR. `admin_activities` is a TEXT column holding JSON, and everything the reports say
 * about what an agent has been paid is derived from it. Text is not queryable and not indexable, so
 * every report that mentions payment state re-parsed it for every matching deal on every request.
 * Measured at 80,000 deals: Transaction Payment Status 10.3 s, Sales Statement 4.0 s, and the
 * brokerage totals 4.2 s — the last dominated by a sequential scan calling `desk_safe_jsonb` over
 * ~40,000 wide rows, three times per request, once per commission variant.
 *
 * The values do not change between writes. So they are computed on write and read as columns.
 *
 * ================================================================================================
 * THE BLOB REMAINS AUTHORITATIVE. These columns are a cache of a pure function of it and never a
 * second place a payment can be recorded. Nothing writes them but this service; if the two ever
 * disagree the blob is right and the cache is stale, and `verify-payment-cache.cjs` is what finds
 * that out — it recomputes every row and fails on a difference of one cent.
 * ================================================================================================
 *
 * IDENTICAL BY CONSTRUCTION, NOT BY TRANSLATION. This calls `agentPaymentsPaid` and `agentLines` —
 * the very functions the reports call — over a breakdown built by the same `CommissionService` the
 * reports use. There is no second implementation to drift: a change to the parser changes what this
 * stores, and the verifier compares stored against freshly parsed rather than against a copy of the
 * rules.
 *
 * THE FIGURES ARE BROKERAGE-WIDE, AND THAT IS A CONSTRAINT ON WHO MAY READ THEM. `enrich()` narrows
 * the agent names to the signed-in agent for an agent-scoped viewer, so the paid figure genuinely
 * differs per reader. What is cached here is the UNSCOPED answer. Every fast path that uses it
 * already refuses agent-scoped callers for unrelated reasons; if one ever stops doing so, it must
 * not read these columns.
 */
@Injectable()
export class PaymentCacheService {
  private readonly log = new Logger(PaymentCacheService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
  ) {}

  /**
   * The five derived values for one loaded transaction.
   *
   * Exported shape rather than written straight to the row, so the verifier can call exactly this
   * and compare — the thing being checked is that the STORE matches this function, which means the
   * check has to be able to run the function without writing anything.
   */
  async computeFor(t: CommissionLoadedTxn): Promise<PaymentCacheValues> {
    const bd = await this.commission.breakdown(normalizeCommissionTxn(t));
    const names = agentLines(bd).map((l) => String(l.name ?? '')).filter((n) => n !== '');
    const paid = agentPaymentsPaid(parseJsonObject(t.admin_activities), names);
    const tracker = parseJsonObject(t.activity_tracker);
    const faq = tracker.agent_commission_paid_status;

    return {
      /*
       * THE COMMISSION ENGINE'S OWN ANSWER, not a second derivation of it. `agentCommission` is the
       * exported function `enrich()` calls, over a breakdown from the same `CommissionService`, so
       * this stores what the report would have computed rather than something equal to it by
       * argument. `addTriple` rounds to the cent at every step, so the stored value carries the same
       * rounding the report shows.
       *
       * UNSCOPED — the sum over every agent line. `enrich()` narrows the lines to the signed-in
       * agent for an agent-scoped viewer, which is a different number; see the header.
       */
      calc_agent_comm_total: agentCommission(bd).total,
      calc_paid_total: paid.totalPaid,
      // `lastPaidDate` is a 'YYYY-MM-DD' string off the blob, or null. Stored as a DATE, so a value
      // that is not a date — the blob is free-form and hand-edited — becomes NULL rather than
      // throwing and stopping the whole backfill on one bad row.
      calc_paid_date: toDateOrNull(paid.lastPaidDate),
      calc_paid_name_count: paid.paidNames.length,
      calc_agent_name_count: names.length,
      // Recorded verbatim, including the empty string, because `agentPaymentStatus` distinguishes
      // 'Yes' and 'N/A' and 'Not Applicable' from everything else — and "everything else" includes
      // absent. Truncated to the column width; nothing meaningful is that long.
      calc_faq_paid_status: faq === undefined || faq === null ? null : String(faq).slice(0, 64),
    };
  }

  /**
   * Recompute and store, for a set of transaction ids.
   *
   * Used by the backfill and by the write path. Batched, because the backfill passes eighty thousand
   * ids and loading them in one query would hold the whole brokerage in memory to write five numbers
   * per row.
   */
  async recompute(ids: number[], batchSize = 500): Promise<number> {
    let written = 0;
    for (let i = 0; i < ids.length; i += batchSize) {
      const slice = ids.slice(i, i + batchSize);
      const rows = await this.prisma.transactions.findMany({
        where: { id: { in: slice } },
        include: commissionInclude,
      });
      const now = new Date();
      for (const t of rows) {
        try {
          const v = await this.computeFor(t);
          await this.prisma.transactions.update({
            where: { id: t.id },
            data: { ...v, calc_at: now },
          });
          written += 1;
        } catch (err) {
          /*
           * One unparseable deal must not stop the run. Its `calc_at` stays NULL, which readers
           * treat as "not computed" and answer from the blob — so the report is still right, just
           * slow for that row. Logged loudly because a growing count of them is a data problem.
           */
          this.log.warn(`payment cache recompute failed for transaction #${t.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return written;
  }

  /** Recompute one deal, after a write that could have moved any of its inputs. */
  async recomputeOne(id: number): Promise<void> {
    await this.recompute([id]);
  }
}

export interface PaymentCacheValues {
  calc_agent_comm_total: number;
  calc_paid_total: number;
  calc_paid_date: Date | null;
  calc_paid_name_count: number;
  calc_agent_name_count: number;
  calc_faq_paid_status: string | null;
}

/**
 * Exactly what `findMany({ include: commissionInclude })` returns.
 *
 * Spelled as the Prisma payload rather than as a hand-written shape: `breakdown()` reads eighty-odd
 * scalar columns off it, and a structural type listing the three this file touches compiles here and
 * fails there — which is what a looser earlier version of this alias did.
 */
export type CommissionLoadedTxn = Prisma.transactionsGetPayload<{ include: typeof commissionInclude }>;

/** 'YYYY-MM-DD' to a UTC Date, or null for anything that is not one. */
function toDateOrNull(s: string | null): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
