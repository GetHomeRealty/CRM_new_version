import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';

/**
 * The only lead sources that trigger an immediate "new lead" email to the agent. Deliberately
 * limited to the three inbound channels — a manually typed referral/LinkedIn/YouTube lead does not
 * notify. Keys are compared lower-cased against `leads.lead_source`.
 */
const NOTIFY_SOURCES: Record<string, string> = {
  meta: 'Meta (Facebook / Instagram)',
  'google ads': 'Google Ads',
  website: 'Website',
};

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

interface NotifiableLead {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  lead_source: string | null;
  assigned_to: number | null;
  owner_user_id: number | null;
  property?: string | null;
  location?: string | null;
  message?: string | null;
}

/**
 * Sends the "a new lead just arrived" email. Best-effort by design: it is called after the lead is
 * already saved, and any mail failure is logged and swallowed so it can never block or roll back the
 * creation of the lead itself.
 */
@Injectable()
export class LeadNotificationService {
  private readonly log = new Logger(LeadNotificationService.name);

  constructor(private readonly prisma: PrismaService, private readonly mailer: MailerService) {}

  async notifyNewLead(lead: NotifiableLead): Promise<void> {
    const sourceLabel = NOTIFY_SOURCES[(lead.lead_source ?? '').trim().toLowerCase()];
    if (!sourceLabel) return; // only Meta / Google Ads / Website notify

    // Notify the assigned agent, or the owner if unassigned. Silent no-op if neither has an email.
    const userId = lead.assigned_to ?? lead.owner_user_id;
    if (!userId) return;

    let recipient: { email: string | null; name: string | null } | null = null;
    try {
      recipient = await this.prisma.users.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    } catch (e) {
      this.log.warn(`Could not look up lead ${lead.id} recipient: ${(e as Error).message}`);
      return;
    }
    const to = recipient?.email?.trim();
    if (!to) return;

    const base = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
    const link = `${base}/app/lead/${lead.id}`;
    const rows: string[] = [];
    const add = (label: string, value: unknown) => {
      const v = String(value ?? '').trim();
      if (v) rows.push(`<tr><td style="padding:4px 12px 4px 0;color:#6b7280">${esc(label)}</td><td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>`);
    };
    add('Name', lead.name);
    add('Source', sourceLabel);
    add('Email', lead.email && !lead.email.endsWith('@meta.invalid') ? lead.email : '');
    add('Phone', lead.phone);
    add('Property', lead.property);
    add('Location', lead.location);
    add('Message', lead.message);

    const subject = `New lead received from ${sourceLabel}${lead.name ? ` — ${lead.name}` : ''}`;
    const html =
      `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111827">` +
      `<h2 style="color:#b91c1c;margin:0 0 4px">New lead received</h2>` +
      `<p style="margin:0 0 16px;color:#374151">A new lead just came in from <strong>${esc(sourceLabel)}</strong>. Follow up as soon as you can.</p>` +
      `<table style="border-collapse:collapse;font-size:14px;margin-bottom:18px">${rows.join('')}</table>` +
      `<a href="${esc(link)}" style="display:inline-block;background:#b91c1c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Open the lead</a>` +
      `<p style="margin:18px 0 0;color:#9ca3af;font-size:12px">Get Home Realty · Transaction Desk</p>` +
      `</div>`;

    try {
      await this.mailer.sendDirect(to, subject, html);
      this.log.log(`New-lead (${sourceLabel}) email sent to ${to} for lead ${lead.id}`);
    } catch (e) {
      this.log.warn(`New-lead email to ${to} failed: ${(e as Error).message}`);
    }
  }
}
