import { MailerService } from './mailer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { LaravelCryptService } from '../common/laravel-crypt.service';
import type { MailAccountService } from './mail-account.service';
import type { mail_accounts } from '@prisma/client';

/**
 * WHO ACTUALLY RECEIVES THE MESSAGE.
 *
 * `mail-redirect.spec.ts` next door pins `redirectTarget()` — the decision. This pins the
 * CONSEQUENCE: what lands in the object handed to nodemailer's `sendMail`. They are different
 * failures. The decision can be right while `dispatch` still puts the wrong address in `to`, and
 * that is the bug nobody sees, because a message that leaves for the wrong recipient looks exactly
 * like a message that worked.
 *
 * WHY IT MATTERS HERE. Rule 4 of `redirectTarget()` turns "not production" into "replace the
 * recipient", which is correct as a default and wrong as an unconditional rule: a developer must be
 * able to send to a real address from localhost without editing code, and must be able to tell at a
 * glance whether they are doing so. These tests fix both directions of that switch so neither can
 * be changed by accident:
 *
 *   real      MAIL_ALLOW_REAL_SEND=1, MAIL_REDIRECT_TO empty  -> the application's own recipient
 *   redirect  MAIL_REDIRECT_TO=<mailbox>                      -> that mailbox, cc/bcc dropped
 *
 * NOTHING IS SENT. `nodemailer` is mocked, so no transport is built and no server is contacted —
 * these assertions are about the message object and nothing else.
 */

const sent: Record<string, unknown>[] = [];

jest.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: (message: Record<string, unknown>) => {
      sent.push(message);
      return Promise.resolve({ messageId: '<test@local>' });
    },
  }),
}));

/** A plain SMTP account, so the OAuth branch and its token decryption stay out of the way. */
const ACCOUNT = {
  id: 1, name: 'CRM', from_name: 'Get Home Realty', from_email: 'crm@gethomerealty.ca',
  host: 'smtp.example.com', port: 587, username: 'crm@gethomerealty.ca', password: 'stored',
  encryption: 'tls', is_active: true, is_default: true, user_id: null, scope: 'crm',
} as unknown as mail_accounts;

const prisma = { mail_accounts: { findFirst: () => Promise.resolve(ACCOUNT) } } as unknown as PrismaService;
const crypt = { decryptString: () => 'decrypted' } as unknown as LaravelCryptService;
const accounts = {} as unknown as MailAccountService;

const mailer = new MailerService(prisma, crypt, accounts);
const last = () => sent[sent.length - 1];

describe('which recipient the message actually leaves for', () => {
  /*
   * S-1 widened what decides delivery from one variable to four, so the harness has to be able to
   * state all of them. `DELIVERING` below is the only configuration that now reaches a real
   * recipient — which is why the cases that check the MECHANICS of real delivery (the recipient,
   * the subject, cc and bcc) are driven from it rather than from a development process.
   */
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    PRODUCTION_DATABASE_NAME: process.env.PRODUCTION_DATABASE_NAME,
    MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO,
    MAIL_ALLOW_REAL_SEND: process.env.MAIL_ALLOW_REAL_SEND,
  };

  /** A correctly configured live server: the four conditions that permit external delivery. */
  const DELIVERING = {
    NODE_ENV: 'production',
    APP_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db.internal:5432/myapp?schema=public',
    PRODUCTION_DATABASE_NAME: 'myapp',
    MAIL_ALLOW_REAL_SEND: '1',
    MAIL_REDIRECT_TO: undefined,
  };

  const set = (env: Partial<typeof saved>) => {
    for (const k of Object.keys(saved) as (keyof typeof saved)[]) {
      const v = env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  beforeEach(() => { sent.length = 0; });

  afterEach(() => {
    // Restore exactly, including "was not set at all" — a leaked NODE_ENV would change the
    // behaviour of every suite that runs after this one.
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('real delivery from a correctly configured production process', () => {
    /*
     * WAS "from a development process", with NODE_ENV=development and MAIL_ALLOW_REAL_SEND=1 — the
     * configuration S-1 closed, because it was how a laptop came to email real clients. The cases
     * below are about what real delivery DOES to a message once permitted, which is unchanged; only
     * the configuration that earns it has moved.
     */
    beforeEach(() => set(DELIVERING));

    it('sends to the address the application asked for', async () => {
      await mailer.sendDirect('client1@gmail.com', 'Your property search', '<p>Hello.</p>');
      expect(last().to).toBe('client1@gmail.com');
    });

    it('does not substitute the previous recipient into the next message', async () => {
      await mailer.sendDirect('client1@gmail.com', 'One', '<p>1</p>');
      await mailer.sendDirect('agent@gethomerealty.ca', 'Two', '<p>2</p>');
      expect(sent.map((m) => m.to)).toEqual(['client1@gmail.com', 'agent@gethomerealty.ca']);
    });

    it('leaves the subject alone — no "[redirected from …]" prefix', async () => {
      await mailer.sendDirect('client1@gmail.com', 'Your property search', '<p>Hello.</p>');
      expect(last().subject).toBe('Your property search');
    });

    it('keeps cc and bcc, which the redirect would otherwise drop', async () => {
      await mailer.sendFromAccount(ACCOUNT, {
        to: ['client1@gmail.com'], cc: ['manager@gethomerealty.ca'], bcc: ['file@gethomerealty.ca'],
        subject: 'Offer', html: '<p>Attached.</p>',
      });
      expect(last().to).toEqual(['client1@gmail.com']);
      expect(last().cc).toEqual(['manager@gethomerealty.ca']);
      expect(last().bcc).toEqual(['file@gethomerealty.ca']);
    });

    it('still sends from the configured account, not from the recipient', async () => {
      await mailer.sendDirect('client1@gmail.com', 'Subject', '<p>Hi.</p>');
      expect(last().from).toEqual({ name: 'Get Home Realty', address: 'crm@gethomerealty.ca' });
    });
  });

  describe('being in development IS, on its own, a reason to redirect', () => {
    /*
     * REVERSED BY S-1. This read "being in development is not, on its own, a reason to redirect",
     * and it was true: one variable let a development process reach a real inbox. That is the
     * defect. A developer who needs to see the message uses MAIL_REDIRECT_TO, tested below.
     */
    it('NODE_ENV=development with real send on no longer reaches the real recipient', async () => {
      set({ NODE_ENV: 'development', APP_ENV: 'development', MAIL_ALLOW_REAL_SEND: '1', MAIL_REDIRECT_TO: undefined });
      await mailer.sendDirect('client1@gmail.com', 'Subject', '<p>Hi.</p>');
      expect(last().to).toBe(MailerService.DEV_SINK);
    });

    it('but the safety default still applies when nothing has been chosen', async () => {
      // Deliberately unchanged behaviour: an unconfigured dev box must not reach real people.
      set({ NODE_ENV: 'development', MAIL_ALLOW_REAL_SEND: undefined, MAIL_REDIRECT_TO: undefined });
      await mailer.sendDirect('client1@gmail.com', 'Subject', '<p>Hi.</p>');
      expect(last().to).toBe(MailerService.DEV_SINK);
    });
  });

  describe('redirect, only when a mailbox has been named', () => {
    beforeEach(() => set({ NODE_ENV: 'development', MAIL_ALLOW_REAL_SEND: '1', MAIL_REDIRECT_TO: 'dev-inbox@example.com' }));

    it('replaces the recipient with the configured mailbox', async () => {
      await mailer.sendDirect('client1@gmail.com', 'Your property search', '<p>Hello.</p>');
      expect(last().to).toBe('dev-inbox@example.com');
    });

    it('says whose message it was in the subject, so the capture is readable', async () => {
      await mailer.sendDirect('client1@gmail.com', 'Your property search', '<p>Hello.</p>');
      expect(last().subject).toBe('[redirected from client1@gmail.com] Your property search');
    });

    it('drops cc and bcc so a diverted message cannot copy the real people', async () => {
      await mailer.sendFromAccount(ACCOUNT, {
        to: ['client1@gmail.com'], cc: ['manager@gethomerealty.ca'], bcc: ['file@gethomerealty.ca'],
        subject: 'Offer', html: '<p>Attached.</p>',
      });
      expect(last().to).toBe('dev-inbox@example.com');
      expect(last().cc).toBeUndefined();
      expect(last().bcc).toBeUndefined();
    });

    it('beats MAIL_ALLOW_REAL_SEND — a named mailbox wins over real delivery', async () => {
      await mailer.sendDirect('client1@gmail.com', 'Subject', '<p>Hi.</p>');
      expect(last().to).toBe('dev-inbox@example.com');
    });
  });

  describe('production delivers, once it has said what it is', () => {
    it('sends to the real recipient when the four conditions agree', async () => {
      set(DELIVERING);
      await mailer.sendDirect('client1@gmail.com', 'Subject', '<p>Hi.</p>');
      expect(last().to).toBe('client1@gmail.com');
      expect(last().subject).toBe('Subject');
    });

    /*
     * The case this file existed to protect, restated. Production used to deliver on NODE_ENV
     * alone; it now needs the rest, and a live server that has not been told them is refused at
     * BOOT by `validate-config.ts` rather than discovering it one undelivered message at a time.
     */
    it('diverts when NODE_ENV is the only thing claiming production', async () => {
      set({ NODE_ENV: 'production', APP_ENV: 'development', MAIL_ALLOW_REAL_SEND: undefined, MAIL_REDIRECT_TO: undefined });
      await mailer.sendDirect('client1@gmail.com', 'Subject', '<p>Hi.</p>');
      expect(last().to).toBe(MailerService.DEV_SINK);
    });
  });
});
