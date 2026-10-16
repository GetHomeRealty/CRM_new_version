import type { AuthUserRecord } from '../auth/auth.types';

// Session data we store (Sanctum-contract emulation).
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    csrfToken?: string;
    /**
     * A sign-in that has passed the password and not yet the second factor.
     *
     * DELIBERATELY A DIFFERENT KEY FROM `userId`. `AuthGuard` reads `userId` and only `userId`, so a
     * pending session reaches no endpoint in the application — half-authenticated is not a weaker
     * kind of authenticated here, it is simply not authenticated. Keeping the two apart is what makes
     * that true by construction rather than by every guard remembering to check a flag.
     */
    mfaPendingUserId?: number;
    /** When the pending sign-in stops being answerable. Enforced in code, not by the cookie. */
    mfaPendingUntil?: number;
    /**
     * The country this person chose to work in with the top-bar switch (India desk, 16 Oct 2026).
     * Kept on the session, not sent per request, so downloads and plain links follow it too. Checked
     * against `users.markets` on every request - see `resolveMarket`.
     */
    market?: string;
  }
}

// The authenticated user record attached by AuthGuard.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUserRecord;
      /** Validated opaque credential used by the native Get Home Hub app. */
      mobileSessionSid?: string;
      mobileUserId?: number;
    }
  }
}

export {};
