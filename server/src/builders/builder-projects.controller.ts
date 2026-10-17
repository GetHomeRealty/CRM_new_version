import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { BuilderProjectsService, FILE_KINDS, HOME_TYPES, PROJECT_STATUSES } from './builder-projects.service';

const MB25 = 25 * 1024 * 1024;

/** India builder projects (stage 3b, 17 Oct 2026). Access is checked in the service. */
@Controller('builder-projects')
@UseGuards(AuthGuard)
export class BuilderProjectsController {
  constructor(private readonly projects: BuilderProjectsService) {}

  @Get()
  list(@CurrentUser() user: AuthUserRecord | undefined, @Query('builder_id') builderId?: string) {
    return this.projects.list(user, builderId ? Number(builderId) : undefined);
  }

  /** The vocabularies the form offers. Declared before ':id'. */
  @Get('options')
  options() {
    return { statuses: PROJECT_STATUSES, home_types: HOME_TYPES, file_kinds: FILE_KINDS };
  }

  /** The project list an India deal picks from. Declared before ':id'. */
  @Get('pick')
  pick(@CurrentUser() user: AuthUserRecord | undefined) {
    return this.projects.pickList(user);
  }

  @Get(':id')
  show(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number) {
    return this.projects.show(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUserRecord | undefined, @Body() body: Record<string, unknown>) {
    return this.projects.create(user, body ?? {});
  }

  @Put(':id')
  update(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) {
    return this.projects.update(user, id, body ?? {});
  }

  @Delete(':id')
  destroy(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number) {
    return this.projects.destroy(user, id);
  }

  @Post(':id/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MB25 } }))
  upload(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.projects.uploadFile(user, id, String(body?.kind ?? ''), file, body?.note as string | undefined);
  }

  @Get(':id/files/:fileId')
  async download(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number, @Res() res: Response) {
    const f = await this.projects.file(user, id, fileId);
    res.download(f.abs, f.name);
  }

  @Delete(':id/files/:fileId')
  removeFile(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number) {
    return this.projects.removeFile(user, id, fileId);
  }

  @Post(':id/prices')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MB25 } }))
  addPrice(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>, @UploadedFile() file?: Express.Multer.File) {
    return this.projects.addPrice(user, id, body ?? {}, file);
  }
}
