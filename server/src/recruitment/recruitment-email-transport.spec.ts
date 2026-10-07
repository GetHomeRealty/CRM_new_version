import * as net from 'net';
import { PrismaClient } from '@prisma/client';
import type { mail_accounts } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { MailerService } from '../email/mailer.service';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentEmailService, REMINDER_MAX_ATTEMPTS } from './recruitment-email.service';

/**
 * THE REAL MAILER, A REAL SMTP CONVERSATION, A LOST REPLY.
 *
 * Nothing here is a stand-in for the send path: Recruitment calls the actual `MailerService`,
 * which drives actual nodemailer over a socket to a local SMTP server. That server takes the whole
 * message and then drops the connection instead of answering the final "." — the provider accepted
 * it and the response was lost. The server counts every complete message it received, so "how many
 * copies went out" is measured, not inferred.
 *
 * Without `maxAttempts: 1` the mailer's own retries would deliver three copies in the first call
 * (measured 2026-10-07). With it, exactly one — and nothing afterwards.
 *
 * Mail can only reach 127.0.0.1: the account points there, and the mailer's redirect is set too.
 * Reminder tests run on a 2031 clock so the sweep sees only the interviews made here.
 */

const prisma = new PrismaClient();
const db = prisma as unknown as PrismaService;
const recruitment = new RecruitmentService(db);
const ADMIN = { id: 1, name: 'ZZ Admin', role: 'admin' } as unknown as AuthUserRecord;
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

const H = 3_600_000;
const NOW = new Date('2031-04-14T15:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

let received = 0;
let server: net.Server;
let account: mail_accounts;
const savedRedirect = process.env.MAIL_REDIRECT_TO;

beforeAll(async () => {
  process.env.MAIL_REDIRECT_TO = 'lost-reply-sink@test.local';
  server = net.createServer((sock) => {
    let data = false; let buf = '';
    sock.write('220 lost-reply ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          // The whole message is here. Count it, then lose the reply.
          if (line === '.') { received += 1; data = false; sock.destroy(); }
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250 lost-reply\r\n');
        else if (up === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  account = {
    id: 0, name: 'Lost reply', host: '127.0.0.1', port: (server.address() as net.AddressInfo).port,
    encryption: null, username: null, password: '', from_email: 'crm@lost-reply.test', from_name: 'CRM', is_active: true,
  } as unknown as mail_accounts;
});

const made: number[] = [];
afterEach(async () => {
  await prisma.recruitment_candidates.updateMany({ where: { id: { in: made }, deleted_at: null }, data: { deleted_at: new Date() } });
});
afterAll(async () => {
  process.env.MAIL_REDIRECT_TO = savedRedirect;
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

/** A Recruitment email service on the REAL mailer — what a restart builds afresh. */
const service = () => new RecruitmentEmailService(
  db,
  new MailerService(db, { decryptString: () => '' } as never, {} as never),
  { defaultSender: async () => account } as never,
  recruitment,
);

async function candidate() {
  const t = tag();
  const row = await prisma.recruitment_candidates.create({
    data: { name: `ZZ Lost Reply ${t}`, email: `zz-lost-${t}@probe.test`, status: 'interview', created_at: new Date(), updated_at: new Date() },
  });
  made.push(row.id);
  return row;
}

describe('the provider accepted it and the reply was lost', () => {
  it('the 24-hour reminder: exactly one copy reaches the server, and no later sweep or restart sends another', async () => {
    const c = await candidate();
    await prisma.recruitment_interviews.create({
      data: {
        candidate_id: c.id, scheduled_at: at(23 * H), status: 'scheduled', location: '1 Main St',
        scheduled_set_at: at(-72 * H), created_at: at(-72 * H), updated_at: at(-72 * H),
      },
    });
    received = 0;
    const svc = service();

    await svc.runReminders(NOW);
    expect(received).toBe(1);
    const [row] = await prisma.recruitment_emails.findMany({ where: { candidate_id: c.id } });
    expect(row).toMatchObject({ kind: 'interview_reminder', status: 'failed', attempts: REMINDER_MAX_ATTEMPTS });
    expect(row.error_message).toMatch(/^Outcome unknown/); // visible, not silently dropped

    for (let i = 1; i <= 6; i += 1) await svc.runReminders(at(i * 10 * 60_000));
    await service().runReminders(at(70 * 60_000)); // a restart: new mailer, new service, same database
    expect(received).toBe(1);
    expect(await prisma.recruitment_emails.count({ where: { candidate_id: c.id } })).toBe(1);
  });

  it('a hand-sent email: exactly one copy, and the recruiter is told it may have arrived', async () => {
    const c = await candidate();
    received = 0;
    await expect(service().send(ADMIN, c.id, { subject: 'Hello', message: 'Hi' })).rejects.toThrow(/may still have been delivered/);
    expect(received).toBe(1);
    const [row] = await prisma.recruitment_emails.findMany({ where: { candidate_id: c.id } });
    expect(row).toMatchObject({ kind: 'manual', status: 'failed' });
    expect(row.error_message).toMatch(/^Outcome unknown/);
  });
});
