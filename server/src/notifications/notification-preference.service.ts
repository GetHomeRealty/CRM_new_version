import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Whether a given push notification actually has something sending it today.
 *
 * This is recorded rather than assumed because most of these do not. Web push has exactly one
 * sender in the codebase — the calendar's event reminders. The rest reach people by email, by the
 * in-app feed, or not at all, and a preferences screen that quietly implied otherwise would be
 * worse than no screen: someone would switch a toggle off, keep getting the email, and conclude
 * the setting was broken.
 *
 *   'live'     a push sender exists and honours this preference now.
 *   'pending'  the event happens and notifies another way; no push sender yet, so the toggle is
 *              stored and will take effect the moment one is added.
 */
export type CategoryReadiness = 'live' | 'pending';

export interface NotificationCategory {
  key: string;
  label: string;
  description: string;
  readiness: CategoryReadiness;
  /** How the user is told today, when it is not (or not only) push. */
  currentChannel: string;
}

/**
 * The categories a person can turn off, in the order the screen shows them.
 *
 * Adding one needs no migration: preferences are stored by key, and an unknown key is rejected
 * here rather than by a database constraint.
 */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  {
    key: 'calendar_reminders',
    label: 'Calendar reminders',
    description: 'Before a showing, closing or appointment you have been reminded about.',
    readiness: 'live',
    currentChannel: 'Push and email',
  },
  {
    key: 'listing_expiry',
    label: 'Listing expiry reminders',
    description: 'A listing is approaching its expiry date, or has just expired.',
    readiness: 'pending',
    currentChannel: 'Email',
  },
  {
    key: 'lawyer_details',
    label: 'Lawyer detail reminders',
    description: 'A deal has reached a phase where the lawyer’s details are still missing.',
    readiness: 'pending',
    currentChannel: 'Email',
  },
  {
    key: 'document_review',
    label: 'Document review updates',
    description: 'A document you uploaded has been accepted, rejected or sent back for changes.',
    readiness: 'pending',
    currentChannel: 'In-app notifications',
  },
  {
    key: 'transaction_approvals',
    label: 'Transaction approvals',
    description: 'A correction or review on one of your deals has been approved or turned down.',
    readiness: 'pending',
    currentChannel: 'Deal chat and email',
  },
  {
    key: 'inbox_new_mail',
    label: 'New inbox emails',
    description: 'Mail arriving in a mailbox you have connected.',
    readiness: 'pending',
    currentChannel: 'None — the Inbox screen refreshes on its own',
  },
  {
    key: 'chat_mentions',
    label: 'Team chat mentions',
    description: 'Somebody mentions you in a deal’s chat.',
    readiness: 'pending',
    currentChannel: 'None — mentions are not implemented yet',
  },
] as const;

const KEYS = new Set(NOTIFICATION_CATEGORIES.map((c) => c.key));

/** A push category key. Anything sending push should pass one so the preference is honoured. */
export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORIES)[number]['key'];

@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Is this person willing to receive this category?
   *
   * Defaults to **true** on absence, and also on anything unexpected — an unknown key, or a
   * database error. Failing open is the right way round here: the cost of a notification someone
   * meant to mute is an annoyance, the cost of silently swallowing a closing reminder is a missed
   * closing.
   */
  async isEnabled(userId: number, category: string): Promise<boolean> {
    if (!userId || userId < 0) return true;
    try {
      const row = await this.prisma.notification_preferences.findUnique({
        where: { user_id_category: { user_id: userId, category } },
        select: { enabled: true },
      });
      return row ? row.enabled : true;
    } catch {
      return true;
    }
  }

  /** Every category with this user's current choice, for the Settings screen. */
  async list(userId: number): Promise<{ categories: (NotificationCategory & { enabled: boolean })[] }> {
    const rows = userId > 0
      ? await this.prisma.notification_preferences.findMany({
        where: { user_id: userId },
        select: { category: true, enabled: true },
      })
      : [];
    const chosen = new Map(rows.map((r) => [r.category, r.enabled]));
    return {
      categories: NOTIFICATION_CATEGORIES.map((c) => ({ ...c, enabled: chosen.get(c.key) ?? true })),
    };
  }

  /**
   * Record a choice. Upsert rather than update: the row only exists once someone has opted out of
   * something, so the first change for a category is always an insert.
   */
  async set(userId: number, category: string, enabled: boolean): Promise<{ category: string; enabled: boolean }> {
    if (!KEYS.has(category)) {
      throw new BadRequestException({
        message: `Unknown notification category "${category}".`,
        errors: { category: [`Unknown notification category "${category}".`] },
      });
    }
    const now = new Date();
    await this.prisma.notification_preferences.upsert({
      where: { user_id_category: { user_id: userId, category } },
      create: { user_id: userId, category, enabled, created_at: now, updated_at: now },
      update: { enabled, updated_at: now },
    });
    return { category, enabled };
  }

  /**
   * Apply several at once, which is what the screen does on Save.
   *
   * Sequential rather than a transaction on purpose: these are independent per-category rows and
   * a half-applied save is not a corrupt state, just a partial one the next save fixes. Wrapping
   * them would buy atomicity nobody needs at the cost of holding a transaction open across an
   * arbitrary number of upserts.
   */
  async setMany(userId: number, prefs: Record<string, boolean>): Promise<{ categories: (NotificationCategory & { enabled: boolean })[] }> {
    for (const [category, enabled] of Object.entries(prefs)) {
      await this.set(userId, category, enabled === true);
    }
    return this.list(userId);
  }
}
