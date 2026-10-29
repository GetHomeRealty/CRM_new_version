/**
 * WHO IS ON WHATSAPP DUTY — counted from the clock, never stored.
 *
 * The rota is a list of people in turn order, each with a turn length. Member 1's first turn began
 * at `cycleStart`; member 2's began when it ended, and so on, and after the last member it starts
 * again at member 1. So the person on duty at any moment is pure arithmetic over three facts, and
 * nothing has to run when a turn ends for the next message to reach the next person.
 *
 * Paused members and people whose account is Inactive are left out by the caller BEFORE this runs,
 * so the turns of those who remain close up rather than leaving a gap nobody covers.
 */

export const MIN_TURN_MINUTES = 5;
/** One week. Longer than that is not a rotation. */
export const MAX_TURN_MINUTES = 10_080;

export interface RotaMember {
  user_id: number;
  name: string;
  duration_minutes: number;
}

export interface DutySlot {
  user_id: number;
  name: string;
  starts_at: Date;
  ends_at: Date;
}

const MINUTE = 60_000;

/** The member on duty at `at`, with the start and end of their current turn. Null with no rota. */
export function dutyAt(members: readonly RotaMember[], cycleStart: Date, at: Date): DutySlot | null {
  const turns = members.filter((m) => Number.isInteger(m.duration_minutes) && m.duration_minutes > 0);
  const cycleMs = turns.reduce((sum, m) => sum + m.duration_minutes * MINUTE, 0);
  if (!turns.length || cycleMs <= 0) return null;

  // Math.floor, not truncation, so a moment before `cycleStart` lands in the previous cycle rather
  // than being counted backwards into the wrong turn.
  const cycles = Math.floor((at.getTime() - cycleStart.getTime()) / cycleMs);
  let turnStart = cycleStart.getTime() + cycles * cycleMs;
  for (const m of turns) {
    const turnEnd = turnStart + m.duration_minutes * MINUTE;
    if (at.getTime() < turnEnd) {
      return { user_id: m.user_id, name: m.name, starts_at: new Date(turnStart), ends_at: new Date(turnEnd) };
    }
    turnStart = turnEnd;
  }
  // Unreachable: the offset into the cycle is always shorter than the cycle.
  return null;
}

/** The current turn and the `count - 1` after it, for the settings screen's schedule. */
export function upcomingTurns(members: readonly RotaMember[], cycleStart: Date, from: Date, count: number): DutySlot[] {
  const out: DutySlot[] = [];
  let at = from;
  for (let i = 0; i < count; i++) {
    const slot = dutyAt(members, cycleStart, at);
    if (!slot) break;
    out.push(slot);
    at = slot.ends_at;
  }
  return out;
}
