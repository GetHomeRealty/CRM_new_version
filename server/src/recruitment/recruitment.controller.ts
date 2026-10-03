import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentAgentService } from './recruitment-agent.service';
import { RecruitmentNoAgentsGuard } from './recruitment-no-agents.guard';
import { CANDIDATE_STATUSES, INTERVIEW_STATUSES, allowedNext, isCandidateStatus } from './recruitment.status';

/**
 * Recruitment & Interview.
 *
 * `@Screen('recruitment', …)` on every route, so the module is enforced by the SAME guard as every
 * other screen rather than by anything this module invents. `view` opens a reading route and `edit`
 * a writing one — but the three things only an administrator may do are NOT expressed that way.
 *
 * APPROVAL AND ACCOUNT CREATION ARE NOT A SCREEN LEVEL. A recruiter holds `recruitment: 'edit'`
 * because the job is editing — notes, interviews, documents — and if the decision rode on the same
 * key it would arrive with the job. It rides on the `recruitment.decide` capability instead, which
 * the services check. The guard on those routes is still `edit`, because the capability is the
 * narrower of the two and refusing earlier would only change which message you get.
 */
@Controller('recruitment')
// RecruitmentNoAgentsGuard: agents are refused here even if permissions fall back to defaults —
// their one recruitment action is the separate "Refer a Candidate" route.
@UseGuards(AuthGuard, ScreenGuard, RecruitmentNoAgentsGuard)
export class RecruitmentController {
  constructor(
    private readonly recruitment: RecruitmentService,
    private readonly agents: RecruitmentAgentService,
  ) {}

  /** The vocabulary, so the client never hardcodes a status or guesses what follows one. */
  @Get('meta')
  @Screen('recruitment', 'view')
  meta(@Query('from') from?: string): Record<string, unknown> {
    return {
      candidate_statuses: CANDIDATE_STATUSES,
      interview_statuses: INTERVIEW_STATUSES,
      next: isCandidateStatus(from) ? allowedNext(from) : null,
    };
  }

  /** Dashboard tiles and the Reports tab. Scoped like every other read. */
  @Get('stats')
  @Screen('recruitment', 'view')
  stats(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    return this.recruitment.stats(user);
  }

  /**
   * Who a candidate may be assigned to. Gated on `recruitment: view` like everything else here —
   * see the service for why `/api/leads/options` could not be reused despite returning this shape.
   */
  @Get('people')
  @Screen('recruitment', 'view')
  people(): Promise<Record<string, unknown>> {
    return this.recruitment.people();
  }

  // ----------------------------------------------------------------- candidates

  @Get('candidates')
  @Screen('recruitment', 'view')
  list(@CurrentUser() user: AuthUserRecord, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.recruitment.list(user, query);
  }

  /** Interviews across the candidates you may see, optionally one status (`?status=scheduled`). */
  @Get('interviews')
  @Screen('recruitment', 'view')
  interviews(@CurrentUser() user: AuthUserRecord, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.recruitment.interviews(user, query);
  }

  /** Pending and overdue follow-ups. Declared before `candidates/:id` so it is not read as an id. */
  @Get('followups')
  @Screen('recruitment', 'view')
  followups(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    return this.recruitment.pendingFollowups(user);
  }

  @Get('candidates/:id')
  @Screen('recruitment', 'view')
  show(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    return this.recruitment.show(user, id);
  }

  @Post('candidates')
  @Screen('recruitment', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.recruitment.create(user, body);
  }

  @Put('candidates/:id')
  @Screen('recruitment', 'edit')
  update(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.update(user, id, body);
  }

  @Post('candidates/:id/assign')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  assign(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.assign(user, id, body);
  }

  @Post('candidates/:id/status')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  status(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.setStatus(user, id, body);
  }

  @Delete('candidates/:id')
  @Screen('recruitment', 'edit')
  archive(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<{ message: string }> {
    return this.recruitment.archive(user, id);
  }

  // ----------------------------------------------------------------- interviews

  @Post('candidates/:id/interviews')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  schedule(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.scheduleInterview(user, id, body);
  }

  /** Reschedule, record feedback, or set the INTERVIEW's own outcome. Never the candidate's. */
  @Put('candidates/:id/interviews/:interviewId')
  @Screen('recruitment', 'edit')
  updateInterview(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('interviewId', ParseIntPipe) interviewId: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.updateInterview(user, id, interviewId, body);
  }

  /** The recruiter's recommendation. Advice — it moves nothing. */
  @Post('candidates/:id/recommend')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  recommend(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.recommend(user, id, body);
  }

  // ----------------------------------------------------------------- notes, follow-ups, documents

  @Post('candidates/:id/notes')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  addNote(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.addNote(user, id, body);
  }

  @Post('candidates/:id/followups')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  addFollowup(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.addFollowup(user, id, body);
  }

  @Post('candidates/:id/followups/:followupId/done')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  completeFollowup(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('followupId', ParseIntPipe) followupId: number,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.completeFollowup(user, id, followupId);
  }

  @Post('candidates/:id/documents')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  requestDocument(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.requestDocument(user, id, body);
  }

  @Post('candidates/:id/documents/:documentId/received')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  receiveDocument(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.receiveDocument(user, id, documentId, body);
  }

  // ----------------------------------------------------------------- onboarding and the account

  @Post('candidates/:id/onboarding')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  addOnboardingItem(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.addOnboardingItem(user, id, body);
  }

  @Post('candidates/:id/onboarding/:itemId/done')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  completeOnboardingItem(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
  ): Promise<Record<string, unknown>> {
    return this.recruitment.completeOnboardingItem(user, id, itemId);
  }

  /**
   * Create the agent account. `recruitment.decide`, checked in the service, inside the transaction
   * that does the work — see `RecruitmentAgentService` for why the database is the real arbiter.
   */
  @Post('candidates/:id/agent')
  @HttpCode(200)
  @Screen('recruitment', 'edit')
  createAgent(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.agents.createAgent(user, id, body);
  }
}
