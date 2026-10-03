import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isAgent } from '../core/authz';

/**
 * Agents never reach the Recruitment screens' routes — whatever the permission matrix says.
 *
 * WHY THIS IS NEEDED AS WELL AS `ScreenGuard`. The stored role matrix gives agents no `recruitment`
 * permission, so normally `ScreenGuard` already refuses them. But when that store has not loaded (or
 * its tables are empty) `PermissionService` falls back to its compiled defaults, and the agent
 * default is `fill('view')` — which includes `recruitment: 'view'`. This closes that gap for this
 * module only, without changing the defaults every other screen relies on.
 *
 * Agents have exactly one recruitment action, "Refer a Candidate", which lives on its own controller
 * (`RecruitmentReferralController`) and is not behind this guard. Admin, Manager and Recruiter are
 * not agents and are unaffected.
 *
 * Runs after `AuthGuard`, which puts the signed-in user on the request. The refusal reads like
 * `ScreenGuard`'s, so it says nothing about why or what exists.
 */
@Injectable()
export class RecruitmentNoAgentsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<Request>().authUser;
    if (isAgent(user)) {
      throw new ForbiddenException({ message: "You don't have permission to perform this action." });
    }
    return true;
  }
}
