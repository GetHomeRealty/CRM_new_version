import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Response } from 'express';
import { createZip } from '../common/archive';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { DocumentsService } from './documents.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_ROOT } from '../config/storage';

import { isAgent } from '../core/authz';
type Res0 = Record<string, unknown>;
const u = (x: AuthUserRecord | undefined): AuthUserRecord | null => x ?? null;
const MB20 = 20480 * 1024;

@Controller()
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(private readonly docs: DocumentsService, private readonly prisma: PrismaService) {}

  // ---- reads (auth only) ----
  @Get('transactions/:transaction/documents')
  index(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number): Promise<Res0> {
    return this.docs.index(u(user), txnId);
  }

  @Get('documents/:document/file')
  async downloadFile(@CurrentUser() user: AuthUserRecord | undefined, @Param('document', ParseIntPipe) id: number, @Query('inline') inline: string, @Res() res: Response): Promise<void> {
    const { absPath, name } = await this.docs.fileFor(id, u(user));
    this.stream(res, absPath, name, this.isInline(inline));
  }

  @Get('documents/:document/files/:index')
  async downloadDocFile(@CurrentUser() user: AuthUserRecord | undefined, @Param('document', ParseIntPipe) id: number, @Param('index', ParseIntPipe) index: number, @Query('inline') inline: string, @Res() res: Response): Promise<void> {
    const { absPath, name } = await this.docs.docFileFor(id, index, u(user));
    this.stream(res, absPath, name, this.isInline(inline));
  }

  @Get('documents/:document/validation-file')
  async downloadValidationFile(@CurrentUser() user: AuthUserRecord | undefined, @Param('document', ParseIntPipe) id: number, @Res() res: Response): Promise<void> {
    const { absPath, name } = await this.docs.validationFileFor(id, u(user));
    this.stream(res, absPath, name, false);
  }

  @Get('transactions/:transaction/documents/download-all')
  async downloadAll(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Res() res: Response): Promise<void> {
    const txn = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!txn) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });
    // Agent access guard mirrors the service.
    if (user && isAgent(user)) {
      const member = await this.prisma.team_members.findFirst({ where: { transaction_id: txnId, name: user.name } });
      if (txn.agent !== user.name && !member) throw new NotFoundException({ message: 'You do not have access to this transaction.' });
    }
    const folder = this.safeName(txn.property || `Trade ${txn.trade_no}`);
    const docs = await this.prisma.documents.findMany({ where: { transaction_id: txnId, deleted_at: null, pending_delete: false }, orderBy: { position: 'asc' } });

    const used: Record<string, number> = {};
    const entries: { name: string; abs: string }[] = [];
    const add = async (rel: string | null | undefined, label: string): Promise<void> => {
      if (!rel) return;
      const abs = path.join(STORAGE_ROOT, rel);
      try { await fs.access(abs); } catch { return; }
      let name = folder + '/' + label;
      if (name in used) { used[name] += 1; const dot = name.lastIndexOf('.'); name = dot !== -1 ? name.slice(0, dot) + ` (${used[name]})` + name.slice(dot) : name + ` (${used[name]})`; }
      else used[name] = 0;
      entries.push({ name, abs });
    };
    for (const d of docs) {
      const title = this.safeName(d.title);
      await add(d.file_path, `${title} - ${d.file_name || 'document'}`);
      for (const f of (this.parse(d.files))) {
        const who = f.client_name ? ' - ' + this.safeName(f.client_name) : '';
        await add(f.file_path ?? null, `${title}${who} - ${f.file_name || 'file'}`);
      }
    }
    if (entries.length === 0) throw new NotFoundException({ message: 'No uploaded documents to download for this transaction.' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folder}.zip"`);
    const zip = createZip();
    zip.pipe(res);
    for (const en of entries) zip.file(en.abs, { name: en.name });
    await zip.finalize();
  }

  // ---- writes (screen:transactions,edit) ----
  @Put('transactions/:transaction/documents')
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  bulkUpdate(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res0): Promise<Res0> {
    return this.docs.bulkUpdate(u(user), txnId, body ?? {});
  }

  @Post('transactions/:transaction/documents/send-reminders')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  sendReminders(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number): Promise<Res0> {
    return this.docs.sendReminders(u(user), txnId);
  }

  @Post('transactions/:transaction/documents/:document/file')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MB20 } }))
  uploadFile(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Param('document', ParseIntPipe) docId: number, @UploadedFile() file: Express.Multer.File): Promise<Res0> {
    return this.docs.uploadFile(u(user), txnId, docId, file);
  }

  @Post('transactions/:transaction/documents/:document/files')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MB20 } }))
  uploadDocFile(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Param('document', ParseIntPipe) docId: number, @UploadedFile() file: Express.Multer.File, @Body() body: Res0): Promise<Res0> {
    const client = body?.client_name;
    return this.docs.uploadDocFile(u(user), txnId, docId, file, client !== undefined && client !== null && client !== '' ? String(client) : null);
  }

  @Delete('transactions/:transaction/documents/:document/files/:index')
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  deleteDocFile(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Param('document', ParseIntPipe) docId: number, @Param('index', ParseIntPipe) index: number): Promise<Res0> {
    return this.docs.deleteDocFile(u(user), txnId, docId, index);
  }

  @Post('transactions/:transaction/documents/:document/validation-file')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MB20 } }))
  uploadValidationFile(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Param('document', ParseIntPipe) docId: number, @UploadedFile() file: Express.Multer.File): Promise<Res0> {
    return this.docs.uploadValidationFile(u(user), txnId, docId, file);
  }

  @Delete('transactions/:transaction/documents/:document/validation-file')
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  deleteValidationFile(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Param('document', ParseIntPipe) docId: number): Promise<Res0> {
    return this.docs.deleteValidationFile(u(user), txnId, docId);
  }

  @Delete('documents/:document')
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  destroy(@CurrentUser() user: AuthUserRecord | undefined, @Param('document', ParseIntPipe) docId: number): Promise<{ message: string }> {
    return this.docs.destroy(u(user), docId);
  }

  @Post('documents/:document/restore')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  restore(@CurrentUser() user: AuthUserRecord | undefined, @Param('document', ParseIntPipe) docId: number): Promise<{ message: string }> {
    return this.docs.restore(u(user), docId);
  }

  // ---- helpers ----
  private isInline(inline: string | undefined): boolean {
    return inline === '1' || inline === 'true' || inline === 'on' || inline === 'yes';
  }

  private stream(res: Response, absPath: string, name: string, inline: boolean): void {
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`);
    res.sendFile(absPath);
  }

  private safeName(s: string): string {
    let out = String(s).replace(/[\\/:*?"<>|]+/g, ' ');
    out = out.replace(/\s+/g, ' ').trim();
    return out !== '' ? out : 'documents';
  }

  private parse(json: string | null): { client_name?: string | null; file_name?: string | null; file_path?: string | null }[] {
    if (!json) return [];
    try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
  }
}
