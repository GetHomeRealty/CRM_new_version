import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../meta/meta-lead-mapper';

@Injectable()
export class SmsInboundService {
  private readonly log = new Logger(SmsInboundService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a reply from a lead.
   *
   * Matched by phone number, which is the only thing an inbound SMS carries. Numbers are
   * compared in normalised form so `+1 (416) 555-0134` and `4165550134` are the same lead —
   * the same rule the Meta importer uses for its own duplicate detection.
   *
   * Nothing is created when no lead owns the number: an unmatched reply is logged for an
   * administrator to look at rather than quietly turned into a new lead, because an SMS gives us
   * no name, no email and no consent to hold either.
   */
  async record(from: string, body: string, sid: string): Promise<{ matched: boolean }> {
    const normalized = normalizePhone(from);
    if (!normalized || !body) return { matched: false };

    // Twilio retries a webhook it thinks failed, so the SID is what stops a reply being logged
    // twice. Checked before the lead lookup: a duplicate is not worth a query.
    if (sid) {
      const seen = await this.prisma.lead_messages.findUnique({ where: { provider_sid: sid }, select: { id: true } });
      if (seen) return { matched: true };
    }

    const lead = await this.prisma.leads.findFirst({
      where: { deleted_at: null, OR: [{ phone_normalized: normalized }, { phone: from }] },
      orderBy: { id: 'desc' },
      select: { id: true, name: true },
    });
    if (!lead) {
      this.log.warn(`Inbound SMS from ${from} matched no lead — not recorded.`);
      return { matched: false };
    }

    await this.prisma.lead_messages.create({
      data: {
        lead_id: lead.id,
        direction: 'inbound',
        status: null,                 // a received message has no delivery status
        body: body.slice(0, 2000),
        phone: from,
        provider_sid: sid || null,
        sent_at: new Date(),
        created_by: 'SMS gateway',
        created_at: new Date(),
      },
    });
    this.log.log(`Inbound SMS from ${from} logged against lead #${lead.id}.`);
    return { matched: true };
  }
}
