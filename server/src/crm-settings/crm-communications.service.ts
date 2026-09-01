import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationPreferenceService, type NotificationChannel } from '../notifications/notification-preference.service';
import { PermissionService } from '../auth/permission.service';
import { CrmTriggersService } from './crm-triggers.service';
import { CrmSettingsService } from './crm-settings.service';
import { MAIL_EVENTS } from '../email/mail-event-registry';
import { auditDomain } from '../common/domain';
import { isSuperAdmin } from '../core/authz';
import { TRIGGER_KEYS } from './crm-settings.constants';
import type { AuthUserRecord } from '../auth/auth.types';
import {
  ACTIVE_CRM_COMMUNICATIONS, byKey, variablesFor,
  type CrmCommunication,
} from './crm-communications.registry';

/**
 * The backend behind CRM → Settings → Communications.
 *
 * WHAT IT IS FOR. One screen answers "what can the CRM send, and what have I chosen about it?",
 * where the answer used to be spread over three screens and two tables. This service is the join.
 *
 * ================================================================================================
 * IT READS EACH PREFERENCE FROM WHEREVER THAT PREFERENCE CURRENTLY LIVES.
 *
 * This is the single most important thing in the file, and it is temporary by design.
 *
 *   the six staff notifications -> `notification_preferences` (already the owner)
 *   birthday/anniversary/seasonal -> `crm_trigger_settings` (STILL the owner)
 *   promotional/referral/custom -> `crm_trigger_settings` (permanently the owner)
 *
 * The greetings have not been migrated yet, and until they are, `crm_trigger_settings` is what
 * decides whether they send. A screen that read `notification_preferences` for them today would
 * show a switch that governs nothing — worse, it would show ON for somebody who had turned them
 * OFF, and they would believe the screen. So the read follows the truth, not the destination.
 *
 * That is also why this needs no feature flag: the screen is correct before the migration and
 * correct after it. When the send path switches, the greeting rows here change source from
 * `legacyTriggerKey` to `preferenceCategory` and nothing else about this file moves.
 * ================================================================================================
 *
 * NOTHING HERE CHANGES SENDING. Writes go to the same store the existing screens write to, in the
 * same shape. A preference set here and a preference set on the old screen are the same row.
 */
@Injectable()
export class CrmCommunicationsService {
  private readonly log = new Logger(CrmCommunicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prefs: NotificationPreferenceService,
    private readonly triggers: CrmTriggersService,
    private readonly settings: CrmSettingsService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * May this person change the brokerage's controls?
   *
   * `settings: edit`, THE SAME PERMISSION THE ENDPOINT ENFORCES, and not `isSuperAdmin`. The two
   * are different populations — `permission.service.ts` gives the Admin role `settings: view` on
   * purpose, and a brokerage can grant `settings: edit` to a role through Roles & Permissions — so
   * deciding the button from the role while the route decides from the permission is how you get
   * either a control that 403s on click or a grant nobody can exercise. Both have happened on this
   * screen's predecessors; both are recorded in the CRM › Triggers audit.
   */
  private canEditBrokerage(user: AuthUserRecord): boolean {
    return this.permissions.can(user.role || 'agent', user.user_permissions ?? [], 'settings', 'edit');
  }

  // ------------------------------------------------------------------ read

  /**
   * Everything the screen renders: the brokerage switch, then one row per communication carrying
   * this person's own choices and, for an administrator, the template behind it.
   */
  async overview(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const admin = isSuperAdmin(user);
    const canSetBrokerage = this.canEditBrokerage(user);
    const [brokerage, templates, defaults] = await Promise.all([
      this.prisma.crm_email_settings.findFirst({ orderBy: { id: 'asc' } }),
      this.prisma.email_templates.findMany({ where: { module: 'CRM' }, orderBy: { name: 'asc' } }),
      this.settings.brokerageToggles(),
    ]);
    const byEventKey = new Map(templates.map((t) => [t.event_key, t]));

    const rows = await Promise.all(
      ACTIVE_CRM_COMMUNICATIONS.map(async (comm) => {
        const template = comm.templateEventKey ? byEventKey.get(comm.templateEventKey) ?? null : null;
        return {
          key: comm.key,
          name: comm.name,
          description: comm.description,
          kind: comm.kind,
          audience: comm.audience,
          channels: comm.channels,
          /** This person's own answers. Absent channels are simply not offered. */
          preferences: await this.preferencesFor(user, comm),
          /** Where this row's preference is stored today — shown in no UI, useful in support. */
          preference_source: comm.preferenceCategory ? 'notification_preferences' : 'crm_triggers',
          /**
           * The brokerage default this row falls back to when the person has expressed nothing.
           *
           * Lead-facing only, and null for the staff notifications, which are personal all the way
           * down and have no brokerage layer to inherit from. The registry key IS the brokerage
           * default key for every lead-facing communication — see `TRIGGER_KEYS` — so there is no
           * second mapping to keep in step.
           */
          brokerage_default: comm.audience === 'lead' ? defaults[comm.key] ?? null : null,
          template: template && {
            id: template.id,
            event_key: template.event_key,
            name: template.name,
            subject: template.subject,
            is_active: template.is_active,
            mail_account_id: template.mail_account_id,
            /** Read from the mail registry, never a second list. */
            variables: variablesFor(comm),
            /** An administrator may edit it; everybody may preview it. */
            can_edit: admin,
          },
        };
      }),
    );

    /*
     * Templates in the CRM module that no registered communication claims. A template can exist
     * without an event — see `createTemplate` — and it must be visible, or an administrator would
     * create one and never find it again. It is reported as unmapped so the screen can say plainly
     * that it will not send.
     */
    const claimed = new Set(ACTIVE_CRM_COMMUNICATIONS.map((c) => c.templateEventKey).filter(Boolean));
    const unmapped = templates
      .filter((t) => !claimed.has(t.event_key))
      .filter((t) => !MAIL_EVENTS[t.event_key])   // a registered event that is simply retired is not "unmapped"
      .map((t) => ({
        id: t.id, event_key: t.event_key, name: t.name, subject: t.subject,
        is_active: t.is_active, can_edit: admin,
      }));

    return {
      brokerage: {
        /** The existing brokerage-wide switch. Not a new one — see CrmTriggersService. */
        auto_send_enabled: brokerage?.auto_send_enabled ?? true,
        /**
         * The brokerage's per-communication defaults, from the same `crm_email_settings` row the
         * send path reads. Moved here from Triggers → CRM Triggers with nothing duplicated: this is
         * a second PLACE to set one value, replacing the first, not a second value.
         */
        defaults,
        /** Which of those keys this screen may offer — the compiled list, never typed by a client. */
        default_keys: [...TRIGGER_KEYS],
        can_edit: canSetBrokerage,
        updated_by: brokerage?.updated_by ?? null,
        updated_at: brokerage?.updated_at?.toISOString() ?? null,
      },
      is_admin: admin,
      communications: rows,
      unmapped_templates: unmapped,
      /** Event keys an administrator may map a new template to — the controlled registry. */
      mappable_events: ACTIVE_CRM_COMMUNICATIONS
        .filter((c) => c.templateEventKey && !byEventKey.has(c.templateEventKey))
        .map((c) => ({ key: c.templateEventKey, name: c.name })),
    };
  }

  /**
   * This person's effective choices for one communication, read from its current owner.
   *
   * THE OWNER IS `preferenceCategory` IF THERE IS ONE, ELSE `legacyTriggerKey` — audience no longer
   * decides it. It used to: staff rows read `notification_preferences` and everything else read
   * `crm_trigger_settings`. That held only while every lead-facing row was in the old store, and
   * stopped being true the moment the greetings migrated. Keying on the registry field that names
   * the store is what makes the next migration a change to one entry rather than to this method.
   */
  private async preferencesFor(user: AuthUserRecord, comm: CrmCommunication): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};

    if (comm.preferenceCategory) {
      /*
       * LEAD-FACING ROWS RESOLVE THROUGH THE SEND PATH'S OWN ANSWER, not through `channelsFor`.
       *
       * `channelsFor` reports absence as ON, which is right for a staff notification and wrong for
       * a greeting: those inherit a brokerage default that is OFF by default, so a screen built on
       * `channelsFor` would show Birthday "Active" to every agent who had never touched it while
       * the scheduler sent nothing. That is the precise failure this file's header warns about —
       * a control that governs nothing, showing the opposite of the truth.
       *
       * `isEnabledFor` is the same method the sweep calls, so the switch and the send agree by
       * construction rather than by two implementations happening to match.
       */
      if (comm.audience === 'lead') {
        out.email = await this.triggers.isEnabledFor(user, comm.key as never);
        return out;
      }

      const choices = await this.prefs.channelsFor(user.id ?? -1, comm.preferenceCategory);
      for (const channel of ['email', 'in_app', 'push'] as NotificationChannel[]) {
        if (comm.channels[channel]) out[channel] = choices[channel];
      }
      return out;
    }

    // Still owned by `crm_trigger_settings`: Welcome, and the three manual emails.
    if (comm.legacyTriggerKey) {
      out.email = await this.triggers.isEnabledFor(user, comm.legacyTriggerKey as never);
    }
    return out;
  }

  // ----------------------------------------------------------------- write

  /**
   * Set one channel of one communication, for the CALLER ONLY.
   *
   * There is no user id parameter, and that is the enforcement rather than a convenience: this
   * endpoint cannot be pointed at somebody else's preferences because it has nowhere to put the
   * request. Everything else about who may do what is a permission check; this one is a shape.
   */
  async setPreference(user: AuthUserRecord, key: string, channel: string, enabled: boolean): Promise<Record<string, unknown>> {
    const comm = byKey(key);
    if (!comm || comm.retired) throw new BadRequestException({ message: `Unknown CRM communication "${key}".` });
    if (!['email', 'in_app', 'push'].includes(channel)) throw new BadRequestException({ message: `Unknown channel "${channel}".` });
    if (!comm.channels[channel as NotificationChannel]) {
      throw new BadRequestException({ message: `${comm.name} cannot be delivered by ${channel}.` });
    }

    if (comm.preferenceCategory) {
      /*
       * Writes go to the same table the read came from, whichever it is — see `preferencesFor`.
       * The greetings write here now; Welcome and the three manual emails still write below.
       */
      await this.prefs.set(user.id ?? -1, comm.preferenceCategory, channel, enabled);
    } else if (comm.legacyTriggerKey) {
      /*
       * The same call the Triggers screen makes, with the same audit trail. `saveForUser` merges
       * into this person's existing overrides rather than replacing them, so setting one switch
       * here cannot silently clear the others — which is exactly the semantics a single toggle on
       * a screen full of toggles needs.
       */
      await this.triggers.saveForUser(user, { triggers: { [comm.legacyTriggerKey]: enabled } });
    }

    return { ok: true, key, channel, enabled, preferences: await this.preferencesFor(user, comm) };
  }

  // ------------------------------------------------------------- brokerage

  /**
   * Set the brokerage-wide controls: the master switch, and the per-communication defaults.
   *
   * ONE FIELD AT A TIME, AND ABSENT MEANS UNCHANGED. This is the semantics the Triggers screen did
   * NOT have — it posted the entire `crm_email_settings` row back on every save, so flipping one
   * switch also wrote the SMTP host, the port and the admin address, and a stale copy of the screen
   * silently reverted an administrator's change made elsewhere (T-H2 in the CRM › Triggers audit).
   * Nothing here can touch a field the caller did not name.
   *
   * THE PERMISSION IS ENFORCED HERE AS WELL AS ON THE ROUTE. `@Screen('settings','edit')` refuses
   * the request first; this refuses it again if the method is ever called from somewhere else. The
   * control is brokerage-wide — one row, one value, every colleague's sending — which is exactly
   * the kind that should not depend on a single check in a single place.
   */
  async setBrokerage(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.canEditBrokerage(user)) {
      throw new ForbiddenException({ message: 'Changing the brokerage controls needs the Settings permission at Edit.' });
    }

    const hasSwitch = body.auto_send_enabled !== undefined;
    const givenDefaults = (body.defaults ?? undefined) as Record<string, unknown> | undefined;
    if (!hasSwitch && givenDefaults === undefined) {
      throw new BadRequestException({ message: 'Send `auto_send_enabled`, `defaults`, or both.' });
    }
    if (hasSwitch && typeof body.auto_send_enabled !== 'boolean') {
      throw new BadRequestException({
        message: '`auto_send_enabled` must be true or false.',
        errors: { auto_send_enabled: ['Must be true or false.'] },
      });
    }
    if (givenDefaults !== undefined && (typeof givenDefaults !== 'object' || Array.isArray(givenDefaults))) {
      throw new BadRequestException({ message: '`defaults` must be an object of trigger keys.' });
    }

    const before = await this.settings.brokerageToggles();
    const next = { ...before };
    for (const [key, value] of Object.entries(givenDefaults ?? {})) {
      if (!(TRIGGER_KEYS as readonly string[]).includes(key)) {
        // Named, not ignored. A key this application does not send is a mistake in the caller, and
        // swallowing it would leave somebody believing they had set something.
        throw new BadRequestException({
          message: `"${key}" is not a CRM communication. Valid keys: ${TRIGGER_KEYS.join(', ')}.`,
          errors: { defaults: [`Unknown key: ${key}.`] },
        });
      }
      if (typeof value !== 'boolean') {
        throw new BadRequestException({
          message: `"${key}" must be true or false.`,
          errors: { [`defaults.${key}`]: ['Must be true or false.'] },
        });
      }
      next[key] = value;
    }

    const existing = await this.prisma.crm_email_settings.findFirst({ orderBy: { id: 'asc' } });
    const wasSending = existing ? existing.auto_send_enabled : true;
    const nowSending = hasSwitch ? (body.auto_send_enabled as boolean) : wasSending;
    const stamp = new Date();
    const data = {
      auto_send_enabled: nowSending,
      template_toggles: JSON.stringify(next),
      updated_by: user.name,
      updated_at: stamp,
    };

    if (existing) await this.prisma.crm_email_settings.update({ where: { id: existing.id }, data });
    else await this.prisma.crm_email_settings.create({ data: { ...data, created_at: stamp } });

    await this.auditBrokerage(user, wasSending, nowSending, before, next);
    return { ...(await this.overview(user)), message: 'Brokerage controls saved' };
  }

  /**
   * One audit row per control that actually moved, carrying what it was and what it became.
   *
   * Per-field rather than one "settings updated" line, matching what `CrmTriggersService` already
   * writes for a person's own switches. These are the brokerage-wide ones, so "who turned CRM email
   * off for everybody, and when" is the question the trail has to be able to answer.
   */
  /**
   * Remove one CRM template from the library.
   *
   * SCOPED TO `module: 'CRM'`, and that is load-bearing rather than tidy. `email_templates` also
   * holds Transaction Desk templates and campaign templates; those are separate products managed on
   * separate screens, and an id from either of them must not be deletable through this one. An id
   * outside the CRM set resolves to "no longer exists" rather than to somebody else's row.
   *
   * WHAT DELETING A **CONNECTED** TEMPLATE ACTUALLY DOES, checked rather than assumed: the event
   * keeps sending. `CrmAdvancedEmailService.render` re-creates a missing template from the built-in
   * default the next time that email goes out. So this resets the wording to the brokerage default;
   * it does not silence the email. The caller is told which case it was so the screen can say so —
   * "deleted" and "reset to the default text" are very different things to have just done.
   *
   * Attachments are `Bytes` in the database with `onDelete: Cascade`, so nothing is left on disk.
   */
  async deleteTemplate(user: AuthUserRecord, id: number): Promise<{ deleted: boolean; was_connected: boolean; name: string }> {
    const row = await this.prisma.email_templates.findFirst({
      where: { id, module: 'CRM' },
      select: { id: true, name: true, subject: true, event_key: true },
    });
    if (!row) throw new NotFoundException({ message: 'That template no longer exists.' });

    // A draft carries the namespaced key minted above; anything else is mapped to a real CRM event.
    const wasConnected = !row.event_key.startsWith('crm.draft.');

    await this.prisma.email_templates.delete({ where: { id: row.id } });

    const stamp = new Date();
    try {
      await this.prisma.audit_logs.create({
        data: {
          category: 'Settings', transaction_id: null, who: user.name, user_id: user.id ?? null,
          section: 'CRM Communications', action: 'CRM template deleted', source: 'Manual',
          domain: auditDomain({ category: 'Settings', section: 'CRM Communications' }),
          field: row.event_key,
          old_value: `${row.name} — ${row.subject ?? ''}`.slice(0, 250),
          new_value: wasConnected ? 'reset to the built-in default' : 'removed',
          // The template body is not copied here: it can be long, and the name, subject and event
          // are what identify which one went. The wording of a connected one is recoverable anyway,
          // because the default is what replaces it.
          details: `${user.name ?? 'Someone'} deleted the CRM template "${row.name}"`
            + (wasConnected ? ` — ${row.event_key} now sends its built-in default text` : ' (an unconnected draft)'),
          created_at: stamp, updated_at: stamp,
        },
      });
    } catch (err) {
      this.log.warn(`CRM template delete audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { deleted: true, was_connected: wasConnected, name: row.name };
  }

  private async auditBrokerage(
    user: AuthUserRecord, wasSending: boolean, nowSending: boolean,
    before: Record<string, boolean>, after: Record<string, boolean>,
  ): Promise<void> {
    const rows: { field: string; old: boolean; now: boolean; what: string }[] = [];
    if (wasSending !== nowSending) {
      rows.push({ field: 'auto_send_enabled', old: wasSending, now: nowSending, what: "the CRM's per-lead emails" });
    }
    for (const key of TRIGGER_KEYS) {
      if (before[key] !== after[key]) {
        rows.push({ field: `default.${key}`, old: !!before[key], now: !!after[key], what: `the brokerage default for "${key}"` });
      }
    }

    for (const row of rows) {
      try {
        const stamp = new Date();
        await this.prisma.audit_logs.create({
          data: {
            category: 'Settings', transaction_id: null, who: user.name, user_id: user.id ?? null,
            section: 'CRM Communications', action: 'CRM brokerage control changed', source: 'Manual',
            domain: auditDomain({ category: 'Settings', section: 'CRM Communications' }),
            field: row.field,
            old_value: row.old ? 'on' : 'off',
            new_value: row.now ? 'on' : 'off',
            details: `${user.name ?? 'Someone'} turned ${row.what} ${row.now ? 'on' : 'off'} for the brokerage`,
            created_at: stamp, updated_at: stamp,
          },
        });
      } catch (err) {
        this.log.warn(`CRM brokerage audit write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // -------------------------------------------------------------- template

  /**
   * Create a CRM email template.
   *
   * TWO RULES, BOTH ABOUT NOT SENDING BY ACCIDENT.
   *
   * 1. THE EVENT KEY IS CHOSEN FROM A LIST, NEVER TYPED. An administrator may map a template to a
   *    registered CRM event or leave it unmapped. They cannot invent a key: a typed key that
   *    happened to match a real event would silently take over that email, and one that matched a
   *    Transaction Desk event would take over a Desk email from inside the CRM screen.
   *
   * 2. AN UNMAPPED TEMPLATE IS CREATED INACTIVE AND CANNOT SEND. Nothing looks it up — the send
   *    paths resolve templates by event key through `MAIL_EVENTS`, so a key that is not in the
   *    registry is not reachable by any sender. Forcing `is_active: false` as well means the screen
   *    and the data agree about that rather than relying on the reader knowing it.
   */
  async createTemplate(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!isSuperAdmin(user)) throw new ForbiddenException({ message: 'Administrator access required.' });

    const name = String(body.name ?? '').trim();
    const subject = String(body.subject ?? '').trim();
    const bodyHtml = String(body.body_html ?? '').trim();
    if (!name) throw new BadRequestException({ message: 'Give the template a name.' });
    if (!subject) throw new BadRequestException({ message: 'Give the template a subject.' });
    if (!bodyHtml) throw new BadRequestException({ message: 'The message cannot be empty.' });

    const requested = String(body.event_key ?? '').trim();
    let eventKey: string;
    let mapped: boolean;

    if (requested) {
      const comm = ACTIVE_CRM_COMMUNICATIONS.find((c) => c.templateEventKey === requested);
      if (!comm) {
        throw new BadRequestException({
          message: 'That is not a CRM communication this application can send. Choose one from the list, or leave it unmapped.',
        });
      }
      const taken = await this.prisma.email_templates.findUnique({ where: { event_key: requested } });
      if (taken) {
        // Offer the existing one rather than failing on a unique violation the reader cannot act on.
        throw new BadRequestException({
          message: `${comm.name} already has a template. Edit the existing one instead of creating a second.`,
          errors: { event_key: [`Already mapped to template #${taken.id}.`] },
          existing_template_id: taken.id,
        });
      }
      eventKey = requested;
      mapped = true;
    } else {
      /*
       * A draft. The key is namespaced and unique so it can never collide with a registered event
       * — including one added later — and is obviously not a sending key to anyone reading the row.
       */
      eventKey = `crm.draft.${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
      mapped = false;
    }

    const now = new Date();
    const created = await this.prisma.email_templates.create({
      data: {
        event_key: eventKey,
        module: 'CRM',            // never Desk, never a campaign template — a different table entirely
        name, subject, body_html: bodyHtml,
        mail_account_id: body.mail_account_id ? Number(body.mail_account_id) : null,
        // Unmapped is inactive, always. A mapped one honours what was asked, defaulting to on.
        is_active: mapped ? body.is_active !== false : false,
        created_at: now, updated_at: now,
      },
    });

    this.log.log(`CRM template #${created.id} created by ${user.name ?? user.id} (${mapped ? `mapped to ${eventKey}` : 'unmapped draft'}).`);
    return {
      id: created.id, event_key: created.event_key, name: created.name,
      is_active: created.is_active, mapped,
      notice: mapped ? null : 'This template is not connected to a CRM event and will not send automatically.',
    };
  }
}
