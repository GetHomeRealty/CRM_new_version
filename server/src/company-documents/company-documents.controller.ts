import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CompanyDocumentsService } from './company-documents.service';

const MB25 = 25 * 1024 * 1024;
type U = AuthUserRecord | undefined;

/**
 * Settings -> Company Documents (19 Oct 2026). Every route checks Super Admin and the country being
 * worked in, in the service, so the rule holds however a route is reached.
 */
@Controller('company-documents')
@UseGuards(AuthGuard)
export class CompanyDocumentsController {
  constructor(private readonly docs: CompanyDocumentsService) {}

  @Get()
  index(@CurrentUser() user: U) { return this.docs.index(user); }

  @Post('documents')
  createDocument(@CurrentUser() user: U, @Body() body: Record<string, unknown>) { return this.docs.createDocument(user, body ?? {}); }

  @Put('documents/:id')
  updateDocument(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) { return this.docs.updateDocument(user, id, body ?? {}); }

  @Delete('documents/:id')
  deleteDocument(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number) { return this.docs.deleteDocument(user, id); }

  @Post('documents/:id/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MB25 } }))
  uploadDocumentFile(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.docs.uploadDocumentFile(user, id, file, body?.note);
  }

  @Get('documents/:id/files/:fileId')
  async documentFile(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number, @Res() res: Response) {
    const f = await this.docs.documentFile(user, id, fileId);
    res.download(f.abs, f.name);
  }

  @Delete('documents/:id/files/:fileId')
  removeDocumentFile(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number) {
    return this.docs.removeDocumentFile(user, id, fileId);
  }

  @Post('stakeholders')
  createStakeholder(@CurrentUser() user: U, @Body() body: Record<string, unknown>) { return this.docs.createStakeholder(user, body ?? {}); }

  @Put('stakeholders/:id')
  updateStakeholder(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) { return this.docs.updateStakeholder(user, id, body ?? {}); }

  @Delete('stakeholders/:id')
  deleteStakeholder(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number) { return this.docs.deleteStakeholder(user, id); }

  @Post('stakeholders/:id/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MB25 } }))
  uploadStakeholderFile(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.docs.uploadStakeholderFile(user, id, file, body?.note);
  }

  @Get('stakeholders/:id/files/:fileId')
  async stakeholderFile(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number, @Res() res: Response) {
    const f = await this.docs.stakeholderFile(user, id, fileId);
    res.download(f.abs, f.name);
  }

  @Delete('stakeholders/:id/files/:fileId')
  removeStakeholderFile(@CurrentUser() user: U, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number) {
    return this.docs.removeStakeholderFile(user, id, fileId);
  }
}
