import { auditDomain } from '../common/domain';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { recordAuditFailure } from '../observability/audit-health';

/**
 * Writes Lead activity into the global audit trail.
 *
 * `audit_logs` rows are usually anchored to a transaction; leads have none, so these are
 * written with `transaction_id = null` and `category = 'Lead'` — the category the Audit Trail
 * page already offers, since it builds its filter list from the screen catalog.
 */
@Injectable()
export class LeadAuditService {
  private readonly log = new Logger(LeadAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Best-effort: a lead change must never fail because the audit write did.
   *
   * `change` carries the BEFORE AND AFTER of one field, and exists because a trail that records
   * only which field moved cannot answer the question it is kept for. "Aswini changed lead_status
   * on this lead" does not tell a broker whether a live client was quietly marked cold, and on a
   * dispute that is the whole question. `audit_logs` has had `field`, `old_value` and `new_value`
   * columns all along, and the Audit Trail screen already renders them as their own columns - this
   * writer simply never filled them, and put the lead's NAME in `new_value` instead, so the New
   * value column showed a person rather than a value.
   *
   * Omitted for create, delete, restore and purge: nothing changed FROM anything on those, and the
   * subject-in-new_value shape those rows already have is left exactly as it was.
   */
  async record(
    user: AuthUserRecord,
    action: string,
    subject: string,
    details = '',
    change?: { field: string; old: string; new: string },
  ): Promise<void> {
    try {
      const now = new Date();
      await this.prisma.audit_logs.create({
        data: {
          category: 'Lead',
          transaction_id: null,
          // Classified by the same rules as every other audit write. This writer bypasses AuditService,
          // so without this line its rows land unclassified and show in both trails.
          domain: auditDomain({ category: 'Lead' }),
          who: user.name,
          user_id: user.id ?? null,
          section: 'Leads',
          field: change?.field ?? null,
          action,
          source: 'Manual',
          // Clipped to the column, exactly as the subject already is. A truncated value is still
          // evidence of a change; a failed insert would be none.
          old_value: change ? change.old.slice(0, 255) : null,
          new_value: (change ? change.new : subject).slice(0, 255),
          details: `${action}: ${subject}${details ? ` — ${details}` : ''}`,
          created_at: now,
          updated_at: now,
        },
      });
    } catch (err) {
      /*
       * Still best-effort — a lead change must not be rolled back because the trail could not be
       * written — but no longer silent.
       *
       * This was a `log.warn` and nothing more, which meant a broken audit trail looked exactly
       * like a working one from outside. For a compliance record that is the wrong failure mode:
       * it made the absence of an entry meaningless, because "it did not happen" and "it happened
       * and we failed to record it" became indistinguishable.
       *
       * ERROR rather than WARN so it reaches error-rate alerting, and counted so the monitor sees
       * it on /api/health/workers without anyone having to grep for a string.
       */
      recordAuditFailure(action, err);
      this.log.error(`Lead audit write failed (${action}) — the audit trail is INCOMPLETE: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
