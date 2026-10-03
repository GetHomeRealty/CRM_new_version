import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentReferralService } from './recruitment-referral.service';

/**
 * "Refer a Candidate" — the ONE recruitment route an agent may call.
 *
 * Its own controller, deliberately: `RecruitmentController` puts `@Screen('recruitment', …)` on
 * every route, and agents hold no Recruitment permission. Rather than loosen anything there, this
 * exposes a single write that needs only a signed-in session; the service then refuses anyone who
 * is not an agent. Every other recruitment route keeps its existing guard unchanged.
 */
@Controller('recruitment')
@UseGuards(AuthGuard)
export class RecruitmentReferralController {
  constructor(private readonly referrals: RecruitmentReferralService) {}

  @Post('referrals')
  @HttpCode(201)
  refer(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<{ message: string }> {
    return this.referrals.refer(user, body);
  }
}
