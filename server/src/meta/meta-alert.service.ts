import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { areaPath } from '../common/domain';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Tells somebody their Meta connection has stopped working.
 *
 * WHY THIS EXISTS. When a long-lived token expires — about sixty days — or is revoked, every sync
 * fails. That failure was recorded on the connection and shown on the Meta screen, and nowhere
 * else. An agent who is not looking at that screen sees only the absence of leads, which looks
 * exactly like a quiet week, and a brokerage paying per click keeps paying while nothing arrives.
 *
 * Silence is the failure mode being fixed here, so the message has to say what happened, what it
 * costs, and the one action that resolves it.
 *
 * Email, because that is what the Leads module already uses to tell an agent about a new lead, and
 * a person whose CRM has stopped collecting leads is not necessarily signed in to see a banner.
 */
@Injectable()
export class MetaAlertService {
  private readonly log = new Logger(MetaAlertService.name);

  constructor(private readonly prisma: PrismaService, private readonly mailer: MailerService) {}

  async reconnectRequired(userId: number, reason: string): Promise<void> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const to = user?.email?.trim();
    if (!to) {
      this.log.warn(`Meta reconnect notice for user #${userId} not sent: no email address on the account.`);
      return;
    }

    const base = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
    const link = `${base}${areaPath('crm', 'meta')}`;
    const name = user?.name?.trim() || 'there';

    const html = `
      <p>Hi ${esc(name)},</p>
      <p><strong>Your Meta connection has stopped working, and new Facebook lead-ad enquiries are not
      reaching your CRM.</strong></p>
      <p>Facebook said: ${esc(reason)}</p>
      <p>Access tokens expire after about sixty days, and they also stop working if the app is removed
      from your Facebook account or your password changes. Reconnecting takes a few seconds and your
      connected lead forms are kept — you will not have to choose them again.</p>
      <p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;background:#1877f2;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Reconnect Meta</a></p>
      <p style="color:#6b7280;font-size:12.5px">Leads submitted while the connection is down are not lost —
      Facebook holds them, and they are collected once you reconnect. Leads already in your CRM are unaffected.</p>
    `;

    await this.mailer.sendDirect(to, 'Action needed: reconnect Meta to keep receiving leads', html, null, [], userId);
    this.log.log(`Meta reconnect notice sent to ${to} (user #${userId}).`);
  }
}
