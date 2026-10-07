import { MailerService } from './mailer.service';
import type { mail_accounts } from '@prisma/client';

/**
 * `sendFromAccount({ maxAttempts })` — an opt-in limit on the mailer's own retries.
 *
 * Every existing caller passes nothing and must keep exactly what it had: up to three attempts,
 * retrying what `isTransient` calls transient, with the same backoff. Only a caller that asks gets
 * fewer. The transport is replaced so each attempt can be counted; timers are faked so the backoff
 * between attempts costs no real time.
 */

let attempts = 0;
let failWith: unknown = null;

jest.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: () => {
      attempts += 1;
      return failWith ? Promise.reject(failWith) : Promise.resolve({ messageId: '<ok@local>' });
    },
  }),
}));

const ACCOUNT = {
  id: 1, host: 'smtp.example.test', port: 587, encryption: 'tls', username: null, password: '',
  from_email: 'crm@example.test', from_name: 'CRM', is_active: true,
} as unknown as mail_accounts;

/** A lost connection — what nodemailer raises when the reply never arrives. Transient to the mailer. */
const lostReply = () => Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' });
const refused550 = () => Object.assign(new Error('550 no such user'), { responseCode: 550 });

function mailer(): MailerService {
  const prisma = {
    email_templates: {
      findUnique: async () => ({ id: 7, is_active: true, subject: 'S', body_html: '<p>B</p>', mail_accounts: ACCOUNT }),
    },
    email_template_attachments: { findMany: async () => [] },
  } as never;
  const m = new MailerService(prisma, { decryptString: () => '' } as never, {} as never);
  jest.spyOn(m, 'resolveSender').mockResolvedValue(ACCOUNT);
  return m;
}

/** Runs a send with the backoff timers fast-forwarded; resolves to the error, if any. */
async function run(send: () => Promise<unknown>): Promise<unknown> {
  const p = send().then(() => null, (e: unknown) => e);
  await jest.advanceTimersByTimeAsync(60_000);
  return p;
}

beforeEach(() => {
  attempts = 0;
  failWith = null;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('existing callers keep the default retries', () => {
  it('sendFromAccount with no option still makes three attempts at a transient failure', async () => {
    failWith = lostReply();
    const err = await run(() => mailer().sendFromAccount(ACCOUNT, { to: ['a@x.test'], subject: 's', html: 'h' }));
    expect(err).toBe(failWith);
    expect(attempts).toBe(3);
  });

  it('sendDirect still makes three attempts', async () => {
    failWith = lostReply();
    await run(() => mailer().sendDirect('a@x.test', 's', 'h'));
    expect(attempts).toBe(3);
  });

  it('send (templated) still makes three attempts', async () => {
    failWith = lostReply();
    await run(() => mailer().send('any.event', {}, 'a@x.test'));
    expect(attempts).toBe(3);
  });

  it('a permanent refusal is still not retried', async () => {
    failWith = refused550();
    await run(() => mailer().sendFromAccount(ACCOUNT, { to: ['a@x.test'], subject: 's', html: 'h' }));
    expect(attempts).toBe(1);
  });

  it('a success is one attempt', async () => {
    await run(() => mailer().sendFromAccount(ACCOUNT, { to: ['a@x.test'], subject: 's', html: 'h' }));
    expect(attempts).toBe(1);
  });
});

describe('maxAttempts', () => {
  it('maxAttempts: 1 makes exactly one attempt, and reports the failure as it came', async () => {
    failWith = lostReply();
    const err = await run(() => mailer().sendFromAccount(ACCOUNT, { to: ['a@x.test'], subject: 's', html: 'h', maxAttempts: 1 }));
    expect(attempts).toBe(1);
    expect(err).toBe(failWith);
  });

  it('maxAttempts: 2 makes two', async () => {
    failWith = lostReply();
    await run(() => mailer().sendFromAccount(ACCOUNT, { to: ['a@x.test'], subject: 's', html: 'h', maxAttempts: 2 }));
    expect(attempts).toBe(2);
  });

  it.each([0, -1, 2.5, Number.NaN])('a meaningless value (%p) falls back to the default', async (n) => {
    failWith = lostReply();
    await run(() => mailer().sendFromAccount(ACCOUNT, { to: ['a@x.test'], subject: 's', html: 'h', maxAttempts: n }));
    expect(attempts).toBe(3);
  });

  it('it can only lower the default, never raise it', async () => {
    failWith = lostReply();
    await run(() => mailer().sendFromAccount(ACCOUNT, { to: ['a@x.test'], subject: 's', html: 'h', maxAttempts: 99 }));
    expect(attempts).toBe(3);
  });
});
