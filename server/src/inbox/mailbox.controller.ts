import {
  BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AreaGuard } from '../core/area.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { MailboxService, type Folder } from './mailbox.service';
import { parseArea } from '../common/domain';

/**
 * The writable Inbox — compose, reply, forward, drafts, sent, search, archive and trash.
 *
 * GUARDED BY AUTHENTICATION AND SCOPED TO THE SIGNED-IN USER, with no role check and deliberately no
 * administrator override. A mailbox is not brokerage data: an Admin reading a colleague's private
 * correspondence because of their rank is precisely what this must not permit, so there is no
 * parameter anywhere below that names a user. The service derives the owner from the session and
 * re-checks every id against it.
 *
 * EVERY ROUTE CARRIES AN AREA. The area chooses which connected accounts are in play, so the CRM
 * Inbox and the Transaction Desk Inbox stay two views over two sets of accounts even when the same
 * address is connected to both. It comes from the query string so a link can address one inbox
 * directly; an absent or unrecognised value falls back to the Transaction Desk, which keeps existing
 * clients working — the same convention `InboxController` already uses.
 */
@Controller('account/mailbox')
@UseGuards(AuthGuard, AreaGuard)
export class MailboxController {
  constructor(private readonly mailbox: MailboxService) {}

  private uid(user: AuthUserRecord): number {
    return user.id ?? -1;
  }

  private folderOf(raw?: string): Folder {
    const v = (raw ?? 'inbox').trim().toLowerCase();
    if (v === 'inbox' || v === 'archive' || v === 'trash' || v === 'drafts' || v === 'sent') return v;
    // Refused rather than silently treated as the Inbox: a client asking for a folder that does not
    // exist should be told, not handed a different folder's contents as though they were the answer.
    throw new BadRequestException({ message: `"${raw}" is not a mailbox folder.` });
  }

  /** One folder, paged and searchable. */
  @Get()
  list(
    @CurrentUser() user: AuthUserRecord,
    @Query('area') area?: string,
    @Query('folder') folder?: string,
    @Query('page') page?: string,
    @Query('q') q?: string,
    @Query('unread') unread?: string,
  ): Promise<unknown> {
    return this.mailbox.folder(this.uid(user), parseArea(area), this.folderOf(folder), {
      page: Number(page) || 1,
      q,
      unread: unread === '1' || unread === 'true',
    });
  }

  /** A whole conversation, oldest first. */
  @Get('thread/:key')
  thread(
    @CurrentUser() user: AuthUserRecord,
    @Param('key') key: string,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.mailbox.thread(this.uid(user), parseArea(area), key);
  }

  /** One received message, with its attachment list. Reading marks it seen. */
  @Get('message/:id')
  message(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.mailbox.message(this.uid(user), parseArea(area), id);
  }

  /** The prefilled composer for a reply, reply-all or forward. */
  @Get('message/:id/:mode')
  replyDraft(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('mode') mode: string,
    @Query('area') area?: string,
  ): Promise<unknown> {
    if (mode !== 'reply' && mode !== 'reply_all' && mode !== 'forward') {
      throw new BadRequestException({ message: `"${mode}" is not a reply mode.` });
    }
    return this.mailbox.replyDraft(this.uid(user), parseArea(area), id, mode);
  }

  /** Archive / unarchive / trash / restore. */
  @Post('message/:id/:action')
  move(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('action') action: string,
    @Query('area') area?: string,
  ): Promise<unknown> {
    if (action !== 'archive' && action !== 'unarchive' && action !== 'trash' && action !== 'restore') {
      throw new BadRequestException({ message: `"${action}" is not a mailbox action.` });
    }
    return this.mailbox.move(this.uid(user), parseArea(area), id, action);
  }

  // ------------------------------------------------------------------ drafts
  @Post('drafts')
  createDraft(
    @CurrentUser() user: AuthUserRecord,
    @Body() body: Record<string, unknown>,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.mailbox.saveDraft(this.uid(user), parseArea(area), body ?? {});
  }

  @Get('drafts/:id')
  readDraft(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.mailbox.draft(this.uid(user), parseArea(area), id);
  }

  @Put('drafts/:id')
  updateDraft(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.mailbox.saveDraft(this.uid(user), parseArea(area), body ?? {}, id);
  }

  @Delete('drafts/:id')
  removeDraft(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.mailbox.deleteDraft(this.uid(user), parseArea(area), id);
  }

  // -------------------------------------------------------------------- send
  /** Send a new message. The body may name `in_reply_to_id` to make it a reply. */
  @Post('send')
  send(
    @CurrentUser() user: AuthUserRecord,
    @Body() body: Record<string, unknown>,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.mailbox.send(this.uid(user), parseArea(area), body ?? {});
  }

  /** Send a stored draft, applying any last edits in the body. */
  @Post('drafts/:id/send')
  sendDraft(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.mailbox.send(this.uid(user), parseArea(area), body ?? {}, id);
  }

  // ------------------------------------------------------------- attachments
  /**
   * Download one attachment.
   *
   * Streamed as a buffer with an explicit filename. The service checks that the message it hangs
   * from belongs to this user and this area BEFORE any bytes are read, and confirms the stored path
   * resolves inside the storage root.
   */
  @Get('attachment/:kind/:id')
  async attachment(
    @CurrentUser() user: AuthUserRecord,
    @Param('kind') kind: string,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
    @Query('area') area?: string,
  ): Promise<void> {
    if (kind !== 'received' && kind !== 'draft') {
      throw new BadRequestException({ message: `"${kind}" is not an attachment kind.` });
    }
    const file = await this.mailbox.attachment(this.uid(user), parseArea(area), kind, id);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
    res.end(file.body);
  }
}
