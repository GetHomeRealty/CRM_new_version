import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadWelcomeService } from './lead-welcome.service';
import { CrmAdvancedEmailService, type WelcomeSender } from './crm-advanced-email.service';
import { CrmTriggersService } from './crm-triggers.service';
import { NotificationPreferenceService } from '../notifications/notification-preference.service';
import type { MailAccountService } from '../email/mail-account.service';
import type { MailerService } from '../email/mailer.service';

/**
 * The welcome a new lead gets, once.
 *
 * NO MAIL LEAVES THESE TESTS. Where the sweep is the subject the email service is a stub that
 * records what it was asked to send; where the send itself is the subject the real service runs
 * with a stub mailer that records the address and the account it would have used. A feature whose
 * failure mode is "every client in the database got a welcome email" must not itself be capable of
 * sending one.
 *
 * WHAT HAS TO HOLD, and each has its own block below:
 *   who is selected     — recently arrived, has an address, not unsubscribed, not deleted
 *   exactly once        — imports, retries and a second pass produce one email per person
 *   who it comes from   — the lead's agent, else the brokerage, and always a CRM mailbox
 *   when it must not go — trigger off, template off, no mailbox connected
 *   what is recorded    — the lead's own history shows it, successes and failures alike
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

// --------------------------------------------------------------------------- stubs

/** Records what the sweep asked to send, and answers however the test wants. */
function stubEmail(opts: { blocked?: string | null; success?: boolean; throws?: boolean } = {}) {
  const calls: { leadId: number; email: string; sender: WelcomeSender }[] = [];
  return {
    calls,
    service: {
      welcomeBlockedReason: async () => opts.blocked ?? null,
      sendWelcomeEmail: async (lead: { id: number; email: string }, sender: WelcomeSender) => {
        calls.push({ leadId: lead.id, email: lead.email, sender });
        if (opts.throws) throw new Error('smtp exploded');
        return { success: opts.success ?? true, message: opts.success === false ? 'refused' : 'stub' };
      },
    } as unknown as CrmAdvancedEmailService,
  };
}

const sweeper = (tx: PrismaService, email: CrmAdvancedEmailService) =>
  new LeadWelcomeService(tx, email, null as never, null as never);

// --------------------------------------------------------------------------- fixtures

async function makeAgent(tx: PrismaService, over: Record<string, unknown> = {}): Promise<{ id: number; name: string; email: string }> {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `Welcome agent ${t}`, email: `welcome-agent-${t}@example.test`,
      username: `wagent${t.replace(/-/g, '')}`, phone: '416-555-0142',
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now, ...over,
    },
  }) as unknown as Promise<{ id: number; name: string; email: string }>;
}

/** A lead who arrived just now, which is the only kind the sweep looks at. */
async function makeLead(tx: PrismaService, over: Record<string, unknown> = {}): Promise<{ id: number; email: string; name: string }> {
  const now = new Date();
  const t = tag();
  return tx.leads.create({
    data: {
      name: `Welcome lead ${t}`, email: `welcome-${t}@example.test`,
      created_at: now, updated_at: now, ...over,
    },
  }) as unknown as Promise<{ id: number; email: string; name: string }>;
}

/** Turn the welcome on at brokerage level — it ships off, like the other timer-driven sends. */
async function enableWelcome(tx: PrismaService, on = true): Promise<void> {
  const row = await tx.crm_email_settings.findFirst({ orderBy: { id: 'asc' } });
  const toggles = JSON.stringify({ welcome: on });
  const now = new Date();
  if (row) await tx.crm_email_settings.update({ where: { id: row.id }, data: { template_toggles: toggles, updated_at: now } });
  else await tx.crm_email_settings.create({ data: { template_toggles: toggles, auto_send_enabled: true, created_at: now, updated_at: now } });
}

/** A welcome already logged against an address — what "they have had theirs" looks like. */
async function logWelcome(tx: PrismaService, recipient: string): Promise<void> {
  await tx.crm_email_log.create({
    data: { kind: 'welcome', recipient, subject: 'Welcome', success: true, created_at: new Date() },
  });
}

const welcomed = (calls: { email: string }[]) => calls.map((c) => c.email).sort();

// ============================================================================ selection
describe('the welcome sweep — who is selected', () => {
  it('welcomes a lead who has just arrived', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const email = stubEmail();
      const out = await sweeper(tx, email.service).sweep();

      expect(welcomed(email.calls)).toContain(lead.email);
      expect(out.sent).toBeGreaterThan(0);
    });
  });

  it('leaves a lead who arrived long ago alone', async () => {
    /*
     * THE MISTAKE THIS PREVENTS. "Leads that have never had a welcome" is every lead the brokerage
     * has ever had. Without the window, the first pass after this shipped would have emailed the
     * entire database — so a lead from last spring must be invisible to it.
     */
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const old = await makeLead(tx, {
        owner_user_id: agent.id,
        created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      expect(welcomed(email.calls)).not.toContain(old.email);
    });
  });

  it('never writes to somebody who has unsubscribed, or to a deleted lead, or to no address', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const gone = await makeLead(tx, { owner_user_id: agent.id, unsubscribed: true });
      const deleted = await makeLead(tx, { owner_user_id: agent.id, deleted_at: new Date() });
      const blank = await makeLead(tx, { owner_user_id: agent.id, email: '' });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      const sent = welcomed(email.calls);
      expect(sent).not.toContain(gone.email);
      expect(sent).not.toContain(deleted.email);
      expect(sent).not.toContain('');
      expect(email.calls.some((c) => c.leadId === blank.id)).toBe(false);
    });
  });
});

// ============================================================================ exactly once
describe('the welcome sweep — exactly once', () => {
  it('does not welcome the same lead on a second pass', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const first = stubEmail();
      await sweeper(tx, first.service).sweep();
      expect(welcomed(first.calls)).toContain(lead.email);

      // The real service writes the log; the stub does not, so this stands in for that write.
      await logWelcome(tx, lead.email);

      const second = stubEmail();
      await sweeper(tx, second.service).sweep();
      expect(welcomed(second.calls)).not.toContain(lead.email);
    });
  });

  it('welcomes a PERSON once, not a row once — the same client under two agents', async () => {
    /*
     * WHERE THE DUPLICATE ACTUALLY COMES FROM. `leads` carries a unique index on
     * (COALESCE(owner_user_id,0), lower(email)), so one agent CANNOT hold the same address twice —
     * a re-import into one book is already refused by the database. What it does not stop is the
     * same client existing in two agents' books, which is normal and legitimate: a referral, a
     * couple working with two people, a lead reassigned by creating a new row. That is two rows and
     * one human being, and they must not be welcomed to the brokerage twice.
     *
     * Matching on the ADDRESS rather than the lead id is the whole of that protection.
     */
    await inRollback(async (tx) => {
      const first = await makeAgent(tx);
      const second = await makeAgent(tx);
      const address = `duplicate-${tag()}@example.test`;
      await makeLead(tx, { owner_user_id: first.id, email: address });
      await makeLead(tx, { owner_user_id: second.id, email: address });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      expect(welcomed(email.calls).filter((e) => e === address)).toHaveLength(1);
    });
  });

  it('matches the address however it was capitalised', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const address = `MixedCase-${tag()}@Example.test`;
      const lead = await makeLead(tx, { owner_user_id: agent.id, email: address });
      await logWelcome(tx, address.toLowerCase());

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      expect(email.calls.some((c) => c.leadId === lead.id)).toBe(false);
    });
  });
});

// ============================================================================ the sender
describe('the welcome sweep — who it comes from', () => {
  it('comes from the lead\'s own agent, with their name, address and number', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      const call = email.calls.find((c) => c.leadId === lead.id)!;
      expect(call.sender.user.id).toBe(agent.id);
      expect(call.sender.agentName).toBe(agent.name);
      expect(call.sender.agentEmail).toBe(agent.email);
      expect(call.sender.agentPhone).toBe('416-555-0142');
    });
  });

  it('prefers the owner over the assignee, so one lead has one agent', async () => {
    await inRollback(async (tx) => {
      const owner = await makeAgent(tx);
      const assignee = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: owner.id, assigned_to: assignee.id });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      expect(email.calls.find((c) => c.leadId === lead.id)!.sender.user.id).toBe(owner.id);
    });
  });

  it('falls back to the assignee when nobody owns it', async () => {
    await inRollback(async (tx) => {
      const assignee = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: null, assigned_to: assignee.id });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      expect(email.calls.find((c) => c.leadId === lead.id)!.sender.user.id).toBe(assignee.id);
    });
  });

  it('comes from the BROKERAGE when the lead belongs to nobody', async () => {
    /*
     * The greetings skip an unattributed lead, because there is no agent whose name belongs at the
     * bottom of a birthday card. A welcome is different: the brokerage is a perfectly good sender
     * for "welcome to the brokerage", and a lead nobody has picked up yet is exactly the one most
     * worth answering quickly.
     */
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { owner_user_id: null, assigned_to: null });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      const call = email.calls.find((c) => c.leadId === lead.id)!;
      expect(call).toBeTruthy();
      // `id: null` is what makes the mailbox lookup fall through to the brokerage's CRM account.
      expect(call.sender.user.id).toBeNull();
      expect(call.sender.agentName).toBe(call.sender.brokerageName);
      expect(call.sender.brokerageName).toBeTruthy();
    });
  });

  it('treats a departed agent as no agent rather than sending under their name', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx, { status: 'Inactive' });
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      const call = email.calls.find((c) => c.leadId === lead.id)!;
      expect(call.sender.user.id).toBeNull();
      expect(call.sender.agentName).not.toBe(agent.name);
    });
  });

  it('names the brokerage from Company Settings, not from a constant', async () => {
    await inRollback(async (tx) => {
      const company = await tx.company_settings.findFirst({ orderBy: { id: 'asc' } });
      const renamed = `ZZ Brokerage ${tag()}`;
      if (company) await tx.company_settings.update({ where: { id: company.id }, data: { name: renamed, phone: '416-555-0000', email: 'hello@zz.test' } });
      else await tx.company_settings.create({ data: { name: renamed, phone: '416-555-0000', email: 'hello@zz.test' } });

      const lead = await makeLead(tx, { owner_user_id: null, assigned_to: null });
      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      const call = email.calls.find((c) => c.leadId === lead.id)!;
      expect(call.sender.brokerageName).toBe(renamed);
      expect(call.sender.brokerageContact).toContain(renamed);
      expect(call.sender.brokerageContact).toContain('hello@zz.test');
    });
  });
});

// ============================================================================ when it must not go
describe('the welcome sweep — when it must not go', () => {
  it('skips without spending the lead\'s one chance when nothing is configured', async () => {
    /*
     * THE TRAP THIS AVOIDS. Any logged welcome means "they have had theirs". If a refusal recorded
     * while no mailbox was connected counted, every lead who arrived before somebody connected one
     * would lose their welcome permanently, and connecting the account later would fix nothing. So a
     * setup problem must not reach the log at all — the lead stays eligible.
     */
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const blocked = stubEmail({ blocked: 'no CRM email account is connected' });
      const out = await sweeper(tx, blocked.service).sweep();

      expect(blocked.calls).toHaveLength(0);        // never attempted
      expect(out.sent).toBe(0);
      expect(out.skipped).toBeGreaterThan(0);
      // Nothing was written, so the very next pass — after somebody connects an account — sends it.
      expect(await tx.crm_email_log.count({ where: { kind: 'welcome', recipient: lead.email } })).toBe(0);

      const fixed = stubEmail();
      await sweeper(tx, fixed.service).sweep();
      expect(welcomed(fixed.calls)).toContain(lead.email);
    });
  });

  it('records a failed send on the lead rather than losing it', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const failing = stubEmail({ success: false });
      await sweeper(tx, failing.service).sweep();

      const rows = await tx.lead_emails.findMany({ where: { lead_id: lead.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('failed');
      expect(rows[0].error).toBeTruthy();
    });
  });

  it('a thrown error is counted and recorded, not allowed to stop the pass', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const exploding = stubEmail({ throws: true });
      const out = await sweeper(tx, exploding.service).sweep();

      expect(out.failed).toBeGreaterThan(0);
      const rows = await tx.lead_emails.findMany({ where: { lead_id: lead.id } });
      expect(rows[0].status).toBe('failed');
      expect(rows[0].error).toContain('smtp exploded');
    });
  });
});

// ============================================================================ the lead's history
describe('the welcome appears in the lead\'s own history', () => {
  it('writes a sent row an agent opening the lead can see', async () => {
    /*
     * `crm_email_log` is the brokerage-wide log behind CRM Settings. An agent opening the lead looks
     * at the lead's own communication history — and without a row there they would introduce
     * themselves a second time, to somebody the brokerage had already written to.
     */
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      const rows = await tx.lead_emails.findMany({ where: { lead_id: lead.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('sent');
      expect(rows[0].recipient).toBe(lead.email);
      expect(rows[0].sent_by).toBe(agent.name);
      expect(rows[0].user_id).toBe(agent.id);
    });
  });

  it('attributes a brokerage send to the brokerage, with no user behind it', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { owner_user_id: null, assigned_to: null });

      const email = stubEmail();
      await sweeper(tx, email.service).sweep();

      const rows = await tx.lead_emails.findMany({ where: { lead_id: lead.id } });
      expect(rows[0].user_id).toBeNull();
      expect(rows[0].sent_by).toBeTruthy();
    });
  });
});

// ============================================================================ the send itself
/**
 * The real `CrmAdvancedEmailService`, with a stub mailer.
 *
 * The block above proves who the sweep picks; this proves what happens when it sends — which
 * template is read, whether the switches are honoured, and which mailbox the message leaves from.
 */
describe('the welcome send', () => {
  /** A mailer that records rather than sends, and the account service that chose the mailbox. */
  function realService(tx: PrismaService, account: { id: number } | null) {
    const sent: { to: string; subject: string; html: string; accountId: number | null }[] = [];
    const mailer = {
      sendDirect: async (to: string, subject: string, html: string, accountId: number | null) => {
        sent.push({ to, subject, html, accountId });
      },
    } as unknown as MailerService;
    const senderFor = jest.fn(async () => account);
    const accounts = { senderFor } as unknown as MailAccountService;
    const service = new CrmAdvancedEmailService(tx, mailer, accounts, new CrmTriggersService(tx, new NotificationPreferenceService(tx)));
    return { service, sent, senderFor };
  }

  /** A CRM mailbox for whoever needs one. */
  async function makeAccount(tx: PrismaService, userId: number | null): Promise<{ id: number }> {
    const now = new Date();
    const t = tag();
    return tx.mail_accounts.create({
      data: {
        name: `Welcome box ${t}`, from_email: `box-${t}@example.test`, host: 'smtp.example.test',
        port: 587, user_id: userId, scope: 'crm', is_active: true, is_default: true,
        created_at: now, updated_at: now,
      },
      select: { id: true },
    });
  }

  const senderFrom = async (tx: PrismaService, lead: { owner_user_id?: number | null }): Promise<WelcomeSender> =>
    sweeper(tx, null as never).senderFor(lead.owner_user_id ?? null, null);

  it('sends the registered wording, addressed to the lead by their first name', async () => {
    await inRollback(async (tx) => {
      await enableWelcome(tx);
      const agent = await makeAgent(tx);
      const account = await makeAccount(tx, agent.id);
      const lead = await makeLead(tx, { owner_user_id: agent.id, name: 'Patricia Okonjo' });

      const { service, sent } = realService(tx, account);
      const out = await service.sendWelcomeEmail(lead, await senderFrom(tx, { owner_user_id: agent.id }));

      expect(out.success).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(lead.email);
      expect(sent[0].subject).toMatch(/^Welcome to /);
      expect(sent[0].html).toContain('Hello Patricia,');     // first name, not the whole name
      expect(sent[0].html).toContain(agent.name);
    });
  });

  it('leaves from the agent\'s own CRM mailbox', async () => {
    await inRollback(async (tx) => {
      await enableWelcome(tx);
      const agent = await makeAgent(tx);
      const account = await makeAccount(tx, agent.id);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const { service, sent, senderFor } = realService(tx, account);
      await service.sendWelcomeEmail(lead, await senderFrom(tx, { owner_user_id: agent.id }));

      // Asked for THIS agent's mailbox, in the CRM — never a Transaction Desk account.
      expect(senderFor).toHaveBeenCalledWith(agent.id, 'crm');
      expect(sent[0].accountId).toBe(account.id);
    });
  });

  it('leaves from the brokerage mailbox when the lead has no agent', async () => {
    await inRollback(async (tx) => {
      await enableWelcome(tx);
      const account = await makeAccount(tx, null);
      const lead = await makeLead(tx, { owner_user_id: null, assigned_to: null });

      const { service, sent, senderFor } = realService(tx, account);
      await service.sendWelcomeEmail(lead, await senderFrom(tx, {}));

      // `null` is the brokerage: `senderFor(null, 'crm')` is the shared CRM account.
      expect(senderFor).toHaveBeenCalledWith(null, 'crm');
      expect(sent[0].accountId).toBe(account.id);
    });
  });

  it('does not send when the template is switched off', async () => {
    await inRollback(async (tx) => {
      await enableWelcome(tx);
      const agent = await makeAgent(tx);
      const account = await makeAccount(tx, agent.id);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      // Seed the row, then switch it off — which is what the Templates screen does.
      const { service, sent } = realService(tx, account);
      await service.sendWelcomeEmail(lead, await senderFrom(tx, { owner_user_id: agent.id }));
      await tx.email_templates.update({ where: { event_key: 'crm.lead_welcome' }, data: { is_active: false } });

      const second = await makeLead(tx, { owner_user_id: agent.id });
      await expect(service.sendWelcomeEmail(second, await senderFrom(tx, { owner_user_id: agent.id })))
        .rejects.toThrow(/switched off/i);
      expect(sent).toHaveLength(1);   // the first one only

      // And the pre-flight reports it, so the sweep skips rather than burning the chance.
      expect(await service.welcomeBlockedReason(agent.id)).toMatch(/switched off/i);
    });
  });

  it('does not send when the trigger is off', async () => {
    await inRollback(async (tx) => {
      await enableWelcome(tx, false);
      const agent = await makeAgent(tx);
      const account = await makeAccount(tx, agent.id);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const { service, sent } = realService(tx, account);
      const out = await service.sendWelcomeEmail(lead, await senderFrom(tx, { owner_user_id: agent.id }));

      expect(out.success).toBe(false);
      expect(sent).toHaveLength(0);
    });
  });

  it('reports the missing mailbox rather than failing silently', async () => {
    await inRollback(async (tx) => {
      await enableWelcome(tx);
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const { service, sent } = realService(tx, null);   // nothing connected

      expect(await service.welcomeBlockedReason(agent.id)).toMatch(/no CRM email account is connected/i);

      const out = await service.sendWelcomeEmail(lead, await senderFrom(tx, { owner_user_id: agent.id }));
      expect(out.success).toBe(false);
      expect(out.message).toMatch(/no CRM email account is connected/i);
      expect(sent).toHaveLength(0);
    });
  });

  it('refuses an address that is not the lead it was told to write to', async () => {
    /*
     * The welcome names its lead instead of searching the caller's scope — see `dispatch`. That is a
     * narrower claim, not a looser one, and this is what makes it narrower: the pair must match.
     */
    await inRollback(async (tx) => {
      await enableWelcome(tx);
      const agent = await makeAgent(tx);
      const account = await makeAccount(tx, agent.id);
      const lead = await makeLead(tx, { owner_user_id: agent.id });

      const { service, sent } = realService(tx, account);
      const out = await service.sendWelcomeEmail(
        { id: lead.id, name: lead.name, email: `somebody-else-${tag()}@example.test` },
        await senderFrom(tx, { owner_user_id: agent.id }),
      );

      expect(out.success).toBe(false);
      expect(sent).toHaveLength(0);
    });
  });
});
