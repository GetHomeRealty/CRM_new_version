import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { LeadsService, type LeadInput, type LeadQuery } from './leads.service';
import { LeadActivityService } from './lead-activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { CrmAdvancedEmailService } from '../crm-settings/crm-advanced-email.service';
import { LeadTransferService } from './lead-transfer.service';
import { LeadImportJobService } from './lead-import-job.service';
import {
  CALL_OUTCOME, CLIENT_TYPE, GENDERS, LANGUAGES, LEAD_CONVERSION, LEAD_RESPONSE, LEAD_SOURCE,
  LEAD_STATUS, LEAD_TYPE, NONE_FILTER_VALUE, PROPERTY_TYPES, RELIGIONS, SHOWING_STATUS,
  TASK_PRIORITY, TASK_STATUS, RECENT_LEAD_DAYS,
} from './lead.constants';

const str = (v: unknown): string => String(v ?? '').trim();
const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

/**
 * Leads. Reading needs `lead` view; creating, editing and every activity write needs
 * `lead` edit.
 *
 * Literal paths are declared BEFORE `:id` — Express matches in registration order, so
 * `/api/leads/tags` registered after `/api/leads/:id` would be swallowed by the id route and
 * rejected by ParseIntPipe.
 */
@Controller('leads')
@UseGuards(AuthGuard, ScreenGuard)
export class LeadsController {
  constructor(
    private readonly transfer: LeadTransferService,
    private readonly leads: LeadsService,
    private readonly activity: LeadActivityService,
    private readonly imports: LeadImportJobService,
    private readonly prisma: PrismaService,
    // For the import preflight only: whether an import will email the people in the file.
    private readonly email: CrmAdvancedEmailService,
  ) {}

  /**
   * Who owns how many leads. Counts only — never a name, a number or a lead.
   *
   * Declared before the `:id` routes below, or Nest would match "books" as a lead id.
   */
  @Get('books')
  booksOwned(@CurrentUser() u: AuthUserRecord): Promise<unknown> {
    return this.transfer.books(u);
  }

  /**
   * The leads a hand-over of `count` WOULD move, named, so the confirmation can show them.
   *
   * Sits beside `books` and before the `:id` routes for the same reason it does - Nest would
   * otherwise read "books" as a lead id.
   *
   * Reads nothing and moves nothing: a Super Admin can open this as often as they like, and it is
   * the same selection the hand-over itself uses, so what it names is what would go.
   */
  @Get('books/preview')
  booksPreview(@CurrentUser() u: AuthUserRecord, @Query('count') count?: string): Promise<unknown> {
    return this.transfer.preview(u, count === undefined || count === '' ? undefined : Number(count));
  }

  /**
   * Hand unassigned brokerage leads to somebody.
   *
   * Super Admin only, returns nothing but counts, and is written to the audit trail with the
   * recipient's name. It reaches only leads that belong to nobody — an agent's own or assigned
   * leads are not eligible and cannot be moved through here.
   *
   * `from_user_id` is deliberately not read any more. It was how the old "move A's book to B"
   * worked, and an old client still sending it must not quietly get the previous behaviour.
   */
  @Post('transfer-ownership')
  @HttpCode(200)
  transferOwnership(@CurrentUser() u: AuthUserRecord, @Body() body: { to_user_id?: number; count?: number }): Promise<unknown> {
    return this.transfer.transfer(u, Number(body?.to_user_id), body?.count === undefined ? undefined : Number(body.count));
  }

  /** Vocabularies for the lead form and filter panel, plus the assignee list. */
  @Get('options')
  @Screen('lead', 'view')
  async options(): Promise<Record<string, unknown>> {
    const users = await this.prisma.users.findMany({
      where: { status: 'Active' },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    return {
      lead_status: LEAD_STATUS,
      lead_type: LEAD_TYPE,
      lead_source: LEAD_SOURCE,
      lead_response: LEAD_RESPONSE,
      client_type: CLIENT_TYPE,
      lead_conversion: LEAD_CONVERSION,
      genders: GENDERS,
      languages: LANGUAGES,
      religions: RELIGIONS,
      property_types: PROPERTY_TYPES,
      task_status: TASK_STATUS,
      task_priority: TASK_PRIORITY,
      showing_status: SHOWING_STATUS,
      call_outcome: CALL_OUTCOME,
      none_filter_value: NONE_FILTER_VALUE,
      recent_days: RECENT_LEAD_DAYS,
      users,
    };
  }

  // ------------------------------------------------------------------ tags
  @Get('tags')
  @Screen('lead', 'view')
  tags(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.leads.tags(user);
  }

  @Post('tags')
  @HttpCode(201)
  @Screen('lead', 'edit')
  createTag(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.leads.registerTag(str(body.tag), user);
  }

  @Delete('tags')
  @Screen('lead', 'edit')
  deleteTag(@CurrentUser() user: AuthUserRecord, @Query('tag') tag: string): Promise<unknown> {
    return this.leads.deleteTag(str(tag), user);
  }

  /** Add or remove a tag across the checked leads. */
  @Post('tag')
  @HttpCode(200)
  @Screen('lead', 'edit')
  tagLeads(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.leads.tagLeads(ids(body.lead_ids), str(body.tag), body.mode === 'remove' ? 'remove' : 'add', user);
  }

  /**
   * Every lead task the caller can see, for the Dashboard. Registered before `:id` — Express
   * matches in order, so `/api/leads/tasks` would otherwise be swallowed by the id route.
   */
  @Get('tasks')
  @Screen('lead', 'view')
  allTasks(
    @CurrentUser() user: AuthUserRecord,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ): Promise<unknown> {
    return this.leads.allTasks(user, { page, limit, status });
  }

  /** Lead showings the caller can see, a page at a time. Registered before `:id`. */
  @Get('showings')
  @Screen('lead', 'view')
  allShowings(
    @CurrentUser() user: AuthUserRecord,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.leads.allShowings(user, { page, limit });
  }

  // ------------------------------------------------------ recently deleted
  @Get('deleted')
  @Screen('lead', 'view')
  listDeleted(
    @CurrentUser() user: AuthUserRecord,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ): Promise<unknown> {
    return this.leads.listDeleted(user, { page, limit, search });
  }

  @Post('deleted/:id/restore')
  @HttpCode(200)
  @Screen('lead', 'edit')
  restore(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.leads.restore(id, user);
  }

  @Delete('deleted/:id')
  @Screen('lead', 'edit')
  purge(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.leads.purge(id, user);
  }

  // --------------------------------------------------------- bulk actions
  /**
   * Queue a CSV import and return immediately.
   *
   * This used to do the whole import inline, which for a large file meant holding the request open
   * past a proxy timeout and answering 504 over a half-finished import. The response is now a job
   * to poll — see `GET import/:jobId`.
   */
  @Post('import')
  @HttpCode(202)
  @Screen('lead', 'edit')
  import(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.imports.enqueue(str(body.csv), str(body.tag), 'leads', user);
  }

  /** Progress for one import. Polled by the screen that started it. */
  @Get('import/:jobId')
  @Screen('lead', 'view')
  importStatus(@Param('jobId') jobId: string): Promise<unknown> {
    return this.imports.status(jobId);
  }

  /** The caller's recent imports, so a refreshed page can pick a running one back up. */
  @Get('imports/recent')
  @Screen('lead', 'view')
  recentImports(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.imports.recent(user);
  }

  /**
   * Rows for a CSV export — either the checked leads, or everything matching the filters.
   *
   * `edit`, not `view`. Reading a lead on screen and carrying the whole book out of the building as
   * a file are different acts, and only the second survives someone leaving. The rows returned were
   * always correctly scoped — measured across five roles during the CRM audit, export count matched
   * list count exactly every time (36/36, 21/21, 0/0, 3/3, 24/24), so this is not closing a data
   * leak. It is saying that a role trusted only to look is not thereby trusted to extract.
   *
   * `accounting` and `documentation` hold `lead: view` and lose export by this change; agent, crm,
   * manager and admin hold `lead: edit` and keep it.
   */
  @Post('export')
  @HttpCode(200)
  @Screen('lead', 'edit')
  export(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.leads.exportRows(user, (body.filters ?? {}) as LeadQuery, ids(body.lead_ids));
  }

  @Post('bulk-delete')
  @HttpCode(200)
  @Screen('lead', 'edit')
  bulkDelete(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.leads.bulkDelete(ids(body.lead_ids), user);
  }

  /**
   * What an import is about to do, beyond creating rows.
   *
   * Read by the import window so it can say so BEFORE the file is processed. The import itself is
   * unchanged; what was missing was any statement that it emails everybody in the file.
   *
   * DECLARED BEFORE `@Get(':id')`, because a two-segment literal path and a parameterised one are
   * matched in declaration order.
   */
  @Get('import/preflight')
  @Screen('lead', 'edit')
  async importPreflight(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    const { willEmail, reason } = await this.email.importWillEmail(user);
    return { will_email: willEmail, reason };
  }

  // ----------------------------------------------------------------- leads
  @Get()
  @Screen('lead', 'view')
  list(@CurrentUser() user: AuthUserRecord, @Query() query: LeadQuery): Promise<unknown> {
    return this.leads.list(user, query ?? {});
  }

  @Post()
  @HttpCode(201)
  @Screen('lead', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: LeadInput): Promise<unknown> {
    return this.leads.create(body ?? {}, user);
  }

  /**
   * The stage this lead was at before it was closed, so Reopen can offer it.
   *
   * DECLARED BEFORE `@Get(':id')`: a literal second segment and a parameterised route are matched
   * in declaration order, and putting this after would make it unreachable. The decorators sit
   * directly above their own method — inserting a method between a decorator and the function it
   * decorates silently reassigns it, which is a mistake this file has already seen once.
   */
  @Get(':id/previous-status')
  @Screen('lead', 'view')
  previousStatus(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.leads.statusBeforeClose(id, user);
  }

  @Get(':id')
  @Screen('lead', 'view')
  get(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.leads.get(id, user);
  }

  @Put(':id')
  @Screen('lead', 'edit')
  update(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: LeadInput): Promise<unknown> {
    return this.leads.update(id, body ?? {}, user);
  }

  @Delete(':id')
  @Screen('lead', 'edit')
  remove(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.leads.remove(id, user);
  }

  // -------------------------------------------------------------- activity
  @Post(':id/notes')
  @HttpCode(201)
  @Screen('lead', 'edit')
  addNote(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.addNote(id, b ?? {}, u);
  }

  @Put(':id/notes/:noteId')
  @Screen('lead', 'edit')
  updateNote(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('noteId', ParseIntPipe) noteId: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.updateNote(id, noteId, b ?? {}, u);
  }

  @Delete(':id/notes/:noteId')
  @Screen('lead', 'edit')
  removeNote(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('noteId', ParseIntPipe) noteId: number): Promise<unknown> {
    return this.activity.removeNote(id, noteId, u);
  }

  @Delete(':id/emails/:emailId')
  @Screen('lead', 'edit')
  removeEmail(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('emailId', ParseIntPipe) emailId: number): Promise<unknown> {
    return this.activity.removeEmail(id, emailId, u);
  }

  @Post(':id/tasks')
  @HttpCode(201)
  @Screen('lead', 'edit')
  addTask(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.addTask(id, b ?? {}, u);
  }

  @Put(':id/tasks/:taskId')
  @Screen('lead', 'edit')
  updateTask(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('taskId', ParseIntPipe) taskId: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.updateTask(id, taskId, b ?? {}, u);
  }

  @Delete(':id/tasks/:taskId')
  @Screen('lead', 'edit')
  removeTask(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('taskId', ParseIntPipe) taskId: number): Promise<unknown> {
    return this.activity.removeTask(id, taskId, u);
  }

  @Post(':id/showings')
  @HttpCode(201)
  @Screen('lead', 'edit')
  addShowing(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.addShowing(id, b ?? {}, u);
  }

  @Put(':id/showings/:showingId')
  @Screen('lead', 'edit')
  updateShowing(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('showingId', ParseIntPipe) showingId: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.updateShowing(id, showingId, b ?? {}, u);
  }

  @Delete(':id/showings/:showingId')
  @Screen('lead', 'edit')
  removeShowing(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('showingId', ParseIntPipe) showingId: number): Promise<unknown> {
    return this.activity.removeShowing(id, showingId, u);
  }

  @Post(':id/calls')
  @HttpCode(201)
  @Screen('lead', 'edit')
  addCall(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.addCall(id, b ?? {}, u);
  }

  /** Click-to-call: Twilio rings the agent, then bridges the lead. Config-gated on the TWILIO_* env. */
  @Post(':id/call')
  @HttpCode(200)
  @Screen('lead', 'edit')
  placeCall(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.activity.initiateCall(id, u);
  }

  /** In-browser dialer: create the call log + return the E.164 number for the Voice SDK to dial. */
  @Post(':id/browser-call')
  @HttpCode(200)
  @Screen('lead', 'edit')
  browserCall(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.activity.prepareBrowserCall(id, u);
  }

  @Delete(':id/calls/:callId')
  @Screen('lead', 'edit')
  removeCall(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('callId', ParseIntPipe) callId: number): Promise<unknown> {
    return this.activity.removeCall(id, callId, u);
  }

  /** Emails this one lead through the configured SMTP account. Not a campaign — see the service. */
  @Post(':id/email')
  @HttpCode(201)
  @Screen('lead', 'edit')
  sendEmail(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.sendEmail(id, b ?? {}, u);
  }

  /** Draft an email with AI from a plain-language prompt. Returns {subject, html} — sends nothing. */
  @Post(':id/email/generate')
  @HttpCode(200)
  @Screen('lead', 'edit')
  generateEmail(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.generateEmail(id, String(b?.prompt ?? ''), u);
  }

  // ------------------------------------------------------- call recordings
  @Post(':id/calls/:callId/recording')
  @HttpCode(201)
  @Screen('lead', 'edit')
  addRecording(
    @CurrentUser() u: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('callId', ParseIntPipe) callId: number,
    @Body() b: Record<string, unknown>,
  ): Promise<unknown> {
    return this.activity.addRecording(id, callId, b ?? {}, u);
  }

  /**
   * Streams the audio so the browser can play it in place. Served `inline`, which is only safe
   * because the upload allowlists audio types — see LeadActivityService.addRecording. `nosniff`
   * stops the browser second-guessing the declared type.
   */
  @Get(':id/calls/:callId/recording')
  @Screen('lead', 'view')
  async playRecording(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('callId', ParseIntPipe) callId: number,
    @Res() res: Response,
  ): Promise<void> {
    // A recording is the audio of a conversation with somebody's lead. This route served it by id
    // with no caller at all, so nothing could check whose lead it was.
    const file = await this.activity.getRecording(id, callId, user);
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', String(file.data.length));
    res.end(Buffer.from(file.data));
  }

  @Delete(':id/calls/:callId/recording')
  @Screen('lead', 'edit')
  removeRecording(
    @CurrentUser() u: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('callId', ParseIntPipe) callId: number,
  ): Promise<unknown> {
    return this.activity.removeRecording(id, callId, u);
  }

  /** Records an SMS in the conversation history. The server does not send it — see the service. */
  @Post(':id/messages')
  @HttpCode(201)
  @Screen('lead', 'edit')
  addMessage(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.addMessage(id, b ?? {}, u);
  }

  /** Marks an outbound message read or failed. Set by hand — there is no delivery receipt. */
  @Put(':id/messages/:messageId')
  @Screen('lead', 'edit')
  updateMessage(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('messageId', ParseIntPipe) messageId: number, @Body() b: Record<string, unknown>): Promise<unknown> {
    return this.activity.updateMessage(id, messageId, b ?? {}, u);
  }

  @Delete(':id/messages/:messageId')
  @Screen('lead', 'edit')
  removeMessage(@CurrentUser() u: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Param('messageId', ParseIntPipe) messageId: number): Promise<unknown> {
    return this.activity.removeMessage(id, messageId, u);
  }
}
