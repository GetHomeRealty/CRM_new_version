import { CampaignsService } from './campaigns.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-010: a campaign test send has to appear in the CRM email log.
 *
 * WHY THIS IS NOT A COSMETIC GAP. The log is the brokerage's record of what left the building. A
 * test send is a real email - it goes out over the same account, to whatever address was typed -
 * and it was the one class of outgoing mail with no row anywhere. If a test reached a client who
 * should not have had it, or went to a mistyped address, nothing in the application would show it
 * had ever happened.
 *
 * THE FAILURE PATH IS ASSERTED TOO, and deliberately. A send that was refused is as much a part of
 * "what happened on this account" as one that went, and it is the more likely thing to be asked
 * about later. Recording only successes would leave the log describing a healthier account than the
 * brokerage actually has - which is the same shape as CRM-016.
 *
 * Stubbed rather than run against a database: the rule is that the send WRITES A ROW, and what a
 * stub cannot fake is whether the call is made at all.
 */

const USER = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;

type Logged = {
  kind: string; recipient: string; subject: string | null;
  success: boolean; error: string | null; redirected: string | null;
};

function harness(opts: { fail?: string; logThrows?: boolean } = {}) {
  const logged: Logged[] = [];
  const mailer = {
    testForUser: async () => {
      if (opts.fail) throw new Error(opts.fail);
      return { from: 'crm@brokerage.test', account: 'CRM' };
    },
  };
  const emailLog = {
    recordExternalSend: async (
      kind: string, recipient: string, subject: string | null,
      success: boolean, error: string | null, _u: unknown, redirected: string | null,
    ) => {
      if (opts.logThrows) throw new Error('log table is down');
      logged.push({ kind, recipient, subject, success, error, redirected });
    },
  };
  const svc = new CampaignsService(
    {} as unknown as PrismaService, null as never, null as never, null as never,
    mailer as never, undefined, undefined, emailLog as never,
  );
  return { svc, logged };
}

describe('a campaign test send is recorded like every other outgoing email', () => {
  it('writes a row naming the recipient', async () => {
    const h = harness();
    const res = await h.svc.sendTest(USER, 'someone@probe.test');

    expect(res.ok).toBe(true);
    // THE DEFECT: this list was empty. The API returned 200 and the log never moved.
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0].recipient).toBe('someone@probe.test');
    expect(h.logged[0].success).toBe(true);
    expect(h.logged[0].error).toBeNull();
    // Distinguishable from a per-lead send, so the log can be read by what each row was.
    expect(h.logged[0].kind).toBe('campaign_test');
  });

  it('records a refused send, not only a delivered one', async () => {
    const h = harness({ fail: '535 BadCredentials' });
    const res = await h.svc.sendTest(USER, 'someone@probe.test');

    expect(res.ok).toBe(false);
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0].success).toBe(false);
    // The real SMTP wording, kept - it is what makes the row worth having.
    expect(h.logged[0].error).toContain('535');
  });

  it('logs the intended recipient, and where it actually went', async () => {
    // On a machine with MAIL_REDIRECT_TO set, every message is diverted. A row showing only the
    // diversion target would say nothing about who was aimed at.
    const saved = { allow: process.env.MAIL_ALLOW_REAL_SEND, to: process.env.MAIL_REDIRECT_TO, env: process.env.NODE_ENV };
    try {
      process.env.NODE_ENV = 'development';
      process.env.MAIL_ALLOW_REAL_SEND = '0';
      process.env.MAIL_REDIRECT_TO = 'capture@probe.test';

      const h = harness();
      await h.svc.sendTest(USER, 'client@probe.test');

      expect(h.logged[0].recipient).toBe('client@probe.test');
      expect(h.logged[0].redirected).toBe('capture@probe.test');
    } finally {
      process.env.MAIL_ALLOW_REAL_SEND = saved.allow ?? '';
      process.env.MAIL_REDIRECT_TO = saved.to ?? '';
      process.env.NODE_ENV = saved.env ?? 'test';
    }
  });

  it('still reports the send when the log itself fails', async () => {
    // The log is a record, not a gate. A broken log table must not turn a delivered email into a
    // failed request - the email has already gone.
    const h = harness({ logThrows: true });
    await expect(h.svc.sendTest(USER, 'someone@probe.test')).resolves.toMatchObject({ ok: true });
  });

  it('works when no log service was injected at all', async () => {
    // Several specs construct this service with the optional dependencies omitted.
    const svc = new CampaignsService(
      {} as unknown as PrismaService, null as never, null as never, null as never,
      { testForUser: async () => ({ from: 'a@b.test', account: 'CRM' }) } as never,
    );
    await expect(svc.sendTest(USER, 'someone@probe.test')).resolves.toMatchObject({ ok: true });
  });
});
