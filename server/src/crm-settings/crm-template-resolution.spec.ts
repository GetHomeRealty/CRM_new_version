import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmAdvancedEmailService } from './crm-advanced-email.service';
import { MAIL_EVENTS } from '../email/mail-event-registry';

/**
 * The CRM's own emails read their wording from Settings → Templates.
 *
 * WHAT THIS PROTECTS. Four CRM emails used to carry their text in the service file. They now
 * resolve a row from `email_templates` keyed by event, which is what makes them editable and
 * deactivatable from the Templates screen. Three properties have to hold for that to be true
 * rather than merely intended:
 *
 *   1. the stored template's wording is what actually goes out — not a fallback that quietly wins;
 *   2. switching a template off stops the email, or the toggle is decorative;
 *   3. a missing row seeds itself, so an upgraded brokerage sends the same words as yesterday.
 *
 * NO MAIL LEAVES THIS FILE. `fromTemplate` is exercised directly; `dispatch` — which is what would
 * reach SMTP — is never called.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/** Only `prisma` is used by the resolver; the rest of the service is not on this path. */
const svc = (tx: PrismaService) =>
  new CrmAdvancedEmailService(tx, null as never, null as never, null as never);

/** `fromTemplate` is private — reached the way a test legitimately reaches one. */
const resolve = (s: CrmAdvancedEmailService, key: string, vars: Record<string, unknown>, sig?: string) =>
  (s as unknown as {
    fromTemplate(k: string, v: Record<string, unknown>, sg?: string): Promise<{ subject: string; html: string }>;
  }).fromTemplate(key, vars, sig);

/** The lead-facing CRM emails — the ones this file's resolver renders. */
const CRM_KEYS = [
  'crm.lead_welcome', 'crm.birthday_greeting', 'crm.anniversary_greeting',
  'crm.wedding_congratulations', 'crm.seasonal_wishes',
];

/**
 * The staff-facing CRM notifications. Registered here too, so that adding a key to the CRM module
 * without a sender fails this test rather than reaching the Templates screen as a control over
 * nothing. Their rendering is covered in `notifications/crm-notification-templates.spec.ts`.
 */
const CRM_NOTIFICATION_KEYS = [
  'crm.lead_new', 'crm.lead_assigned', 'crm.lead_task_due', 'crm.meta_lead_received',
  'crm.campaign_completed', 'crm.campaign_failed',
];

describe('CRM templates — registration', () => {
  it('registers exactly the CRM emails that have a sender, all under one module', () => {
    const crm = Object.entries(MAIL_EVENTS).filter(([, m]) => m.module === 'CRM').map(([k]) => k);
    expect(crm.sort()).toEqual([...CRM_KEYS, ...CRM_NOTIFICATION_KEYS].sort());
  });

  it('keeps Transaction Desk events out of the CRM group', () => {
    // The separation is the whole point: Desk keeps its own modules and its own rows.
    for (const key of ['invoice.send', 'transaction.review_decision', 'document.reminder', 'user.onboard_email']) {
      expect(MAIL_EVENTS[key].module).not.toBe('CRM');
    }
  });

  it('every CRM template declares the variables its body uses', () => {
    for (const key of CRM_KEYS) {
      const meta = MAIL_EVENTS[key];
      const used = new Set(
        [...`${meta.default_subject} ${meta.default_body_html}`.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)]
          .map((m) => m[1]),
      );
      for (const v of used) expect(meta.variables).toContain(v);
    }
  });
});

describe('CRM templates — resolution', () => {
  it('seeds the row from the registry on first use, and sends the shipped wording', async () => {
    await inRollback(async (tx) => {
      await tx.email_templates.deleteMany({ where: { event_key: 'crm.birthday_greeting' } });

      const out = await resolve(svc(tx), 'crm.birthday_greeting', { lead_name: 'Priya' });

      expect(out.subject).toBe('Happy Birthday!');
      expect(out.html).toContain('Dear Priya');
      expect(out.html).toContain('very happy birthday');

      // The row now exists and is editable rather than living in the source.
      const row = await tx.email_templates.findUnique({ where: { event_key: 'crm.birthday_greeting' } });
      expect(row).not.toBeNull();
      expect(row!.module).toBe('CRM');
      expect(row!.is_active).toBe(true);
    });
  });

  it('an edited template is what actually goes out', async () => {
    await inRollback(async (tx) => {
      await resolve(svc(tx), 'crm.anniversary_greeting', { lead_name: 'X' });   // seed
      await tx.email_templates.update({
        where: { event_key: 'crm.anniversary_greeting' },
        data: { subject: 'Many happy returns, {{ lead_name }}', body_html: '<p>Bespoke wording for {{ lead_name }}.</p>' },
      });

      const out = await resolve(svc(tx), 'crm.anniversary_greeting', { lead_name: 'Dana' });
      expect(out.subject).toBe('Many happy returns, Dana');
      expect(out.html).toContain('Bespoke wording for Dana.');
      // The wording it replaced must be gone, not merely added to.
      expect(out.html).not.toContain('Happy anniversary!');
    });
  });

  it('switching a template off stops the email', async () => {
    await inRollback(async (tx) => {
      await resolve(svc(tx), 'crm.seasonal_wishes', { lead_name: 'X', season: 'Spring', year: '2026' });
      await tx.email_templates.update({ where: { event_key: 'crm.seasonal_wishes' }, data: { is_active: false } });

      await expect(resolve(svc(tx), 'crm.seasonal_wishes', { lead_name: 'X', season: 'Spring', year: '2026' }))
        .rejects.toThrow(/switched off/i);
    });
  });

  it('escapes a lead name that contains markup', async () => {
    await inRollback(async (tx) => {
      // A lead name is attacker-reachable — a Meta form, a web enquiry and a CSV import all write it.
      const out = await resolve(svc(tx), 'crm.birthday_greeting', { lead_name: '<script>alert(1)</script>' });
      expect(out.html).not.toContain('<script>');
      expect(out.html).toContain('&lt;script&gt;');
    });
  });

  it('reads the wedding date into the sentence, and reads cleanly when there is none', async () => {
    await inRollback(async (tx) => {
      /*
       * Activate it inside the rollback first. This test is about RENDERING — that the date lands
       * in the sentence and that the sentence still reads when there is none — and it was asserting
       * that only for as long as somebody happened to leave the template switched on. Wedding is
       * being retired and is now Off in the development database, which turned a rendering test into
       * a report of an unrelated setting. The deactivation behaviour has its own test above.
       */
      await tx.email_templates.updateMany({
        where: { event_key: 'crm.wedding_congratulations' },
        data: { is_active: true },
      });

      const withDate = await resolve(svc(tx), 'crm.wedding_congratulations', { lead_name: 'Sam', wedding_date: ' on 20 September' });
      expect(withDate.html).toContain('your wedding on 20 September!');

      const without = await resolve(svc(tx), 'crm.wedding_congratulations', { lead_name: 'Sam', wedding_date: '' });
      expect(without.html).toContain('your wedding!');
    });
  });

  it('refuses an event that is not registered rather than sending something empty', async () => {
    await inRollback(async (tx) => {
      await expect(resolve(svc(tx), 'crm.not_a_real_event', {})).rejects.toThrow(/No CRM email is registered/i);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
