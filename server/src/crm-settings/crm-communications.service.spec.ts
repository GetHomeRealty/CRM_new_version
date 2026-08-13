import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmCommunicationsService } from './crm-communications.service';
import { CrmTriggersService } from './crm-triggers.service';
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

const svc = (tx: PrismaService) =>
  new CrmCommunicationsService(tx, new NotificationPreferenceService(tx), new CrmTriggersService(tx));

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
  it('offers the ten automated communications and the three manual ones, and no retired one', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const o = await svc(tx).overview(agent);
      const keys = (o.communications as { key: string }[]).map((c) => c.key);
      expect(keys.sort()).toEqual(ACTIVE_CRM_COMMUNICATIONS.map((c) => c.key).sort());
      expect(keys).not.toContain('wedding');
      expect(keys).toHaveLength(13);
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

  it('writes greetings to the store that still governs sending', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'agent');
      await svc(tx).setPreference(a, 'birthday', 'email', false);

      // Until the migration runs, crm_trigger_settings is what the send path reads. A preference
      // written anywhere else would be a switch that governs nothing.
      const row = await tx.crm_trigger_settings.findUnique({ where: { user_id: a.id! } });
      expect(JSON.parse(row!.template_toggles!).birthday).toBe(false);

      // And the old screen agrees, because it is the same row.
      expect(await new CrmTriggersService(tx).isEnabledFor(a, 'birthday')).toBe(false);
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
