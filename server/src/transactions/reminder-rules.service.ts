import { ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { isSuperAdmin } from '../core/authz';
import { parseJsonObject, phpJsonNormalize } from '../common/serialize';
import {
  AFTER_KEYS, DAYS_KEYS, MAX_REMINDER_DAYS, RULE_LABEL, type ReminderRules, applyRulesPatch, describeRule, readRules, storedForm,
} from './reminder-rules';
import { startOfDay } from './reminder-schedule';
import { dayYmd } from './reminder-rules';

/**
 * The Triggers screen's reminder switches and days (Sai, 29 Oct 2026). See reminder-rules.ts for
 * what each one means. Anyone who can open transactions may READ them - the screen shows what runs;
 * only a Super Admin may CHANGE them (Sai: "super admin is enough for triggers").
 */
@Injectable()
export class ReminderRulesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async flags(): Promise<Record<string, unknown>> {
    const s = await this.prisma.company_settings.findUnique({ where: { id: 1 }, select: { feature_flags: true } });
    return parseJsonObject(s?.feature_flags ?? null);
  }

  async read(user: AuthUserRecord | null | undefined): Promise<{ data: ReminderRules; can_edit: boolean; max_days: number }> {
    return { data: readRules(await this.flags()), can_edit: isSuperAdmin(user ?? null), max_days: MAX_REMINDER_DAYS };
  }

  /** Save the reminders named in the body; every change is written to the Settings audit trail. */
  async save(user: AuthUserRecord | null | undefined, body: Record<string, unknown>): Promise<{ data: ReminderRules; can_edit: boolean; max_days: number }> {
    if (!user || !isSuperAdmin(user)) throw new ForbiddenException({ message: 'Only a Super Admin can change the reminders.' });

    const flags = await this.flags();
    const before = readRules(flags);
    const patched = applyRulesPatch(before, body ?? {});
    if ('errors' in patched) throw new UnprocessableEntityException({ message: patched.errors.join(' '), errors: { reminders: patched.errors } });
    const after = patched.rules;

    // The lawyer switch is `lawyer_reminder_days`, as Company Settings writes it: 0 = off. Switching
    // it back on keeps a number somebody set, or 3, the value it has always defaulted to.
    if (after.lawyer.on !== before.lawyer.on) {
      const cur = Math.max(0, Math.floor(Number(flags.lawyer_reminder_days) || 0));
      flags.lawyer_reminder_days = after.lawyer.on ? (cur > 0 ? cur : 3) : 0;
    }
    // "Hold the old deals": an after-closing reminder switched On today only chases deals closing from
    // today. The go-live day itself is fixed by the scheduler, never by a save.
    const today = dayYmd(startOfDay(new Date()));
    for (const key of AFTER_KEYS) {
      if (after[key].on && !before[key].on) after.after_started = { ...after.after_started, [key]: today };
    }
    flags.reminder_rules = { ...storedForm(after), after_closing_from: before.after_closing_from };
    await this.prisma.company_settings.update({
      where: { id: 1 },
      data: { feature_flags: JSON.stringify(phpJsonNormalize(flags)), updated_at: new Date() },
    });

    const keys = [...DAYS_KEYS, 'deposit', 'commission', ...AFTER_KEYS] as (keyof typeof RULE_LABEL)[];
    for (const key of keys) {
      const old = describeRule(before, key);
      const next = describeRule(after, key);
      if (old === next) continue;
      await this.audit.logModule({ id: user.id, name: user.name }, 'Settings', {
        section: 'Triggers',
        field: RULE_LABEL[key],
        action: 'Settings updated',
        old,
        new: next,
        details: `${RULE_LABEL[key]}: ${old} → ${next}`,
      });
    }
    return this.read(user);
  }

  /**
   * "Hold the old deals" (Sai, 29 Oct 2026): the first run after go-live writes today's date, and
   * after-closing reminders only ever look at deals closing on or after it. Never moved afterwards.
   */
  async markAfterClosingStart(today: Date = new Date()): Promise<void> {
    const flags = await this.flags();
    const rules = readRules(flags);
    if (rules.after_closing_from) return;
    const day = dayYmd(startOfDay(today));
    const stored = flags.reminder_rules && typeof flags.reminder_rules === 'object' && !Array.isArray(flags.reminder_rules)
      ? flags.reminder_rules as Record<string, unknown>
      : {};
    flags.reminder_rules = { ...stored, after_closing_from: day };
    await this.prisma.company_settings.update({ where: { id: 1 }, data: { feature_flags: JSON.stringify(phpJsonNormalize(flags)) } });
  }
}
