import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { auditDomain } from '../common/domain';
import { recordAuditFailure } from '../observability/audit-health';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Writes Campaigns activity into the global audit trail.
 *
 * WHY THIS DID NOT EXIST, and why that mattered. Leads, Settings, Users and Meta all write to
 * `audit_logs`; Campaigns did not write a single row. So the module that sends mail to thousands of
 * a brokerage's clients — under CASL, the one area where "who authorised this and when" is a legal
 * question rather than a curiosity — left no record of who created a campaign, who sent it, who
 * cancelled it, or who took an address off the suppression list.
 *
 * `category = 'Campaigns'` was already a recognised value: `auditDomain()` maps it to `crm`, and the
 * Audit Trail screen already offers it as a filter because the list is built from the screen
 * catalogue. The category existed and nothing ever wrote to it, so the filter was permanently empty.
 *
 * Anchored with `transaction_id = null`, exactly as Lead entries are — a campaign belongs to no
 * deal.
 *
 * BEST EFFORT, DELIBERATELY. A campaign must not fail to send because the trail could not be
 * written. But not silent either: a failure is counted through `recordAuditFailure` so it surfaces
 * on `GET /api/health/workers`, and logged at ERROR so it reaches alerting. The distinction the
 * lead writer records applies here too — without that, "it did not happen" and "it happened and we
 * failed to record it" are indistinguishable, which for a compliance record is the wrong failure
 * mode.
 */
@Injectable()
export class CampaignAuditService {
  private readonly log = new Logger(CampaignAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param action  what happened, in the past tense — this is what the trail filters on
   * @param subject the campaign's name, or the address for a suppression change
   * @param details the specifics somebody reading the trail a year later would need
   */
  async record(user: AuthUserRecord, action: string, subject: string, details = ''): Promise<void> {
    try {
      const now = new Date();
      await this.prisma.audit_logs.create({
        data: {
          category: 'Campaigns',
          transaction_id: null,
          // Classified by the same rules as every other audit write. This writer bypasses
          // AuditService, so without this line its rows land unclassified and show in both trails.
          domain: auditDomain({ category: 'Campaigns' }),
          who: user.name,
          user_id: user.id ?? null,
          section: 'Campaigns',
          action,
          source: 'Manual',
          /*
           * `new_value` and `details`, mirroring `LeadAuditService` exactly — there is no `subject`
           * column, and inventing one per module is how two writers end up producing rows the Audit
           * Trail screen renders differently. Truncated to the column width rather than left to be
           * rejected at insert time, which would lose the entry entirely.
           */
          new_value: subject.slice(0, 255),
          details: `${action}: ${subject}${details ? ` — ${details}` : ''}`,
          created_at: now,
          updated_at: now,
        },
      });
    } catch (err) {
      recordAuditFailure(action, err);
      this.log.error(
        `Campaign audit write failed (${action}) — the audit trail is INCOMPLETE: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
