import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUserRecord } from './auth.types';

/** Param decorator: injects the authenticated user record (set by AuthGuard). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUserRecord | undefined => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return req.authUser;
});

export const SCREEN_META = 'screen_access';

export interface ScreenMeta {
  screen: string;
  level: string;
  /**
   * The area this particular route serves, when the screen itself belongs to both.
   *
   * `SCREEN_DOMAIN` marks Dashboard, Calendar and Inbox as `common`, which is right — each has a
   * CRM view and a Transaction Desk view, and the screen as a whole is not owned by either. But a
   * route like `GET /dashboard/crm` serves exactly one of them, and without a way to say so the
   * module check has nothing to test and lets a Desk-only user read the CRM's figures. Naming the
   * area here is the route saying which half of a shared screen it answers for.
   */
  area?: string;
}

/** Route metadata for ScreenGuard, e.g. @Screen('transactions', 'edit') or @Screen('dashboard', 'view', 'crm'). */
export const Screen = (screen: string, level = 'view', area?: string): MethodDecorator & ClassDecorator =>
  SetMetadata(SCREEN_META, { screen, level, area } satisfies ScreenMeta);
