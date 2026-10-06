import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmsModule } from '../sms/sms.module';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';
import { RecruitmentController } from './recruitment.controller';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentAgentService } from './recruitment-agent.service';
import { RecruitmentReferralController } from './recruitment-referral.controller';
import { RecruitmentReferralService } from './recruitment-referral.service';
import { RecruitmentSmsService } from './recruitment-sms.service';
import { RecruitmentInterviewNotifyService } from './recruitment-interview-notify.service';
import { RecruitmentInterviewReminderService } from './recruitment-interview-reminder.service';
import { RecruitmentInterviewReminderScheduler } from './recruitment-interview-reminder.scheduler';

/**
 * Recruitment & Interview: candidates, their interviews, and the one step that turns an approved
 * candidate into somebody who can sign in.
 *
 * `AuthModule` for `PasswordHashService` — the agent account is created here, so the password is
 * hashed at the brokerage's configured cost rather than at whatever this module might pick. It also
 * provides `PermissionService`, which decides whether a named interviewer could actually open the
 * screen a notification would send them to.
 *
 * `SmsModule` for `TwilioService` — the SAME gateway the rest of the product sends through, with
 * its sender selection, its STOP list and its delivery callbacks. A second path to Twilio would be
 * a second place for the opt-out list to be forgotten.
 *
 * `NotificationDispatcherModule` for the bell. It is the module designed to be imported by anything
 * that raises an event, and depends on nothing but the preference lookup — see its own comment.
 *
 * Nothing is exported. No other module should reach into recruitment: a candidate is not a lead,
 * not a transaction and not yet a user, and the only crossing point is the account creation, which
 * happens inside this module and writes `users` directly within its own transaction.
 */
@Module({
  imports: [AuthModule, SmsModule, NotificationDispatcherModule],
  // The referral controller is the agents' submission-only door; see its own comment.
  controllers: [RecruitmentController, RecruitmentReferralController],
  providers: [
    RecruitmentService,
    RecruitmentAgentService,
    RecruitmentReferralService,
    RecruitmentSmsService,
    RecruitmentInterviewNotifyService,
    RecruitmentInterviewReminderService,
    RecruitmentInterviewReminderScheduler,
  ],
})
export class RecruitmentModule {}
