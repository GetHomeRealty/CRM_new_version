import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { MarketingInventoryService } from './marketing-inventory.service';
import { MARKETING_ITEM_TYPES, MARKETING_STATUSES } from './marketing-inventory.model';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * Marketing / physical-asset inventory. Viewing needs `inventory` view; every mutation needs
 * `inventory` edit — so admins/managers manage and agents get the list read-only, scoped by the
 * service to only the stock assigned to their name. Endpoints are directly reachable, so the
 * scoping lives in the service, never in the UI.
 *
 * Route order matters: the literal `assignable-users`, `types` and `options` GETs are declared
 * before `:id` so they aren't captured as an id.
 */
@Controller('marketing-inventory')
@UseGuards(AuthGuard, ScreenGuard)
export class MarketingInventoryController {
  constructor(private readonly service: MarketingInventoryService) {}

  @Get()
  @Screen('inventory', 'view')
  list(
    @CurrentUser() user: AuthUserRecord,
    @Query('deleted') deleted?: string,
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ): Promise<unknown> {
    return this.service.list(user, { deleted: deleted === 'true', search, type, status });
  }

  /** Vocabularies + the assignable-name list for the add/edit form. Edit-gated. */
  @Get('options')
  @Screen('inventory', 'edit')
  async options(): Promise<unknown> {
    return {
      types: MARKETING_ITEM_TYPES,
      statuses: MARKETING_STATUSES,
      names: await this.service.assignableNames(),
    };
  }

  @Get(':id')
  @Screen('inventory', 'view')
  get(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.service.getOne(user, id);
  }

  @Post()
  @Screen('inventory', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>, @Query('merge') merge?: string): Promise<unknown> {
    return this.service.create(user, body, merge !== 'false');
  }

  @Put(':id')
  @Screen('inventory', 'edit')
  update(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.service.update(user, id, body);
  }

  @Delete(':id')
  @Screen('inventory', 'edit')
  remove(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Query('permanent') permanent?: string): Promise<unknown> {
    return this.service.remove(user, id, str(permanent) === 'true');
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Screen('inventory', 'edit')
  restore(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.service.restore(user, id);
  }
}
