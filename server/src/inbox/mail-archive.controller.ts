import { BadRequestException, Controller, Get, Header, NotFoundException, Param, ParseIntPipe, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AreaGuard } from '../core/area.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { isArea } from '../common/domain';
import { PrismaService } from '../prisma/prisma.service';
import { archiveMetadata, type ArchivedFile, MAX_ARCHIVE_BYTES } from './mail-archive';

@Controller('account/mail-archive')
@UseGuards(AuthGuard, AreaGuard)
export class MailArchiveController {
  constructor(private readonly prisma: PrismaService) {}
  private check(user: AuthUserRecord, area: string | undefined) {
    if (!isArea(area)) throw new BadRequestException('Specify CRM or Desk.');
    if (!Number.isSafeInteger(user.id) || user.id! < 1) throw new NotFoundException('Mailbox not found.');
    if (process.env.INBOX_ARCHIVE_ENABLED !== 'true') throw new ServiceUnavailableException('Mail archive is not enabled.');
    return user.id!;
  }
  @Get('sent')
  @Header('Cache-Control', 'no-store')
  async sent(@CurrentUser() user: AuthUserRecord, @Query('area') area?: string, @Query('page') pageValue = '1') {
    const owner = this.check(user, area), page = Number(pageValue);
    if (!Number.isInteger(page) || page < 1 || page > 20000) throw new BadRequestException('Invalid page.');
    // Project only metadata in SQL: never load attachment base64 into the message list.
    const data = await this.prisma.$queryRaw<{ id: string; to_email: string | null; subject: string | null; sent_at: Date; content_available: boolean }[]>`
      SELECT request_key AS id, snapshot->>'to' AS to_email, snapshot->>'subject' AS subject,
        updated_at AS sent_at, snapshot IS NOT NULL AS content_available
      FROM inbox_reply_submissions WHERE user_id = ${owner} AND status = 'accepted'
      ORDER BY updated_at DESC, request_key DESC LIMIT 21 OFFSET ${(page - 1) * 20}`;
    return { data: data.slice(0, 20), page, has_more: data.length > 20, scope: 'hub-submissions', delivery_note: 'Accepted by the sending server; not proof of recipient delivery.' };
  }
  private async sentRow(owner: number, key: string) {
    if (!/^[0-9a-f-]{36}$/i.test(key)) throw new BadRequestException('Invalid message.');
    const row = await this.prisma.inbox_reply_submissions.findFirst({ where: { user_id: owner, request_key: key, status: 'accepted' } });
    if (!row) throw new NotFoundException('Message not found.');
    return row;
  }
  @Get('sent/:key')
  @Header('Cache-Control', 'no-store')
  async sentDetail(@CurrentUser() user: AuthUserRecord, @Param('key') key: string, @Query('area') area?: string) {
    const row = await this.sentRow(this.check(user, area), key);
    const snapshot = row.snapshot as { to?: string; subject?: string; body_text?: string; attachments?: unknown } | null;
    return { id: key, to_email: snapshot?.to ?? null, subject: snapshot?.subject ?? null, body_text: snapshot?.body_text ?? null, sent_at: row.updated_at,
      content_available: Boolean(snapshot), attachments: archiveMetadata(snapshot?.attachments) };
  }
  private download(value: unknown, index: number) {
    const archive = value as { files?: ArchivedFile[] } | null;
    if (index < 0 || !Array.isArray(archive?.files) || !archive.files[index]?.data) throw new NotFoundException('Attachment unavailable.');
    const data = archive.files[index].data!;
    if (data.length > Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4) throw new BadRequestException('Attachment exceeds limit.');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES || bytes.toString('base64') !== data) throw new BadRequestException('Invalid attachment.');
    const extension = bytes.subarray(0, 5).toString() === '%PDF-' ? 'pdf' : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg' : 'bin';
    return { filename: `attachment-${index + 1}.${extension}`, size: bytes.length, data };
  }
  @Get('sent/:key/attachments/:index')
  @Header('Cache-Control', 'no-store')
  async sentAttachment(@CurrentUser() user: AuthUserRecord, @Param('key') key: string, @Param('index', ParseIntPipe) index: number, @Query('area') area?: string) {
    const row = await this.sentRow(this.check(user, area), key);
    return this.download((row.snapshot as { attachments?: unknown } | null)?.attachments, index);
  }
  @Get('inbound/:id/attachments/:index')
  @Header('Cache-Control', 'no-store')
  async inboundAttachment(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('index', ParseIntPipe) index: number, @Query('area') area?: string) {
    const owner = this.check(user, area);
    const primary = await this.prisma.mail_accounts.findFirst({ where: { user_id: owner, is_default: true }, select: { id: true } })
      ?? await this.prisma.mail_accounts.findFirst({ where: { user_id: owner, is_active: true }, orderBy: { id: 'asc' }, select: { id: true } });
    const row = await this.prisma.inbound_emails.findFirst({ where: { id, user_id: owner, ...(primary ? { account_id: primary.id } : {}) }, select: { attachments: true } });
    if (!row) throw new NotFoundException('Message not found.');
    return this.download(row.attachments, index);
  }
}
