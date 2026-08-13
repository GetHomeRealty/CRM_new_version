import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmEventNotifier } from './crm-events.service';
import { MAIL_EVENTS } from '../email/mail-event-registry';
import { NOTIFICATION_CATEGORIES } from './notification-preference.service';

/**
 * The five CRM notifications that reach a STAFF inbox now read their wording from
 * Settings → Templates.
 *
 * WHY A SEPARATE FILE FROM `crm-events.spec.ts`: that one asserts what the notifier DISPATCHES —
 * category, dedupe key, who is skipped. This one asserts what the recipient would READ, and that
 * the Templates screen actually governs it. They fail for different reasons and should.
 *
 * NOTHING HERE SENDS. The dispatcher is a stub that records the request it was handed, so every
 * assertion is about the `email` override and the channel list the notifier produced.
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

/** Records every dispatch request instead of delivering it. */
function recorder() {
  const seen: Record<string, unknown>[] = [];
  return { seen, dispatcher: { dispatch: async (r: Record<string, unknown>) => { seen.push(r); } } as never };
}

async function makeUser(tx: PrismaService, name: string): Promise<{ id: number }> {
  const now = new Date();
  return tx.users.create({
    data: { name, email: `crmtpl-${tag()}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
}

const LEAD = { id: 4242, first_name: 'Priya', last_name: 'Raman', email: 'priya@example.test' };

/** Every CRM staff-notification event this file governs, with a way to trigger each. */
const EVENTS: {
  key: string;
  category: string;
  fire: (n: CrmEventNotifier, userId: number) => Promise<void>;
}[] = [
  {
    key: 'crm.lead_new', category: 'lead_new',
    // `actorUserId` must differ from the recipient — you are not told about a lead you just typed in.
    fire: (n, u) => n.leadCreated({ ...LEAD, source: 'meta' }, u, null),
  },
  {
    key: 'crm.lead_assigned', category: 'lead_assigned',
    fire: (n, u) => n.leadAssigned(LEAD, u, null, 'Sam Whitfield'),
  },
  {
    key: 'crm.lead_task_due', category: 'lead_task_due',
    fire: (n, u) => n.leadTaskDue({ id: 7, title: 'Call back', due_at: new Date('2026-08-20') }, LEAD, u, '2026-08-20'),
  },
  {
    key: 'crm.meta_lead_received', category: 'lead_meta',
    fire: (n, u) => n.metaLeadArrived(LEAD, u, `fb-${tag()}`, 'Spring Campaign'),
  },
  {
    key: 'crm.campaign_completed', category: 'campaign_completed',
    fire: (n, u) => n.campaignCompleted({ id: 9, name: 'August Update' }, u, { recipients: 100, sent: 98, failed: 2 }),
  },
  {
    key: 'crm.campaign_failed', category: 'campaign_failed',
    fire: (n, u) => n.campaignFailed({ id: 9, name: 'August Update' }, u, 'smtp_down', 'ECONNREFUSED 10.0.0.4:587'),
  },
];

describe('CRM notification templates — registration', () => {
  it('registers all five under the CRM module, and only events that really send email', () => {
    for (const { key, category } of EVENTS) {
      expect(MAIL_EVENTS[key]).toBeDefined();
      expect(MAIL_EVENTS[key].module).toBe('CRM');
      // The guard the brief asked for: no template control for an email that does not exist.
      const cat = NOTIFICATION_CATEGORIES.find((c) => c.key === category);
      expect(cat?.channels.email).toBe('live');
    }
  });

  it('leaves Transaction Desk events on their own modules', () => {
    for (const key of ['invoice.send', 'transaction.review_decision', 'document.reminder', 'user.onboard_email']) {
      expect(MAIL_EVENTS[key].module).not.toBe('CRM');
    }
  });

  it('declares every variable each default body uses', () => {
    for (const { key } of EVENTS) {
      const meta = MAIL_EVENTS[key];
      const used = new Set([...`${meta.default_subject} ${meta.default_body_html}`
        .matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1]));
      for (const v of used) expect(meta.variables).toContain(v);
    }
  });

  it('never exposes the technical failure detail to a campaign-failed template', () => {
    // Stack traces and SMTP responses belong in the log, not in an owner's inbox.
    expect(MAIL_EVENTS['crm.campaign_failed'].variables).not.toContain('technical_detail');
    expect(MAIL_EVENTS['crm.campaign_failed'].variables).not.toContain('terminal_state');
  });
});

describe('CRM notification templates — resolution', () => {
  it('seeds a missing row from the registry default and uses it', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'Dana Okafor');
      for (const { key, fire } of EVENTS) {
        await tx.email_templates.deleteMany({ where: { event_key: key } });
        const rec = recorder();
        await fire(new CrmEventNotifier(rec.dispatcher, tx), user.id);

        const row = await tx.email_templates.findUnique({ where: { event_key: key } });
        expect(row).not.toBeNull();
        expect(row!.module).toBe('CRM');
        expect(row!.is_active).toBe(true);

        // And the request carried an email override rendered from that row.
        expect(rec.seen).toHaveLength(1);
        expect((rec.seen[0].email as { subject: string }).subject).toBeTruthy();
      }
    });
  });

  it('uses the EDITED template on the next send, for every event', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'Dana Okafor');
      for (const { key, fire } of EVENTS) {
        await tx.email_templates.deleteMany({ where: { event_key: key } });
        // Seed, then rewrite it the way an administrator would on the Templates screen.
        await fire(new CrmEventNotifier(recorder().dispatcher, tx), user.id);
        await tx.email_templates.update({
          where: { event_key: key },
          data: { subject: `EDITED ${key}`, body_html: '<p>Bespoke wording for {{ user_name }}.</p>' },
        });

        const rec = recorder();
        await fire(new CrmEventNotifier(rec.dispatcher, tx), user.id);
        const email = rec.seen[0].email as { subject: string; html: string };
        expect(email.subject).toBe(`EDITED ${key}`);
        expect(email.html).toBe('<p>Bespoke wording for Dana Okafor.</p>');
      }
    });
  });

  it('carries the right event_key to the right notification category', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'Dana Okafor');
      for (const { key, category, fire } of EVENTS) {
        await tx.email_templates.deleteMany({ where: { event_key: key } });
        await fire(new CrmEventNotifier(recorder().dispatcher, tx), user.id);
        // Editing THIS key must be what changes THIS category's email — the link the brief asks for.
        await tx.email_templates.update({ where: { event_key: key }, data: { subject: `KEYED ${key}` } });

        const rec = recorder();
        await fire(new CrmEventNotifier(rec.dispatcher, tx), user.id);
        expect(rec.seen[0].category).toBe(category);
        expect((rec.seen[0].email as { subject: string }).subject).toBe(`KEYED ${key}`);
      }
    });
  });
});

describe('CRM notification templates — deactivation', () => {
  it('an inactive template stops the email and leaves in-app and push alone', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'Dana Okafor');
      for (const { key, fire } of EVENTS) {
        await tx.email_templates.deleteMany({ where: { event_key: key } });
        await fire(new CrmEventNotifier(recorder().dispatcher, tx), user.id);
        await tx.email_templates.update({ where: { event_key: key }, data: { is_active: false } });

        const rec = recorder();
        await fire(new CrmEventNotifier(rec.dispatcher, tx), user.id);
        const req = rec.seen[0];

        // Email is removed from the delivery set...
        expect(req.channels).toEqual(['in_app', 'push']);
        expect(req.channels).not.toContain('email');
        // ...and no wording is handed over, so nothing could send it by another route.
        expect(req.email).toBeUndefined();
      }
    });
  });
});

describe('CRM notification templates — the separations that must hold', () => {
  it('does not touch campaign_templates — Campaigns → Templates is a different library', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'Dana Okafor');
      const before = await tx.campaign_templates.count();
      for (const { fire } of EVENTS) await fire(new CrmEventNotifier(recorder().dispatcher, tx), user.id);
      expect(await tx.campaign_templates.count()).toBe(before);
    });
  });

  it('creates no Transaction Desk template rows', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'Dana Okafor');
      const deskBefore = await tx.email_templates.count({ where: { module: { not: 'CRM' } } });
      for (const { fire } of EVENTS) await fire(new CrmEventNotifier(recorder().dispatcher, tx), user.id);
      // Only CRM rows may appear; Desk's own rows are seeded by Desk's own sends.
      expect(await tx.email_templates.count({ where: { module: { not: 'CRM' } } })).toBe(deskBefore);
    });
  });

  it('a template failure never stops the notification', async () => {
    // No database at all. The in-app record is what somebody is waiting on; a template lookup that
    // cannot run must fall back to the dispatcher's default body, not lose the message.
    const rec = recorder();
    const notifier = new CrmEventNotifier(rec.dispatcher, null as never);
    await expect(notifier.leadAssigned(LEAD, 1, null, 'A')).resolves.toBeUndefined();
    expect(rec.seen).toHaveLength(1);
    expect(rec.seen[0].email).toBeUndefined();      // fell back
    expect(rec.seen[0].channels).toBeUndefined();   // and did not silence anything
  });
});

afterAll(async () => { await prisma.$disconnect(); });
