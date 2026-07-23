import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

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

  /** Best-effort: a lead change must never fail because the audit write did. */
  async record(user: AuthUserRecord, action: string, subject: string, details = ''): Promise<void> {
    try {
      const now = new Date();
      await this.prisma.audit_logs.create({
        data: {
          category: 'Lead',
          transaction_id: null,
          who: user.name,
          user_id: user.id ?? null,
          section: 'Leads',
          action,
          source: 'Manual',
          new_value: subject.slice(0, 255),
          details: `${action}: ${subject}${details ? ` — ${details}` : ''}`,
          created_at: now,
          updated_at: now,
        },
      });
    } catch (err) {
      this.log.warn(`Lead audit write failed (${action}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
