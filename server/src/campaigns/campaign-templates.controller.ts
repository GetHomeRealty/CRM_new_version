import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CampaignTemplatesService, type TemplateInput } from './campaign-templates.service';
import { CAMPAIGN_CATEGORIES } from './campaign.constants';
import { contentDisposition } from '../common/content-disposition';

/**
 * Campaign email templates. Viewing needs `campaigns` view; writing needs `campaigns` edit.
 *
 * Registered BEFORE CampaignsController so `campaigns/templates` is matched here — the guarded
 * `campaigns/:id` route would otherwise capture "templates" as an id and reject it.
 */
@Controller('campaigns/templates')
@UseGuards(AuthGuard, ScreenGuard)
export class CampaignTemplatesController {
  constructor(private readonly templates: CampaignTemplatesService) {}

  @Get('categories')
  @Screen('campaigns', 'view')
  categories(): { categories: typeof CAMPAIGN_CATEGORIES } {
    return { categories: CAMPAIGN_CATEGORIES };
  }

  @Get()
  @Screen('campaigns', 'view')
  list(@CurrentUser() user: AuthUserRecord, @Query('category') category?: string): Promise<unknown> {
    return this.templates.list(category, user);
  }

  @Get(':id')
  @Screen('campaigns', 'view')
  get(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.templates.get(id, user);
  }

  @Post()
  @HttpCode(201)
  @Screen('campaigns', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: TemplateInput): Promise<unknown> {
    return this.templates.create(body ?? {}, user);
  }

  @Put(':id')
  @Screen('campaigns', 'edit')
  update(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: TemplateInput): Promise<unknown> {
    return this.templates.update(id, body ?? {}, user);
  }

  @Delete(':id')
  @Screen('campaigns', 'edit')
  remove(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.templates.remove(id, user);
  }

  // ----------------------------------------------------------- attachments
  /*
   * ALL THREE PASS THE CALLER NOW.
   *
   * They did not, and the service had no `user` parameter to receive one — so a template's files
   * were reachable by anyone with the screen permission, while the template itself is owner-private.
   * `@Screen` answers "may you use the Campaigns module"; it cannot answer "is this yours".
   */
  @Post(':id/attachments')
  @HttpCode(201)
  @Screen('campaigns', 'edit')
  addAttachment(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.templates.addAttachment(id, body ?? {}, user);
  }

  @Get(':id/attachments/:attachmentId')
  @Screen('campaigns', 'view')
  async download(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @Res() res: Response,
  ): Promise<void> {
    // The ownership check has to happen before this line: everything below streams bytes.
    const file = await this.templates.getAttachment(id, attachmentId, user);
    res.setHeader('Content-Type', file.content_type);
    // `attachment` so a stored HTML or SVG file downloads instead of executing in our origin.
    res.setHeader('Content-Disposition', contentDisposition(file.filename));
    res.setHeader('Content-Length', String(file.data.length));
    res.end(file.data);
  }

  @Delete(':id/attachments/:attachmentId')
  @Screen('campaigns', 'edit')
  removeAttachment(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
  ): Promise<unknown> {
    return this.templates.removeAttachment(id, attachmentId, user);
  }
}
