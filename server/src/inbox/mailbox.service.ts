import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { STORAGE_ROOT } from '../config/storage';
import type { Area } from '../common/domain';
import {
  MAX_RECIPIENTS, parseAddresses, prefixSubject, quoteBody, replyRecipients, splitLoose, threadKeyFor,
} from './mailbox';

/**
 * The writable half of the Inbox: compose, reply, forward, drafts, sent, search, archive and trash.
 *
 * TWO RULES GOVERN EVERY METHOD HERE, and both are enforced on the server rather than by the screen.
 *
 *   OWNERSHIP IS THE USER ID. Every query carries `user_id`, and every id the caller supplies is
 *   re-checked against it before anything is read, written or sent. There is no administrator
 *   override: a person's mailbox is not brokerage data, and an Admin reading somebody's private
 *   correspondence because of their rank is exactly the thing this must not allow.
 *
 *   THE MAILBOX IS THE AREA'S. Every operation resolves an account belonging to this user AND this
 *   area (`mail_accounts.scope`), and sends through that account explicitly rather than letting the
 *   mailer pick a "best available" sender. The same address connected to both CRM and Transaction
 *   Desk is two mailboxes; a Desk reply cannot leave from the CRM account and a Desk draft cannot
 *   appear in the CRM's drafts.
 *
 * NOTHING IS MARKED SENT UNTIL THE PROVIDER ACCEPTS IT. A send that fails leaves a row the person
 * can open, fix and retry, with `sent_at` null so it never appears in Sent — the same ordering the
 * invoice send already follows, and for the same reason: "Sent" is a claim about the outside world.
 */

/** Attachments per message, and bytes per attachment. Both are also bounded by the mail provider. */
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Everything one message may carry, so a send cannot be built in memory beyond this. */
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Where attachments are written, under the application's storage root. */
const MAIL_DIR = 'mail';

const PER_PAGE = 30;
/** A deep offset is a full scan dressed as a page request — see `InboxService.list`. */
const MAX_PAGE = 20_000;

export type Folder = 'inbox' | 'archive' | 'trash' | 'drafts' | 'sent';

export interface ComposeInput {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  body_html?: unknown;
  body_text?: unknown;
  /** Reply/forward context: the received message this is a response to. */
  in_reply_to_id?: unknown;
  attachments?: unknown;
}

interface IncomingAttachment {
  filename: string;
  mime: string;
  data: string;
}

@Injectable()
export class MailboxService {
  private readonly log = new Logger(MailboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  // ---------------------------------------------------------------- accounts
  /**
   * The account this area's mailbox writes from — the same one `InboxService` reads.
   *
   * The area's own primary first, an unassigned-scope primary only as a fallback, and then any
   * account the area can see. Throws rather than falling back to somebody else's account: "no
   * mailbox configured" is a fixable message, and silently sending from the wrong address is not.
   */
  async sendingAccount(userId: number, area: Area) {
    const own = await this.prisma.mail_accounts.findFirst({
      where: { user_id: userId, is_active: true, is_default: true, scope: area },
    })
      ?? await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, is_active: true, is_default: true, scope: null } })
      ?? await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, is_active: true, OR: [{ scope: area }, { scope: null }] } });
    if (!own) {
      throw new BadRequestException({
        message: 'No mailbox is connected for this area. Add one under Settings → Integrations.',
      });
    }
    return own;
  }

  /** The accounts this user may act through in this area — used to scope every id lookup. */
  private async accountIds(userId: number, area: Area): Promise<number[]> {
    const rows = await this.prisma.mail_accounts.findMany({
      where: { user_id: userId, OR: [{ scope: area }, { scope: null }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------ folders
  /**
   * One folder of the mailbox, paged.
   *
   * `inbox`, `archive` and `trash` read received mail; `drafts` and `sent` read what this user has
   * written. They are one method because the screen treats them as one list with a folder selector,
   * and because the scoping — this user, this area's accounts — has to be identical for all five.
   */
  async folder(
    userId: number,
    area: Area,
    folder: Folder,
    opts: { page?: number; q?: string; unread?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(opts.page ?? 1)) || 1));
    const accounts = await this.accountIds(userId, area);
    if (accounts.length === 0) {
      return { data: [], meta: { page, per_page: PER_PAGE, total: 0, last_page: 1 }, folder };
    }

    if (folder === 'drafts' || folder === 'sent') return this.outboundFolder(userId, accounts, folder, page, opts.q);
    return this.inboundFolder(userId, accounts, folder, page, opts);
  }

  private async inboundFolder(
    userId: number,
    accounts: number[],
    folder: Folder,
    page: number,
    opts: { q?: string; unread?: boolean },
  ): Promise<Record<string, unknown>> {
    const where: Prisma.inbound_emailsWhereInput = {
      user_id: userId,
      account_id: { in: accounts },
      // The folder IS the pair of timestamps — see migration 20260815140000.
      ...(folder === 'trash'
        ? { deleted_at: { not: null } }
        : folder === 'archive'
          ? { deleted_at: null, archived_at: { not: null } }
          : { deleted_at: null, archived_at: null }),
      ...(opts.unread ? { seen: false } : {}),
      ...this.searchWhere(opts.q),
    };

    // Which mailbox this is. The list is one area's accounts, so naming it is what stops a shorter
    // list reading as lost mail — the same reason `InboxService.list` reports it.
    const primary = await this.prisma.mail_accounts.findFirst({
      where: { user_id: userId, id: { in: accounts }, is_default: true },
      select: { from_email: true, inbound_enabled: true, imap_host: true },
    });

    const [rows, total, unread] = await Promise.all([
      this.prisma.inbound_emails.findMany({
        where,
        orderBy: { received_at: 'desc' },
        skip: (page - 1) * PER_PAGE,
        take: PER_PAGE,
        // The list never selects a body. A mailbox page is a list of headers; the bodies are what
        // make a mail list slow and are fetched one at a time when a message is opened.
        select: {
          id: true, from_email: true, from_name: true, to_email: true, subject: true, snippet: true,
          received_at: true, seen: true, lead_id: true, has_attachments: true, thread_key: true,
        },
      }),
      this.prisma.inbound_emails.count({ where }),
      this.prisma.inbound_emails.count({
        where: { user_id: userId, account_id: { in: accounts }, deleted_at: null, archived_at: null, seen: false },
      }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id, kind: 'received', from_email: r.from_email, from_name: r.from_name,
        to_email: r.to_email, subject: r.subject, snippet: r.snippet,
        date: r.received_at.toISOString(), seen: r.seen, lead_id: r.lead_id,
        has_attachments: r.has_attachments, thread_key: r.thread_key,
      })),
      meta: { page, per_page: PER_PAGE, total, last_page: Math.max(1, Math.ceil(total / PER_PAGE)) },
      unread,
      folder,
      mailbox: primary
        ? { address: primary.from_email, is_primary: true, auto_sync: primary.inbound_enabled && !!primary.imap_host }
        : null,
    };
  }

  private async outboundFolder(
    userId: number,
    accounts: number[],
    folder: 'drafts' | 'sent',
    page: number,
    q?: string,
  ): Promise<Record<string, unknown>> {
    const where: Prisma.outbound_emailsWhereInput = {
      user_id: userId,
      account_id: { in: accounts },
      // A FAILED send is a draft with a reason attached, never a sent message.
      ...(folder === 'sent' ? { status: 'sent' } : { status: { in: ['draft', 'failed'] } }),
      ...(q && q.trim()
        ? {
          OR: [
            { subject: { contains: q.trim(), mode: 'insensitive' } },
            { to_emails: { contains: q.trim(), mode: 'insensitive' } },
            { body_text: { contains: q.trim(), mode: 'insensitive' } },
          ],
        }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.outbound_emails.findMany({
        where,
        orderBy: folder === 'sent' ? { sent_at: 'desc' } : { updated_at: 'desc' },
        skip: (page - 1) * PER_PAGE,
        take: PER_PAGE,
        select: {
          id: true, to_emails: true, cc_emails: true, subject: true, status: true,
          sent_at: true, created_at: true, updated_at: true, error: true, thread_key: true,
          _count: { select: { attachments: true } },
        },
      }),
      this.prisma.outbound_emails.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id, kind: folder === 'sent' ? 'sent' : 'draft',
        to_email: r.to_emails, cc_email: r.cc_emails, subject: r.subject, status: r.status,
        date: (r.sent_at ?? r.updated_at ?? r.created_at)?.toISOString() ?? null,
        error: r.error, thread_key: r.thread_key, has_attachments: r._count.attachments > 0,
      })),
      meta: { page, per_page: PER_PAGE, total, last_page: Math.max(1, Math.ceil(total / PER_PAGE)) },
      folder,
      unread: 0,
      mailbox: null,
    };
  }

  /**
   * Search, IN THE DATABASE.
   *
   * Sender, recipient, subject and body, case-insensitively. The alternative — handing the mailbox
   * to the browser and filtering there — is the shape this codebase has already removed from the
   * Transactions list, Analytics and the Invoice list; a mailbox grows without bound and would be
   * the worst of them.
   */
  private searchWhere(q?: string): Prisma.inbound_emailsWhereInput {
    const term = (q ?? '').trim();
    if (term === '') return {};
    const like = { contains: term, mode: 'insensitive' as const };
    return {
      OR: [
        { from_email: like }, { from_name: like }, { to_email: like },
        { subject: like }, { body_text: like },
      ],
    };
  }

  // ------------------------------------------------------------------ reading
  /** One received message, with its attachment metadata. Reading it marks it seen. */
  async message(userId: number, area: Area, id: number): Promise<Record<string, unknown>> {
    const row = await this.ownedInbound(userId, area, id);
    if (!row.seen) await this.prisma.inbound_emails.update({ where: { id }, data: { seen: true } });
    const attachments = await this.prisma.inbound_email_attachments.findMany({
      where: { email_id: id },
      select: { id: true, filename: true, mime: true, size_bytes: true, content_id: true },
      orderBy: { id: 'asc' },
    });

    /**
     * Does the body actually use this part?
     *
     * Compared case-insensitively and against the percent-encoded spelling too, because a
     * Content-ID commonly contains `@` and some clients escape it in the `src`. The angle brackets
     * are the storage form, never the reference form, so they come off first.
     */
    const bodyHtml = (row.body_html ?? '').toLowerCase();
    const referencedInBody = (contentId: string | null): boolean => {
      if (!contentId) return false;
      const bare = contentId.replace(/^<|>$/g, '').trim().toLowerCase();
      if (bare === '') return false;
      return bodyHtml.includes(`cid:${bare}`) || bodyHtml.includes(`cid:${encodeURIComponent(bare).toLowerCase()}`);
    };

    return {
      id: row.id, kind: 'received',
      from_email: row.from_email, from_name: row.from_name, to_email: row.to_email,
      subject: row.subject, body_text: row.body_text, body_html: row.body_html,
      date: row.received_at.toISOString(), seen: true,
      // The matched lead, as the read-only reader already showed — kept so the link to the CRM
      // record does not disappear now that this reader replaces it.
      lead_id: row.lead_id,
      lead_name: row.lead_id
        ? (await this.prisma.leads.findUnique({ where: { id: row.lead_id }, select: { name: true } }))?.name ?? null
        : null,
      thread_key: row.thread_key,
      archived: row.archived_at !== null, deleted: row.deleted_at !== null,
      /*
       * Inline images belong to the body, not to the download list — but ONLY the ones the body
       * actually asks for.
       *
       * This used to split on `content_id` alone, and that hid real documents. A forwarded message
       * arrives with every part carrying a Content-ID whether the HTML refers to it or not: one in
       * the mailbox has two signed Agreement-to-Lease PDFs with content ids and a body that mentions
       * neither. Under the old rule they were not in the download list, because they looked inline,
       * and they were not in the body either, because nothing referenced them. They were simply
       * unreachable — the message said it had attachments and the reader offered none.
       *
       * Asking the BODY which parts it uses is the only test that answers the real question. What
       * the body references is inline; everything else is a file, whether or not it has an id.
       */
      attachments: attachments.filter((a) => !referencedInBody(a.content_id)),
      /*
       * The inline images the body refers to by `cid:`, so the reader can resolve them.
       *
       * They stay OUT of `attachments` above — a signature logo is not a file anybody wants a
       * download button for — but the reader cannot render them without knowing which attachment
       * id each `cid:` means. This is that lookup and nothing else: id, content id, and the mime
       * type needed to build the data URI. The bytes still come from the attachment route, which
       * is where the ownership check lives.
       */
      inline_images: attachments
        .filter((a) => referencedInBody(a.content_id))
        .map((a) => ({ id: a.id, content_id: a.content_id, mime: a.mime, filename: a.filename })),
    };
  }

  /**
   * A whole conversation, oldest first — received and sent messages interleaved.
   *
   * Both halves are scoped the same way, so a thread cannot show a message from another mailbox
   * merely because it shares a `thread_key`.
   */
  async thread(userId: number, area: Area, threadKey: string): Promise<Record<string, unknown>> {
    const accounts = await this.accountIds(userId, area);
    if (accounts.length === 0) return { thread_key: threadKey, messages: [] };
    const [received, sent] = await Promise.all([
      this.prisma.inbound_emails.findMany({
        where: { user_id: userId, account_id: { in: accounts }, thread_key: threadKey, deleted_at: null },
        select: { id: true, from_email: true, from_name: true, subject: true, snippet: true, received_at: true, seen: true, has_attachments: true },
        orderBy: { received_at: 'asc' },
      }),
      this.prisma.outbound_emails.findMany({
        where: { user_id: userId, account_id: { in: accounts }, thread_key: threadKey, status: 'sent' },
        select: { id: true, to_emails: true, subject: true, body_text: true, sent_at: true },
        orderBy: { sent_at: 'asc' },
      }),
    ]);
    const messages = [
      ...received.map((r) => ({
        id: r.id, kind: 'received' as const, who: r.from_name ?? r.from_email, subject: r.subject,
        snippet: r.snippet, date: r.received_at.toISOString(), seen: r.seen, has_attachments: r.has_attachments,
      })),
      ...sent.map((r) => ({
        id: r.id, kind: 'sent' as const, who: r.to_emails, subject: r.subject,
        snippet: (r.body_text ?? '').replace(/\s+/g, ' ').slice(0, 300),
        date: r.sent_at?.toISOString() ?? null, seen: true, has_attachments: false,
      })),
    ].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
    return { thread_key: threadKey, messages };
  }

  // ------------------------------------------------------------------ folders
  /** Archive, restore, trash or restore-from-trash. Idempotent, and scoped before it writes. */
  async move(userId: number, area: Area, id: number, action: 'archive' | 'unarchive' | 'trash' | 'restore'): Promise<Record<string, unknown>> {
    await this.ownedInbound(userId, area, id);
    const now = new Date();
    const data: Prisma.inbound_emailsUpdateInput =
      action === 'archive' ? { archived_at: now }
        : action === 'unarchive' ? { archived_at: null }
          // TRASH IS A FOLDER, NOT A DELETION. The message stays in the mailbox and can be restored;
          // nothing here removes it from the provider or from this table.
          : action === 'trash' ? { deleted_at: now }
            : { deleted_at: null };
    await this.prisma.inbound_emails.update({ where: { id }, data });
    return { id, action };
  }

  // ------------------------------------------------------------------- drafts
  /** Create or update a draft. Attachments are replaced wholesale when supplied. */
  async saveDraft(userId: number, area: Area, input: ComposeInput, draftId?: number): Promise<Record<string, unknown>> {
    const account = await this.sendingAccount(userId, area);
    const fields = await this.composeFields(userId, area, input);
    const now = new Date();

    const id = draftId ?? null;
    if (id !== null) await this.ownedDraft(userId, area, id);

    const saved = id === null
      ? await this.prisma.outbound_emails.create({
        data: { user_id: userId, account_id: account.id, status: 'draft', ...fields.columns, created_at: now, updated_at: now },
        select: { id: true },
      })
      : await this.prisma.outbound_emails.update({
        // A failed send edited and re-saved becomes a draft again, so it stops reporting an error
        // it no longer has.
        where: { id }, data: { ...fields.columns, status: 'draft', error: null, updated_at: now }, select: { id: true },
      });

    if (fields.attachments !== null) await this.replaceAttachments(saved.id, fields.attachments);
    return this.draft(userId, area, saved.id);
  }

  /** One draft, with everything needed to reopen the composer. */
  async draft(userId: number, area: Area, id: number): Promise<Record<string, unknown>> {
    const row = await this.ownedDraft(userId, area, id);
    const attachments = await this.prisma.outbound_email_attachments.findMany({
      where: { email_id: id }, select: { id: true, filename: true, mime: true, size_bytes: true }, orderBy: { id: 'asc' },
    });
    return {
      id: row.id, kind: row.status === 'sent' ? 'sent' : 'draft', status: row.status,
      to: row.to_emails, cc: row.cc_emails, bcc: row.bcc_emails, subject: row.subject,
      body_html: row.body_html, body_text: row.body_text,
      in_reply_to: row.in_reply_to, thread_key: row.thread_key,
      sent_at: row.sent_at?.toISOString() ?? null, error: row.error, attachments,
    };
  }

  async deleteDraft(userId: number, area: Area, id: number): Promise<{ message: string }> {
    const row = await this.ownedDraft(userId, area, id);
    if (row.status === 'sent') {
      throw new BadRequestException({ message: 'A sent message cannot be deleted from here.' });
    }
    await this.removeAttachmentFiles(id);
    await this.prisma.outbound_emails.delete({ where: { id } });
    return { message: 'Draft deleted' };
  }

  // --------------------------------------------------------------------- send
  /**
   * Send — a new message, a reply, a forward, or a stored draft.
   *
   * THE ORDER IS THE POINT. The provider is asked first; only its acceptance turns the row into a
   * sent message. A refusal records the reason on the row, leaves `sent_at` null, and raises — so
   * nothing appears in Sent that did not leave, and nothing the person typed is lost.
   */
  async send(userId: number, area: Area, input: ComposeInput, draftId?: number): Promise<Record<string, unknown>> {
    const account = await this.sendingAccount(userId, area);
    // Persist first, so a failure mid-send leaves the content recoverable rather than in a request
    // body that has already been discarded.
    const saved = await this.saveDraft(userId, area, input, draftId);
    const id = Number(saved.id);
    const row = await this.prisma.outbound_emails.findUniqueOrThrow({ where: { id } });

    const to = splitLoose(row.to_emails);
    const cc = splitLoose(row.cc_emails);
    const bcc = splitLoose(row.bcc_emails);
    if (to.length + cc.length + bcc.length === 0) {
      throw new BadRequestException({ message: 'Add at least one recipient.', errors: { to: ['A recipient is required.'] } });
    }

    const files = await this.prisma.outbound_email_attachments.findMany({ where: { email_id: id } });
    const attachments = await Promise.all(files.map(async (f) => ({
      name: f.filename,
      mime: f.mime ?? 'application/octet-stream',
      // Read at the moment of sending rather than held in memory from the upload.
      data: (await fs.readFile(path.join(STORAGE_ROOT, f.storage_path))).toString('base64'),
    })));

    /*
     * THREADING HEADERS. Without these a reply is a new conversation in the recipient's client, even
     * though it looks like a reply in ours.
     */
    const headers: Record<string, string> = {};
    if (row.in_reply_to) headers['In-Reply-To'] = row.in_reply_to;
    if (row.references_header) headers.References = row.references_header;

    try {
      const { messageId } = await this.mailer.sendFromAccount(account, {
        to, cc, bcc,
        subject: row.subject ?? '',
        html: row.body_html ?? '',
        attachments,
        headers: Object.keys(headers).length ? headers : undefined,
      });
      await this.prisma.outbound_emails.update({
        where: { id },
        data: {
          status: 'sent', sent_at: new Date(), error: null, updated_at: new Date(),
          message_id: messageId ? messageId.slice(0, 512) : null,
          // A message that started its own conversation becomes the root of it, so a reply that
          // quotes this id threads back here.
          thread_key: row.thread_key ?? (messageId ? messageId.slice(0, 512) : null),
        },
      });
      return this.draft(userId, area, id);
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.prisma.outbound_emails.update({
        where: { id },
        data: { status: 'failed', error: reason, sent_at: null, updated_at: new Date() },
      });
      this.log.warn(`Mailbox send failed for user ${userId}: ${reason}`);
      throw new BadRequestException({
        message: `The message was not sent: ${reason}`,
        errors: { send: [reason] },
        // The caller can reopen the draft and try again — nothing was lost.
        draft_id: id,
      });
    }
  }

  /**
   * The prefilled composer for a reply, reply-all or forward.
   *
   * Built on the server because the recipients are an authorization question as much as a
   * convenience one: the original must be one of this user's own messages before any of its
   * addresses are handed back.
   */
  async replyDraft(userId: number, area: Area, id: number, mode: 'reply' | 'reply_all' | 'forward'): Promise<Record<string, unknown>> {
    const original = await this.ownedInbound(userId, area, id);
    const account = await this.sendingAccount(userId, area);

    const quoted = quoteBody({
      fromName: original.from_name, fromEmail: original.from_email,
      date: original.received_at, html: original.body_html, text: original.body_text,
    });

    if (mode === 'forward') {
      const attachments = await this.prisma.inbound_email_attachments.findMany({
        where: { email_id: id, content_id: null },
        select: { id: true, filename: true, mime: true, size_bytes: true },
      });
      return {
        to: '', cc: '', bcc: '',
        subject: prefixSubject(original.subject, 'Fwd'),
        body_html: quoted,
        // A forward starts a NEW conversation: it goes to somebody who was not on the original, so
        // threading it into the old one would put a stranger's client inside that history.
        in_reply_to_id: null,
        forward_of_id: id,
        attachments,
      };
    }

    const { to, cc } = replyRecipients(original, account.from_email, mode === 'reply_all');
    return {
      to: to.join(', '), cc: cc.join(', '), bcc: '',
      subject: prefixSubject(original.subject, 'Re'),
      body_html: quoted,
      in_reply_to_id: id,
      attachments: [],
    };
  }

  // ------------------------------------------------------------------ helpers
  /** A received message that belongs to this user AND this area, or a 404 that says nothing else. */
  private async ownedInbound(userId: number, area: Area, id: number) {
    const accounts = await this.accountIds(userId, area);
    const row = accounts.length
      ? await this.prisma.inbound_emails.findFirst({ where: { id, user_id: userId, account_id: { in: accounts } } })
      : null;
    // Deliberately the same answer for "not yours" and "does not exist": telling the caller a
    // message exists but belongs to someone else is itself a disclosure.
    if (!row) throw new NotFoundException({ message: 'Message not found.' });
    return row;
  }

  /** A draft or sent row belonging to this user and this area. */
  private async ownedDraft(userId: number, area: Area, id: number) {
    const accounts = await this.accountIds(userId, area);
    const row = accounts.length
      ? await this.prisma.outbound_emails.findFirst({ where: { id, user_id: userId, account_id: { in: accounts } } })
      : null;
    if (!row) throw new NotFoundException({ message: 'Message not found.' });
    return row;
  }

  /** Validate and normalise everything a compose or draft-save supplies. */
  private async composeFields(userId: number, area: Area, input: ComposeInput): Promise<{
    columns: Prisma.outbound_emailsUncheckedCreateInput extends never ? never : Record<string, unknown>;
    attachments: IncomingAttachment[] | null;
  }> {
    const to = parseAddresses(input.to, 'to');
    const cc = parseAddresses(input.cc, 'cc');
    const bcc = parseAddresses(input.bcc, 'bcc');
    if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
      throw new BadRequestException({ message: `A message may have at most ${MAX_RECIPIENTS} recipients.` });
    }

    const subject = String(input.subject ?? '').slice(0, 998);
    const html = typeof input.body_html === 'string' ? input.body_html : '';
    const text = typeof input.body_text === 'string'
      ? input.body_text
      : html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Threading, resolved from the message being replied to — and only if it is this user's.
    let inReplyTo: string | null = null;
    let references: string | null = null;
    let threadKey: string | null = null;
    const parentId = Number(input.in_reply_to_id ?? 0);
    if (Number.isSafeInteger(parentId) && parentId > 0) {
      const parent = await this.ownedInbound(userId, area, parentId);
      inReplyTo = parent.message_id;
      references = [parent.references_header, parent.message_id].filter(Boolean).join(' ').trim() || null;
      threadKey = parent.thread_key ?? threadKeyFor({ messageId: parent.message_id });
    }

    return {
      columns: {
        to_emails: to.join(', ') || null,
        cc_emails: cc.join(', ') || null,
        bcc_emails: bcc.join(', ') || null,
        subject: subject || null,
        body_html: html || null,
        body_text: text || null,
        in_reply_to: inReplyTo,
        references_header: references,
        thread_key: threadKey,
      },
      attachments: input.attachments === undefined ? null : this.parseAttachments(input.attachments),
    };
  }

  /**
   * Attachments off the request body, bounded before anything is decoded.
   *
   * The size is checked on the BASE64 LENGTH, not after decoding: refusing a 200 MB string is only
   * useful if the refusal happens before it is turned into a Buffer.
   */
  private parseAttachments(raw: unknown): IncomingAttachment[] {
    if (!Array.isArray(raw)) return [];
    if (raw.length > MAX_ATTACHMENTS) {
      throw new BadRequestException({ message: `A message may carry at most ${MAX_ATTACHMENTS} attachments.` });
    }
    let total = 0;
    return raw.map((a, i) => {
      const item = (a ?? {}) as Record<string, unknown>;
      const data = String(item.data ?? '').replace(/^data:[^;]*;(?:[^,]*;)?base64,/i, '').trim();
      if (!data || !/^[A-Za-z0-9+/=\r\n]+$/.test(data)) {
        throw new BadRequestException({ message: `Attachment ${i + 1} is not a readable file.` });
      }
      const bytes = Math.floor((data.length * 3) / 4);
      if (bytes > MAX_ATTACHMENT_BYTES) {
        throw new BadRequestException({ message: `Attachment ${i + 1} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.` });
      }
      total += bytes;
      if (total > MAX_TOTAL_BYTES) {
        throw new BadRequestException({ message: `The attachments total more than ${MAX_TOTAL_BYTES / 1024 / 1024} MB.` });
      }
      const filename = String(item.filename ?? 'attachment').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 255) || 'attachment';
      return { filename, mime: String(item.mime ?? 'application/octet-stream').slice(0, 255), data };
    });
  }

  /** Write this draft's attachments to disk, replacing whatever was there. */
  private async replaceAttachments(emailId: number, incoming: IncomingAttachment[]): Promise<void> {
    await this.removeAttachmentFiles(emailId);
    await this.prisma.outbound_email_attachments.deleteMany({ where: { email_id: emailId } });
    if (incoming.length === 0) return;

    const rel = path.join(MAIL_DIR, 'outbound', String(emailId));
    await fs.mkdir(path.join(STORAGE_ROOT, rel), { recursive: true });
    let n = 0;
    for (const a of incoming) {
      n += 1;
      const buf = Buffer.from(a.data, 'base64');
      const relFile = path.join(rel, `${n}-${a.filename}`);
      await fs.writeFile(path.join(STORAGE_ROOT, relFile), buf);
      await this.prisma.outbound_email_attachments.create({
        data: {
          email_id: emailId, filename: a.filename, mime: a.mime,
          size_bytes: buf.length, storage_path: relFile.split(path.sep).join('/'),
          created_at: new Date(),
        },
      });
    }
  }

  private async removeAttachmentFiles(emailId: number): Promise<void> {
    const rows = await this.prisma.outbound_email_attachments.findMany({ where: { email_id: emailId }, select: { storage_path: true } });
    for (const r of rows) {
      // A missing file is not an error: the row is being removed either way, and refusing to delete
      // a draft because its attachment is already gone would be the worse outcome.
      await fs.rm(path.join(STORAGE_ROOT, r.storage_path), { force: true }).catch(() => undefined);
    }
  }

  /**
   * An attachment's bytes, for download — and the ownership check that must precede it.
   *
   * The path is resolved and confirmed to be INSIDE the storage root before anything is read, so a
   * stored path that somehow contains traversal cannot reach the filesystem above it.
   */
  async attachment(userId: number, area: Area, kind: 'received' | 'draft', attachmentId: number): Promise<{ filename: string; mime: string; body: Buffer }> {
    const row = kind === 'received'
      ? await this.prisma.inbound_email_attachments.findUnique({ where: { id: attachmentId }, select: { filename: true, mime: true, storage_path: true, email_id: true } })
      : await this.prisma.outbound_email_attachments.findUnique({ where: { id: attachmentId }, select: { filename: true, mime: true, storage_path: true, email_id: true } });
    if (!row) throw new NotFoundException({ message: 'Attachment not found.' });

    // The OWNER of the message the attachment hangs from decides who may read it.
    if (kind === 'received') await this.ownedInbound(userId, area, row.email_id);
    else await this.ownedDraft(userId, area, row.email_id);

    const abs = path.resolve(STORAGE_ROOT, row.storage_path);
    if (!abs.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) {
      throw new ForbiddenException({ message: 'That file is not readable.' });
    }
    try {
      return { filename: row.filename, mime: row.mime ?? 'application/octet-stream', body: await fs.readFile(abs) };
    } catch {
      throw new NotFoundException({ message: 'That attachment is no longer stored.' });
    }
  }
}
