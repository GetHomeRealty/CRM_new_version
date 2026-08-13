import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { auditDomain } from '../common/domain';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { DEFAULT_TRIGGERS, TRIGGER_KEYS, type TriggerKey } from './crm-settings.constants';

/**
 * CRM email triggers — ONE PERSON'S OWN.
 *
 * WHAT THIS REPLACES. Triggers were five switches on the single brokerage-wide `crm_email_settings`
 * row. Three things followed, all measured in the CRM › Triggers audit:
 *
 *   * An agent switching off promotional email switched it off for everybody.
 *   * The Triggers screen, which displays nothing but switches, posted the whole row back — so a
 *     trigger flip silently reverted SMTP details an administrator had changed elsewhere (T-H2).
 *   * The screen was gated on `triggers` and its API on `settings`, so four of six roles were
 *     offered a screen that refused them (T-H1).
 *
 * Splitting the store fixes all three at once. This service owns per-user toggles and nothing else,
 * so there is no shared field for a save to trample and no reason for the screen to ask for the
 * `settings` permission.
 *
 * THE THREE LEVELS, most specific first:
 *
 *   1. `auto_send_enabled` on the brokerage row — the kill switch. No personal choice overrides it.
 *   2. This person's own toggle for the trigger, if they have expressed one.
 *   3. The brokerage default (`crm_email_settings.template_toggles`), then the compiled default.
 *
 * A key is stored only when somebody actually sets it, so an agent who has never opened the screen
 * follows the brokerage default and keeps following it when an administrator changes it.
 */
@Injectable()
export class CrmTriggersService {
  private readonly log = new Logger(CrmTriggersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The brokerage's defaults, or the compiled ones when nothing is configured. */
  private async brokerageDefaults(): Promise<Record<string, boolean>> {
    const row = await this.prisma.crm_email_settings.findFirst({
      orderBy: { id: 'asc' },
    });
    if (!row?.template_toggles) return { ...DEFAULT_TRIGGERS };
    try {
      return { ...DEFAULT_TRIGGERS, ...(JSON.parse(row.template_toggles) as Record<string, boolean>) };
    } catch {
      // A brokerage row we cannot read is a data fault, not an instruction. Say so loudly and use
      // the compiled defaults rather than inventing an answer.
      this.log.error('The brokerage trigger defaults are not valid JSON — falling back to the compiled defaults.');
      return { ...DEFAULT_TRIGGERS };
    }
  }

  /** One person's stored overrides. `null` for a corrupt row, so the caller can fail closed. */
  private async ownOverrides(userId: number): Promise<Record<string, boolean> | null> {
    const row = await this.prisma.crm_trigger_settings.findUnique({ where: { user_id: userId } });
    if (!row?.template_toggles) return {};
    try {
      const parsed = JSON.parse(row.template_toggles) as Record<string, unknown>;
      const out: Record<string, boolean> = {};
      for (const key of TRIGGER_KEYS) if (typeof parsed[key] === 'boolean') out[key] = parsed[key] as boolean;
      return out;
    } catch {
      this.log.error(`Trigger settings for user ${userId} are not valid JSON.`);
      return null;
    }
  }

  /**
   * What the Triggers screen renders: this person's effective switches, plus the two pieces of
   * context that explain them.
   */
  async getForUser(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const userId = user.id ?? -1;
    const [defaults, overrides, brokerage] = await Promise.all([
      this.brokerageDefaults(),
      this.ownOverrides(userId),
      this.prisma.crm_email_settings.findFirst({ orderBy: { id: 'asc' } }),
    ]);
    const row = await this.prisma.crm_trigger_settings.findUnique({ where: { user_id: userId } });

    const triggers: Record<string, boolean> = {};
    const customised: Record<string, boolean> = {};
    for (const key of TRIGGER_KEYS) {
      const own = overrides?.[key];
      triggers[key] = own ?? defaults[key] ?? true;
      customised[key] = own !== undefined;
    }

    return {
      triggers,
      /** Which of them this person has set themselves, as opposed to inheriting. */
      customised,
      /** The brokerage's defaults, so the screen can say what "inherited" means. */
      brokerage_defaults: defaults,
      /**
       * The brokerage kill switch. Read-only here — it belongs to CRM Settings — but shown so
       * somebody whose triggers are all on and sending nothing is not left guessing why.
       */
      sending_allowed: brokerage ? brokerage.auto_send_enabled : true,
      trigger_keys: [...TRIGGER_KEYS],
      updated_by: row?.updated_by ?? null,
      updated_at: row?.updated_at?.toISOString() ?? null,
      /** Corrupt stored JSON. The screen warns, and every send is refused until it is re-saved. */
      unreadable: overrides === null,
    };
  }

  /**
   * Save this person's switches.
   *
   * ABSENT IS UNCHANGED, PRESENT-AND-INVALID IS AN ERROR. The brokerage endpoint this replaced
   * rebuilt its whole row from the body on every call, so `PUT {}` returned 200 and turned every
   * trigger back on (T-H3), and a non-boolean value was silently replaced by the permissive default
   * (T-M1). Both are refused here: a request that forgets a field must not re-enable it.
   */
  async saveForUser(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = user.id ?? -1;
    if (userId < 0) throw new BadRequestException({ message: 'No signed-in user to save triggers for.' });

    const given = body?.triggers;
    if (given === undefined || given === null || typeof given !== 'object' || Array.isArray(given)) {
      throw new BadRequestException({
        message: 'Send a `triggers` object saying which CRM emails you want to send.',
        errors: { triggers: ['Required.'] },
      });
    }

    const input = given as Record<string, unknown>;
    const unknown = Object.keys(input).filter((k) => !(TRIGGER_KEYS as readonly string[]).includes(k));
    if (unknown.length) {
      throw new BadRequestException({
        message: `"${unknown[0]}" is not a CRM email trigger. Valid triggers: ${TRIGGER_KEYS.join(', ')}.`,
        errors: { triggers: [`Unknown trigger: ${unknown.join(', ')}.`] },
      });
    }

    const before = (await this.ownOverrides(userId)) ?? {};
    const next: Record<string, boolean> = { ...before };
    for (const [key, value] of Object.entries(input)) {
      if (typeof value !== 'boolean') {
        throw new BadRequestException({
          message: `"${key}" must be true or false.`,
          errors: { [`triggers.${key}`]: ['Must be true or false.'] },
        });
      }
      next[key] = value;
    }

    const now = new Date();
    await this.prisma.crm_trigger_settings.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        template_toggles: JSON.stringify(next),
        updated_by: user.name, created_at: now, updated_at: now,
      },
      update: { template_toggles: JSON.stringify(next), updated_by: user.name, updated_at: now },
    });

    await this.audit(user, before, next);
    return { ...(await this.getForUser(user)), message: 'Your CRM triggers were saved' };
  }

  /**
   * One audit entry per switch that moved, carrying what it was and what it became.
   *
   * The endpoint this replaces wrote a single entry with `old_value: null` and a details sentence,
   * so the trail could not answer "who turned promotional off, and when" (T-M2). It is one row per
   * person now, so it is also worth recording whose.
   */
  private async audit(user: AuthUserRecord, before: Record<string, boolean>, after: Record<string, boolean>): Promise<void> {
    const defaults = await this.brokerageDefaults();
    for (const key of TRIGGER_KEYS) {
      const old = before[key] ?? defaults[key] ?? true;
      const now = after[key] ?? defaults[key] ?? true;
      const wasSet = before[key] !== undefined;
      const isSet = after[key] !== undefined;
      if (old === now && wasSet === isSet) continue;
      try {
        const stamp = new Date();
        await this.prisma.audit_logs.create({
          data: {
            category: 'Settings', transaction_id: null, who: user.name, user_id: user.id ?? null,
            section: 'CRM Triggers', action: 'CRM trigger changed', source: 'Manual',
            domain: auditDomain({ category: 'Settings', section: 'CRM Triggers' }),
            field: key,
            old_value: old ? 'on' : 'off',
            new_value: now ? 'on' : 'off',
            details: `${user.name ?? 'Someone'} turned their "${key}" CRM email ${now ? 'on' : 'off'}`,
            created_at: stamp, updated_at: stamp,
          },
        });
      } catch (err) {
        this.log.warn(`CRM trigger audit write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * May THIS PERSON send this kind of CRM email?
   *
   * FAILS CLOSED ON CORRUPTION, and that is a deliberate departure from how this application
   * usually resolves an unreadable preference. Elsewhere the reasoning is that a notification
   * somebody meant to mute is an annoyance while a missed closing reminder is a missed closing, so
   * absence means yes. The cost here runs the other way: the thing that happens is an email leaving
   * the brokerage's own domain, to a client, that somebody had said not to send. Under CASL that is
   * the expensive direction, so an instruction we cannot read is not treated as permission.
   *
   * A MISSING row is not corruption — it means "I have never set these", and inherits.
   */
  /**
   * The brokerage's own answer for one trigger, with no person in it.
   *
   * For the sends that have no agent to attribute — the welcome to a lead the brokerage owns
   * outright. `isEnabledFor` would read overrides for user -1 and arrive at the same value by
   * accident; this asks the question that is actually being asked.
   */
  async brokerageDefaultFor(key: TriggerKey): Promise<boolean> {
    const defaults = await this.brokerageDefaults();
    return defaults[key] ?? true;
  }

  async isEnabledFor(user: AuthUserRecord, key: TriggerKey): Promise<boolean> {
    const overrides = await this.ownOverrides(user.id ?? -1);
    if (overrides === null) return false;
    const own = overrides[key];
    if (own !== undefined) return own;
    const defaults = await this.brokerageDefaults();
    return defaults[key] ?? true;
  }
}
