import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Whether a given (category, channel) pair actually has something sending it today.
 *
 * Recorded rather than assumed, because most pairs do not have a sender. A preferences screen that
 * quietly implied otherwise would be worse than no screen: somebody would switch a toggle off, keep
 * receiving the notification by another route, and reasonably conclude the setting was broken.
 *
 *   'live'        a sender exists and honours this preference now.
 *   'pending'     the event happens and reaches the person another way; no sender on THIS channel
 *                 yet, so the choice is stored and takes effect the moment one is built.
 *   'unsupported' this channel makes no sense for this event and is not offered at all.
 */
export type CategoryReadiness = 'live' | 'pending' | 'unsupported';

/** The ways this application can reach somebody. */
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

const CHANNEL_SET = new Set<string>(NOTIFICATION_CHANNELS);

export const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: 'In-app',
  email: 'Email',
  push: 'Push',
};

export interface NotificationCategory {
  key: string;
  label: string;
  description: string;
  /** Readiness per channel — the matrix the settings screen renders. */
  channels: Record<NotificationChannel, CategoryReadiness>;
  /**
   * Which area's Notification Preferences screen offers this category. Omitted means BOTH, which is
   * the right default for anything that is not tied to one side of the product.
   *
   * This exists because five categories describe things that only ever happen on a transaction — a
   * listing expiring, lawyer details missing, a document review, an approval, a mention in a deal's
   * chat — and were being offered on the CRM's screen too, where none of them can occur. A switch
   * for an event that cannot reach you is not a preference, it is a puzzle.
   *
   * IT GOVERNS THE SCREEN, NOT DELIVERY. A category hidden from one area is still stored, still
   * respected, and still honoured by whatever sends it; the preference a user already set is
   * untouched. Nothing about who is notified changes — only where the switch is shown.
   */
  areas?: readonly ('crm' | 'desk')[];
}

/**
 * The categories a person can control, in the order the screen shows them.
 *
 * Adding one needs no migration: preferences are stored by key and channel, both validated here
 * rather than by a database constraint.
 *
 * THE READINESS VALUES ARE A HONEST MAP OF WHAT EXISTS, checked against the code rather than
 * aspirational. Every `pending` below is a sender still to be built, and they are the six the audit
 * asked about:
 *
 *   in-app  is live wherever the Notification Centre already surfaces the event — it reads
 *           `audit_logs`, `transaction_reviews` and `transaction_reminders`, so those categories
 *           genuinely appear in-app today.
 *   email   is live where a mailer already sends for that event.
 *   push    is live for exactly one category. `web-push.service.ts` is the only push sender in the
 *           codebase and calendar reminders are the only thing that calls it.
 */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  {
    key: 'calendar_reminders',
    label: 'Calendar reminders',
    description: 'Before a showing, closing or appointment you have been reminded about.',
    // In-app via the dispatcher in `event-reminder.service.ts`; email and push are sent there too,
    // each by its own long-standing path.
    channels: { in_app: 'live', email: 'live', push: 'live' },
  },
  {
    key: 'listing_expiry',
    label: 'Listing expiry reminders',
    description: 'A listing is approaching its expiry date, or has just expired.',
    // In-app is the `transaction_reminders` row the Centre reads; push goes through the dispatcher
    // from `reminder-sweep.service.ts`.
    channels: { in_app: 'live', email: 'live', push: 'live' },
    areas: ['desk'],
  },
  {
    key: 'lawyer_details',
    label: 'Lawyer detail reminders',
    description: 'A deal has reached a phase where the lawyer’s details are still missing.',
    // Same sweep, same dispatcher call, keyed on the reminder's kind.
    channels: { in_app: 'live', email: 'live', push: 'live' },
    areas: ['desk'],
  },
  {
    key: 'document_review',
    label: 'Document review updates',
    description: 'A document you uploaded has been accepted, rejected or sent back for changes.',
    // in-app  the `DocReview` audit row the Centre reads
    // email    `DocumentMailService.sendReviewOutcome`, now gated on this preference
    // push     dispatched from `documents.service.ts` beside the audit row
    channels: { in_app: 'live', email: 'live', push: 'live' },
    areas: ['desk'],
  },
  {
    key: 'transaction_approvals',
    label: 'Transaction approvals',
    description: 'A correction or review on one of your deals has been approved or turned down.',
    // in-app and email were already sent by `announce`; push joins them through the dispatcher.
    channels: { in_app: 'live', email: 'live', push: 'live' },
    areas: ['desk'],
  },
  {
    key: 'inbox_new_mail',
    label: 'New inbox emails',
    description: 'Mail arriving in a mailbox you have connected.',
    /*
     * Email is `unsupported` on purpose rather than `pending`: emailing somebody to tell them they
     * have an email is a loop nobody wants, and offering a toggle for it would imply we might.
     */
    // One summary per poll rather than one per message — see `imap-sync.service.ts`.
    channels: { in_app: 'live', email: 'unsupported', push: 'live' },
  },
  /*
   * ---------------------------------------------------------------- CRM lead and campaign events
   *
   * All six are delivered by `NotificationDispatcher` from their own event sites, so every channel
   * is 'live' from the moment the category exists — there is no half-built cell here. They follow
   * the naming already used above: a snake_case key, a plain label, and a description written for
   * the person reading the settings screen rather than for a developer.
   */
  {
    key: 'lead_new',
    label: 'New leads',
    description: 'A lead is added to your book, however it arrived.',
    channels: { in_app: 'live', email: 'live', push: 'live' },
  },
  {
    key: 'lead_assigned',
    label: 'Leads assigned to you',
    description: 'Somebody assigns or transfers a lead to you.',
    channels: { in_app: 'live', email: 'live', push: 'live' },
  },
  {
    key: 'lead_meta',
    label: 'Facebook leads',
    description: 'A new lead arrives from a Meta lead form.',
    channels: { in_app: 'live', email: 'live', push: 'live' },
  },
  {
    key: 'lead_task_due',
    label: 'Follow-ups falling due',
    description: 'A follow-up or task on one of your leads reaches its due date.',
    channels: { in_app: 'live', email: 'live', push: 'live' },
  },
  {
    key: 'campaign_completed',
    label: 'Campaign finished',
    description: 'A campaign you own finishes sending.',
    channels: { in_app: 'live', email: 'live', push: 'live' },
  },
  {
    key: 'campaign_failed',
    label: 'Campaign problems',
    description: 'A campaign you own stops before it could finish.',
    channels: { in_app: 'live', email: 'live', push: 'live' },
  },
  {
    key: 'chat_mentions',
    label: 'Team chat mentions',
    description: 'Somebody mentions you in a deal’s chat.',
    /*
     * All three through the dispatcher from `messages.service.ts`. This was the last category with
     * no sender, and the reason was that the FEATURE did not exist — there was no mention parsing,
     * no resolution to a person and no access rule, so there was no event to notify anybody about.
     *
     * A mention only ever reaches somebody who can already open the deal; see `mention.service.ts`.
     */
    channels: { in_app: 'live', email: 'live', push: 'live' },
    areas: ['desk'],
  },
] as const;

const KEYS = new Set(NOTIFICATION_CATEGORIES.map((c) => c.key));
const BY_KEY = new Map(NOTIFICATION_CATEGORIES.map((c) => [c.key, c]));

export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORIES)[number]['key'];

/** One person's answer for one category, across every channel. */
export type ChannelChoices = Record<NotificationChannel, boolean>;

@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The definition of one category, or undefined.
   *
   * Static so callers that only need the shape — the dispatcher asking whether a channel exists for
   * a category — do not have to inject the service or keep a second copy of the map.
   */
  static categoryFor(key: string): NotificationCategory | undefined {
    return BY_KEY.get(key);
  }

  /**
   * Is this person willing to receive this category on this channel?
   *
   * `channel` defaults to 'push' so every existing caller keeps its exact previous meaning — before
   * channels existed, this table only ever described push, and `web-push.service.ts` is the one
   * consumer.
   *
   * Defaults to **true** on absence, and on anything unexpected — an unknown key, an unknown
   * channel, or a database error. Failing open is the right way round: the cost of a notification
   * somebody meant to mute is an annoyance; the cost of silently swallowing a closing reminder is a
   * missed closing.
   *
   * An `unsupported` pair answers false, because nothing should be sent on a channel this category
   * does not have.
   */
  async isEnabled(userId: number, category: string, channel: NotificationChannel = 'push'): Promise<boolean> {
    if (!userId || userId < 0) return true;
    if (BY_KEY.get(category)?.channels[channel] === 'unsupported') return false;
    try {
      const row = await this.prisma.notification_preferences.findUnique({
        where: { user_id_category_channel: { user_id: userId, category, channel } },
        select: { enabled: true },
      });
      return row ? row.enabled : true;
    } catch {
      return true;
    }
  }

  /**
   * Every channel this person is willing to be reached on for a category.
   *
   * One query rather than three, because the send path asks this question for every recipient of
   * every event — see `NotificationDispatcher`.
   */
  async channelsFor(userId: number, category: string): Promise<ChannelChoices> {
    const definition = BY_KEY.get(category);
    const answer = { in_app: true, email: true, push: true } as ChannelChoices;
    if (!userId || userId < 0) return answer;

    try {
      const rows = await this.prisma.notification_preferences.findMany({
        where: { user_id: userId, category },
        select: { channel: true, enabled: true },
      });
      for (const row of rows) {
        if (CHANNEL_SET.has(row.channel)) answer[row.channel as NotificationChannel] = row.enabled;
      }
    } catch {
      // Fail open, as above.
    }

    // A channel with no sender for this category is never "on", whatever is stored.
    if (definition) {
      for (const channel of NOTIFICATION_CHANNELS) {
        if (definition.channels[channel] === 'unsupported') answer[channel] = false;
      }
    }
    return answer;
  }

  /** Every category with this user's choices, for the Settings screen. */
  async list(userId: number): Promise<{
    channels: readonly NotificationChannel[];
    categories: (NotificationCategory & { enabled: ChannelChoices })[];
  }> {
    const rows = userId > 0
      ? await this.prisma.notification_preferences.findMany({
        where: { user_id: userId },
        select: { category: true, channel: true, enabled: true },
      })
      : [];

    const chosen = new Map<string, boolean>();
    for (const row of rows) chosen.set(`${row.category}:${row.channel}`, row.enabled);

    return {
      channels: NOTIFICATION_CHANNELS,
      categories: NOTIFICATION_CATEGORIES.map((c) => ({
        ...c,
        enabled: NOTIFICATION_CHANNELS.reduce((acc, channel) => {
          // Absence means on, except where the pair is unsupported.
          acc[channel] = c.channels[channel] === 'unsupported'
            ? false
            : chosen.get(`${c.key}:${channel}`) ?? true;
          return acc;
        }, {} as ChannelChoices),
      })),
    };
  }

  /**
   * Record one choice.
   *
   * Upsert rather than update: a row exists only once somebody has expressed a preference, so the
   * first change for any pair is an insert.
   */
  async set(userId: number, category: string, channel: string, enabled: boolean): Promise<{ category: string; channel: string; enabled: boolean }> {
    if (!KEYS.has(category)) {
      throw new BadRequestException({
        message: `Unknown notification category "${category}".`,
        errors: { category: [`Unknown notification category "${category}".`] },
      });
    }
    if (!CHANNEL_SET.has(channel)) {
      throw new BadRequestException({
        message: `Unknown notification channel "${channel}".`,
        errors: { channel: [`Unknown notification channel "${channel}".`] },
      });
    }
    if (BY_KEY.get(category)!.channels[channel as NotificationChannel] === 'unsupported') {
      throw new BadRequestException({
        message: `"${category}" cannot be delivered by ${channel}.`,
        errors: { channel: [`"${category}" cannot be delivered by ${channel}.`] },
      });
    }

    const now = new Date();
    await this.prisma.notification_preferences.upsert({
      where: { user_id_category_channel: { user_id: userId, category, channel } },
      create: { user_id: userId, category, channel, enabled, created_at: now, updated_at: now },
      update: { enabled, updated_at: now },
    });
    return { category, channel, enabled };
  }

  /**
   * Apply the whole matrix at once, which is what the screen does on Save.
   *
   * Shape: `{ [category]: { [channel]: boolean } }`.
   *
   * Sequential rather than one transaction, on purpose: these are independent rows and a
   * half-applied save is a partial state the next save fixes, not a corrupt one. Wrapping them would
   * buy atomicity nobody needs at the cost of holding a transaction open across an arbitrary number
   * of upserts.
   */
  async setMany(
    userId: number,
    prefs: Record<string, Record<string, boolean>>,
  ): Promise<Awaited<ReturnType<NotificationPreferenceService['list']>>> {
    for (const [category, channels] of Object.entries(prefs ?? {})) {
      if (!channels || typeof channels !== 'object') continue;
      for (const [channel, enabled] of Object.entries(channels)) {
        await this.set(userId, category, channel, enabled === true);
      }
    }
    return this.list(userId);
  }
}
