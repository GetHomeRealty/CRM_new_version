import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { areaPath } from '../common/domain';
import { toDateTimeString } from '../common/serialize';

/**
 * The reminder ladder for review items nobody has put right.
 *
 * A rejection with a reason is worth little if it sits unread for a fortnight, so an open item is
 * chased on a fixed ladder — a day, three days, a week — and on the last rung the office is told as
 * well as the agent. The office rung is the point of the whole thing: an agent who has stopped
 * reading their mail is exactly the case a reminder cannot fix on its own.
 *
 * `sla_stage` records how far up the ladder each item has climbed, so a rung is sent once rather
 * than every hour until the item is resolved. The stage only moves forward, and an item that is
 * corrected or resolved simply stops matching.
 */

/** Hours open, and what happens when an item passes that mark. */
const LADDER = [
  { stage: 1, hours: 24, label: 'a day' },
  { stage: 2, hours: 72, label: 'three days' },
  { stage: 3, hours: 168, label: 'a week' },
] as const;

/** The rung that also tells the office. */
const ESCALATION_STAGE = 3;

/** Never chase more than this in one sweep — a backlog is reported, not fired off in one burst. */
const MAX_PER_SWEEP = 100;

const redirectTo = (): string | null => {
  const v = (process.env.MAIL_REDIRECT_TO ?? '').trim();
  return v === '' ? null : v;
};

@Injectable()
export class ReviewSlaService {
  private readonly log = new Logger(ReviewSlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
  ) {}

  /**
   * One pass of the ladder. Safe to run as often as you like: an item only moves up a rung once it
   * has genuinely passed the next mark, and nothing is sent twice for the same rung.
   */
  async sweep(): Promise<{ reminded: number; escalated: number }> {
    const now = Date.now();
    let reminded = 0;
    let escalated = 0;

    // Highest rung first, so an item that has been open for a fortnight gets the week's message and
    // the escalation rather than three days' worth of catching up.
    for (const rung of [...LADDER].reverse()) {
      const due = await this.prisma.transaction_reviews.findMany({
        where: {
          decision: 'Rejected',
          resolution_status: 'Open',
          sla_stage: { lt: rung.stage },
          created_at: { lt: new Date(now - rung.hours * 3600_000) },
        },
        orderBy: { created_at: 'asc' },
        take: MAX_PER_SWEEP,
        include: { transactions: { select: { id: true, trade_no: true, property: true, deleted_at: true } } },
      });

      for (const item of due) {
        if (!item.transactions || item.transactions.deleted_at) {
          // The deal is gone; stop chasing it but record that we are done with the item.
          await this.advance(item.id, rung.stage);
          continue;
        }
        try {
          await this.remind(item, rung.label, rung.stage === ESCALATION_STAGE);
          reminded++;
          if (rung.stage === ESCALATION_STAGE) escalated++;
        } catch (err) {
          // Logged and skipped: the stage is still advanced below, because retrying a broken address
          // every hour for ever is noise, and the item stays visible as overdue on the dashboard.
          this.log.error(`Review ${item.id}: reminder failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.advance(item.id, rung.stage);
      }
    }

    if (reminded) this.log.log(`Review reminders: ${reminded} sent, ${escalated} escalated to the office.`);
    return { reminded, escalated };
  }

  private async advance(id: number, stage: number): Promise<void> {
    await this.prisma.transaction_reviews.update({
      where: { id },
      data: { sla_stage: stage, sla_notified_at: new Date(), updated_at: new Date() },
    });
  }

  /** The agent, and on the last rung the office too. */
  private async remind(
    item: { id: number; field_label: string | null; reason: string | null; agent_name: string | null; actor_name: string | null; created_at: Date | null; transactions: { id: number; trade_no: string | null; property: string | null } },
    openFor: string,
    escalate: boolean,
  ): Promise<void> {
    const company = (await this.settings.current()).name;
    const base = (process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
    const link = base ? `${base}${areaPath('desk', `transactions/${item.transactions.id}`)}` : '';

    const vars = {
      agent_name: item.agent_name ?? 'there',
      deal_number: item.transactions.trade_no ?? String(item.transactions.id),
      property_address: item.transactions.property ?? '—',
      field_label: item.field_label ?? 'A change',
      reason: item.reason ?? '—',
      reviewer: item.actor_name ?? 'the office',
      open_for: openFor,
      rejected_at: toDateTimeString(item.created_at) ?? '',
      transaction_button: link
        ? `<p style="margin:18px 0"><a href="${link}" style="background:#1f3b73;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;display:inline-block">Open the transaction</a></p>`
        : '',
      company_name: company,
    };

    const agentAddress = await this.addressFor(item.agent_name);
    if (agentAddress) {
      await this.mailer.send('transaction.review_reminder', vars, redirectTo() ?? agentAddress);
    } else {
      this.log.warn(`Review ${item.id}: no email on file for "${item.agent_name ?? 'unassigned'}".`);
    }

    if (escalate) {
      const office = await this.officeAddresses();
      if (office.length) {
        await this.mailer.send('transaction.review_escalation', vars, redirectTo() ?? office);
      } else {
        this.log.warn(`Review ${item.id}: nothing to escalate to — no active administrator has an email address.`);
      }
    }
  }

  private async addressFor(name: string | null): Promise<string | null> {
    const n = (name ?? '').trim();
    if (!n) return null;
    const user = await this.prisma.users.findFirst({ where: { name: n, status: 'Active' }, select: { email: true } });
    return (user?.email ?? '').trim() || null;
  }

  /** Who an overdue item escalates to: the administrators, who can act on it. */
  private async officeAddresses(): Promise<string[]> {
    const users = await this.prisma.users.findMany({
      where: { status: 'Active', role: { in: ['admin', 'manager'] } },
      select: { email: true },
    });
    return [...new Set(users.map((u) => (u.email ?? '').trim()).filter(Boolean))];
  }
}
