import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { BuildersService, CONTACT_KINDS } from './builders.service';

/**
 * India builder database (stage 3, 17 Oct 2026). Every route checks Super Admin + working in India
 * in the service, so the rule holds however a route is reached.
 */
@Controller('builders')
@UseGuards(AuthGuard)
export class BuildersController {
  constructor(private readonly builders: BuildersService) {}

  @Get()
  list(@CurrentUser() user: AuthUserRecord | undefined, @Query('search') search?: string) {
    return this.builders.list(user, search);
  }

  /** The contact kinds the form offers. Declared before ':id' so it is not read as an id. */
  @Get('options')
  options() {
    return { contact_kinds: CONTACT_KINDS };
  }

  @Get(':id')
  show(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number) {
    return this.builders.show(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUserRecord | undefined, @Body() body: Record<string, unknown>) {
    return this.builders.create(user, body ?? {});
  }

  @Put(':id')
  update(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) {
    return this.builders.update(user, id, body ?? {});
  }

  @Delete(':id')
  destroy(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number) {
    return this.builders.destroy(user, id);
  }

  @Post(':id/agreement/file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  upload(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File) {
    return this.builders.uploadAgreementFile(user, id, file);
  }

  @Get(':id/agreement/file')
  async download(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const f = await this.builders.agreementFile(user, id);
    res.download(f.abs, f.name);
  }
}
