import { CrmEventNotifier } from './crm-events.service';
import { NOTIFICATION_CATEGORIES } from './notification-preference.service';
import { MAIL_EVENTS } from '../email/mail-event-registry';
import { ACTIVE_CRM_COMMUNICATIONS } from '../crm-settings/crm-communications.registry';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationDispatcher } from './notification-dispatcher.service';

/**
 * Two events that did not exist: a task being ASSIGNED, and a showing being BOOKED.
 *
 * WHAT WAS WRONG. `addTask` and `addShowing` wrote their row and told nobody. The only task-shaped
 * notification was `lead_task_due`, raised by the 30-minute sweep when the date arrives — so being
 * handed a job produced silence, and a task assigned for next month notified nobody until next
 * month. A showing produced silence permanently: it raises no event and creates no calendar entry,
 * so it never picked up calendar reminders either.
 *
 * The risk in adding them is not that they fail to send. It is that they QUIETLY REPLACE the due
 * reminder, or notify the wrong person. Both are pinned below.
 */

const dispatched: Record<string, unknown>[] = [];

function notifier() {
  dispatched.length = 0;
  const prisma = {
    email_templates: { findUnique: async () => null, create: async () => ({}) },
    users: { findUnique: async () => ({ name: 'Dana Okafor', email: 'dana@example.test' }) },
  } as unknown as PrismaService;
  const dispatcher = {
    dispatch: async (r: Record<string, unknown>) => { dispatched.push(r); },
  } as unknown as NotificationDispatcher;
  // Constructor order is (dispatcher, prisma) — getting it the wrong way round fails silently,
  // because `send()` swallows dispatch errors by design.
  return new CrmEventNotifier(dispatcher, prisma);
}

const LEAD = { id: 77, first_name: 'John Smith', last_name: null, email: 'john@example.test' };
const TASK = { id: 5, title: 'Follow up with John Smith', due_date: new Date('2026-08-25T00:00:00Z') };
const SHOWING = { id: 9, property: '123 Main Street', showing_date: new Date('2026-08-25T00:00:00Z'), time: '14:00' };

describe('the two new categories are registered like every other one', () => {
  it('both exist in NOTIFICATION_CATEGORIES with all three channels live', () => {
    for (const key of ['task_assigned', 'showing_created']) {
      const cat = NOTIFICATION_CATEGORIES.find((c) => c.key === key);
      expect(cat).toBeDefined();
      expect(cat!.channels).toEqual({ in_app: 'live', email: 'live', push: 'live' });
    }
  });

  it('both have a mail template, so email is not hard-coded in a service', () => {
    expect(MAIL_EVENTS['crm.task_assigned']).toBeDefined();
    expect(MAIL_EVENTS['crm.showing_created']).toBeDefined();
    expect(MAIL_EVENTS['crm.task_assigned'].default_subject).toContain('{{ task_title }}');
    expect(MAIL_EVENTS['crm.showing_created'].default_subject).toContain('{{ property }}');
  });

  it('both appear on the Communications screen, wired to their preference and template', () => {
    for (const [key, tpl] of [['task_assigned', 'crm.task_assigned'], ['showing_created', 'crm.showing_created']]) {
      const row = ACTIVE_CRM_COMMUNICATIONS.find((c) => c.key === key);
      expect(row).toBeDefined();
      expect(row!.preferenceCategory).toBe(key);
      expect(row!.templateEventKey).toBe(tpl);
      expect(row!.audience).toBe('staff');
    }
  });

  it('leaves every pre-existing category untouched', () => {
    // The six that already existed must still be there, spelled the same way.
    for (const key of ['lead_new', 'lead_assigned', 'lead_meta', 'lead_task_due', 'campaign_completed', 'campaign_failed']) {
      expect(NOTIFICATION_CATEGORIES.find((c) => c.key === key)).toBeDefined();
    }
  });
});

describe('task assigned', () => {
  it('notifies the assignee, not the person who assigned it', async () => {
    await notifier().taskAssigned(TASK, LEAD, 42, 7, 'Priya Raman');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].userId).toBe(42);
    expect(dispatched[0].category).toBe('task_assigned');
  });

  it('says nothing when you assign a task to yourself', async () => {
    await notifier().taskAssigned(TASK, LEAD, 7, 7, 'Priya Raman');
    expect(dispatched).toHaveLength(0);
  });

  it('says nothing when there is no assignee', async () => {
    await notifier().taskAssigned(TASK, LEAD, null, 7, 'Priya Raman');
    expect(dispatched).toHaveLength(0);
  });

  it('carries the task, the lead and the due date', async () => {
    await notifier().taskAssigned(TASK, LEAD, 42, 7, 'Priya Raman');
    expect(dispatched[0].title).toBe('New task assigned');
    expect(String(dispatched[0].body)).toContain('Follow up with John Smith');
    expect(String(dispatched[0].body)).toContain('John Smith');
    expect(String(dispatched[0].body)).toContain('2026-08-25');
    expect(String(dispatched[0].link)).toContain('77');
  });

  it('cannot notify twice for the same task and assignee', async () => {
    const n = notifier();
    await n.taskAssigned(TASK, LEAD, 42, 7, 'Priya');
    await n.taskAssigned(TASK, LEAD, 42, 7, 'Priya');
    // Two dispatches, ONE dedupe key — the ledger's unique claim drops the second.
    expect(new Set(dispatched.map((d) => d.dedupeKey)).size).toBe(1);
    expect(dispatched[0].dedupeKey).toBe('task-assigned:5:42');
  });

  it('reassignment to somebody else is a different occurrence and does notify', async () => {
    const n = notifier();
    await n.taskAssigned(TASK, LEAD, 42, 7, 'Priya');
    await n.taskAssigned(TASK, LEAD, 43, 7, 'Priya');
    expect(new Set(dispatched.map((d) => d.dedupeKey)).size).toBe(2);
  });
});

describe('showing created', () => {
  it('notifies the lead\'s agent, not the person who booked it', async () => {
    await notifier().showingCreated(SHOWING, LEAD, 42, 7, 'Priya Raman');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].userId).toBe(42);
    expect(dispatched[0].category).toBe('showing_created');
  });

  it('says nothing when the agent booked it themselves', async () => {
    await notifier().showingCreated(SHOWING, LEAD, 7, 7, 'Priya Raman');
    expect(dispatched).toHaveLength(0);
  });

  it('carries property, client, date and time', async () => {
    await notifier().showingCreated(SHOWING, LEAD, 42, 7, 'Priya Raman');
    const body = String(dispatched[0].body);
    expect(dispatched[0].title).toBe('New showing scheduled');
    expect(body).toContain('123 Main Street');
    expect(body).toContain('John Smith');
    expect(body).toContain('2026-08-25');
    expect(body).toContain('14:00');
  });

  it('cannot notify twice for the same showing', async () => {
    const n = notifier();
    await n.showingCreated(SHOWING, LEAD, 42, 7, 'Priya');
    await n.showingCreated(SHOWING, LEAD, 42, 7, 'Priya');
    expect(new Set(dispatched.map((d) => d.dedupeKey)).size).toBe(1);
    expect(dispatched[0].dedupeKey).toBe('showing-created:9:42');
  });
});

describe('the existing task-due reminder is untouched', () => {
  it('still raises lead_task_due, with its own category and its own key shape', async () => {
    const n = notifier();
    await n.leadTaskDue({ id: 5, title: 'Follow up', due_at: new Date('2026-08-25T00:00:00Z') }, LEAD, 42, '2026-08-25');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].category).toBe('lead_task_due');
    expect(dispatched[0].dedupeKey).toBe('lead-task-due:5:2026-08-25');
  });

  it('assignment and due are separate events for the same task — neither suppresses the other', async () => {
    const n = notifier();
    await n.taskAssigned(TASK, LEAD, 42, 7, 'Priya');
    await n.leadTaskDue({ id: 5, title: 'Follow up', due_at: new Date('2026-08-25T00:00:00Z') }, LEAD, 42, '2026-08-25');
    expect(dispatched.map((d) => d.category)).toEqual(['task_assigned', 'lead_task_due']);
    // Different keys, so the ledger treats them as different occurrences and both are delivered.
    expect(new Set(dispatched.map((d) => d.dedupeKey)).size).toBe(2);
  });
});
