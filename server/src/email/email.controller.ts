import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Put, Res as ResponseParam, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { MailAccountService } from './mail-account.service';
import { EmailTemplateService } from './email-template.service';
import { MailerService } from './mailer.service';
import { throwValidation } from '../common/laravel-exceptions';
import type { MailEvent } from './mail-event-registry';

type Res = Record<string, unknown>;

// Email settings — SMTP sender accounts + per-event templates (admin-gated).
@Controller()
@UseGuards(AuthGuard, AdminGuard)
export class EmailController {
  constructor(
    private readonly mailAccounts: MailAccountService,
    private readonly templates: EmailTemplateService,
    private readonly mailer: MailerService,
  ) {}

  // ---- Mail accounts ----
  @Get('mail-accounts')
  async accountsIndex(): Promise<{ data: Res[] }> { return { data: await this.mailAccounts.index() }; }

  @Post('mail-accounts')
  async accountStore(@Body() body: Res): Promise<{ data: Res }> { return { data: await this.mailAccounts.store(body ?? {}) }; }

  @Put('mail-accounts/:mailAccount')
  async accountUpdate(@Param('mailAccount', ParseIntPipe) id: number, @Body() body: Res): Promise<{ data: Res }> { return { data: await this.mailAccounts.update(id, body ?? {}) }; }

  @Delete('mail-accounts/:mailAccount')
  accountDestroy(@Param('mailAccount', ParseIntPipe) id: number): Promise<{ message: string }> { return this.mailAccounts.destroy(id); }

  @Post('mail-accounts/:mailAccount/default')
  @HttpCode(200)
  async accountSetDefault(@Param('mailAccount', ParseIntPipe) id: number): Promise<{ data: Res }> { return { data: await this.mailAccounts.setDefault(id) }; }

  @Post('mail-accounts/:mailAccount/test')
  @HttpCode(200)
  async accountTest(@Param('mailAccount', ParseIntPipe) id: number, @Body() body: Res): Promise<Res> {
    const account = await this.mailAccounts.find(id);
    if (!account) throw new NotFoundException({ message: `No query results for model [App\\Models\\MailAccount] ${id}.` });
    const to = body?.to;
    if (to === undefined || to === null || to === '') throwValidation({ to: ['The to field is required.'] });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) throwValidation({ to: ['The to field must be a valid email address.'] });

    try {
      await this.mailer.test(account, String(to));
    } catch (err) {
      const e = err as { message?: string };
      // 422 with the failure shape (message text is transport-specific, not byte-identical to PHP).
      throw new UnprocessableEntityException({ ok: false, message: 'Send failed: ' + (e?.message ?? 'unknown error') });
    }
    return { ok: true, message: `Test email sent to ${to}.` };
  }

  // ---- Email templates ----
  @Get('email-templates')
  templatesIndex(): Promise<Res> { return this.templates.index(); }

  @Put('email-templates/:emailTemplate')
  async templateUpdate(@Param('emailTemplate', ParseIntPipe) id: number, @Body() body: Res): Promise<{ data: Res }> { return { data: await this.templates.update(id, body ?? {}) }; }

  @Post('email-templates/:emailTemplate/preview')
  @HttpCode(200)
  templatePreview(
    @Param('emailTemplate', ParseIntPipe) id: number,
    /** Unsaved edits to render. Absent means preview the template exactly as stored. */
    @Body() body?: Res,
  ): Promise<{ subject: string; html: string }> {
    return this.templates.preview(id, body ?? {});
  }

  // ---- Template attachments ----
  @Post('email-templates/:emailTemplate/attachments')
  @HttpCode(200)
  templateAddAttachment(@Param('emailTemplate', ParseIntPipe) id: number, @Body() body: Res): Promise<Res> {
    return this.templates.addAttachment(id, body ?? {});
  }

  @Get('email-templates/:emailTemplate/attachments/:attachmentId')
  async templateGetAttachment(
    @Param('emailTemplate', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @ResponseParam() res: ExpressResponse,
  ): Promise<void> {
    const file = await this.templates.getAttachment(id, attachmentId);
    res.setHeader('Content-Type', file.contentType);
    // Always `attachment`: a stored HTML or SVG file must download rather than execute in
    // this origin, where it would sit alongside the session cookie.
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
    res.end(file.data);
  }

  @Delete('email-templates/:emailTemplate/attachments/:attachmentId')
  @HttpCode(200)
  templateRemoveAttachment(
    @Param('emailTemplate', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
  ): Promise<{ deleted: boolean }> {
    return this.templates.removeAttachment(id, attachmentId);
  }

  @Get('mail-events')
  events(): Record<string, MailEvent> { return this.templates.events(); }
}
