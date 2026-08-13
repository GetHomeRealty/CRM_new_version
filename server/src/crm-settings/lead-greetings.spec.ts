import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadGreetingsService } from './lead-greetings.service';
import type { CrmAdvancedEmailService } from './crm-advanced-email.service';

/**
 * What the greeting sweep is allowed to send, and — mostly — what it must not send twice.
 *
 * NO MAIL LEAVES THESE TESTS. The email service is a stub that records the calls it was asked to
 * make, so every assertion is about who the sweep SELECTED and whether it would have sent, not
 * about SMTP. A test for a feature whose failure mode is "a real client got four birthday emails"
 * must not itself be capable of sending one.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** Records what it was asked to send and always reports success. */
function stubEmail() {
  const calls: { kind: string; name: string; email: string }[] = [];
  return {
    calls,
    service: {
      sendBirthdayWishes: async (name: string, email: string) => {
        calls.push({ kind: 'birthday', name, email });
        return { success: true, message: 'stub' };
      },
      sendAnniversaryWishes: async (name: string, email: string) => {
        calls.push({ kind: 'anniversary', name, email });
        return { success: true, message: 'stub' };
      },
    } as unknown as CrmAdvancedEmailService,
  };
}

const svc = (tx: PrismaService, email: CrmAdvancedEmailService) =>
  new LeadGreetingsService(tx, email, null as never, null as never);

async function makeAgent(tx: PrismaService): Promise<{ id: number }> {
  const now = new Date();
  return tx.users.create({
    data: { name: `Greet agent ${tag()}`, email: `greet-agent-${tag()}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
}

async function makeLead(tx: PrismaService, over: Record<string, unknown>): Promise<{ id: number; email: string }> {
  const now = new Date();
  return tx.leads.create({
    data: { name: `Greet lead ${tag()}`, email: `greet-${tag()}@example.test`, created_at: now, updated_at: now, ...over },
  }) as unknown as Promise<{ id: number; email: string }>;
}

/** A date with today's month and day, in a year long past — which is what a real DOB looks like. */
const anniversaryOf = (today: Date, yearsAgo: number): Date =>
  new Date(Date.UTC(today.getFullYear() - yearsAgo, today.getMonth(), today.getDate()));

describe('lead greetings — who gets one', () => {
  it('greets a lead whose birthday is today, and nobody whose is not', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      const birthdayToday = await makeLead(tx, { owner_user_id: agent.id, date_of_birth: anniversaryOf(today, 40) });
      // Same day, different month — the near-miss a `date` comparison would get wrong.
      const notToday = new Date(Date.UTC(today.getFullYear() - 40, (today.getMonth() + 6) % 12, today.getDate()));
      await makeLead(tx, { owner_user_id: agent.id, date_of_birth: notToday });

      const email = stubEmail();
      const out = await svc(tx, email.service).sweep(today);

      expect(email.calls.map((c) => c.email)).toEqual([birthdayToday.email]);
      expect(out.sent).toBe(1);
    });
  });

  it('greets a wedding anniversary on its day, as an anniversary and not a birthday', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id, marriage_day: anniversaryOf(today, 5) });

      const email = stubEmail();
      await svc(tx, email.service).sweep(today);

      expect(email.calls).toEqual([{ kind: 'anniversary', name: expect.any(String), email: lead.email }]);
    });
  });

  it('does not greet a lead who has unsubscribed', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      await makeLead(tx, { owner_user_id: agent.id, date_of_birth: anniversaryOf(today, 30), unsubscribed: true });

      const email = stubEmail();
      expect((await svc(tx, email.service).sweep(today)).sent).toBe(0);
      expect(email.calls).toHaveLength(0);
    });
  });

  it('does not greet a deleted lead', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      await makeLead(tx, { owner_user_id: agent.id, date_of_birth: anniversaryOf(today, 30), deleted_at: new Date() });

      const email = stubEmail();
      expect((await svc(tx, email.service).sweep(today)).sent).toBe(0);
    });
  });

  it('skips a lead with no agent rather than sending from a stand-in', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      await makeLead(tx, { owner_user_id: null, assigned_to: null, date_of_birth: anniversaryOf(today, 30) });

      const email = stubEmail();
      const out = await svc(tx, email.service).sweep(today);
      expect(email.calls).toHaveLength(0);
      expect(out.skipped).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('lead greetings — never twice', () => {
  /*
   * The requirement this feature lives or dies by. The sweep runs hourly, so "sends once" cannot
   * rest on the schedule; it rests on the `crm_email_log` row the first send wrote.
   */
  it('sends once however many times the sweep runs in a day', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      await makeLead(tx, { owner_user_id: agent.id, date_of_birth: anniversaryOf(today, 30) });

      const email = stubEmail();
      const service = svc(tx, email.service);

      await service.sweep(today);
      expect(email.calls).toHaveLength(1);

      /*
       * The stub does not write the log the real service would, so the row is written here — this
       * asserts the DEDUPE READ, which is the half that lives in this file. `dispatch` writing the
       * row on every send is covered where `dispatch` is.
       */
      await tx.crm_email_log.create({
        data: { kind: 'birthday', recipient: email.calls[0].email, subject: 'Happy Birthday!', success: true, created_at: new Date() },
      });

      await service.sweep(today);
      await service.sweep(today);
      expect(email.calls).toHaveLength(1);
    });
  });

  it('a greeting logged LAST year does not stop this year\'s', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id, date_of_birth: anniversaryOf(today, 30) });

      await tx.crm_email_log.create({
        data: {
          kind: 'birthday', recipient: lead.email, subject: 'Happy Birthday!', success: true,
          created_at: new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()),
        },
      });

      const email = stubEmail();
      await svc(tx, email.service).sweep(today);
      expect(email.calls).toHaveLength(1);
    });
  });

  it('a birthday already sent does not suppress the anniversary', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      // One lead with both dates on the same day — the case where a per-address key would collide.
      const lead = await makeLead(tx, {
        owner_user_id: agent.id,
        date_of_birth: anniversaryOf(today, 30),
        marriage_day: anniversaryOf(today, 5),
      });
      await tx.crm_email_log.create({
        data: { kind: 'birthday', recipient: lead.email, subject: 'Happy Birthday!', success: true, created_at: new Date() },
      });

      const email = stubEmail();
      await svc(tx, email.service).sweep(today);

      expect(email.calls.map((c) => c.kind)).toEqual(['anniversary']);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
