import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests, driven through a real browser against a real stack.
 *
 * THE POINT OF THE PORTS: everything here runs beside the development stack rather than on top of
 * it. The API is on 8100 and the SPA on 5174, so 8000 and 5173 keep serving whatever the developer
 * already had running and nothing needs stopping to run the suite.
 *
 * THE POINT OF THE DATABASE: `myapp_test`, never the live one. These tests delete records, submit
 * bad data on purpose and sign in as six different people. Pointing them at production would put
 * fake deals next to real commission figures, and destructive cases would be destroying somebody's
 * actual records. `TEST_DATABASE_URL` has no default for the same reason — the suite refuses to
 * start rather than guessing at a connection string.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  throw new Error(
    'TEST_DATABASE_URL is not set.\n\n'
    + '  These tests write and delete freely, so they will not run without being told explicitly\n'
    + '  which database to do that to. Point it at your QA database, e.g.\n\n'
    + '    TEST_DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/myapp_test?schema=public"\n',
  );
}
if (!/test|staging|qa|scratch/i.test(TEST_DB) || /prod/i.test(TEST_DB)) {
  throw new Error(`Refusing to run against "${TEST_DB.split('/').pop()}" — the database name must identify it as a test database.`);
}

const API_PORT = 8100;
const UI_PORT = 5174;
const UI = `http://localhost:${UI_PORT}`;

export default defineConfig({
  testDir: './tests',
  // Serial by default. These tests share one database, and a suite that deletes a record while
  // another test is reading it produces failures that are about the runner rather than the app.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: UI,
    // Evidence for anything that fails. Screenshots and traces are what turn "the assertion did
    // not hold" into something a person can act on without re-running it themselves.
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // The compiled server, not `start:dev` — watch mode restarts on file changes, and a restart
      // in the middle of a run drops the session the test was relying on.
      command: 'node dist/main.js',
      cwd: '../server',
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        DATABASE_URL: TEST_DB,
        // Real env vars beat the .env file dotenv loads, so this genuinely overrides the
        // developer's own configuration rather than sitting alongside it.
        CORS_ORIGINS: UI,
        FRONTEND_URL: UI,
        SESSION_SECRET: 'e2e-only-session-secret-not-used-anywhere-else',
        // Nothing may reach a real mailbox, mail server or push service from a test run.
        IMAP_POLL_DISABLED: '1',
        RUN_SCHEDULERS: 'false',
        MAIL_REDIRECT_TO: 'e2e-sink@test.local',
        /*
         * Sign-in throttling, raised for the suite only.
         *
         * Every test signs in, all from 127.0.0.1, and a full run does so far more often in five
         * minutes than a real office ever would — so the production ceiling of 120/IP/5min is hit
         * partway through and the remaining tests fail to log in. That looked like a broken
         * application and was the opposite: the brute-force guard doing exactly its job.
         *
         * Raised rather than disabled, so the mechanism still runs and a genuine regression in it
         * would still show up. The per-ACCOUNT limit is deliberately left at its default — that is
         * the real brute-force defence, tests never trip it, and weakening it here would hide the
         * one failure worth catching.
         */
        AUTH_RATE_LIMIT_MAX: '5000',
        RATE_LIMIT_ANON_PER_MINUTE: '5000',
        TZ: 'America/Toronto',
      },
    },
    {
      command: `npx vite --port ${UI_PORT}`,
      cwd: '../client',
      port: UI_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // Points the SPA at the test API instead of the default 8000. Same registrable domain, so
      // the session cookie is still same-site and SameSite=lax behaves as it does in production.
      env: { VITE_API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
