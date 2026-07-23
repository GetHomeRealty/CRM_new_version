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
}

/** Route metadata for ScreenGuard, e.g. @Screen('transactions', 'edit'). */
export const Screen = (screen: string, level = 'view'): MethodDecorator & ClassDecorator =>
  SetMetadata(SCREEN_META, { screen, level } satisfies ScreenMeta);
