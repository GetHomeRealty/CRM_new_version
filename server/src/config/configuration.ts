/**
 * Typed application configuration, loaded from environment (see .env.example).
 * Mirrors the relevant Laravel .env values so auth/CORS/cookies behave identically
 * to what the React SPA already expects.
 */

const bool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
};

const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const list = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export type SameSite = 'lax' | 'strict' | 'none';

export interface AppConfig {
  env: string;
  port: number;
  appKey: string;
  databaseUrl: string;
  frontendUrl: string;
  corsOrigins: string[];
  bcryptRounds: number;
  session: {
    secret: string;
    cookieName: string;
    lifetimeMinutes: number;
    secure: boolean;
    sameSite: SameSite;
    domain: string | undefined;
  };
  idExtraction: {
    provider: string;
    apiKey: string;
    model: string;
  };
}

export default (): AppConfig => {
  const sameSiteRaw = (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase();
  const sameSite: SameSite = sameSiteRaw === 'strict' || sameSiteRaw === 'none' ? sameSiteRaw : 'lax';

  return {
    env: process.env.NODE_ENV ?? 'development',
    port: int(process.env.PORT, 8000),
    appKey: process.env.APP_KEY ?? '',
    databaseUrl: process.env.DATABASE_URL ?? '',
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    corsOrigins: list(process.env.CORS_ORIGINS).length
      ? list(process.env.CORS_ORIGINS)
      : [process.env.FRONTEND_URL ?? 'http://localhost:5173'],
    bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),
    session: {
      secret: process.env.SESSION_SECRET ?? 'insecure-dev-secret',
      cookieName: process.env.SESSION_COOKIE_NAME ?? 'laravel_session',
      lifetimeMinutes: int(process.env.SESSION_LIFETIME_MINUTES, 120),
      secure: bool(process.env.COOKIE_SECURE, false),
      sameSite,
      domain: process.env.COOKIE_DOMAIN || undefined,
    },
    idExtraction: {
      provider: process.env.ID_EXTRACTION_PROVIDER ?? 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: process.env.ID_EXTRACTION_MODEL ?? 'claude-sonnet-5',
    },
  };
};
