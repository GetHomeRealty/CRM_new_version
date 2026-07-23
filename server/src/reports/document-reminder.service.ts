import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { ReportDataService, type EnrichedTxn } from './report-data.service';
import type { AuthUserRecord } from '../auth/auth.types';
import type { DocRow } from './report-documents';

/** What a reminder targets. Pending and invalid are always kept apart. */
export type ReminderScope = 'pending' | 'invalid' | 'all';

export interface ReminderRequest {
  /** Transactions to remind about (bulk = more than one). */
  transaction_ids: number[];
  /** Restrict to specific documents (individual reminder / partial selection). */
  document_ids?: number[];
  scope: ReminderScope;
  channel?: string;
}

/** One deal's worth of reminder work, resolved before anything is sent. */
export interface ReminderTarget {
  transaction_id: number;
  trade_no: string;
  property: string | null;
  recipient: string | null;
  recipient_name: string | null;
  documents: DocRow[];
  pending: number;
  invalid: number;
  /** Documents reminded about within the duplicate window (warned, not blocked). */
  recently_reminded: { id: number; name: string; sent_at: string | null }[];
  blocked_reason?: string;
}

export interface ReminderPreview {
  deals: number;
  documents: number;
  pending: number;
  invalid: number;
  recipients: string[];
  missing_recipients: { trade_no: string; reason: string }[];
  duplicate_warnings: { trade_no: string; document: string; sent_at: string | null }[];
  targets: ReminderTarget[];
}

export interface ReminderResult {
  batch_id: string;
  sent: number;
  failed: number;
  skipped: number;
  documents: number;
  deals: { trade_no: string; recipient: string | null; status: string; documents: number; reason?: string }[];
}

/** A document reminded about within this many hours triggers a duplicate warning. */
export const DUPLICATE_WINDOW_HOURS = 24;
/**
 * Safety valve for non-production environments: when MAIL_REDIRECT_TO is set, every reminder
 * is delivered to that address instead of the agent's. The log still records the intended
 * recipient, so reports stay truthful about who the reminder was for.
 */
const redirectTo = (): string | null => {
  const v = (process.env.MAIL_REDIRECT_TO ?? '').trim();
  return v === '' ? null : v;
};
/** Never let one request fan out further than this (accidental "select all" protection). */
export const MAX_DEALS_PER_REQUEST = 200;

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

@Injectable()
export class DocumentReminderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: ReportDataService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
  ) {}

  /** Agents may only ever act on their own deals. */
  private scopeOf(user: AuthUserRecord) {
    return (user.role ?? 'agent') === 'agent' ? { lockedAgent: user.name } : {};
  }

  /** Documents in scope for a reminder — pending and invalid are never merged silently. */
  private docsInScope(t: EnrichedTxn, scope: ReminderScope, ids?: number[]): DocRow[] {
    let docs = t.docs.filter((d) => (scope === 'all' ? d.status === 'Pending' || d.status === 'Invalid' : d.status === (scope === 'pending' ? 'Pending' : 'Invalid')));
    if (ids && ids.length) docs = docs.filter((d) => ids.includes(d.id));
    return docs;
  }

  /**
   * Resolve what WOULD be sent: deals, document counts, recipients and duplicate warnings.
   * The spec requires the user to see the applicable document count before sending, so the
   * send path calls this too rather than duplicating the logic.
   */
  async preview(req: ReminderRequest, user: AuthUserRecord): Promise<ReminderPreview> {
    const ids = [...new Set(req.transaction_ids ?? [])];
    if (!ids.length) throw new BadRequestException({ message: 'Select at least one transaction.' });
    if (ids.length > MAX_DEALS_PER_REQUEST) {
      throw new BadRequestException({ message: `Too many transactions selected (${ids.length}). The limit is ${MAX_DEALS_PER_REQUEST}.` });
    }

    const all = await this.data.load(this.scopeOf(user));
    const byId = new Map(all.map((t) => [t.id, t]));
    // an id the user cannot see is simply not in scope — never reveal that it exists
    const found = ids.map((id) => byId.get(id)).filter((t): t is EnrichedTxn => !!t);
    if (!found.length) throw new NotFoundException({ message: 'No matching transactions are available to you.' });

    const agentEmails = await this.agentEmails();
    const since = new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 3600_000);
    const recent = await this.prisma.document_reminders.findMany({
      where: { transaction_id: { in: found.map((t) => t.id) }, sent_at: { gte: since }, delivery_status: 'Sent' },
      select: { document_id: true, transaction_id: true, sent_at: true },
    });

    const targets: ReminderTarget[] = found.map((t) => {
      const docs = this.docsInScope(t, req.scope, req.document_ids);
      const name = t.agent ?? t.agent_names[0] ?? null;
      const email = name ? agentEmails.get(name) ?? null : null;
      const recentlyReminded = docs
        .map((d) => {
          const hit = recent.find((r) => r.transaction_id === t.id && r.document_id === d.id);
          return hit ? { id: d.id, name: d.title, sent_at: hit.sent_at ? hit.sent_at.toISOString() : null } : null;
        })
        .filter((x): x is { id: number; name: string; sent_at: string | null } => !!x);
      return {
        transaction_id: t.id,
        trade_no: t.trade_no,
        property: t.property,
        recipient: email,
        recipient_name: name,
        documents: docs,
        pending: docs.filter((d) => d.status === 'Pending').length,
        invalid: docs.filter((d) => d.status === 'Invalid').length,
        recently_reminded: recentlyReminded,
        blocked_reason: !docs.length
          ? 'No documents match this reminder type.'
          : !email
            ? `No email address on file for ${name ?? 'the assigned agent'}.`
            : undefined,
      };
    });

    return {
      deals: targets.filter((t) => !t.blocked_reason).length,
      documents: targets.reduce((a, t) => a + (t.blocked_reason ? 0 : t.documents.length), 0),
      pending: targets.reduce((a, t) => a + (t.blocked_reason ? 0 : t.pending), 0),
      invalid: targets.reduce((a, t) => a + (t.blocked_reason ? 0 : t.invalid), 0),
      recipients: [...new Set(targets.filter((t) => t.recipient).map((t) => t.recipient!))],
      missing_recipients: targets.filter((t) => t.blocked_reason).map((t) => ({ trade_no: t.trade_no, reason: t.blocked_reason! })),
      duplicate_warnings: targets.flatMap((t) => t.recently_reminded.map((d) => ({ trade_no: t.trade_no, document: d.name, sent_at: d.sent_at }))),
      targets,
    };
  }

  /**
   * Send reminders. One message per deal — documents from different deals are never mixed —
   * and every attempt is logged per document, whether it succeeded or failed.
   */
  async send(req: ReminderRequest, user: AuthUserRecord): Promise<ReminderResult> {
    if (!this.canSend(user)) throw new ForbiddenException({ message: 'You do not have permission to send document reminders.' });
    if (req.transaction_ids.length > 1 && !this.canBulk(user)) {
      throw new ForbiddenException({ message: 'You do not have permission to send bulk reminders.' });
    }

    const preview = await this.preview(req, user);
    const company = (await this.settings.current()).name;
    const batchId = this.batchId();
    const channel = req.channel ?? 'email';
    const now = new Date();
    const result: ReminderResult = { batch_id: batchId, sent: 0, failed: 0, skipped: 0, documents: 0, deals: [] };

    for (const target of preview.targets) {
      if (target.blocked_reason) {
        result.skipped++;
        result.deals.push({ trade_no: target.trade_no, recipient: target.recipient, status: 'Skipped', documents: target.documents.length, reason: target.blocked_reason });
        await this.log(target, batchId, req, channel, user, now, 'Skipped', target.blocked_reason, null);
        continue;
      }

      const statusLabel = req.scope === 'invalid' ? 'Invalid' : req.scope === 'pending' ? 'Pending' : 'Outstanding';
      const html = this.documentsTable(target.documents);
      const redirect = redirectTo();
      const message = `${statusLabel} documentation reminder — ${target.documents.length} document(s) on ${target.trade_no}`
        // the log keeps the intended recipient; note the override so history is never misleading
        + (redirect ? ` [redirected to ${redirect}]` : '');
      try {
        await this.mailer.send('document.reminder', {
          deal_number: target.trade_no,
          property_address: target.property ?? '—',
          agent_name: target.recipient_name ?? 'there',
          status_label: statusLabel,
          document_count: String(target.documents.length),
          documents_table: html,
          instructions: this.instructions(req.scope),
          company_name: company,
        }, redirect ?? target.recipient!);
        result.sent++;
        result.documents += target.documents.length;
        result.deals.push({ trade_no: target.trade_no, recipient: target.recipient, status: 'Sent', documents: target.documents.length });
        await this.log(target, batchId, req, channel, user, now, 'Sent', null, message);
        // mark the documents as reminded so the Documents module reflects it too
        await this.prisma.documents.updateMany({ where: { id: { in: target.documents.map((d) => d.id) } }, data: { reminder: true, updated_at: now } });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.failed++;
        result.deals.push({ trade_no: target.trade_no, recipient: target.recipient, status: 'Failed', documents: target.documents.length, reason });
        await this.log(target, batchId, req, channel, user, now, 'Failed', reason, message);
      }
    }
    return result;
  }

  /** One log row per document, so history can be reported per document or per batch. */
  private async log(
    target: ReminderTarget, batchId: string, req: ReminderRequest, channel: string,
    user: AuthUserRecord, now: Date, status: string, failure: string | null, message: string | null,
  ): Promise<void> {
    const type = this.reminderType(req);
    const rows = (target.documents.length ? target.documents : [null]).map((d) => ({
      batch_id: batchId,
      transaction_id: target.transaction_id,
      document_id: d?.id ?? null,
      document_name: d?.title ?? null,
      document_status: d?.status ?? null,
      reminder_type: type,
      channel,
      recipient: target.recipient,
      recipient_name: target.recipient_name,
      sent_by: user.name,
      sent_by_id: user.id ?? null,
      sent_at: now,
      delivery_status: status,
      failure_reason: failure,
      message,
      document_count: target.documents.length || 0,
      created_at: now,
      updated_at: now,
    }));
    await this.prisma.document_reminders.createMany({ data: rows });
  }

  private reminderType(req: ReminderRequest): string {
    const bulk = req.transaction_ids.length > 1;
    if (req.document_ids?.length && !bulk) return 'individual';
    return `${bulk ? 'bulk' : 'deal'}_${req.scope}`;
  }

  private instructions(scope: ReminderScope): string {
    if (scope === 'invalid') return 'Please replace each document listed above — open the deal in Transaction Desk, remove the invalid file and upload a corrected copy.';
    if (scope === 'pending') return 'Please upload each document listed above from the Documents tab of the deal in Transaction Desk.';
    return 'Please upload the pending documents and replace the invalid ones from the Documents tab of the deal in Transaction Desk.';
  }

  /** The document list embedded in the email — name, status, due/uploaded date and reason. */
  private documentsTable(docs: DocRow[]): string {
    const rows = docs.map((d) => `<tr>`
      + `<td style="padding:4px 8px;border:1px solid #e5e7eb">${esc(d.title)}</td>`
      + `<td style="padding:4px 8px;border:1px solid #e5e7eb">${esc(d.category)}</td>`
      + `<td style="padding:4px 8px;border:1px solid #e5e7eb">${esc(d.status)}</td>`
      + `<td style="padding:4px 8px;border:1px solid #e5e7eb">${esc(d.mandatory ? 'Required' : 'Optional')}</td>`
      + `<td style="padding:4px 8px;border:1px solid #e5e7eb">${esc(d.status === 'Invalid' ? (d.remarks ?? 'Not specified') : (d.uploaded_at ?? '—'))}</td>`
      + `</tr>`).join('');
    return '<table style="border-collapse:collapse;font-size:13px">'
      + '<thead><tr>'
      + ['Document', 'Category', 'Status', 'Required', 'Reason / Uploaded']
        .map((h) => `<th style="padding:4px 8px;border:1px solid #e5e7eb;background:#eef2ff;text-align:left">${h}</th>`).join('')
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /** name → email for agent users (reminders go to the agent responsible for the deal). */
  private async agentEmails(): Promise<Map<string, string>> {
    const users = await this.prisma.users.findMany({ where: { status: 'Active' }, select: { name: true, email: true } });
    const map = new Map<string, string>();
    for (const u of users) if (u.email) map.set(u.name, u.email);
    return map;
  }

  /** Deterministic-enough batch id (timestamp + counter suffix) for grouping a single send. */
  private batchId(): string {
    return 'RB-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 1e6).toString(36).toUpperCase();
  }

  // ---- permissions ----
  /** Any user who can reach the reports screen may remind on their own deals. */
  private canSend(user: AuthUserRecord): boolean {
    return !!user?.name;
  }
  /** Multi-deal reminders are a staff/admin action — agents send one deal at a time. */
  private canBulk(user: AuthUserRecord): boolean {
    return (user.role ?? 'agent') !== 'agent';
  }
}
