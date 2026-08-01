import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Area } from '../common/domain';
import type { AuthUserRecord } from '../auth/auth.types';
import { draftEmailWithAi, resolveEmailAi } from '../common/ai-provider';
import { EVENT_TYPE_LABELS } from './calendar.constants';

/**
 * Suggested follow-ups for an appointment.
 *
 * WHAT THIS IS NOT. It does not summarise a meeting. A summary needs a record of what was said, and
 * the calendar holds no notes taken during an appointment, no recording and no transcript — only
 * what somebody typed before it. A "summary" built from a title and a date would be the model
 * inventing a meeting that it was not at, presented to an agent as a record of one. That is worse
 * than nothing in a business that keeps files for regulators, so it is deliberately not offered.
 *
 * WHAT IT IS. Given what the appointment actually holds — its kind, when it was, its notes, the
 * lead or deal attached — it proposes the next actions. Those are suggestions on screen for a
 * person to accept or ignore; nothing here writes to a lead, sends anything, or changes the diary.
 *
 * WHAT LEAVES THE BUILDING. The prompt carries the appointment's own fields and the linked lead's
 * name — client information, sent to whichever provider is configured. Worth knowing before this
 * is switched on for a brokerage; it is why nothing is sent automatically and why the button says
 * what it will do.
 */

export interface FollowUpSuggestion {
  action: string;
  why: string;
  /** high | medium | low — the model's own ordering, shown as a pill. */
  urgency: string;
  /** A suggested day, yyyy-mm-dd, when the action is time-bound. */
  when: string | null;
}

export interface SuggestionResult {
  event: { id: number; title: string; date: string; type: string; status: string };
  suggestions: FollowUpSuggestion[];
  /** Which provider answered, so a surprising suggestion can be traced to a model. */
  provider: string;
  model: string;
}

const SYSTEM = [
  'You advise a real-estate agent on what to do after an appointment.',
  'You are given ONLY the appointment record — you were not present and have no account of what was said.',
  'Never state what happened at the appointment. Never invent an outcome, a price, a decision or anything a client said.',
  'Suggest concrete next actions that follow from the KIND of appointment, its status, and any notes the agent typed.',
  'Between two and five suggestions. Fewer is better than padding.',
  'If the appointment is cancelled or nobody turned up, say so in the actions — rebooking comes first.',
  'Reply with JSON only: {"suggestions":[{"action":"...","why":"...","urgency":"high|medium|low","when":"YYYY-MM-DD or null"}]}',
  'action: an imperative, under 90 characters. why: one short sentence grounded in the record you were given.',
].join(' ');

@Injectable()
export class EventSuggestionsService {
  constructor(private readonly prisma: PrismaService) {}

  async forEvent(id: number, user: AuthUserRecord, area: Area): Promise<SuggestionResult> {
    const ev = await this.prisma.calendar_events.findFirst({
      where: {
        id, deleted_at: null,
        user_id: user.id ?? -1,
        OR: [{ domain: area }, { domain: null }],
      },
      include: {
        transactions: { select: { trade_no: true, property: true } },
      },
    });
    if (!ev) throw new NotFoundException({ message: 'Event not found.' });

    const cfg = resolveEmailAi();
    if (!cfg) {
      throw new ServiceUnavailableException({
        message: 'AI suggestions are not configured on the server. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, then restart.',
      });
    }

    // Only the lead's NAME, never their address book entry. The suggestion needs to say "call
    // Priya", not carry her phone number and email to a third party to do it.
    const lead = ev.lead_id
      ? await this.prisma.leads.findFirst({ where: { id: ev.lead_id }, select: { name: true, lead_status: true } })
      : null;

    const facts = [
      `Appointment: ${ev.title}`,
      `Kind: ${EVENT_TYPE_LABELS[ev.type] ?? ev.type}`,
      `Date: ${ev.date.toISOString().slice(0, 10)} at ${ev.time}${ev.end_time ? `–${ev.end_time}` : ''}`,
      `Status: ${ev.status}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      ev.location ? `Location: ${ev.location}` : null,
      ev.attendees ? `Attendees: ${ev.attendees}` : null,
      lead ? `Linked lead: ${lead.name}${lead.lead_status ? ` (${lead.lead_status})` : ''}` : null,
      ev.transactions ? `Linked deal: ${ev.transactions.trade_no}${ev.transactions.property ? ` — ${ev.transactions.property}` : ''}` : null,
      ev.description ? `Description: ${ev.description}` : null,
      ev.notes ? `Notes the agent wrote: ${ev.notes}` : null,
      ev.property_details ? `Property details: ${ev.property_details}` : null,
    ].filter(Boolean).join('\n');

    const raw = await draftEmailWithAi(cfg, SYSTEM, facts);
    return {
      event: { id: ev.id, title: ev.title, date: ev.date.toISOString().slice(0, 10), type: ev.type, status: ev.status },
      suggestions: this.parse(raw),
      provider: cfg.provider,
      model: cfg.model,
    };
  }

  /**
   * Read the model's JSON, defensively.
   *
   * A model asked for JSON usually returns JSON and occasionally wraps it in prose or a code fence.
   * Rather than failing the request on that, the first object in the text is taken. Anything that
   * still will not parse becomes a clear error instead of an empty panel that looks like "no ideas".
   */
  private parse(raw: string): FollowUpSuggestion[] {
    const text = String(raw ?? '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new ServiceUnavailableException({ message: 'The AI service did not return usable suggestions. Try again.' });
    }

    let parsed: { suggestions?: unknown };
    try {
      parsed = JSON.parse(text.slice(start, end + 1)) as { suggestions?: unknown };
    } catch {
      throw new ServiceUnavailableException({ message: 'The AI service did not return usable suggestions. Try again.' });
    }

    const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    const clean = list
      .map((s) => s as Record<string, unknown>)
      .map((s) => ({
        action: String(s.action ?? '').trim().slice(0, 200),
        why: String(s.why ?? '').trim().slice(0, 400),
        urgency: ['high', 'medium', 'low'].includes(String(s.urgency)) ? String(s.urgency) : 'medium',
        when: /^\d{4}-\d{2}-\d{2}$/.test(String(s.when ?? '')) ? String(s.when) : null,
      }))
      .filter((s) => s.action !== '')
      // Capped here as well as in the prompt. A prompt is a request; this is the guarantee.
      .slice(0, 5);

    if (!clean.length) {
      throw new ServiceUnavailableException({ message: 'The AI service returned no suggestions for this appointment.' });
    }
    return clean;
  }
}
