import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecruitmentController } from './recruitment.controller';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentAgentService } from './recruitment-agent.service';
import { RecruitmentReferralController } from './recruitment-referral.controller';
import { RecruitmentReferralService } from './recruitment-referral.service';

/**
 * Recruitment & Interview: candidates, their interviews, and the one step that turns an approved
 * candidate into somebody who can sign in.
 *
 * `AuthModule` for `PasswordHashService` — the agent account is created here, so the password is
 * hashed at the brokerage's configured cost rather than at whatever this module might pick.
 *
 * Nothing is exported. No other module should reach into recruitment: a candidate is not a lead,
 * not a transaction and not yet a user, and the only crossing point is the account creation, which
 * happens inside this module and writes `users` directly within its own transaction.
 */
@Module({
  imports: [AuthModule],
  // The referral controller is the agents' submission-only door; see its own comment.
  controllers: [RecruitmentController, RecruitmentReferralController],
  providers: [RecruitmentService, RecruitmentAgentService, RecruitmentReferralService],
})
export class RecruitmentModule {}
