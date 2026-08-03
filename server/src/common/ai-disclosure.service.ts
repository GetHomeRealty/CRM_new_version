import { Injectable, Logger } from '@nestjs/common';
import { auditDomain } from './domain';
import { PrismaService } from '../prisma/prisma.service';
import { recordAuditFailure } from '../observability/audit-health';
import { AI_FEATURES, type AiFeatureKey } from './ai-consent';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Records that personal information was sent to a third-party AI provider.
 *
 * WHY ITS OWN WRITER. `AuditService.record` anchors an entry to a transaction, and most of these
 * disclosures have no transaction — an appointment need not be linked to a deal, a lead never is.
 * Recording only the linked ones would leave most disclosures unrecorded, which is the opposite of
 * the point. `LeadAuditService` already writes unanchored rows for the same reason; this does the
 * same for a concern that spans modules.
 *
 * WHY ONE CATEGORY FOR ALL OF THEM. The question this exists to answer is not "what happened to
 * this lead" but "what has this brokerage sent to AI vendors, and about whom" — asked by a privacy
 * officer, or by anyone answering an access request. That question is only answerable if every
 * disclosure lands in one place under one name, whichever module made it. Hence `category: 'AI'`
 * and one action verb, rather than each module inventing its own wording.
 *
 * Best-effort, like every other audit writer here: a feature must not fail because the trail could
 * not be written. But NOT silent — a compliance record whose absence is meaningless is worse than
 * none, so a failure is logged at ERROR and counted for the health endpoint.
 */
@Injectable()
export class AiDisclosureService {
  private readonly log = new Logger(AiDisclosureService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param feature  which catalogue entry authorised this — its `discloses` text is the standing
   *                 description of what the send is permitted to contain.
   * @param subject  who the disclosure was about, in words a person recognises (a lead's name, an
   *                 appointment's title). This is the field an access request is answered from.
   * @param sent     what was ACTUALLY included this time. Not the same as `discloses`: a record
   *                 with no notes discloses less than one with them, and the trail should describe
   *                 the request rather than the feature.
   */
  async record(
    user: AuthUserRecord,
    feature: AiFeatureKey,
    subject: string,
    sent: string,
    provider: { provider: string; model: string },
  ): Promise<void> {
    const action = `Sent to AI provider — ${AI_FEATURES[feature].label}`;
    try {
      const now = new Date();
      await this.prisma.audit_logs.create({
        data: {
          category: 'AI',
          transaction_id: null,
          domain: auditDomain({ category: 'AI' }),
          who: user.name,
          user_id: user.id ?? null,
          section: 'AI',
          action,
          source: 'Manual',
          new_value: subject.slice(0, 255),
          details:
            `${action}: ${subject} — provider ${provider.provider} (${provider.model}); sent: ${sent}`
              .slice(0, 2000),
          created_at: now,
          updated_at: now,
        },
      });
    } catch (err) {
      recordAuditFailure(action, err);
      this.log.error(
        `AI disclosure audit write failed (${feature}) — the record of what was sent to `
        + `${provider.provider} is INCOMPLETE: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
