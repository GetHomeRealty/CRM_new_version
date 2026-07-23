import type { AuthUserRecord } from '../auth/auth.types';

// Session data we store (Sanctum-contract emulation).
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    csrfToken?: string;
  }
}

// The authenticated user record attached by AuthGuard.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUserRecord;
    }
  }
}

export {};
