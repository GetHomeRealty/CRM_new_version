'use strict';

/**
 * Production PM2 topology.
 *
 * Secrets are intentionally NOT defined here.
 * NestJS loads them from the protected server .env file.
 *
 * Exactly two Node processes:
 *
 *   crm-api     port 8000   schedulers disabled
 *   crm-worker  port 8001   schedulers enabled
 *
 * WEB_CONCURRENCY is pinned to 1 because PM2 owns process topology.
 */

const shared = {
  script: 'dist/main.js',
  cwd: __dirname,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
};

module.exports = {
  apps: [
    {
      ...shared,
      name: 'crm-api',

      // Run the public API with a dedicated, non-login runtime identity.
      uid: 'crm-app',
      gid: 'crm-app',

      env: {
        NODE_ENV: 'production',
        // S-1. Stated separately from NODE_ENV on purpose: two signals that must agree, so that a
        // copied .env alone does not make another machine believe it is the live system. Both this
        // app and crm-worker declare it, and `validate-config.ts` refuses to boot production
        // without it rather than starting unable to send mail.
        APP_ENV: 'production',
        TZ: 'America/Toronto',
        PORT: '8000',
        RUN_SCHEDULERS: 'false',
        WEB_CONCURRENCY: '1',

        HOME: '/var/lib/crm-app',
        USER: 'crm-app',
        LOGNAME: 'crm-app',
        SHELL: '/usr/sbin/nologin',
        TMPDIR: '/tmp',
      },
    },

    {
      ...shared,
      name: 'crm-worker',

      // Dedicated non-login identity for scheduled/background work.
      uid: 'crm-app',
      gid: 'crm-app',

      // Preserve the worker safeguards already used in production.
      max_restarts: 10,
      min_uptime: '30s',
      kill_timeout: 15000,
      max_memory_restart: '1G',

      env: {
        NODE_ENV: 'production',
        // As crm-api. The worker is the process that OWNS the sweeps, so it is the one where a
        // wrong identity would email real clients on a timer — see `common/schedulers.ts`.
        APP_ENV: 'production',
        TZ: 'America/Toronto',
        PORT: '8001',
        RUN_SCHEDULERS: 'true',
        WEB_CONCURRENCY: '1',

        HOME: '/var/lib/crm-app',
        USER: 'crm-app',
        LOGNAME: 'crm-app',
        SHELL: '/usr/sbin/nologin',
        TMPDIR: '/tmp',
      },
    },
  ],
};
