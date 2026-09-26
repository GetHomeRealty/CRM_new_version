import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MetaApiBudgetService } from './meta-api-budget.service';
import { MetaConnectionService } from './meta-connection.service';
import { MetaSyncService } from './meta-sync.service';
import { LeadNotificationService } from '../leads/lead-notification.service';
import { CrmEventNotifier } from '../notifications/crm-events.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { NotificationPreferenceService } from '../notifications/notification-preference.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * ONE FACEBOOK LEAD, ONE EMAIL.
 *
 * WHAT WAS REPORTED. Every lead arriving from Meta produced TWO emails to the same agent.
 *
 * WHY. `upsertLead` calls two notifiers back to back on the same imported row:
 *
 *   notifications.notifyNewLead(row)   → "New lead received from Meta (Facebook / Instagram) — «name»"
 *   metaArrived(row, …) → crmEvents.metaLeadArrived → the `crm.meta_lead_received` template
 *
 * Neither suppressed the other. They are separate preference categories — `lead_new` and
 * `lead_meta` — and both default to `email: 'live'`, so the `shouldSend` guard inside
 * `notifyNewLead` could not see the second one. `metaLeadArrived`'s `dedupeKey` only dedupes the
 * dispatcher against itself, which is why it already caught the webhook/scheduler race and not this.
 *
 * WHY THIS FILE EXISTS ON TOP OF THE UNIT TESTS. `crm-events.spec.ts` asserts that
 * `metaLeadArrived` sends no email, which is the fix but not the property. The property is that ONE
 * IMPORT PRODUCES ONE EMAIL, and only the two notifiers running together can show that — a change
 * that silenced the wrong one, or silenced both, would leave those unit tests green.
 *
 * BOTH NOTIFIERS ARE REAL HERE. Only the Graph call and the mail transport are doubles, so the
 * count below is the number of messages the agent's address would actually have received.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const asUser = (id: number, name: string): AuthUserRecord =>
  ({ id, name, role: 'agent' } as unknown as AuthUserRecord);

async function makeUser(tx: PrismaService): Promise<{ id: number; name: string; email: string }> {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ Meta ${t}`, email: `zz-meta-${t}@probe.test`, username: `zzmeta${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true, email: true },
  });
}

/** A connection with one page and one opted-in form, which is what `syncUser` walks. */
async function connectWithForm(tx: PrismaService, userId: number): Promise<string> {
  const now = new Date();
  const conn = await tx.meta_connections.create({
    data: {
      user_id: userId, access_token: 'plain:tok', facebook_user_id: `fb-${tag()}`,
      is_active: true, connected_at: now, created_at: now, updated_at: now,
    },
  });
  const pageId = `page-${tag()}`;
  await tx.meta_pages.create({
    data: { connection_id: conn.id, page_id: pageId, name: 'Page', access_token: 'plain:pt', created_at: now, updated_at: now },
  });
  const formId = `form-${tag()}`;
  await tx.meta_lead_forms.create({
    data: {
      user_id: userId, page_id: pageId, form_id: formId,
      form_name: 'Spring Buyers', is_active: true, created_at: now, updated_at: now,
    },
  });
  return formId;
}

/*
 * The shared Graph allowance is keyed by time window and written by the running application, so a
 * committed row from anything that synced in this window would refuse our `consume()` for a reason
 * that has nothing to do with this test. Deleted inside the transaction, so it rolls back.
 */
const clearWindow = (tx: PrismaService) => tx.$executeRawUnsafe('DELETE FROM meta_api_budget');

/*
 * WAIT FOR THE NOTIFIERS, BECAUSE `upsertLead` DOES NOT.
 *
 * Both are fired and abandoned — `void this.notifications.notifyNewLead(row)` and
 * `void this.metaArrived(...)` — deliberately, so a mail failure never stops a sync. It means
 * `syncUser` can return before either has finished, and counting emails at that moment is a race:
 * this file's first run showed one email and NO in-app notification, which is the dispatcher chain
 * still in flight rather than anything being wrong.
 *
 * The in-app row is the LAST thing the longer of the two chains writes, so waiting for it is the
 * signal that both have landed. A test that skipped this could report "one email" while the second
 * one was still on its way — the exact defect, passing.
 */
async function settle(tx: PrismaService, userId: number): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    const rows = await tx.notifications.count({ where: { user_id: userId, category: 'lead_meta' } });
    if (rows > 0) return;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  throw new Error('The Meta notification never landed; the notifier chain did not complete.');
}

/** One submission, carrying the fields the mapper reads. */
const graphWith = (leadId: string, email: string) => ({
  formLeads: async () => ({
    leads: [{
      id: leadId,
      created_time: new Date().toISOString(),
      field_data: [
        { name: 'full_name', values: ['Jane Buyer'] },
        { name: 'email', values: [email] },
        { name: 'phone_number', values: ['+1 416 555 0133'] },
      ],
    }],
    truncated: false,
  }),
});

/** Real notifiers, one shared mail transport, so every send lands in `emails`. */
function build(tx: PrismaService, formLeads: unknown) {
  const emails: { to: string; subject: string }[] = [];
  const mailer = {
    sendDirect: async (to: string, subject: string) => { emails.push({ to, subject }); },
  };
  const moduleRef = {
    get: (type: { name: string }) => {
      if (type.name === 'MailerService') return mailer;
      throw new Error('absent');
    },
  };
  const dispatcher = new NotificationDispatcher(tx, new NotificationPreferenceService(tx), moduleRef as never);
  const sync = new MetaSyncService(
    tx,
    new MetaConnectionService(tx, { fetchPages: async () => [] } as never),
    formLeads as never,
    { record: async () => {} } as never,
    new LeadNotificationService(tx, mailer as never, dispatcher),
    new MetaApiBudgetService(tx),
    { reconnectRequired: async () => {} } as never,
    new CrmEventNotifier(dispatcher, tx),
  );
  return { sync, emails };
}

describe('a lead arriving from Meta', () => {
  it('emails the agent ONCE, not twice', async () => {
    await inRollback(async (tx) => {
      await clearWindow(tx);
      const user = await makeUser(tx);
      await connectWithForm(tx, user.id);
      const { sync, emails } = build(tx, graphWith(`lead-${tag()}`, `buyer-${tag()}@probe.test`));

      const result = await sync.syncUser(asUser(user.id, user.name), 'scheduled');
      await settle(tx, user.id);

      expect(result.imported).toBe(1);
      // THE DEFECT: two here, with these two subjects —
      //   "New lead received from Meta (Facebook / Instagram) — Jane Buyer"
      //   "New Facebook lead: Jane Buyer"
      expect(emails).toHaveLength(1);
      expect(emails[0].to).toBe(user.email);
    });
  });

  it('keeps the email that carries the lead’s details', async () => {
    /*
     * WHICH of the two survives is the whole decision, so it is asserted rather than left to the
     * count. `notifyNewLead`'s message holds the phone, property, location and enquiry message; the
     * `crm.meta_lead_received` template has variables for the name and the form only.
     */
    await inRollback(async (tx) => {
      await clearWindow(tx);
      const user = await makeUser(tx);
      await connectWithForm(tx, user.id);
      const { sync, emails } = build(tx, graphWith(`lead-${tag()}`, `buyer-${tag()}@probe.test`));

      await sync.syncUser(asUser(user.id, user.name), 'scheduled');
      await settle(tx, user.id);

      expect(emails[0].subject).toContain('New lead received from Meta');
    });
  });

  it('still records the in-app notification, so nothing was silenced wholesale', async () => {
    // The failure mode this fix could be mistaken for: muting the Meta event entirely.
    await inRollback(async (tx) => {
      await clearWindow(tx);
      const user = await makeUser(tx);
      await connectWithForm(tx, user.id);
      const { sync } = build(tx, graphWith(`lead-${tag()}`, `buyer-${tag()}@probe.test`));

      await sync.syncUser(asUser(user.id, user.name), 'scheduled');
      await settle(tx, user.id);

      expect(await tx.notifications.count({ where: { user_id: user.id, category: 'lead_meta' } })).toBe(1);
    });
  });

  it('an agent who turns the new-lead email off receives nothing at all', async () => {
    /*
     * The preference that now governs the Meta email is `lead_new` — catalogued as "a lead is added
     * to your book, however it arrived". Worth pinning, because before the fix turning it off still
     * left the `lead_meta` copy arriving, which is what made the setting look broken.
     */
    await inRollback(async (tx) => {
      await clearWindow(tx);
      const user = await makeUser(tx);
      await connectWithForm(tx, user.id);
      const { sync, emails } = build(tx, graphWith(`lead-${tag()}`, `buyer-${tag()}@probe.test`));
      await new NotificationPreferenceService(tx).set(user.id, 'lead_new', 'email', false);

      await sync.syncUser(asUser(user.id, user.name), 'scheduled');
      await settle(tx, user.id);

      expect(emails).toHaveLength(0);
    });
  });
});
