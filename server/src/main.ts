import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import configuration from './config/configuration';
import { assertProductionConfig } from './config/validate-config';
import { laravelValidationExceptionFactory } from './common/laravel-exceptions';
import { installShutdownHandlers } from './common/shutdown';

async function bootstrap(): Promise<void> {
  // `rawBody` keeps the exact bytes of each request alongside the parsed body. The Meta webhook
  // needs them: its HMAC signature is computed over the raw payload, and re-serialising the
  // parsed JSON changes the bytes and breaks verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Pure, deterministic from env — identical to what ConfigModule loaded for DI.
  const appCfg = configuration();

  // Checked before anything binds a port. Each setting it guards fails silently at runtime
  // rather than at boot — a non-secure cookie is discarded by the browser, so login "works" and
  // the next request is anonymous — so a deploy that stops here is the cheap outcome.
  assertProductionConfig(appCfg);

  // All API routes live under /api (matching Laravel). The Sanctum CSRF-cookie
  // route is served at the root, so it is excluded from the prefix.
  app.setGlobalPrefix('api', { exclude: ['sanctum/csrf-cookie'] });

  // Express defaults to a 100 KB JSON body, which is far below what this app posts: campaign
  // template attachments and document uploads arrive base64-encoded, so a 5 MB file is ~6.7 MB
  // on the wire. Without this the server answers 413 and the size limits enforced in code are
  // never even reached.
  app.useBodyParser('json', { limit: '12mb' });
  app.useBodyParser('urlencoded', { limit: '12mb', extended: true });

  // Trust the proxy so secure cookies work behind nginx in production.
  app.set('trust proxy', 1);

  // CORS for the React SPA — credentials required for cookie auth.
  app.enableCors({
    origin: appCfg.corsOrigins,
    credentials: true,
  });

  // Server-side sessions (cookie-based), emulating the Sanctum SPA contract.
  // Persisted in Postgres (connect-pg-simple → `user_sessions` table) so sessions
  // survive restarts and scale across instances — production-grade, like Laravel's
  // database session driver. The session payload (user id + XSRF token) is unchanged.
  const PgStore = connectPgSimple(session);
  const sessionPool = new Pool({ connectionString: appCfg.databaseUrl });
  app.use(
    session({
      store: new PgStore({ pool: sessionPool, tableName: 'user_sessions', createTableIfMissing: true, pruneSessionInterval: 60 * 15 }),
      name: appCfg.session.cookieName,
      secret: appCfg.session.secret,
      resave: false,
      saveUninitialized: false,
      // Slide the expiry on every response. Without this the cookie dies a fixed
      // SESSION_LIFETIME_MINUTES after sign-in no matter how active the user is, and the next
      // save fails mid-edit — surfacing as a bare "CSRF token mismatch" because the session
      // holding the token is gone. Idle users still time out; working users don't.
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: appCfg.session.secure,
        sameSite: appCfg.session.sameSite,
        domain: appCfg.session.domain,
        path: '/',
        maxAge: appCfg.session.lifetimeMinutes * 60 * 1000,
      },
    }),
  );

  // Mirror Laravel FormRequest behaviour: reject unknown fields, coerce types,
  // and emit validation failures in Laravel's 422 { message, errors } shape.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: laravelValidationExceptionFactory,
    }),
  );

  await app.listen(appCfg.port);
  // eslint-disable-next-line no-console
  console.log(`Transaction Desk API listening on http://localhost:${appCfg.port}`);

  // Every deploy stops this process. Without handlers that is an instant kill mid-request,
  // with the IMAP sockets dropped and Prisma never disconnected.
  installShutdownHandlers(app, sessionPool);
}

void bootstrap();
