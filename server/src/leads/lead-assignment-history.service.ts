import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The two halves of a lead's ownership that the history records: which team, and who handles it. */
export interface AssignmentSide {
  team_id: number | null;
  team_name?: string | null;
  assigned_to: number | null;
  assigned_name?: string | null;
}

/** Who made the change. `null` is the system acting on its own, e.g. a deactivation. */
export interface AssignmentActor {
  id: number | null;
  name: string | null;
}

/** One row of a lead's ownership history, as the lead screen shows it. */
export interface AssignmentEvent {
  id: number;
  action: string;
  description: string;
  from_team_name: string | null;
  to_team_name: string | null;
  from_user_name: string | null;
  to_user_name: string | null;
  actor_name: string | null;
  created_at: string;
}

type EventRow = {
  lead_id: number; action: string; description: string;
  from_team_id: number | null; from_team_name: string | null;
  to_team_id: number | null; to_team_name: string | null;
  from_user_id: number | null; from_user_name: string | null;
  to_user_id: number | null; to_user_name: string | null;
  actor_user_id: number | null; actor_name: string | null;
  created_at: Date;
};

/**
 * THE HISTORY OF WHO OWNS AND WHO HANDLES A LEAD — team moves, agent assignment, reassignment,
 * removal.
 *
 * Activity on the lead (calls, notes, tasks, showings, messages) already records the person who
 * did it on its own row, so it is not repeated here. What had no record was the ownership side:
 * `assigned_to` was simply overwritten, so "who was handling this in March?" had no answer.
 *
 * TEAM AND AGENT ARE RECORDED AS SEPARATE EVENTS, because they are separate facts. Moving a lead to
 * another team and choosing its handler in the same save produces two rows, and reassigning the
 * handler within a team produces one row that never mentions the team — it did not change.
 *
 * Names are snapshotted beside the ids, so the history still reads correctly after a team is
 * renamed or a person leaves.
 *
 * BEST-EFFORT, like `LeadAuditService`: a history row that fails to write must never undo or block
 * the assignment it describes. Failures are logged.
 */
@Injectable()
export class LeadAssignmentHistoryService {
  private readonly log = new Logger(LeadAssignmentHistoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The events one change produces, without writing them. Exported for the bulk paths. */
  build(leadId: number, before: AssignmentSide, after: AssignmentSide, actor: AssignmentActor | null, reason?: string): EventRow[] {
    const rows: EventRow[] = [];
    const now = new Date();
    const base = {
      lead_id: leadId,
      from_team_id: before.team_id, from_team_name: before.team_name ?? null,
      to_team_id: after.team_id, to_team_name: after.team_name ?? null,
      from_user_id: before.assigned_to, from_user_name: before.assigned_name ?? null,
      to_user_id: after.assigned_to, to_user_name: after.assigned_name ?? null,
      actor_user_id: actor?.id ?? null, actor_name: actor?.name ?? null,
      created_at: now,
    };
    const suffix = reason ? ` (${reason})` : '';

    if (before.team_id !== after.team_id) {
      if (after.team_id !== null) {
        rows.push({
          ...base, action: 'team_assigned',
          description: before.team_id !== null
            ? `Lead moved from ${before.team_name ?? 'a team'} to ${after.team_name ?? 'a team'}${suffix}`
            : `Lead assigned to ${after.team_name ?? 'a team'}${suffix}`,
        });
      } else {
        rows.push({
          ...base, action: 'team_removed',
          description: `Lead removed from ${before.team_name ?? 'its team'} and returned to the brokerage${suffix}`,
        });
      }
    }

    if (before.assigned_to !== after.assigned_to) {
      const from = before.assigned_name ?? (before.assigned_to ? `user #${before.assigned_to}` : null);
      const to = after.assigned_name ?? (after.assigned_to ? `user #${after.assigned_to}` : null);
      if (before.assigned_to === null) {
        rows.push({ ...base, action: 'agent_assigned', description: `${to} assigned as handling agent${suffix}` });
      } else if (after.assigned_to === null) {
        rows.push({ ...base, action: 'agent_unassigned', description: `Agent assignment removed — ${from} no longer handles this lead${suffix}` });
      } else {
        rows.push({ ...base, action: 'agent_reassigned', description: `Lead reassigned from ${from} to ${to}${suffix}` });
      }
    }
    return rows;
  }

  /** Record one lead's change. Returns the descriptions written, for the audit trail. */
  async record(leadId: number, before: AssignmentSide, after: AssignmentSide, actor: AssignmentActor | null, reason?: string): Promise<string[]> {
    const rows = this.build(leadId, before, after, actor, reason);
    await this.write(rows);
    return rows.map((r) => r.description);
  }

  /** Record many at once — the bulk hand-over and a deactivation clear dozens of leads in one go. */
  async write(rows: EventRow[]): Promise<void> {
    if (!rows.length) return;
    try {
      await this.prisma.crm_lead_assignment_events.createMany({ data: rows });
    } catch (e) {
      this.log.error(`Could not record ${rows.length} lead assignment event(s): ${(e as Error).message}`);
    }
  }

  /** A lead's ownership history, newest first. The caller has already checked the lead is visible. */
  async list(leadId: number, limit = 100): Promise<AssignmentEvent[]> {
    const rows = await this.prisma.crm_lead_assignment_events.findMany({
      where: { lead_id: leadId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      description: r.description,
      from_team_name: r.from_team_name,
      to_team_name: r.to_team_name,
      from_user_name: r.from_user_name,
      to_user_name: r.to_user_name,
      actor_name: r.actor_name,
      created_at: r.created_at.toISOString(),
    }));
  }
}
