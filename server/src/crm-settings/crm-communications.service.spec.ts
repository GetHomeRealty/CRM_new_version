import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmCommunicationsService } from './crm-communications.service';
import { CrmTriggersService } from './crm-triggers.service';
import { CrmSettingsService } from './crm-settings.service';
import { PermissionService } from '../auth/permission.service';
import { NotificationPreferenceService } from '../notifications/notification-preference.service';
import { ACTIVE_CRM_COMMUNICATIONS } from './crm-communications.registry';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM → Settings → Communications, at the service level.
 *
 * THE PROPERTY THAT MATTERS MOST is isolation: one person's switch must never move another's.
 * These preferences decide whether email reaches a client, so a leak between accounts is not a
 * cosmetic bug — it is somebody's instruction being applied to somebody else.
 *
 * READS FOLLOW THE CURRENT OWNER. Greetings still live in `crm_trigger_settings` until the
 * migration runs, so that is what these tests assert against. When the send path switches, the
 * greeting expectations move to `notification_preferences` and these tests are what prove the move
 * preserved everybody's answers.
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

/*
 * `CrmSettingsService` is constructed with no mailer and no mail accounts, because the only method
 * this service calls on it is `brokerageToggles()`, which reads one row and nothing else. Passing
 * real ones would mean this suite could send mail, which is the last thing a preference test should
 * be able to do by accident.
 *
 * `PermissionService` takes no arguments and falls back to its compiled role defaults when no store
 * has been attached — see its own comment — so it answers `settings: edit` here exactly as it does
 * in the running application for a role with no database override.
 */
const svc = (tx: PrismaService) =>
  new CrmCommunicationsService(
    tx,
    new NotificationPreferenceService(tx),
    new CrmTriggersService(tx, new NotificationPreferenceService(tx)),
    new CrmSettingsService(tx, null as never, null as never),
    new PermissionService(),
  );

async function makeUser(tx: PrismaService, role: string): Promise<AuthUserRecord> {
  const now = new Date();
  const u = await tx.users.create({
    data: { name: `Comms ${role} ${tag()}`, email: `comms-${tag()}@example.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u as unknown as AuthUserRecord;
}

const commRow = (overview: Record<string, unknown>, key: string) =>
  (overview.communications as { key: string; preferences: Record<string, boolean>; template: unknown; channels: Record<string, boolean> }[])
    .find((c) => c.key === key)!;

describe('CRM Communications — the list', () => {
  it('offers the twelve automated communications and the three manual ones, and no retired one', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const o = await svc(tx).overview(agent);
      const keys = (o.communications as { key: string }[]).map((c) => c.key);
      expect(keys.sort()).toEqual(ACTIVE_CRM_COMMUNICATIONS.map((c) => c.key).sort());
      expect(keys).not.toContain('wedding');
      expect(keys).toHaveLength(15);
    });
  });

  it('offers only the channels each communication actually has', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const o = await svc(tx).overview(agent);
      // A client has no in-app inbox, so a lead-facing communication offers email alone.
      expect(commRow(o, 'birthday').channels).toEqual({ email: true, in_app: false, push: false });
      expect(Object.keys(commRow(o, 'birthday').preferences)).toEqual(['email']);
      // A staff notification offers all three.
      expect(commRow(o, 'lead_assigned').channels).toEqual({ email: true, in_app: true, push: true });
      expect(Object.keys(commRow(o, 'lead_assigned').preferences).sort()).toEqual(['email', 'in_app', 'push']);
      // A manual email needs one switch and nothing else.
      expect(Object.keys(commRow(o, 'custom').preferences)).toEqual(['email']);
    });
  });

  it('tells an agent they may not edit, and an administrator that they may', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const admin = await makeUser(tx, 'admin');
      const asAgent = await svc(tx).overview(agent);
      const asAdmin = await svc(tx).overview(admin);

      expect(asAgent.is_admin).toBe(false);
      expect((asAgent.brokerage as { can_edit: boolean }).can_edit).toBe(false);
      expect(asAdmin.is_admin).toBe(true);
      expect((asAdmin.brokerage as { can_edit: boolean }).can_edit).toBe(true);

      const t = commRow(asAgent, 'lead_new').template as { can_edit: boolean } | null;
      if (t) expect(t.can_edit).toBe(false);
    });
  });

  it('reports the brokerage master switch rather than inventing a second one', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const row = await tx.crm_email_settings.findFirst({ orderBy: { id: 'asc' } });
      const o = await svc(tx).overview(admin);
      expect((o.brokerage as { auto_send_enabled: boolean }).auto_send_enabled).toBe(row?.auto_send_enabled ?? true);
    });
  });
});

describe('CRM Communications — preference isolation', () => {
  /*
   * These compare against what the other person had BEFORE, rather than against `true`.
   *
   * A communication nobody has set inherits the brokerage default, and those are not all `true` —
   * `birthday` and `anniversary` default to OFF on purpose, so that a deployment does not begin
   * emailing a brokerage's whole book on a timer nobody chose. Asserting a literal would have been
   * asserting that default rather than the isolation this test is named for, and would break the
   * day somebody changed it. The property is: A's write moves A and nobody else.
   */
  it('Agent A turning Birthday off does not touch Agent B or an admin', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      const b = await makeUser(tx, 'agent');
      const admin = await makeUser(tx, 'admin');
      const s = svc(tx);

      const bBefore = commRow(await s.overview(b), 'birthday').preferences.email;
      const adminBefore = commRow(await s.overview(admin), 'birthday').preferences.email;

      await s.setPreference(a, 'birthday', 'email', false);

      expect(commRow(await s.overview(a), 'birthday').preferences.email).toBe(false);
      expect(commRow(await s.overview(b), 'birthday').preferences.email).toBe(bBefore);
      expect(commRow(await s.overview(admin), 'birthday').preferences.email).toBe(adminBefore);
    });
  });

  it('Agent A turning it back on resumes for A only', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      const b = await makeUser(tx, 'agent');
      const s = svc(tx);

      const bBefore = commRow(await s.overview(b), 'birthday').preferences.email;

      await s.setPreference(a, 'birthday', 'email', false);
      await s.setPreference(a, 'birthday', 'email', true);

      // A explicitly ON — which is a real choice, not the inherited default.
      expect(commRow(await s.overview(a), 'birthday').preferences.email).toBe(true);
      expect(commRow(await s.overview(b), 'birthday').preferences.email).toBe(bBefore);
    });
  });

  it('turning Lead Assigned EMAIL off leaves that person\'s in-app and push alone', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      const s = svc(tx);

      await s.setPreference(a, 'lead_assigned', 'email', false);
      const prefs = commRow(await s.overview(a), 'lead_assigned').preferences;

      expect(prefs.email).toBe(false);
      expect(prefs.in_app).toBe(true);   // independent channels, independently chosen
      expect(prefs.push).toBe(true);
    });
  });

  it('setting one communication does not disturb another', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      const s = svc(tx);

      const anniversaryBefore = commRow(await s.overview(a), 'anniversary').preferences.email;

      await s.setPreference(a, 'birthday', 'email', false);
      await s.setPreference(a, 'seasonal', 'email', false);
      await s.setPreference(a, 'seasonal', 'email', true);

      const o = await s.overview(a);
      // All three share one JSON column; a write that replaced rather than merged would have
      // cleared the earlier ones. Anniversary was never set here and must be exactly as it was.
      expect(commRow(o, 'birthday').preferences.email).toBe(false);
      expect(commRow(o, 'seasonal').preferences.email).toBe(true);
      expect(commRow(o, 'anniversary').preferences.email).toBe(anniversaryBefore);
    });
  });

  it('refuses a channel a communication does not have, and an unknown communication', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      const s = svc(tx);
      await expect(s.setPreference(a, 'birthday', 'push', false)).rejects.toThrow(/cannot be delivered by push/i);
      await expect(s.setPreference(a, 'wedding', 'email', false)).rejects.toThrow(/Unknown CRM communication/i);
      await expect(s.setPreference(a, 'nope', 'email', false)).rejects.toThrow(/Unknown CRM communication/i);
    });
  });

  /**
   * The migrated greetings write to `notification_preferences`, and the send path reads them there.
   *
   * WHAT THIS REPLACES. It asserted the opposite — that a greeting written here landed in
   * `crm_trigger_settings`, because that was still the store the send path consulted. The migration
   * has run; this is the same property stated against the store that now governs sending. Written
   * as "the switch and the send agree" rather than "a row exists", because a row in the right table
   * that the sender does not consult is the failure mode worth catching.
   */
  it('writes a migrated greeting to notification_preferences, and the send path reads it there', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      await svc(tx).setPreference(a, 'birthday', 'email', false);

      const row = await tx.notification_preferences.findUnique({
        where: { user_id_category_channel: { user_id: a.id!, category: 'crm_birthday', channel: 'email' } },
      });
      expect(row?.enabled).toBe(false);

      // Nothing was written to the old store — a second answer there could only ever disagree.
      const legacy = await tx.crm_trigger_settings.findUnique({ where: { user_id: a.id! } });
      expect(legacy).toBeNull();

      // And the sender agrees, because `isEnabledFor` is what both this screen and the sweep ask.
      const triggers = new CrmTriggersService(tx, new NotificationPreferenceService(tx));
      expect(await triggers.isEnabledFor(a, 'birthday')).toBe(false);
    });
  });

  /**
   * Absence still means the brokerage default, not "on".
   *
   * The single most dangerous thing about moving these three: `NotificationPreferenceService`
   * answers TRUE when no row exists, because failing open is right for a staff notification.
   * Birthday, Anniversary and Seasonal default to OFF precisely because they fire on a timer with
   * nobody watching, so inheriting that fail-open would have turned the migration into an event
   * that began emailing every brokerage's whole book. `storedChoice` is what keeps them apart.
   */
  it('an agent who has never chosen still inherits the brokerage default, not a fail-open true', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      const triggers = new CrmTriggersService(tx, new NotificationPreferenceService(tx));

      const brokerageDefault = await triggers.brokerageDefaultFor('birthday');
      expect(await triggers.isEnabledFor(a, 'birthday')).toBe(brokerageDefault);
      // The screen shows the same answer the sender would give — not `channelsFor`'s optimistic one.
      expect(commRow(await svc(tx).overview(a), 'birthday').preferences.email).toBe(brokerageDefault);
    });
  });

  /**
   * Welcome and the manual emails still write to `crm_trigger_settings`.
   *
   * The counterpart to the greeting test above: the migration moved three rows and no more, and
   * this is what proves the other four were not swept along with them. Welcome in particular is a
   * lead-facing automated email like the greetings, so nothing about its shape would have stopped
   * it moving by accident.
   */
  it('keeps Welcome and the manual emails in crm_trigger_settings', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      const s = svc(tx);

      await s.setPreference(a, 'welcome', 'email', false);
      await s.setPreference(a, 'custom', 'email', false);

      const row = await tx.crm_trigger_settings.findUnique({ where: { user_id: a.id! } });
      const stored = JSON.parse(row!.template_toggles!);
      expect(stored.welcome).toBe(false);
      expect(stored.custom).toBe(false);

      // Nothing leaked into the notification table for either of them.
      const leaked = await tx.notification_preferences.findMany({
        where: { user_id: a.id!, category: { in: ['crm_welcome', 'crm_custom'] } },
      });
      expect(leaked).toHaveLength(0);

      expect(commRow(await s.overview(a), 'welcome').preferences.email).toBe(false);
      expect(commRow(await s.overview(a), 'custom').preferences.email).toBe(false);
    });
  });

  /**
   * Setting one switch must not clear the others in the same row.
   *
   * `crm_trigger_settings` holds all four remaining keys in one JSON column, so a write that
   * rebuilt the object rather than merging into it would silently reset whatever the caller did not
   * mention. That is T-H3 from the CRM › Triggers audit, and it is worth a test now that a single
   * toggle on a screen full of toggles is the only way these are ever written.
   */
  it('setting one crm_trigger_settings switch leaves the others alone', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      const s = svc(tx);

      await s.setPreference(a, 'welcome', 'email', false);
      await s.setPreference(a, 'referral', 'email', false);
      await s.setPreference(a, 'custom', 'email', true);

      const stored = JSON.parse((await tx.crm_trigger_settings.findUnique({ where: { user_id: a.id! } }))!.template_toggles!);
      expect(stored).toMatchObject({ welcome: false, referral: false, custom: true });
    });
  });
});

/**
 * The brokerage controls, moved here from the retired CRM Triggers screen.
 *
 * Two properties matter and they pull in opposite directions: an administrator must be able to set
 * them from this screen, and an agent must not be able to set them from anywhere.
 */
describe('CRM Communications — brokerage controls', () => {
  it('an administrator can turn the master switch off and on', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const s = svc(tx);

      await s.setBrokerage(admin, { auto_send_enabled: false });
      expect((await tx.crm_email_settings.findFirst({ orderBy: { id: 'asc' } }))!.auto_send_enabled).toBe(false);
      expect(((await s.overview(admin)).brokerage as { auto_send_enabled: boolean }).auto_send_enabled).toBe(false);

      await s.setBrokerage(admin, { auto_send_enabled: true });
      expect(((await s.overview(admin)).brokerage as { auto_send_enabled: boolean }).auto_send_enabled).toBe(true);
    });
  });

  it('an administrator can change a brokerage default, and a colleague inherits it', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const agent = await makeUser(tx, 'agent');
      const s = svc(tx);
      const triggers = new CrmTriggersService(tx, new NotificationPreferenceService(tx));

      await s.setBrokerage(admin, { defaults: { birthday: true } });
      expect(await triggers.brokerageDefaultFor('birthday')).toBe(true);
      // The agent has chosen nothing, so they follow it.
      expect(await triggers.isEnabledFor(agent, 'birthday')).toBe(true);

      await s.setBrokerage(admin, { defaults: { birthday: false } });
      expect(await triggers.isEnabledFor(agent, 'birthday')).toBe(false);
    });
  });

  /**
   * ABSENT IS UNCHANGED. The Triggers screen posted the whole `crm_email_settings` row back on
   * every save, so one switch also rewrote the SMTP host and every other default (T-H2). This
   * endpoint can only touch what it was given.
   */
  it('leaves untouched every field the request did not name', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const s = svc(tx);
      const now = new Date();

      await tx.crm_email_settings.deleteMany({});
      await tx.crm_email_settings.create({
        data: {
          smtp_host: 'smtp.keepme.test', smtp_port: '2525', smtp_user: 'keep', admin_email: 'keep@x.test',
          auto_send_enabled: true, template_toggles: JSON.stringify({ birthday: true, custom: false }),
          created_at: now, updated_at: now,
        },
      });

      await s.setBrokerage(admin, { defaults: { seasonal: false } });

      const row = (await tx.crm_email_settings.findFirst({ orderBy: { id: 'asc' } }))!;
      expect(row.smtp_host).toBe('smtp.keepme.test');
      expect(row.smtp_port).toBe('2525');
      expect(row.admin_email).toBe('keep@x.test');
      expect(row.auto_send_enabled).toBe(true);
      const toggles = JSON.parse(row.template_toggles!);
      expect(toggles.seasonal).toBe(false);   // what was asked for
      expect(toggles.birthday).toBe(true);    // and nothing else moved
      expect(toggles.custom).toBe(false);
    });
  });

  it('refuses an agent, at the service and not only in the screen', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const s = svc(tx);
      await expect(s.setBrokerage(agent, { auto_send_enabled: false })).rejects.toThrow(/Settings permission/i);
      await expect(s.setBrokerage(agent, { defaults: { birthday: true } })).rejects.toThrow(/Settings permission/i);
      expect(((await s.overview(agent)).brokerage as { can_edit: boolean }).can_edit).toBe(false);
    });
  });

  it('refuses a key this application does not send, rather than storing it', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const s = svc(tx);
      // `wedding` is retired — the clearest case of a key that must not come back through the door.
      await expect(s.setBrokerage(admin, { defaults: { wedding: true } })).rejects.toThrow(/not a CRM communication/i);
      await expect(s.setBrokerage(admin, { defaults: { birthday: 'yes' as never } })).rejects.toThrow(/true or false/i);
    });
  });

  /** The master switch stops every send, whatever anybody's personal choice says. */
  it('the master switch overrides a personal preference that is on', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const agent = await makeUser(tx, 'agent');
      const s = svc(tx);

      await s.setPreference(agent, 'birthday', 'email', true);
      await s.setBrokerage(admin, { auto_send_enabled: false });

      // The personal switch is untouched — the kill switch sits above it rather than rewriting it.
      const triggers = new CrmTriggersService(tx, new NotificationPreferenceService(tx));
      expect(await triggers.isEnabledFor(agent, 'birthday')).toBe(true);
      // And the screen reports the brokerage state so nobody is left guessing why nothing sends.
      expect(((await s.overview(agent)).brokerage as { auto_send_enabled: boolean }).auto_send_enabled).toBe(false);
    });
  });
});

describe('CRM Communications — creating a template', () => {
  it('refuses an agent, at the service and not only in the screen', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      await expect(svc(tx).createTemplate(agent, { name: 'X', subject: 'S', body_html: '<p>B</p>' }))
        .rejects.toThrow(/Administrator access required/i);
    });
  });

  it('creates an UNMAPPED template inactive, with a notice, and unable to send', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const out = await svc(tx).createTemplate(admin, {
        name: `Draft ${tag()}`, subject: 'Draft subject', body_html: '<p>Draft</p>', is_active: true,
      }) as { id: number; event_key: string; is_active: boolean; mapped: boolean; notice: string | null };

      // Asked for active; created inactive anyway, because nothing may send from an unmapped row.
      expect(out.mapped).toBe(false);
      expect(out.is_active).toBe(false);
      expect(out.notice).toMatch(/not connected to a CRM event/i);
      expect(out.event_key).toMatch(/^crm\.draft\./);

      const row = await tx.email_templates.findUnique({ where: { id: out.id } });
      expect(row!.module).toBe('CRM');
      expect(row!.is_active).toBe(false);
    });
  });

  it('refuses an arbitrary event key rather than letting one silently start sending', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const base = { name: 'X', subject: 'S', body_html: '<p>B</p>' };
      // Invented.
      await expect(svc(tx).createTemplate(admin, { ...base, event_key: 'crm.something_made_up' }))
        .rejects.toThrow(/not a CRM communication this application can send/i);
      // A real Transaction Desk event — must not be reachable from the CRM screen.
      await expect(svc(tx).createTemplate(admin, { ...base, event_key: 'invoice.send' }))
        .rejects.toThrow(/not a CRM communication this application can send/i);
    });
  });

  it('offers Edit Existing instead of creating a duplicate for an event that already has one', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const existing = await tx.email_templates.findUnique({ where: { event_key: 'crm.lead_new' } });
      if (!existing) return;   // seeds on first send; nothing to duplicate on a fresh database

      await expect(svc(tx).createTemplate(admin, {
        name: 'Second', subject: 'S', body_html: '<p>B</p>', event_key: 'crm.lead_new',
      })).rejects.toThrow(/already has a template. Edit the existing one/i);

      const count = await tx.email_templates.count({ where: { event_key: 'crm.lead_new' } });
      expect(count).toBe(1);
    });
  });

  it('will not create a template with no name, subject or body', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      await expect(svc(tx).createTemplate(admin, { subject: 'S', body_html: '<p>B</p>' })).rejects.toThrow(/name/i);
      await expect(svc(tx).createTemplate(admin, { name: 'N', body_html: '<p>B</p>' })).rejects.toThrow(/subject/i);
      await expect(svc(tx).createTemplate(admin, { name: 'N', subject: 'S' })).rejects.toThrow(/message cannot be empty/i);
    });
  });

  it('lists an unmapped template separately so it cannot be mistaken for a live one', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const out = await svc(tx).createTemplate(admin, {
        name: `Draft ${tag()}`, subject: 'S', body_html: '<p>B</p>',
      }) as { id: number };

      const o = await svc(tx).overview(admin);
      const unmapped = o.unmapped_templates as { id: number; is_active: boolean }[];
      expect(unmapped.some((t) => t.id === out.id)).toBe(true);
      // And it is not among the sending communications.
      expect((o.communications as { template: { id: number } | null }[])
        .some((c) => c.template?.id === out.id)).toBe(false);
    });
  });
});

describe('CRM Communications — leaves everything else alone', () => {
  it('creates no Transaction Desk template rows', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const before = await tx.email_templates.count({ where: { module: { not: 'CRM' } } });
      await svc(tx).createTemplate(admin, { name: `D ${tag()}`, subject: 'S', body_html: '<p>B</p>' });
      expect(await tx.email_templates.count({ where: { module: { not: 'CRM' } } })).toBe(before);
    });
  });

  it('never touches campaign templates', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const before = await tx.campaign_templates.count();
      await svc(tx).createTemplate(admin, { name: `D ${tag()}`, subject: 'S', body_html: '<p>B</p>' });
      await svc(tx).setPreference(admin, 'birthday', 'email', false);
      expect(await tx.campaign_templates.count()).toBe(before);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
