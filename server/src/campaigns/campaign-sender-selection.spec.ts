import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';
import { MailAccountService } from '../email/mail-account.service';

/**
 * WHICH MAILBOX A CAMPAIGN SENDS FROM — chosen, honoured, and written down.
 *
 * WHAT WAS WRONG. The sender was resolved at delivery and discarded. Three consequences, all of
 * them silent:
 *
 *   NOBODY COULD CHOOSE IT. `resolveSenderInArea` walked a chain — your default account, any
 *   account of yours, the brokerage mailbox, and finally ANY active account in id order, which is
 *   a colleague's. That last step is a recorded incident, not a hypothetical: clients received mail
 *   "sent through Veena", and nobody had picked that.
 *
 *   A SCHEDULED CAMPAIGN RE-RESOLVED IT AT DISPATCH. The confirmation dialog named an address days
 *   before a background sweep with no user session asked the same question again and could get a
 *   different answer. The campaign then went out from an address nobody had been shown.
 *
 *   AND AFTERWARDS THERE WAS NO RECORD. "Which address did these four hundred clients see?" had no
 *   answer in the database at all, so nothing above could even be detected after the fact.
 *
 * NO GLOBAL SWEEP IS RUN FROM THIS FILE, and the scheduled fixtures here are dated in the FUTURE.
 * `dispatchDue` sends every campaign the shared test database happens to have due, so two spec
 * files calling it in parallel workers steal each other's fixtures — which is exactly what happened
 * when this file first ran in a full suite: it took `schedule-and-recovery`'s campaigns and that
 * file took its. `dispatchScheduled(id)` claims ONE campaign by id and does not consult the date,
 * so a future-dated row is reachable here and invisible to anybody else's sweep. The sweep itself
 * is tested in `schedule-and-recovery.spec.ts`, which owns it.
 *
 * REAL ROWS, not the rolled-back fixture. `CampaignsService` commits counter updates with
 * `prisma.$transaction([...])`, which an interactive transaction client does not expose, so inside
 * one the delivery paths throw and are swallowed and everything appears not to send — the same trap
 * documented in `schedule-and-recovery.spec.ts`. Everything created is prefixed `ZZSENDER` and
 * removed in a `finally`.
 */

const prisma = new PrismaClient();
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

/** Two arbitrary user ids. `campaigns.created_by_id` and `mail_accounts.user_id` carry no FK. */
const ME = 90_001;
const COLLEAGUE = 90_002;

afterAll(async () => { await prisma.$disconnect(); });

async function withCleanup(fn: (db: PrismaService) => Promise<void>) {
  try {
    await fn(prisma as unknown as PrismaService);
  } finally {
    const rows = await prisma.campaigns.findMany({ where: { name: { startsWith: 'ZZSENDER' } }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await prisma.campaign_recipients.deleteMany({ where: { campaign_id: { in: ids } } }).catch(() => undefined);
      await prisma.campaign_links.deleteMany({ where: { campaign_id: { in: ids } } }).catch(() => undefined);
      await prisma.campaigns.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
    await prisma.mail_accounts.deleteMany({ where: { name: { startsWith: 'ZZSENDER' } } }).catch(() => undefined);
  }
}

/** What the mailer was asked to do, rather than whether it was asked. */
interface Spy {
  /** One entry per message, naming the account it was sent from. */
  sent: { from: string | null; to: string }[];
  /** How many times the automatic chain was consulted. Zero is the assertion for a chosen sender. */
  resolved: number;
}

function services(db: PrismaService, spy: Spy, auto = 'auto@test.local') {
  const audience = new CampaignAudienceService(db);
  const campaigns = new CampaignsService(
    db, audience, new CampaignTemplatesService(db, audience),
    { domainCanReceiveMail: async () => true } as never,
    {
      resolveSenderInArea: async () => {
        spy.resolved += 1;
        return { id: -1, from_email: auto };
      },
      sendFromAccount: async (account: { from_email?: string | null }, o: { to: string[] }) => {
        spy.sent.push({ from: account?.from_email ?? null, to: o.to[0] });
        return { messageId: 'x' };
      },
      sendDirect: async () => undefined,
    } as never,
  );
  return { campaigns };
}

async function account(db: PrismaService, over: Record<string, unknown> = {}) {
  const t = tag();
  return db.mail_accounts.create({
    data: {
      name: `ZZSENDER ${t}`,
      from_email: `zz-sender-${t}@probe.test`,
      host: 'smtp.gmail.com', port: 587, is_active: true, is_default: false,
      user_id: ME, scope: null, created_at: new Date(), updated_at: new Date(),
      ...over,
    },
  });
}

async function campaignWith(db: PrismaService, over: Record<string, unknown> = {}, recipients = 1) {
  const now = new Date();
  const t = tag();
  const campaign = await db.campaigns.create({
    data: {
      name: `ZZSENDER ${t}`, subject: 'S', content: '<p>Hi</p>',
      created_by: 'ZZ Prober', created_by_id: ME, tracking_base_url: 'https://crm.test',
      /*
       * 'draft', NOT 'sending', and that is about other spec files rather than this one.
       * `CampaignResumeService.resumeAll` adopts EVERY campaign in the database whose status is
       * 'sending' — it is the restart-recovery sweep — so a fixture left in that state while this
       * test runs can be picked up and delivered by a parallel worker running
       * `schedule-and-recovery.spec.ts`, which then spends this campaign's send delay inside its
       * own 60-second timeout. `deliver` writes the final status unconditionally when it finishes,
       * so starting as a draft changes nothing this file asserts and makes the fixture invisible
       * to that sweep.
       */
      status: 'draft', total: recipients, sent: 0, failed: 0,
      created_at: now, updated_at: now, ...over,
    },
  });
  const rows = [];
  for (let i = 0; i < recipients; i += 1) {
    rows.push(await db.campaign_recipients.create({
      data: {
        campaign_id: campaign.id, email: `zz-send-${t}-${i}@probe.test`, name: `Probe ${i}`,
        token: `tok-send-${t}-${i}`, status: 'pending', created_at: now, updated_at: now,
      },
    }));
  }
  return { campaign, rows };
}

/** Drive the one path every send reaches, as `createAndSend` and `resume` both do. */
function deliverJob(
  campaign: { id: number; name: string },
  rows: { id: number; email: string; name: string | null; token: string }[],
  senderAccountId: number | null,
) {
  return {
    campaignId: campaign.id,
    name: campaign.name,
    recipients: rows.map((r) => ({ leadId: null, name: r.name ?? '', email: r.email, vars: {} })),
    rows: rows.map((r) => ({ id: r.id, retry_count: 0 })),
    tokens: rows.map((r) => r.token),
    template: { subject: 'S', content: '<p>Hi</p>' },
    agentVars: {},
    attachments: [],
    baseUrl: 'https://crm.test',
    userId: ME,
    senderAccountId,
  };
}

const run = (svc: CampaignsService, job: unknown): Promise<void> =>
  (svc as unknown as { deliver: (j: unknown) => Promise<void> }).deliver(job);

const me = { id: ME, name: 'ZZ Prober', role: 'agent' } as unknown as AuthUserRecord;

// =====================================================================================
describe('which mailboxes a person may send a campaign from', () => {
  it('OFFERS THEIR OWN ACCOUNTS AND THE BROKERAGE ONES, and not a colleague\'s', async () => {
    /*
     * THE BOUNDARY IS THE SECURITY PROPERTY. `senderFor` can already land on a colleague's mailbox
     * as a last resort, which is a bug. Putting one in a dropdown would make sending as another
     * agent a FEATURE — a different and worse thing — so the list is asserted by what it omits.
     */
    await withCleanup(async (db) => {
      const mine = await account(db, { user_id: ME });
      const shared = await account(db, { user_id: null });
      const theirs = await account(db, { user_id: COLLEAGUE });
      const inactive = await account(db, { user_id: ME, is_active: false });

      const offered = await new MailAccountService(db, null as never).sendersForCrm(ME);
      const ids = offered.map((a) => a.id);

      expect(ids).toContain(mine.id);
      expect(ids).toContain(shared.id);
      expect(ids).not.toContain(theirs.id);
      // A deactivated mailbox cannot send, so offering it would be offering a failure.
      expect(ids).not.toContain(inactive.id);
    });
  }, 60000);

  it('the clause that builds the list is the clause that authorises an id', async () => {
    // One definition, so the picker cannot offer something the endpoint refuses, or accept
    // something it never offered. A dropdown is not an access control.
    const where = MailAccountService.crmSenderWhere(ME);
    expect(where.is_active).toBe(true);
    expect(where.OR).toEqual([{ user_id: null }, { user_id: ME }]);
    // No user at all (a system send) leaves the shared accounts, not everything.
    expect(MailAccountService.crmSenderWhere(null).OR).toEqual([{ user_id: null }]);
  });
});

// =====================================================================================
describe('a chosen sender is the one that sends', () => {
  it('SENDS FROM THE CHOSEN ACCOUNT, and does not consult the automatic chain at all', async () => {
    await withCleanup(async (db) => {
      const chosen = await account(db, { user_id: ME });
      const { campaign, rows } = await campaignWith(db, { sender_account_id: chosen.id });
      const spy: Spy = { sent: [], resolved: 0 };

      await run(services(db, spy).campaigns, deliverJob(campaign, rows, chosen.id));

      expect(spy.sent.map((m) => m.from)).toEqual([chosen.from_email]);
      /*
       * ZERO, not "the chain happened to agree". The chain's answer depends on what else is
       * connected, so a test that only compared addresses would pass by coincidence on a machine
       * with one mailbox and say nothing about the behaviour being asserted.
       */
      expect(spy.resolved).toBe(0);
    });
  }, 60000);

  it('resolves automatically when nothing was chosen — the behaviour that already existed', async () => {
    await withCleanup(async (db) => {
      const { campaign, rows } = await campaignWith(db);
      const spy: Spy = { sent: [], resolved: 0 };

      await run(services(db, spy, 'auto@test.local').campaigns, deliverJob(campaign, rows, null));

      expect(spy.sent.map((m) => m.from)).toEqual(['auto@test.local']);
      expect(spy.resolved).toBe(1);
    });
  }, 60000);

  it('REFUSES THE WHOLE SEND when the chosen account has been deactivated', async () => {
    /*
     * NOT A FALLBACK. Somebody who chose an address has said which one matters; sending from
     * another because theirs was unavailable is the exact failure this feature exists to prevent.
     * Refused before the first message, so nobody receives a campaign from an unexpected sender.
     */
    await withCleanup(async (db) => {
      const chosen = await account(db, { user_id: ME });
      const { campaign, rows } = await campaignWith(db, { sender_account_id: chosen.id });
      await db.mail_accounts.update({ where: { id: chosen.id }, data: { is_active: false } });
      const spy: Spy = { sent: [], resolved: 0 };

      await expect(run(services(db, spy).campaigns, deliverJob(campaign, rows, chosen.id)))
        .rejects.toThrow(/no longer connected|deactivated/i);

      expect(spy.sent).toHaveLength(0);
      expect(spy.resolved).toBe(0);
      // `failed`, not `partial`: nobody received it, and the two words mean different things to
      // whoever reads the campaign list.
      const after = await db.campaigns.findUnique({ where: { id: campaign.id }, select: { status: true } });
      expect(after?.status).toBe('failed');
    });
  }, 60000);

  it('refuses an account belonging to somebody else, even though it exists and is active', async () => {
    await withCleanup(async (db) => {
      const theirs = await account(db, { user_id: COLLEAGUE });
      const { campaign, rows } = await campaignWith(db, { sender_account_id: theirs.id });
      const spy: Spy = { sent: [], resolved: 0 };

      await expect(run(services(db, spy).campaigns, deliverJob(campaign, rows, theirs.id)))
        .rejects.toThrow(/no longer connected|deactivated/i);
      expect(spy.sent).toHaveLength(0);
    });
  }, 60000);

  it('a refused send leaves the campaign claimable, rather than locked as "already delivering"', async () => {
    /*
     * The in-process `delivering` set is released by the `finally` of a try the refusal is raised
     * ABOVE. Were it raised inside, the claim would never be released and every later attempt to
     * send this campaign would be skipped as a duplicate for the life of the process — a campaign
     * that can never be sent again, with nothing on screen to say why.
     */
    await withCleanup(async (db) => {
      const chosen = await account(db, { user_id: ME, is_active: false });
      const { campaign, rows } = await campaignWith(db, { sender_account_id: chosen.id });
      const spy: Spy = { sent: [], resolved: 0 };
      const svc = services(db, spy).campaigns;

      await expect(run(svc, deliverJob(campaign, rows, chosen.id))).rejects.toThrow();

      // Reinstate the mailbox; the same campaign must now send rather than be skipped.
      await db.mail_accounts.update({ where: { id: chosen.id }, data: { is_active: true } });
      await run(svc, deliverJob(campaign, rows, chosen.id));
      expect(spy.sent).toHaveLength(1);
    });
  }, 60000);
});

// =====================================================================================
describe('a scheduled campaign keeps the sender it was given', () => {
  it('DISPATCHES FROM THE STORED ACCOUNT, not from whatever resolution answers that day', async () => {
    /*
     * The requirement in one test. `dispatchScheduled` runs in a background sweep with no user
     * session, days after the campaign was confirmed. Before the column existed it called
     * `resolveSenderInArea` again — so the address shown at scheduling time was a guess about the
     * future, and the campaign could leave from a mailbox nobody had been shown.
     */
    await withCleanup(async (db) => {
      const chosen = await account(db, { user_id: ME });
      const { campaign } = await campaignWith(db, {
        status: 'scheduled',
        // FUTURE — see the file header. `dispatchScheduled` claims by id regardless of the date.
        scheduled_for: new Date(Date.now() + 60 * 60 * 1000),
        sender_account_id: chosen.id,
      });
      const spy: Spy = { sent: [], resolved: 0 };

      const dispatched = await services(db, spy).campaigns.dispatchScheduled(campaign.id);

      expect(dispatched).toBe(true);
      expect(spy.sent.map((m) => m.from)).toEqual([chosen.from_email]);
      expect(spy.resolved).toBe(0);
      expect((await db.campaigns.findUnique({ where: { id: campaign.id }, select: { status: true } }))?.status)
        .not.toBe('scheduled');
    });
  }, 60000);

  it('VERIFIES THE ACCOUNT BEFORE SENDING, and the refusal is not relabelled as half-delivered', async () => {
    /*
     * Two things at once, because they are one outcome. The sweep's own catch used to overwrite
     * every failure with `partial` — "some of them got it" — which for a send refused before the
     * first message is simply false.
     */
    await withCleanup(async (db) => {
      const chosen = await account(db, { user_id: ME });
      const { campaign, rows } = await campaignWith(db, {
        status: 'scheduled',
        scheduled_for: new Date(Date.now() + 60 * 60 * 1000),
        sender_account_id: chosen.id,
      });
      // Disconnected between scheduling and dispatch — the case the verification is for.
      await db.mail_accounts.delete({ where: { id: chosen.id } });
      const spy: Spy = { sent: [], resolved: 0 };

      await expect(services(db, spy).campaigns.dispatchScheduled(campaign.id))
        .rejects.toThrow(/no longer connected|deactivated/i);

      expect(spy.sent.map((m) => m.to)).not.toContain(rows[0].email);
      /*
       * `failed`, and it stays that way. That the SWEEP does not then relabel this as `partial` is
       * asserted in `schedule-and-recovery.spec.ts`, which owns the sweep — see this file's header.
       */
      const after = await db.campaigns.findUnique({ where: { id: campaign.id }, select: { status: true } });
      expect(after?.status).toBe('failed');
    });
  }, 60000);

  it('a scheduled campaign with no chosen sender still resolves one, as it always did', async () => {
    await withCleanup(async (db) => {
      const { campaign } = await campaignWith(db, { status: 'scheduled', scheduled_for: new Date(Date.now() + 60 * 60 * 1000) });
      const spy: Spy = { sent: [], resolved: 0 };

      await services(db, spy, 'auto@test.local').campaigns.dispatchScheduled(campaign.id);

      expect(spy.sent.map((m) => m.from)).toEqual(['auto@test.local']);
    });
  }, 60000);
});

// =====================================================================================
describe('the address a campaign sent from is recorded', () => {
  it('STAMPS THE ADDRESS ON THE CAMPAIGN, for a chosen sender and for an automatic one', async () => {
    await withCleanup(async (db) => {
      const chosen = await account(db, { user_id: ME });
      const picked = await campaignWith(db, { sender_account_id: chosen.id });
      const automatic = await campaignWith(db);
      const spy: Spy = { sent: [], resolved: 0 };
      const svc = services(db, spy, 'auto@test.local').campaigns;

      await run(svc, deliverJob(picked.campaign, picked.rows, chosen.id));
      await run(svc, deliverJob(automatic.campaign, automatic.rows, null));

      const read = async (id: number) =>
        (await db.campaigns.findUnique({ where: { id }, select: { sender_email: true } }))?.sender_email;
      expect(await read(picked.campaign.id)).toBe(chosen.from_email);
      // Recorded for automatic sends too — those are the ones where nobody knew the answer.
      expect(await read(automatic.campaign.id)).toBe('auto@test.local');
    });
  }, 60000);

  it('DOES NOT OVERWRITE IT when a resume resolves a different address', async () => {
    /*
     * A half-sent campaign's FIRST address is the honest answer to "what did these people see".
     * A resume that picks up a different automatic sender must not rewrite history to claim the
     * whole campaign came from the second one.
     */
    await withCleanup(async (db) => {
      const { campaign, rows } = await campaignWith(db, {}, 2);
      const first: Spy = { sent: [], resolved: 0 };
      await run(services(db, first, 'first@test.local').campaigns, deliverJob(campaign, rows.slice(0, 1), null));

      const second: Spy = { sent: [], resolved: 0 };
      await run(services(db, second, 'second@test.local').campaigns, deliverJob(campaign, rows.slice(1), null));

      const after = await db.campaigns.findUnique({ where: { id: campaign.id }, select: { sender_email: true } });
      expect(after?.sender_email).toBe('first@test.local');
    });
  }, 60000);

  it('REPORTS IT ON THE CAMPAIGN, which is what the sent-email popup reads', async () => {
    await withCleanup(async (db) => {
      const chosen = await account(db, { user_id: ME });
      const { campaign, rows } = await campaignWith(db, { sender_account_id: chosen.id });
      const spy: Spy = { sent: [], resolved: 0 };
      const svc = services(db, spy).campaigns;
      await run(svc, deliverJob(campaign, rows, chosen.id));

      const detail = await svc.get(campaign.id, me);

      expect(detail.sender_email).toBe(chosen.from_email);
      expect(detail.sender_account_id).toBe(chosen.id);
      // And the recipient rows the popup lists, with the three fields it shows.
      const list = detail.recipients as { name: string | null; email: string; status: string }[];
      expect(list).toHaveLength(1);
      expect(list[0].email).toBe(rows[0].email);
      expect(list[0].name).toBe(rows[0].name);
      expect(list[0].status).toBe('sent');
    });
  }, 60000);

  it('says nothing rather than guessing for a campaign sent before this was recorded', async () => {
    // Null is the honest answer: the sender was resolved and discarded, so there is none to give.
    await withCleanup(async (db) => {
      const { campaign } = await campaignWith(db, { status: 'completed', sender_email: null });
      const detail = await services(db, { sent: [], resolved: 0 }).campaigns.get(campaign.id, me);
      expect(detail.sender_email).toBeNull();
    });
  }, 60000);
});

// =====================================================================================
describe('recipient details stay with the person whose campaign it is', () => {
  it('ANOTHER USER CANNOT READ THE RECIPIENTS, or learn the campaign exists', async () => {
    /*
     * Unchanged by this work and asserted because of it: the sender fields ride on the same
     * response as every recipient's name and email address, so widening that response — or
     * forgetting that `ownerScope` is what narrows it — would disclose a colleague's client list.
     * "Not found" rather than "not yours", so the error cannot be used to enumerate campaigns.
     */
    await withCleanup(async (db) => {
      const { campaign } = await campaignWith(db, { created_by_id: ME });
      const svc = services(db, { sent: [], resolved: 0 }).campaigns;
      const other = { id: COLLEAGUE, name: 'ZZ Other', role: 'admin' } as unknown as AuthUserRecord;

      await expect(svc.get(campaign.id, other)).rejects.toThrow(/not found/i);
      // Including an admin — this module scopes by creator for every role.
      const theirList = await svc.list(other);
      expect(theirList.map((c) => c.id)).not.toContain(campaign.id);
    });
  }, 60000);
});
