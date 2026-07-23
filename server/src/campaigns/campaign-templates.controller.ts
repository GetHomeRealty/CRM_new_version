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
  list(@Query('category') category?: string): Promise<unknown> {
    return this.templates.list(category);
  }

  @Get(':id')
  @Screen('campaigns', 'view')
  get(@Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.templates.get(id);
  }

  @Post()
  @HttpCode(201)
  @Screen('campaigns', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: TemplateInput): Promise<unknown> {
    return this.templates.create(body ?? {}, user);
  }

  @Put(':id')
  @Screen('campaigns', 'edit')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: TemplateInput): Promise<unknown> {
    return this.templates.update(id, body ?? {});
  }

  @Delete(':id')
  @Screen('campaigns', 'edit')
  remove(@Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.templates.remove(id);
  }

  // ----------------------------------------------------------- attachments
  @Post(':id/attachments')
  @HttpCode(201)
  @Screen('campaigns', 'edit')
  addAttachment(@Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.templates.addAttachment(id, body ?? {});
  }

  @Get(':id/attachments/:attachmentId')
  @Screen('campaigns', 'view')
  async download(
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.templates.getAttachment(id, attachmentId);
    res.setHeader('Content-Type', file.content_type);
    // `attachment` so a stored HTML or SVG file downloads instead of executing in our origin.
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', String(file.data.length));
    res.end(file.data);
  }

  @Delete(':id/attachments/:attachmentId')
  @Screen('campaigns', 'edit')
  removeAttachment(
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
  ): Promise<unknown> {
    return this.templates.removeAttachment(id, attachmentId);
  }
}
