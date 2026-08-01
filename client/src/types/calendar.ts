/** Calendar event types (mirrors the server's calendar.constants). */
export type EventType =
  | 'viewing' | 'meeting' | 'open-house' | 'follow-up' | 'call' | 'showing'
  | 'inspection' | 'closing' | 'task';
export type EventStatus = 'scheduled' | 'completed' | 'cancelled' | 'no-show' | 'rescheduled';

/** One appointment as returned by the API. */
export interface CalendarEvent {
  id: number;
  title: string;
  /** yyyy-mm-dd */
  date: string;
  /** 24-hour HH:MM */
  time: string;
  /** Optional 24-hour HH:MM end. Null means a one-hour slot for conflict checking. */
  end_time: string | null;
  /** Bumped on every save. Sent back when editing so a stale write is refused, not applied. */
  version: number;
  /** The series this belongs to — the id of its first occurrence. Null for a one-off. */
  recurrence_id: number | null;
  /** The rule, carried by the first occurrence only. */
  recur_freq: string | null;
  type: EventType;
  status: EventStatus;
  location: string | null;
  description: string | null;
  attendees: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  property_details: string | null;
  notes: string | null;
  enable_reminder: boolean;
  reminder_sent: boolean;
  /** Optional link to a deal — this app's equivalent of the source calendar's lead link. */
  transaction_id: number | null;
  trade_no: string | null;
  transaction_property: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** The payload sent when creating or updating an event. */
export interface CalendarEventInput {
  title: string;
  date: string;
  time: string;
  /** Optional end. Null or omitted means a one-hour slot. */
  end_time?: string | null;
  /** Save despite overlapping another appointment — back-to-back showings are legitimate. */
  allow_overlap?: boolean;
  /** The version the editor was opened on. */
  version?: number;
  /** Repeat rule, on create only. Omitted or 'none' makes a single appointment. */
  recur_freq?: 'none' | 'daily' | 'weekly' | 'monthly';
  recur_interval?: number;
  recur_until?: string | null;
  recur_count?: number | null;
  type: EventType;
  status: EventStatus;
  location?: string;
  description?: string;
  attendees?: string;
  contact_phone?: string;
  contact_email?: string;
  property_details?: string;
  notes?: string;
  enable_reminder?: boolean;
  transaction_id?: number | null;
}

/** Vocabularies for the event form. */
export interface CalendarOptions {
  types: { value: EventType; label: string }[];
  statuses: { value: EventStatus; label: string }[];
}

/** A Canadian statutory holiday, observance or cultural festival. Computed server-side. */
export interface Holiday {
  date: string;
  name: string;
  kind: 'statutory' | 'observance' | 'festival';
  provinces: string[];
  national: boolean;
  /** Lunar/lunisolar date that should be confirmed locally. */
  approximate: boolean;
}

export interface HolidayResponse {
  province: string;
  /** Years the festival table covers; outside these only statutory days appear. */
  festival_years: number[];
  data: Holiday[];
}
