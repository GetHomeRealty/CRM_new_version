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
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO,
    MAIL_ALLOW_REAL_SEND: process.env.MAIL_ALLOW_REAL_SEND,
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

  describe('real delivery from a development process', () => {
    // The configuration a developer runs locally when they mean to reach a real inbox.
    beforeEach(() => set({ NODE_ENV: 'development', MAIL_ALLOW_REAL_SEND: '1', MAIL_REDIRECT_TO: undefined }));

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

  describe('being in development is not, on its own, a reason to redirect', () => {
    it('NODE_ENV=development with real send on reaches the real recipient', async () => {
      set({ NODE_ENV: 'development', MAIL_ALLOW_REAL_SEND: '1', MAIL_REDIRECT_TO: undefined });
      await mailer.sendDirect('client1@gmail.com', 'Subject', '<p>Hi.</p>');
      expect(last().to).toBe('client1@gmail.com');
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

  describe('production is unaffected by either switch', () => {
    it('sends to the real recipient with nothing configured', async () => {
      set({ NODE_ENV: 'production', MAIL_ALLOW_REAL_SEND: undefined, MAIL_REDIRECT_TO: undefined });
      await mailer.sendDirect('client1@gmail.com', 'Subject', '<p>Hi.</p>');
      expect(last().to).toBe('client1@gmail.com');
      expect(last().subject).toBe('Subject');
    });
  });
});
