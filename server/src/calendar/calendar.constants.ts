/**
 * Calendar vocabularies. These mirror the event types/statuses used by the source calendar
 * implementation so imported data keeps its meaning.
 */

/** Event kinds offered when creating an appointment. */
export const EVENT_TYPES = [
  'viewing',
  'meeting',
  'open-house',
  'follow-up',
  'call',
  'showing',
  'task',
] as const;

/** Lifecycle of an appointment. */
export const EVENT_STATUSES = ['scheduled', 'completed', 'cancelled', 'rescheduled'] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Human labels for the UI (the stored value stays kebab-case). */
export const EVENT_TYPE_LABELS: Record<string, string> = {
  viewing: 'Property Viewing',
  meeting: 'Meeting',
  'open-house': 'Open House',
  'follow-up': 'Follow-up',
  call: 'Call',
  showing: 'Showing',
  task: 'Task',
};

export const isEventType = (v: unknown): v is EventType =>
  (EVENT_TYPES as readonly string[]).includes(String(v));

export const isEventStatus = (v: unknown): v is EventStatus =>
  (EVENT_STATUSES as readonly string[]).includes(String(v));
