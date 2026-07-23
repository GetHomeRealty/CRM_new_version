import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CompanySettingsService } from './company-settings.service';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto';

@Controller('company-settings')
export class CompanySettingsController {
  constructor(private readonly settings: CompanySettingsService) {}

  /** Readable by any authenticated staff (printed on invoices). */
  @Get()
  @UseGuards(AuthGuard)
  async show(): Promise<Record<string, unknown>> {
    return this.settings.serialize(await this.settings.current());
  }

  /** Administrators only. */
  @Put()
  @UseGuards(AuthGuard, AdminGuard)
  async update(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() dto: UpdateCompanySettingsDto,
  ): Promise<Record<string, unknown>> {
    const actor = user ? { id: user.id, name: user.name } : null;
    return this.settings.serialize(await this.settings.update(actor, dto));
  }
}
