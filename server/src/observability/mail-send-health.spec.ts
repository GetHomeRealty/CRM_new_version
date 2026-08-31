import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { QueueService } from '../queue/queue.service';

/**
 * OUTGOING MAIL HEALTH.
 *
 * ================================================================================================
 * THE INCIDENT THIS PINS DOWN. On 2026-08-20 a production server ran for 36 minutes with
 * MAIL_REDIRECT_TO pointing at a development sink and an expired Google refresh token. 43 sends
 * were diverted away from real recipients and then failed. Throughout, `/api/health/workers`
 * reported every scheduler `healthy: true, failures: 0`, and `mail_sync` reported `ok: true`.
 *
 * Both were telling the truth, and that is the point:
 *
 *   - the sweeps COMPLETED. A sweep that records a failed send has done its job, so its failure
 *     counter never moves. Scheduler health cannot see what a scheduler produced.
 *   - `mail_sync` measures INBOUND polling freshness. IMAP kept working perfectly while nothing
 *     could be sent, because the two directions fail independently.
 *
 * So the outage was invisible on the one endpoint an operator or an uptime monitor watches. These
 * tests exist so that stays fixed.
 * ================================================================================================
 *
 * The `redirected` case is separated deliberately. A diverted send SUCCEEDS — the provider accepts
 * it and the row records `success: true` — so it can never appear in any failure count. It is the
 * quietest way for client mail to stop arriving, and it needs its own signal.
 */

type LogRow = {
  success: boolean;
  error: string | null;
  redirected: string | null;
  sent_by: string | null;
};

/** A controller whose only live dependency is the email log. Everything else answers empty. */
function controllerWith(rows: LogRow[], lastSuccessAt: Date | null = new Date()) {
  const prisma = {
    crm_email_log: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn().mockResolvedValue(lastSuccessAt ? { created_at: lastSuccessAt } : null),
    },
    export_jobs: { count: jest.fn().mockResolvedValue(0) },
    users: { groupBy: jest.fn().mockResolvedValue([]) },
    mail_accounts: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;

  const redis = { enabled: () => false } as unknown as RedisService;
  const queues = {} as unknown as QueueService;
  return new HealthController(prisma, redis, queues);
}

const row = (over: Partial<LogRow> = {}): LogRow =>
  ({ success: true, error: null, redirected: null, sent_by: 'GetHomeRealty INC', ...over });

const AUTH_ERROR = 'invalid_grant: Token has been expired or revoked.';

describe('outgoing mail health on /api/health/workers', () => {
  it('reports ok when every send in the window left the building', async () => {
    const c = controllerWith([row(), row(), row()]);
    const mail = (await c.workers()).mail_send as Record<string, unknown>;

    expect(mail.ok).toBe(true);
    expect(mail.sent_24h).toBe(3);
    expect(mail.failed_24h).toBe(0);
    expect(mail.redirected_24h).toBe(0);
    expect(mail.detail).toBe('no outgoing mail failed in the last 24 h');
  });

  it('STOPS REPORTING OK when sends are failing, which is the whole point', async () => {
    // The exact shape of the August incident: the sweeps ran, so scheduler health was green.
    const c = controllerWith([row(), row({ success: false, error: AUTH_ERROR })]);
    const mail = (await c.workers()).mail_send as Record<string, unknown>;

    expect(mail.ok).toBe(false);
    expect(mail.failed_24h).toBe(1);
    expect(mail.sent_24h).toBe(1);
  });

  it('counts provider auth refusals separately, because a reconnect is the fix', async () => {
    const c = controllerWith([
      row({ success: false, error: AUTH_ERROR }),
      row({ success: false, error: AUTH_ERROR }),
      row({ success: false, error: 'Not sent — no brokerage lead has this address.' }),
    ]);
    const mail = (await c.workers()).mail_send as Record<string, unknown>;

    expect(mail.failed_24h).toBe(3);
    // The guard refusal is a failure but NOT an auth failure: nobody should reconnect a mailbox
    // because the CRM correctly declined to email a stranger.
    expect(mail.auth_failures_24h).toBe(2);
    expect(String(mail.detail)).toContain('reconnect the affected mailbox');
  });

  it('names WHICH sending identity is failing, since each mailbox holds its own token', async () => {
    // One agent's automated mail can be dead while everyone else's is fine. A total hides that.
    const c = controllerWith([
      row({ success: false, error: AUTH_ERROR, sent_by: 'Sai Ramesh' }),
      row({ success: false, error: AUTH_ERROR, sent_by: 'Sai Ramesh' }),
      row({ success: false, error: AUTH_ERROR, sent_by: 'Aswini' }),
      row(),
    ]);
    const mail = (await c.workers()).mail_send as Record<string, unknown>;

    expect(mail.senders_failing_auth).toEqual(
      expect.arrayContaining([{ name: 'Sai Ramesh', count: 2 }, { name: 'Aswini', count: 1 }]),
    );
  });

  it('REPORTS DIVERTED MAIL EVEN THOUGH EVERY SUCH SEND SUCCEEDED', async () => {
    // The August failure mode, isolated. `success: true` on every row, no error anywhere — and
    // not one message reached a client. No failure count can ever catch this.
    const c = controllerWith([
      row({ redirected: 'dev-sink@localhost.invalid' }),
      row({ redirected: 'dev-sink@localhost.invalid' }),
    ]);
    const mail = (await c.workers()).mail_send as Record<string, unknown>;

    expect(mail.failed_24h).toBe(0);
    expect(mail.sent_24h).toBe(2);
    expect(mail.ok).toBe(false);
    expect(mail.redirected_24h).toBe(2);
    expect(mail.redirected_to).toBe('dev-sink@localhost.invalid');
    expect(String(mail.detail)).toContain('MAIL_REDIRECT_TO is set on this server');
  });

  it('reports how long ago mail last actually left, so silence is not read as health', async () => {
    // Zero failures means nothing if nothing was attempted. On the day this was written the
    // production ledger had been quiet for 33 hours and every counter read perfectly.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const c = controllerWith([], twoDaysAgo);
    const mail = (await c.workers()).mail_send as Record<string, unknown>;

    expect(mail.ok).toBe(true);
    expect(mail.sent_24h).toBe(0);
    expect(mail.last_success_age_s).toBeGreaterThan(47 * 3600);
  });

  it('survives a log that has never been written to', async () => {
    const c = controllerWith([], null);
    const mail = (await c.workers()).mail_send as Record<string, unknown>;

    expect(mail.ok).toBe(true);
    expect(mail.last_success_age_s).toBeNull();
  });

  it('degrades to a reported problem rather than taking the whole endpoint down', async () => {
    // Every other block on this endpoint catches its own errors; this one must too, or one bad
    // query removes the process profile and scheduler state an operator came for.
    const prisma = {
      crm_email_log: { findMany: jest.fn().mockRejectedValue(new Error('relation does not exist')) },
      export_jobs: { count: jest.fn().mockResolvedValue(0) },
      users: { groupBy: jest.fn().mockResolvedValue([]) },
      mail_accounts: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const c = new HealthController(prisma, { enabled: () => false } as unknown as RedisService, {} as unknown as QueueService);

    const body = await c.workers();
    expect((body.mail_send as Record<string, unknown>).ok).toBe(false);
    expect(String((body.mail_send as Record<string, unknown>).detail)).toContain('relation does not exist');
    expect(body.process).toBeDefined();
    expect(body.schedulers).toBeDefined();
  });
});
