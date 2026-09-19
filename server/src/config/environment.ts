/**
 * ================================================================================================
 * WHICH SYSTEM IS THIS, AND MAY IT EMAIL A REAL PERSON?
 *
 * S-1. The application decided "am I production?" from `NODE_ENV`, which is one line in a file, and
 * a file can be copied. Copy the deploy host's `.env` to a laptop, restore a database dump to look
 * at something, and that line says production there too — so a scheduler sweeping real rows mails
 * the brokerage's real clients from a developer's machine. Nobody notices, because from the
 * outside it looks exactly like production working.
 *
 * `MAIL_REAL_SEND_HOST` already closed the narrowest version of that (a named machine, checked at
 * send time, kept below). This widens it from one signal to four that must AGREE:
 *
 *     APP_ENV=production        an explicit statement of identity, separate from NODE_ENV so that
 *                               copying one file is not enough to inherit production's privileges
 *     NODE_ENV=production       what the framework and every library already key off
 *     an approved database      the deployment is pointed at the database production actually uses
 *     MAIL_ALLOW_REAL_SEND=1    somebody has explicitly said "yes, mail real people from here"
 *
 * Any one of them missing means external delivery is refused and the message goes to a sink that
 * cannot resolve. There is no configuration of a development machine that reaches a client:
 * `MAIL_ALLOW_REAL_SEND=1` USED TO BE AN ESCAPE HATCH OUTSIDE PRODUCTION AND IS NO LONGER ONE — it
 * is now a necessary condition rather than a sufficient one. A developer who needs to watch a
 * message arrive uses `MAIL_REDIRECT_TO` and reads it in their own mailbox.
 *
 * PRODUCTION IS NOT DISABLED, WHICH IS THE WHOLE POINT OF DOING IT THIS WAY. A correctly configured
 * production process satisfies all four and sends exactly as it did before. What changed for
 * production is that the four must be SAID rather than inferred — and `validate-config.ts` refuses
 * to boot a production process that has not said them, so a deployment which would have gone quiet
 * fails its health check and rolls back instead of running mail-less for a week.
 * ================================================================================================
 */

/** The four identities a deployment may declare. Anything else is a configuration error. */
export type AppEnvironment = 'production' | 'staging' | 'development' | 'test';

const ENVIRONMENTS: readonly AppEnvironment[] = ['production', 'staging', 'development', 'test'];

/**
 * The database this deployment's production data lives in.
 *
 * A NAME rather than a full URL, and the same reasoning `test/jest-db-guard.cjs` records for its
 * own check: the host is not what makes a database dangerous. `myapp` on a laptop holds a restored
 * copy of the brokerage's real records — that is the case S-1 was raised about — so matching on
 * host would call it safe.
 *
 * Overridable because the name is a fact about this deployment rather than about the software.
 */
export const DEFAULT_PRODUCTION_DATABASE = 'myapp';

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v ?? '').trim());
const falsy = (v: string | undefined): boolean => /^(0|false|no|off)$/i.test((v ?? '').trim());

/** `APP_ENV` exactly as it was written, or '' — for the messages that have to quote it back. */
export const declaredAppEnv = (): string => (process.env.APP_ENV ?? '').trim();

/**
 * This deployment's identity.
 *
 * UNSET DOES NOT MEAN PRODUCTION, and must never come to mean it: inferring production from
 * `NODE_ENV` would rebuild the single signal this exists to replace. Unset reads as `test` under a
 * test runner and `development` everywhere else — the two answers that permit no external mail.
 */
export function appEnvironment(): AppEnvironment {
  const declared = declaredAppEnv().toLowerCase();
  if ((ENVIRONMENTS as readonly string[]).includes(declared)) return declared as AppEnvironment;
  return process.env.NODE_ENV === 'test' ? 'test' : 'development';
}

/** Set, but not to one of the four. Worth saying out loud rather than silently treating as absent. */
export const appEnvIsUnrecognised = (): boolean =>
  declaredAppEnv() !== '' && !(ENVIRONMENTS as readonly string[]).includes(declaredAppEnv().toLowerCase());

/** The database name out of a connection URL — credentials and host are never read or logged. */
export function databaseName(url: string | undefined = process.env.DATABASE_URL): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).pathname.replace(/^\//, '').split('?')[0] ?? '';
  } catch {
    return '';
  }
}

/** The database name production is allowed to use. */
export const approvedProductionDatabase = (): string =>
  (process.env.PRODUCTION_DATABASE_NAME ?? '').trim() || DEFAULT_PRODUCTION_DATABASE;

/** Whether this process is pointed at the brokerage's real records. */
export const connectedToProductionDatabase = (): boolean => {
  const name = databaseName();
  return name !== '' && name === approvedProductionDatabase();
};

/**
 * Why this process may not email the outside world, or null when it may.
 *
 * A REASON RATHER THAN A BOOLEAN, because the reason is the whole value of the check on the day it
 * refuses: "mail is off" sends somebody reading logs into the mail code, while "APP_ENV is
 * development" points at the one line to change. It is quoted in the boot log and in the refusal.
 *
 * Ordered so the answer names the most fundamental mismatch first — being a development machine
 * matters more than which flag is unset.
 */
export function externalMailProblem(): string | null {
  const env = appEnvironment();
  if (env !== 'production') {
    return `APP_ENV is ${declaredAppEnv() || `unset (reading as ${env})`}, not production`;
  }
  if (process.env.NODE_ENV !== 'production') {
    return `NODE_ENV is ${process.env.NODE_ENV || 'unset'} while APP_ENV is production — the two disagree`;
  }
  const db = databaseName();
  if (!connectedToProductionDatabase()) {
    return `the database is ${db || 'not configured'}, not the approved production database `
      + `(${approvedProductionDatabase()})`;
  }
  if (!truthy(process.env.MAIL_ALLOW_REAL_SEND)) {
    return 'MAIL_ALLOW_REAL_SEND is not set to 1, so nobody has said this process may mail real people';
  }
  return null;
}

/**
 * Why the schedulers must not run here, or null when they may.
 *
 * THE COMBINATION THIS REFUSES is a non-production process holding the production database. The
 * sweeps are what turn that into outgoing mail without anybody asking for it — reminders, the lead
 * welcome, birthday greetings — and they select over whole tables, so against real rows they find
 * real clients. `externalMailProblem` already stops the message leaving, and this stops the sweep
 * that would have produced it, because the two defences fail in different ways: one is a decision
 * taken per message, the other is whether the work happens at all.
 *
 * It does NOT refuse a development process on a development database — that is ordinary work — and
 * it does not refuse production. It refuses exactly the mismatch.
 */
export function schedulerEnvironmentProblem(): string | null {
  if (appEnvironment() === 'production') return null;
  if (!connectedToProductionDatabase()) return null;
  return `APP_ENV is ${declaredAppEnv() || `unset (reading as ${appEnvironment()})`} but DATABASE_URL points at `
    + `${databaseName()}, the approved production database. Refusing to run schedulers: the sweeps would `
    + 'act on the brokerage\'s real records from a machine that is not production. Point DATABASE_URL at a '
    + 'copy, or set APP_ENV=production if this really is the live system.';
}

/**
 * What production must say before it is allowed to boot — read by `validate-config.ts`.
 *
 * WHY REFUSING TO BOOT IS SAFER THAN QUIETLY NOT SENDING. `deploy.sh` waits on `/api/health` and
 * restores the previous `dist/` when it does not come back, so a production process that refuses to
 * start is rolled back within seconds and somebody is looking at it. The alternative — booting
 * happily with `externalMailProblem()` explaining into a log file that nothing sends mail — is the
 * failure this application has been bitten by before: silent, and discovered by a client asking why
 * they never heard back.
 *
 * `MAIL_ALLOW_REAL_SEND=0` is accepted and is not an error: a production process deliberately held
 * back from sending is a legitimate thing to run. What is refused is saying NOTHING.
 */
export function productionEnvironmentProblems(): string[] {
  const problems: string[] = [];

  if (appEnvIsUnrecognised()) {
    problems.push(`APP_ENV is "${declaredAppEnv()}", which is not one of ${ENVIRONMENTS.join(', ')}.`);
  } else if (appEnvironment() !== 'production') {
    problems.push(
      'APP_ENV is not set to production, but NODE_ENV is. Since S-1 the two must agree before this '
      + 'process may email anyone: set APP_ENV=production in the environment of BOTH crm-api and '
      + 'crm-worker. Without it the process starts but every message is diverted to a sink.',
    );
  }

  if (!connectedToProductionDatabase()) {
    problems.push(
      `DATABASE_URL points at "${databaseName() || '(unset)'}" but the approved production database is `
      + `"${approvedProductionDatabase()}". Set PRODUCTION_DATABASE_NAME if the live database has been `
      + 'renamed, or correct DATABASE_URL. Mail is refused while these disagree.',
    );
  }

  const declaredSend = (process.env.MAIL_ALLOW_REAL_SEND ?? '').trim();
  if (!truthy(declaredSend) && !falsy(declaredSend)) {
    problems.push(
      'MAIL_ALLOW_REAL_SEND is not set. Production must say explicitly whether it may email real '
      + 'people: set MAIL_ALLOW_REAL_SEND=1 to send (what the live deployment wants), or 0 to run '
      + 'deliberately without outgoing mail. Refusing to start rather than starting silently unable '
      + 'to send.',
    );
  }

  return problems;
}
