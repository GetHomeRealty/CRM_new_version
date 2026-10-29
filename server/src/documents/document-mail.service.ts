import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { STORAGE_ROOT } from '../config/storage';

/**
 * The two emails documentation sends on its own: the review outcome to the agent, and the upload
 * notice to the deals desk.
 *
 * Both are best-effort. A save that succeeded must not report failure because a mail server was
 * briefly unreachable — the documents are stored and audited either way — so every failure here is
 * logged and swallowed. That is a deliberate trade: silence about an email is recoverable, losing a
 * document review because of one is not.
 */

/**
 * Where an agent's uploads are copied. A constant rather than a setting because it is one fixed
 * internal address, and MAIL_REDIRECT_TO still diverts it in a test environment like everything else.
 */
const DEALS_INBOX = 'deals@gethomerealty.ca';

/** Diverts every message when set, so a test environment cannot mail the real desk or a real agent. */
const redirectTo = (): string | null => {
  const v = (process.env.MAIL_REDIRECT_TO ?? '').trim();
  return v === '' ? null : v;
};

const esc = (value: unknown): string =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Extensions worth naming so a mail client shows a preview rather than an unknown blob. */
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

@Injectable()
export class DocumentMailService {
  private readonly log = new Logger(DocumentMailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
    /*
     * Optional so existing constructions — including this service's specs — keep working. Always
     * injected in the running application.
     */
    private readonly dispatcher?: NotificationDispatcher,
  ) {}

  /**
   * Tell the agent how their documents were assessed.
   *
   * Valid first, then invalid with the reason each was rejected for. That order is the point of the
   * message: an agent reads it to find out what they still have to do, and burying three rejections
   * among twenty acceptances is how a re-upload gets missed. Anything still Pending is left out —
   * it has not been assessed, so there is nothing to report about it.
   */
  async sendReviewOutcome(txnId: number): Promise<void> {
    try {
      const txn = await this.prisma.transactions.findFirst({
        where: { id: txnId, deleted_at: null },
        select: { id: true, trade_no: true, property: true, agent: true },
      });
      if (!txn) return;

      // 29 Oct 2026 (Sai) - every agent on the deal: its agent and each co-agent with an account.
      const agents = (await this.agentsOf(txnId)).filter((a) => (a.email ?? '').trim() !== '');
      if (agents.length === 0) {
        this.log.warn(`Document review on ${txn.trade_no}: no email on file for "${txn.agent ?? 'unassigned'}" — nothing sent.`);
        return;
      }

      /*
       * THE PREFERENCE, ASKED OF THE DISPATCHER RATHER THAN CHECKED HERE.
       *
       * This message is worth keeping — it lists every document, which passed, and why the rest did
       * not — so it is not replaced by a generic dispatched notification. What was missing is that
       * it went out whatever the person had chosen. The dispatcher owns that decision for every
       * channel of every category; this asks it and then sends its own, better message.
       */

      const docs = await this.prisma.documents.findMany({
        where: { transaction_id: txnId, deleted_at: null },
        orderBy: { position: 'asc' },
        select: { title: true, validation: true, remarks: true },
      });
      const valid = docs.filter((d) => d.validation === 'Valid');
      const invalid = docs.filter((d) => d.validation === 'Invalid');
      // Nothing assessed either way — the save changed something else, and an email saying so would
      // be noise.
      if (valid.length === 0 && invalid.length === 0) return;

      const company = (await this.settings.current()).name;
      for (const agent of agents) {
        if (this.dispatcher && !(await this.dispatcher.shouldSend(agent.id, 'document_review', 'email'))) {
          this.log.log(`Document review on ${txn.trade_no}: ${agent.name} has turned this email off.`);
          continue;
        }
        await this.mailer.send('document.review_result', {
          agent_name: agent.name,
          deal_number: txn.trade_no ?? String(txn.id),
          property_address: txn.property ?? '—',
          valid_count: String(valid.length),
          invalid_count: String(invalid.length),
          documents_table: this.outcomeTable(valid, invalid),
          instructions: invalid.length
            ? 'Please re-upload the documents marked invalid, correcting the point noted against each one.'
            : 'No further action is needed.',
          company_name: company,
        }, redirectTo() ?? (agent.email as string));
      }
    } catch (err) {
      this.log.error(`Could not send the document review outcome for transaction ${txnId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Copy an agent's upload to the deals desk, with the file attached.
   *
   * Sent per file rather than batched: an upload is a single act, the desk wants the paperwork at
   * the moment it arrives, and holding files back to group them would mean deciding when a batch
   * has ended — which nothing here knows.
   */
  async notifyUpload(txnId: number, agentName: string | null, documentTitle: string, fileName: string, relPath: string): Promise<void> {
    try {
      const txn = await this.prisma.transactions.findFirst({
        where: { id: txnId, deleted_at: null },
        select: { id: true, trade_no: true, property: true },
      });
      if (!txn) return;

      const company = (await this.settings.current()).name;
      const attachment = await this.readFile(relPath, fileName);

      await this.mailer.send('document.agent_upload', {
        agent_name: agentName ?? 'An agent',
        deal_number: txn.trade_no ?? String(txn.id),
        property_address: txn.property ?? '—',
        document_name: documentTitle,
        file_name: fileName,
        company_name: company,
      }, redirectTo() ?? DEALS_INBOX, [], attachment ? [attachment] : []);
    } catch (err) {
      this.log.error(`Could not notify ${DEALS_INBOX} of an upload on transaction ${txnId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The stored file as a mail attachment, or null when it cannot be read — the notice still goes. */
  private async readFile(relPath: string, fileName: string): Promise<{ data: string; name: string; mime: string } | null> {
    if (!relPath) return null;
    // Resolved against the storage root and checked, so a stored path can never reach outside it.
    const abs = path.resolve(STORAGE_ROOT, relPath);
    if (!abs.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) return null;
    try {
      const bytes = await fs.readFile(abs);
      return {
        data: bytes.toString('base64'),
        name: fileName,
        mime: MIME[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  /** The agent's address, by the name recorded on the deal — the same lookup document reminders use. */
  /**
   * The agent behind a name — id as well as address, because the preference is keyed by user id.
   *
   * This replaced `agentEmail`, which returned only the address and had exactly one caller — the
   * one that now needs the id too.
   */
  // ---------------------------------------------------------------- 29 Oct 2026 (Sai): who is told

  /**
   * Every agent on a deal: its agent (by account, else by name) and each co-agent on the team with an
   * active account. One entry per person.
   */
  async agentsOf(txnId: number): Promise<{ id: number; name: string; email: string | null }[]> {
    const t = await this.prisma.transactions.findFirst({
      where: { id: txnId, deleted_at: null },
      select: { agent: true, agent_user_id: true, team_members: { select: { user_id: true, name: true } } },
    });
    if (!t) return [];
    const out = new Map<number, { id: number; name: string; email: string | null }>();
    const add = async (id: number | null, name: string | null) => {
      const n = (name ?? '').trim();
      const u = id
        ? await this.prisma.users.findFirst({ where: { id, status: 'Active' }, select: { id: true, name: true, email: true } })
        : n ? await this.prisma.users.findFirst({ where: { name: n, status: 'Active' }, select: { id: true, name: true, email: true }, orderBy: { id: 'asc' } }) : null;
      if (u && !out.has(u.id)) out.set(u.id, u);
    };
    await add(t.agent_user_id ?? null, t.agent);
    for (const m of t.team_members) await add(m.user_id ?? null, m.name);
    return [...out.values()];
  }

  /**
   * Who in Documentation hears about a deal - the same rule as the after-closing reminders (Sai, answer
   * (a)): the deal's Documentation "Handled by" person; when nobody is named, everyone active in
   * Documentation who works in the deal's country.
   */
  async documentationFor(txnId: number): Promise<{ id: number; name: string; email: string | null }[]> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId }, select: { doc_handler_id: true, market: true } });
    if (!t) return [];
    if (t.doc_handler_id) {
      const h = await this.prisma.users.findFirst({ where: { id: t.doc_handler_id, status: 'Active' }, select: { id: true, name: true, email: true } });
      if (h) return [h];
    }
    const market = (t.market ?? 'CA').trim().toUpperCase() || 'CA';
    const team = await this.prisma.users.findMany({
      where: { role: 'documentation', status: 'Active' },
      select: { id: true, name: true, email: true, markets: true },
      orderBy: { id: 'asc' },
    });
    return team
      .filter((u) => (u.markets ?? 'CA').split(',').map((m) => m.trim().toUpperCase()).includes(market))
      .map(({ id, name, email }) => ({ id, name, email }));
  }

  /**
   * An agent submitted documents: Documentation is told in the bell and on their phone - no email
   * (Sai: "only bell and phone"; deals@ still gets its email with the file). One message per submit,
   * naming each document and marking the ones sent again after being marked Invalid.
   */
  async tellDocumentationOfUploads(txnId: number, agentName: string | null, items: { title: string; reupload: boolean }[]): Promise<void> {
    if (!this.dispatcher || items.length === 0) return;
    try {
      const txn = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null }, select: { trade_no: true, property: true } });
      if (!txn) return;
      const reup = items.filter((i) => i.reupload).length;
      const what = items.length === 1 ? (items[0].reupload ? 're-uploaded 1 document' : 'uploaded 1 document') : `uploaded ${items.length} documents${reup ? ` (${reup} re-uploaded)` : ''}`;
      const title = `${agentName ?? 'An agent'} ${what} - ${txn.property ?? txn.trade_no ?? ''}`.trim();
      const body = items.map((i) => (i.reupload ? `${i.title} (re-upload after Invalid)` : i.title)).join(' · ');
      for (const p of await this.documentationFor(txnId)) {
        await this.dispatcher.dispatch({
          category: 'document_uploads', userId: p.id, title, body,
          link: `/desk/transactions/${txnId}`, channels: ['in_app', 'push'],
        }).catch(() => undefined);
      }
    } catch (err) {
      this.log.error(`Could not tell Documentation about uploads on transaction ${txnId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The office changed documents on a deal: every agent on it is told, in the bell and on their phone,
   * in ONE message listing what changed. `reviewed` = a Valid/Invalid decision was in this save; that
   * one already has its email (sendReviewOutcome) and its bell row (the DocReview audit), so only the
   * phone is asked for here.
   */
  async tellAgentsOfChanges(txnId: number, changes: string[], reviewed: boolean, reviewSummary: string | null): Promise<void> {
    if (!this.dispatcher || (changes.length === 0 && !reviewed)) return;
    try {
      const txn = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null }, select: { trade_no: true, property: true } });
      if (!txn) return;
      const where = txn.property ?? txn.trade_no ?? '';
      const title = reviewed ? 'Your documents were reviewed' : `Documents updated - ${where}`.trim();
      const shown = changes.length > 8 ? [...changes.slice(0, 8), `and ${changes.length - 8} more`] : changes;
      const body = [reviewSummary, ...shown].filter((x): x is string => !!x).join(' · ');
      for (const a of await this.agentsOf(txnId)) {
        await this.dispatcher.dispatch({
          category: 'document_review', userId: a.id, title, body,
          link: `/desk/transactions/${txnId}`, channels: reviewed ? ['push'] : ['in_app', 'push'],
        }).catch(() => undefined);
      }
    } catch (err) {
      this.log.error(`Could not tell the agents about document changes on transaction ${txnId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }



  /** Valid documents, then invalid ones with their reason. */
  private outcomeTable(
    valid: { title: string; remarks: string | null }[],
    invalid: { title: string; remarks: string | null }[],
  ): string {
    const head = '<tr>'
      + '<th align="left" style="padding:6px 10px;border-bottom:2px solid #d1d5db;font-size:13px">Document</th>'
      + '<th align="left" style="padding:6px 10px;border-bottom:2px solid #d1d5db;font-size:13px">Result</th>'
      + '<th align="left" style="padding:6px 10px;border-bottom:2px solid #d1d5db;font-size:13px">Reason</th>'
      + '</tr>';

    const row = (title: string, result: string, colour: string, reason: string): string =>
      '<tr>'
      + `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px">${esc(title)}</td>`
      + `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;font-weight:700;color:${colour}">${result}</td>`
      + `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#4b5563">${esc(reason) || '—'}</td>`
      + '</tr>';

    const rows = [
      ...valid.map((d) => row(d.title, 'Valid', '#15803d', '')),
      // Last, and with the reason beside each: this is the part that has to be acted on.
      ...invalid.map((d) => row(d.title, 'Invalid', '#b91c1c', d.remarks ?? 'No reason given — please contact the office.')),
    ].join('');

    return `<table style="border-collapse:collapse;width:100%;margin:10px 0">${head}${rows}</table>`;
  }
}
