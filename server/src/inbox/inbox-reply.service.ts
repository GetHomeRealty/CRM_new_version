import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { InboxService } from './inbox.service';
import type { Area } from '../common/domain';
import { parseComposeSubmission, parseReplySubmission, replyTextToHtml } from './reply-submission';
import { archiveFiles } from './mail-archive';

@Injectable()
export class InboxReplyService {
  constructor(private readonly prisma: PrismaService, private readonly inbox: InboxService, private readonly mailer: MailerService) {}

  private owner(userId: number) {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new NotFoundException('Submission not found.');
  }
  private present(row: { request_key: string; message_id: number; status: string }) {
    // "accepted" means SMTP transport accepted the message, not delivered to the recipient.
    return { request_key: row.request_key, message_id: row.message_id, status: row.status };
  }
  async recover(userId: number, key: string) {
    this.owner(userId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw new BadRequestException('Invalid submission key.');
    const row = await this.prisma.inbox_reply_submissions.findUnique({ where: { user_id_request_key: { user_id: userId, request_key: key.toLowerCase() } } });
    // A 404 does not prove there is no in-flight request. Clients must not generate a new key.
    if (!row) throw new NotFoundException('Submission not found. Do not resend while its status is unknown.');
    return this.present(row);
  }
  async submit(userId: number, area: Area, messageId: number, input: unknown) {
    this.owner(userId);
    const composed = messageId === 0 ? parseComposeSubmission(input) : null;
    const draft = composed ?? parseReplySubmission(messageId, input);
    const identity = { user_id: userId, request_key: draft.requestKey };
    const previous = await this.prisma.inbox_reply_submissions.findUnique({ where: { user_id_request_key: identity } });
    if (previous) {
      if (previous.fingerprint !== draft.fingerprint) throw new ConflictException('This submission key was already used for a different reply.');
      return this.present(previous);
    }
    if (process.env.INBOX_REPLY_SENDING_ENABLED !== 'true') throw new ServiceUnavailableException('Reply sending is not enabled.');
    const sender = composed ? await this.inbox.composeContext(userId, area) : null;
    const context = composed ? composed : await this.inbox.replyContext(userId, area, messageId);
    const original = sender ? { account_id: sender.account_id, message_id: null } : await this.prisma.inbound_emails.findFirst({ where: { id: messageId, user_id: userId }, select: { account_id: true, message_id: true } });
    if (!original) throw new NotFoundException('Message not found.');
    // Unique insert is the claim. Only the process which inserts may invoke SMTP.
    // A crash after this point leaves pending and MUST NOT trigger automatic replay.
    try {
      await this.prisma.inbox_reply_submissions.create({ data: { ...identity, fingerprint: draft.fingerprint, message_id: messageId, status: 'pending',
        ...(process.env.INBOX_ARCHIVE_ENABLED === 'true' ? { snapshot: { to: context.to, subject: context.subject, body_text: draft.bodyText, account_id: original.account_id,
          attachments: archiveFiles(draft.attachments.map(file => ({ filename: file.name, contentType: file.mime, content: Buffer.from(file.data, 'base64') }))) } } : {}),
      } });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;
      const winner = await this.prisma.inbox_reply_submissions.findUnique({ where: { user_id_request_key: identity } });
      if (!winner || winner.fingerprint !== draft.fingerprint) throw new ConflictException('Submission key conflict.');
      return this.present(winner);
    }
    let status = 'accepted';
    try {
      await this.mailer.sendOwnedReplyOnce(userId, original.account_id, context.to, context.subject, replyTextToHtml(draft.bodyText), draft.attachments, original.message_id);
    } catch {
      // Even an SMTP/network error can occur after remote acceptance. Never expose credentials
      // from transport errors and never automatically retry this key.
      status = 'uncertain';
    }
    await this.prisma.inbox_reply_submissions.update({ where: { user_id_request_key: identity }, data: { status, updated_at: new Date() } });
    return { request_key: draft.requestKey, message_id: messageId, status };
  }
}
