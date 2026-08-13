import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationPreferenceService, type NotificationChannel } from '../notifications/notification-preference.service';
import { CrmTriggersService } from './crm-triggers.service';
import { MAIL_EVENTS } from '../email/mail-event-registry';
import { isSuperAdmin } from '../core/authz';
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
  ) {}

  // ------------------------------------------------------------------ read

  /**
   * Everything the screen renders: the brokerage switch, then one row per communication carrying
   * this person's own choices and, for an administrator, the template behind it.
   */
  async overview(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const admin = isSuperAdmin(user);
    const [brokerage, templates] = await Promise.all([
      this.prisma.crm_email_settings.findFirst({ orderBy: { id: 'asc' } }),
      this.prisma.email_templates.findMany({ where: { module: 'CRM' }, orderBy: { name: 'asc' } }),
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
          preference_source: comm.preferenceCategory && comm.audience === 'staff' ? 'notification_preferences' : 'crm_triggers',
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
        can_edit: admin,
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

  /** This person's stored choices for one communication, read from its current owner. */
  private async preferencesFor(user: AuthUserRecord, comm: CrmCommunication): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};

    if (comm.audience === 'staff' && comm.preferenceCategory) {
      const choices = await this.prefs.channelsFor(user.id ?? -1, comm.preferenceCategory);
      for (const channel of ['email', 'in_app', 'push'] as NotificationChannel[]) {
        if (comm.channels[channel]) out[channel] = choices[channel];
      }
      return out;
    }

    // Lead-facing: one email switch, still owned by crm_triggers until the migration lands.
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

    if (comm.audience === 'staff' && comm.preferenceCategory) {
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
