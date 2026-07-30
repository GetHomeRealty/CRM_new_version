import { areaPath } from '../common/domain';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { parseJsonObject, phpJsonNormalize } from '../common/serialize';
import { missingLawyerParties, lawyerReminderMessage, tracksBothLawyers, type LawyerParty } from './lawyer-details';

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Emails the deal's agent(s) when buyer and/or seller lawyer details are still missing, naming
 * exactly which are outstanding. Best-effort — a mail failure never blocks saving a transaction.
 *
 * Two triggers, both funnel through `evaluate`:
 *   • on save (`maybeRemind`, interval 0) — fires the moment the *set* of missing parties changes;
 *   • on a schedule (`evaluate(id, days)`) — re-fires every `days` days while anything stays missing.
 *
 * State lives in `transactions.activity_tracker.lawyer_reminder = { parties, at }`, so we know both
 * which parties were last outstanding and when the last email went out.
 */
@Injectable()
export class TransactionLawyerReminderService {
  private readonly log = new Logger(TransactionLawyerReminderService.name);

  constructor(private readonly prisma: PrismaService, private readonly mailer: MailerService) {}

  /** On-save entry point: email only when the set of missing parties has changed. */
  maybeRemind(txnId: number): Promise<void> {
    return this.evaluate(txnId, 0);
  }

  /**
   * Decide whether to (re)send the reminder for one transaction.
   * @param intervalDays 0 = only when the missing set changes; > 0 = also every `intervalDays` days.
   */
  async evaluate(txnId: number, intervalDays: number): Promise<void> {
    const t = await this.prisma.transactions.findFirst({
      where: { id: txnId, deleted_at: null },
      select: {
        id: true, trade_no: true, property: true, type: true, agent: true,
        buyer_lawyer_name: true, seller_lawyer_name: true, activity_tracker: true,
      },
    });
    if (!t || !tracksBothLawyers(t.type)) return; // only Buying/Lease deals track both lawyers

    const missing = missingLawyerParties(t);
    const key = missing.join(','); // '', 'buyer', 'seller', 'buyer,seller'
    const tracker = parseJsonObject(t.activity_tracker);
    const marker = tracker.lawyer_reminder as { parties?: string; at?: string } | undefined;
    const prevKey = marker?.parties ?? '';

    const changed = key !== prevKey;
    const elapsed = marker?.at ? (Date.now() - new Date(marker.at).getTime()) / DAY_MS : Infinity;
    const due = intervalDays > 0 && elapsed >= intervalDays;
    const shouldSend = missing.length > 0 && (changed || due);

    if (!shouldSend && !changed) return; // nothing outstanding changed and nothing is due

    // Record the new state first (so a send retry can't loop), then send best-effort.
    const now = new Date();
    tracker.lawyer_reminder = { parties: key, at: shouldSend ? now.toISOString() : (marker?.at ?? now.toISOString()) };
    await this.prisma.transactions.update({
      where: { id: txnId },
      data: { activity_tracker: JSON.stringify(phpJsonNormalize(tracker)), updated_at: now },
    }).catch(() => { /* marker is best-effort */ });

    if (!shouldSend) return;

    const emails = await this.agentEmails(t.id, t.agent);
    if (emails.length === 0) return;

    const name = t.property || `Trade #${t.trade_no}`;
    await this.dispatch(emails, missing, name, t.id, t.trade_no, t.property);
    this.log.log(`Lawyer-detail reminder (${key}) sent for transaction ${txnId} to ${emails.length} agent(s)`);
  }

  private async dispatch(emails: string[], missing: LawyerParty[], name: string, id: number, tradeNo: string, property: string | null): Promise<void> {
    const message = lawyerReminderMessage(missing, name);
    const base = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
    const html =
      `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111827">` +
      `<h2 style="color:#b45309;margin:0 0 6px">Lawyer details needed</h2>` +
      `<p style="margin:0 0 16px;color:#374151">${esc(message)}</p>` +
      `<p style="margin:0 0 16px;color:#374151">Transaction <strong>#${esc(tradeNo)}</strong>${property ? ` — ${esc(property)}` : ''}.</p>` +
      `<a href="${esc(base)}${areaPath('desk', `transactions/${id}`)}?mode=edit" style="display:inline-block;background:#b45309;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Update lawyer details</a>` +
      `<p style="margin:18px 0 0;color:#9ca3af;font-size:12px">Get Home Realty · Transaction Desk</p>` +
      `</div>`;
    try {
      await this.mailer.sendDirect(emails.join(', '), `Action needed: lawyer details missing — ${name}`, html);
    } catch (e) {
      this.log.warn(`Lawyer-detail reminder for transaction ${id} failed: ${(e as Error).message}`);
    }
  }

  /** Emails of the primary agent plus any full team members. */
  private async agentEmails(txnId: number, agent: string | null): Promise<string[]> {
    const members = await this.prisma.team_members.findMany({ where: { transaction_id: txnId }, select: { name: true } });
    const names = [...new Set([agent, ...members.map((m) => m.name)].filter((n): n is string => !!n))];
    if (names.length === 0) return [];
    const users = await this.prisma.users.findMany({ where: { name: { in: names }, email: { not: '' } }, select: { email: true } });
    return [...new Set(users.map((u) => u.email).filter((e) => e))];
  }
}
