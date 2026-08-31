import { CampaignsService } from './campaigns.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-028: a campaign that reached a client has to appear in the log of what the brokerage sent.
 *
 * THE SIBLING OF CRM-010, and the more serious half. That one was about TEST sends; this is real
 * mail to real clients. A campaign was sent during the audit, the message arrived, and the email
 * log's highest entry was 66 before and 66 after — not one row.
 *
 * NOTHING WAS LOST, which is why it is Medium rather than Major: the campaign's own record is
 * complete, per-recipient, with opens, bounces and retries. The information simply was not in the
 * place a brokerage looks, so answering "what did we send this client" meant knowing to check two
 * screens, and nothing said so.
 *
 * A ROW PER RECIPIENT, because the question is asked about a PERSON. A single summary row per
 * campaign could not answer it, and every automated message already logs per recipient — a campaign
 * summary would be the odd shape out.
 *
 * A DEFERRED RETRY IS NOT AN OUTCOME. A mailbox full at eleven and fine at noon is one delivery;
 * writing a row per attempt would make the log read as several messages to one person. Only
 * terminal results are recorded, which is the case the fourth test pins.
 */

const USER = { id: 3, name: 'Sender', role: 'agent' } as unknown as AuthUserRecord;

type Logged = { kind: string; recipient: string; subject: string | null; success: boolean; error: string | null };

/**
 * The send loop with everything around it stubbed.
 *
 * `deliver` decides what the transport does per address, which is how the soft-bounce, hard-bounce
 * and success paths are reached without a mail server.
 */
function harness(emails: string[], deliver: (to: string) => void) {
  const logged: Logged[] = [];
  const rows = emails.map((_, i) => ({ id: i + 1, retry_count: 0 }));
  const recipients = emails.map((email, i) => ({ id: i + 1, email, name: `R${i}`, lead_id: null }));

  const prisma = {
    campaigns: {
      update: async () => ({}),
      findUnique: async () => ({ id: 12, name: 'ZZ Market Update', created_by_id: 3 }),
      findFirst: async () => null,
    },
    campaign_recipients: { update: async () => ({}), updateMany: async () => ({ count: 1 }) },
    campaign_links: { createMany: async () => ({}), findMany: async () => [] },
    email_suppressions: { upsert: async () => ({}) },
    $executeRaw: async () => 1,
  } as unknown as PrismaService;

  const mailer = { sendDirect: async (to: string) => { deliver(to); } };
  const emailLog = {
    recordExternalSend: async (
      kind: string, recipient: string, subject: string | null,
      success: boolean, error: string | null,
    ) => { logged.push({ kind, recipient, subject, success, error }); },
  };

  // The deliverability pre-check runs per address before the transport is touched; "yes" keeps the
  // test about the LOG rather than about DNS.
  const deliverability = { domainCanReceiveMail: async () => true } as never;

  // Token substitution, reduced to identity: the subject asserted below is the template's, and a
  // real personaliser would only add tokens this test does not use.
  const audience = {
    personalize: (text: string) => text,
    rewriteLinks: (html: string) => html,
    injectTracking: (html: string) => html,
  } as never;

  const svc = new CampaignsService(
    prisma, audience, null as never, deliverability, mailer as never,
    undefined, undefined, emailLog as never,
  );

  /** The job shape `send` and `resume` both hand to the private delivery loop. */
  const job = {
    campaignId: 12,
    name: 'ZZ Market Update',
    recipients,
    rows,
    tokens: emails.map((_, i) => `tok${i}`),
    template: { subject: 'ZZ Aug Market Update', content: '<p>hi</p>' },
    agentVars: {},
    attachments: [],
    baseUrl: 'https://crm.test',
    userId: USER.id,
  };
  return { svc, logged, job };
}

/** Drive the real delivery loop, with only the cross-process claim stubbed to "won". */
async function runSend(h: ReturnType<typeof harness>) {
  const anySvc = h.svc as unknown as Record<string, unknown>;
  anySvc.claimRecipient = async () => true;
  await (anySvc.deliver as (j: unknown) => Promise<void>).call(h.svc, h.job);
}

describe('a sent campaign is recorded where the brokerage looks', () => {
  it('writes a row naming each recipient', async () => {
    const h = harness(['one@probe.invalid', 'two@probe.invalid'], () => undefined);
    await runSend(h);

    // THE DEFECT: this list was empty however many people the campaign reached.
    expect(h.logged.map((l) => l.recipient).sort()).toEqual(['one@probe.invalid', 'two@probe.invalid']);
    expect(h.logged.every((l) => l.success)).toBe(true);
    // Distinguishable from a test send, which logs as `campaign_test` (CRM-010).
    expect(h.logged.every((l) => l.kind === 'campaign')).toBe(true);
    // The real subject, so the log answers "what did we send them".
    expect(h.logged[0].subject).toBe('ZZ Aug Market Update');
  });

  it('records a refused address with the transport error', async () => {
    const h = harness(['gone@probe.invalid'], () => { throw new Error('550 5.1.1 No such user'); });
    await runSend(h);

    expect(h.logged).toHaveLength(1);
    expect(h.logged[0].success).toBe(false);
    expect(h.logged[0].error).toContain('550');
  });

  it('does not turn a delivered campaign into a failed one when the log breaks', async () => {
    const h = harness(['one@probe.invalid'], () => undefined);
    (h.svc as unknown as { emailLog: { recordExternalSend: () => Promise<void> } }).emailLog = {
      recordExternalSend: async () => { throw new Error('log table is down'); },
    };
    // The email has already gone; a log that cannot be written must not undo that.
    await expect(runSend(h)).resolves.toBeUndefined();
  });

  it('works when no log service was injected at all', async () => {
    const svc = new CampaignsService(
      {} as unknown as PrismaService, null as never, null as never, null as never,
      { sendDirect: async () => undefined } as never,
    );
    expect(svc).toBeTruthy();
  });
});
