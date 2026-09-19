import { MailerService } from '../email/mailer.service';
import {
  appEnvironment,
  connectedToProductionDatabase,
  externalMailProblem,
  productionEnvironmentProblems,
  schedulerEnvironmentProblem,
} from './environment';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';

/**
 * S-1 — THAT ONLY PRODUCTION CAN EMAIL A REAL PERSON, AND THAT PRODUCTION STILL CAN.
 *
 * Both halves matter and the second is the one easy to break while fixing the first: a guard that
 * stops development mailing clients, and also stops the brokerage mailing its own clients, has
 * made things worse. So the production case is asserted first and in the same detail.
 *
 * DRIVEN ENTIRELY BY EXPLICIT ENVIRONMENT, never by the machine this happens to run on. The suite
 * itself runs with `APP_ENV=test` pinned by `test/jest-mail-guard.cjs`, so every case below states
 * the configuration it is about and restores whatever was there before.
 */

const PRODUCTION_DB = 'postgresql://u:p@db.internal:5432/myapp?schema=public';
const COPY_DB = 'postgresql://u:p@127.0.0.1:5432/myapp_qa?schema=public';

/** Run `fn` with `env` applied, restoring exactly what was there before — including unset keys. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(env);
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of keys) {
      const was = saved.get(k);
      if (was === undefined) delete process.env[k];
      else process.env[k] = was;
    }
  }
}

/** A correctly configured live server: all four conditions satisfied. */
const PRODUCTION = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  DATABASE_URL: PRODUCTION_DB,
  PRODUCTION_DATABASE_NAME: 'myapp',
  MAIL_ALLOW_REAL_SEND: '1',
  MAIL_REDIRECT_TO: '',
  MAIL_REAL_SEND_HOST: '',
};

describe('production is permitted to deliver, and that is not a formality', () => {
  it('delivers for real when all four conditions agree', () => {
    withEnv(PRODUCTION, () => {
      expect(externalMailProblem()).toBeNull();
      // null means "no redirect" — the message goes to the recipient it names.
      expect(MailerService.redirectTarget()).toBeNull();
    });
  });

  it('starts: a correctly configured production deployment raises no environment problem', () => {
    withEnv(PRODUCTION, () => {
      expect(productionEnvironmentProblems()).toEqual([]);
    });
  });

  it('still honours the machine name check that was already there', () => {
    withEnv({ ...PRODUCTION, MAIL_REAL_SEND_HOST: 'srv-that-is-not-this-one' }, () => {
      // Four conditions met, but this is not the machine named for delivery.
      expect(externalMailProblem()).toBeNull();
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });
  });

  it('runs its schedulers', () => {
    withEnv({ ...PRODUCTION, RUN_SCHEDULERS: 'true' }, () => {
      expect(schedulerEnvironmentProblem()).toBeNull();
      expect(schedulersEnabled()).toBe(true);
    });
  });

  /*
   * A production process may be deliberately held back from sending. That is a choice somebody
   * made, not a misconfiguration, so it must not stop the process from starting.
   */
  it('accepts an explicit MAIL_ALLOW_REAL_SEND=0 as a deliberate silence, and still boots', () => {
    withEnv({ ...PRODUCTION, MAIL_ALLOW_REAL_SEND: '0' }, () => {
      expect(productionEnvironmentProblems()).toEqual([]);
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });
  });
});

describe('development cannot email the outside world, however it is configured', () => {
  it('diverts to a sink that cannot resolve', () => {
    withEnv({ APP_ENV: 'development', NODE_ENV: 'development', DATABASE_URL: COPY_DB, MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: '0' }, () => {
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
      expect(String(MailerService.redirectTarget())).toMatch(/\.invalid$/i);
    });
  });

  /*
   * THE ESCAPE HATCH THAT S-1 CLOSED. This exact configuration used to return null — deliver for
   * real — and is how a laptop came to email the brokerage's clients. One variable was the whole
   * distance. It is now one of four conditions rather than an override.
   */
  it('cannot be opened by MAIL_ALLOW_REAL_SEND=1 any more', () => {
    for (const on of ['1', 'true', 'yes', 'on', 'ON']) {
      withEnv({ APP_ENV: 'development', NODE_ENV: 'development', DATABASE_URL: COPY_DB, MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: on }, () => {
        expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
        expect(externalMailProblem()).toMatch(/APP_ENV/);
      });
    }
  });

  /* The copied-.env case: NODE_ENV says production, nothing else does. */
  it('cannot be opened by inheriting NODE_ENV=production alone', () => {
    withEnv({ APP_ENV: 'development', NODE_ENV: 'production', DATABASE_URL: COPY_DB, MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: '1' }, () => {
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
      expect(externalMailProblem()).toMatch(/APP_ENV/);
    });
  });

  /* And the reverse: APP_ENV alone is not enough either. */
  it('cannot be opened by APP_ENV=production alone', () => {
    withEnv({ APP_ENV: 'production', NODE_ENV: 'development', DATABASE_URL: PRODUCTION_DB, PRODUCTION_DATABASE_NAME: 'myapp', MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: '1' }, () => {
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
      expect(externalMailProblem()).toMatch(/NODE_ENV/);
    });
  });

  it('still lets a developer read their own test mail through MAIL_REDIRECT_TO', () => {
    withEnv({ APP_ENV: 'development', NODE_ENV: 'development', DATABASE_URL: COPY_DB, MAIL_REDIRECT_TO: 'me@example.invalid', MAIL_ALLOW_REAL_SEND: '0' }, () => {
      expect(MailerService.redirectTarget()).toBe('me@example.invalid');
    });
  });
});

describe('test configuration cannot email the outside world', () => {
  it('is sealed in this very process, with no overrides applied', () => {
    // No withEnv: this is the suite as it actually runs, sealed by test/jest-mail-guard.cjs.
    expect(appEnvironment()).toBe('test');
    expect(MailerService.redirectTarget()).not.toBeNull();
    expect(String(MailerService.redirectTarget())).toMatch(/\.invalid$/i);
  });

  it('stays sealed even if the host it runs on declares production settings', () => {
    withEnv({ APP_ENV: 'test', NODE_ENV: 'production', DATABASE_URL: PRODUCTION_DB, PRODUCTION_DATABASE_NAME: 'myapp', MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: '1' }, () => {
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });
  });

  it('never runs schedulers', () => {
    withEnv({ APP_ENV: 'test', NODE_ENV: 'test', RUN_SCHEDULERS: 'true' }, () => {
      expect(schedulersEnabled()).toBe(false);
    });
  });
});

describe('a non-production process holding the production database', () => {
  const DEV_ON_PROD_DB = {
    APP_ENV: 'development',
    NODE_ENV: 'development',
    DATABASE_URL: PRODUCTION_DB,
    PRODUCTION_DATABASE_NAME: 'myapp',
    RUN_SCHEDULERS: 'true',
    MAIL_REDIRECT_TO: '',
    MAIL_ALLOW_REAL_SEND: '1',
  };

  it('is recognised as exactly that', () => {
    withEnv(DEV_ON_PROD_DB, () => {
      expect(connectedToProductionDatabase()).toBe(true);
      expect(appEnvironment()).toBe('development');
    });
  });

  /*
   * The combination the defect describes: `DATABASE_URL=myapp` (real records), `RUN_SCHEDULERS=
   * true`, mail enabled. The sweeps are what turn that into unattended email to real clients.
   */
  it('refuses to run schedulers, whatever RUN_SCHEDULERS says', () => {
    withEnv(DEV_ON_PROD_DB, () => {
      expect(schedulersEnabled()).toBe(false);
      expect(schedulerSkipReason()).toMatch(/approved production database/i);
    });
  });

  it('cannot send mail either, so both defences hold independently', () => {
    withEnv(DEV_ON_PROD_DB, () => {
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });
  });

  it('does NOT refuse a development process on its own database', () => {
    withEnv({ ...DEV_ON_PROD_DB, DATABASE_URL: COPY_DB }, () => {
      expect(schedulerEnvironmentProblem()).toBeNull();
      expect(schedulersEnabled()).toBe(true);
    });
  });
});

describe('a production process that has not said what it is refuses to start', () => {
  /*
   * WHY REFUSING IS THE SAFER FAILURE. The alternative is booting and silently delivering nothing,
   * which nobody notices until a client asks why they never heard back. `deploy.sh` waits on
   * /api/health and restores the previous build, so this turns a silent outage into a rollback.
   */
  it('names APP_ENV when it is missing', () => {
    withEnv({ ...PRODUCTION, APP_ENV: undefined }, () => {
      expect(productionEnvironmentProblems().join(' ')).toMatch(/APP_ENV is not set to production/);
    });
  });

  it('names MAIL_ALLOW_REAL_SEND when it says nothing at all', () => {
    withEnv({ ...PRODUCTION, MAIL_ALLOW_REAL_SEND: undefined }, () => {
      expect(productionEnvironmentProblems().join(' ')).toMatch(/MAIL_ALLOW_REAL_SEND is not set/);
    });
  });

  it('names the database when production is pointed somewhere unapproved', () => {
    withEnv({ ...PRODUCTION, DATABASE_URL: COPY_DB }, () => {
      expect(productionEnvironmentProblems().join(' ')).toMatch(/approved production database/);
    });
  });

  it('rejects an APP_ENV that is not one of the four', () => {
    withEnv({ ...PRODUCTION, APP_ENV: 'prod' }, () => {
      expect(productionEnvironmentProblems().join(' ')).toMatch(/not one of production, staging, development, test/);
    });
  });
});

describe('staging is not production', () => {
  it('cannot deliver externally even pointed at real data with the flag on', () => {
    withEnv({ APP_ENV: 'staging', NODE_ENV: 'production', DATABASE_URL: PRODUCTION_DB, PRODUCTION_DATABASE_NAME: 'myapp', MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: '1' }, () => {
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });
  });

  it('refuses schedulers against the production database', () => {
    withEnv({ APP_ENV: 'staging', NODE_ENV: 'production', DATABASE_URL: PRODUCTION_DB, PRODUCTION_DATABASE_NAME: 'myapp', RUN_SCHEDULERS: 'true' }, () => {
      expect(schedulersEnabled()).toBe(false);
    });
  });
});
