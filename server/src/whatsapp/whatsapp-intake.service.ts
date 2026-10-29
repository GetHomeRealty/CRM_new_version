import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../meta/meta-lead-mapper';
import { CrmEventNotifier } from '../notifications/crm-events.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { WhatsAppRotationService } from './whatsapp-rotation.service';
import { InboundWhatsApp, WHATSAPP_LEAD_SOURCE, whatsappPhoneNumberId } from './whatsapp.constants';
import type { DutySlot } from './whatsapp-rotation';

export type IntakeOutcome = 'created' | 'appended' | 'duplicate' | 'skipped';

export interface IntakeResult {
  outcome: IntakeOutcome;
  leadId?: number;
  assignedUserId?: number | null;
}

const ACTOR = 'WhatsApp rotation';

/** What one message's transaction decided, for the notifications sent after it commits. */
interface Written {
  outcome: 'created' | 'appended';
  leadId: number;
  leadName: string;
  firstName: string | null;
  lastName: string | null;
  assignedUserId: number | null;
  /** The rotation chose the assignee just now (a new lead, or an unheld one picked up). */
  byRotation: boolean;
}

/** Part of a moment in the brokerage's own time, for the lead's assignment history. */
function fmt(d: Date, parts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'America/Toronto', ...parts }).format(d);
}

/**
 * The turn a message arrived in: "on duty Oct 29, 2:00 p.m. – 4:00 p.m.", with the second date
 * only when the turn runs past midnight.
 */
export function turnLabel(slot: Pick<DutySlot, 'starts_at' | 'ends_at'>): string {
  const day = { month: 'short', day: 'numeric' } as const;
  const time = { hour: 'numeric', minute: '2-digit' } as const;
  const sameDay = fmt(slot.starts_at, day) === fmt(slot.ends_at, day);
  const end = sameDay ? fmt(slot.ends_at, time) : fmt(slot.ends_at, { ...day, ...time });
  return `on duty ${fmt(slot.starts_at, { ...day, ...time })} – ${end}`;
}

function splitName(full: string): { first: string | null; last: string | null } {
  const parts = full.split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

/**
 * Turns an incoming WhatsApp message into CRM work, with no manual step.
 *
 *   A NEW NUMBER  creates a lead (source WhatsApp) and assigns it to whoever is on duty in the
 *                 WhatsApp rotation at the moment the message arrived. The assignment is written to
 *                 the lead's ownership history with that person's turn, and they are notified.
 *   A KNOWN NUMBER adds the message to that lead's message history and tells its handler. The lead
 *                 stays with the person already working it; only a brokerage lead nobody holds is
 *                 given to whoever is on duty.
 *
 * Everything for one message is written in ONE transaction keyed on WhatsApp's message id, so a
 * delivery Meta repeats is recorded once. A per-number advisory lock stops three quick messages
 * from a new customer creating three leads. Notifications go out only after the commit.
 */
@Injectable()
export class WhatsAppIntakeService {
  private readonly log = new Logger(WhatsAppIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rotation: WhatsAppRotationService,
    private readonly events: CrmEventNotifier,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async ingest(m: InboundWhatsApp): Promise<IntakeResult> {
    const only = whatsappPhoneNumberId();
    if (only && m.phoneNumberId && m.phoneNumberId !== only) {
      this.log.debug(`WhatsApp message to number ${m.phoneNumberId} ignored (not WHATSAPP_PHONE_NUMBER_ID).`);
      return { outcome: 'skipped' };
    }
    const normalized = normalizePhone(m.from);
    if (!normalized) return { outcome: 'skipped' };

    const seen = await this.prisma.whatsapp_intake.findUnique({ where: { wa_message_id: m.id }, select: { lead_id: true } });
    if (seen) return { outcome: 'duplicate', leadId: seen.lead_id };

    const phone = `+${m.from}`;
    const body = (m.text || `[${m.type}]`).slice(0, 5000);
    const now = new Date();
    // The turn is decided by when the CUSTOMER sent it, not by when Meta got round to delivering it.
    const duty = await this.rotation.onDuty(m.receivedAt);

    let result: Written;
    try {
      result = await this.prisma.$transaction(async (tx): Promise<Written> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`whatsapp:${normalized}`}))`;

        const existing = await tx.leads.findFirst({
          where: { deleted_at: null, OR: [{ phone_normalized: normalized }, { phone }] },
          orderBy: { id: 'desc' },
          select: { id: true, name: true, first_name: true, last_name: true, assigned_to: true, owner_user_id: true, team_id: true },
        });

        let leadId: number;
        let assignee: number | null;
        let slot: DutySlot | null = null;
        let isNew = false;
        let leadName: string;
        let firstName: string | null;
        let lastName: string | null;

        if (existing) {
          leadId = existing.id;
          leadName = existing.name;
          firstName = existing.first_name;
          lastName = existing.last_name;
          assignee = existing.assigned_to ?? existing.owner_user_id;
          // A brokerage lead nobody holds (and no team is routing) is picked up by the duty member.
          if (!assignee && existing.team_id === null && duty) {
            slot = duty;
            assignee = duty.user_id;
            await tx.leads.update({ where: { id: leadId }, data: { assigned_to: duty.user_id, updated_at: now } });
          }
        } else {
          isNew = true;
          const name = m.profileName?.trim() || `WhatsApp ${phone}`;
          const split = m.profileName ? splitName(m.profileName) : { first: null, last: null };
          firstName = split.first;
          lastName = split.last;
          leadName = name;
          slot = duty;
          assignee = duty?.user_id ?? null;
          const row = await tx.leads.create({
            data: {
              name: name.slice(0, 255),
              first_name: firstName?.slice(0, 128) ?? null,
              last_name: lastName?.slice(0, 128) ?? null,
              phone,
              phone_normalized: normalized,
              lead_status: 'cold',
              lead_response: 'active',
              lead_source: WHATSAPP_LEAD_SOURCE,
              source: WHATSAPP_LEAD_SOURCE,
              message: body,
              tags: JSON.stringify([]),
              assigned_to: assignee,
              owner_user_id: null,
              created_by: 'WhatsApp',
              created_at: now,
              updated_at: now,
            },
            select: { id: true },
          });
          leadId = row.id;
        }

        await tx.lead_messages.create({
          data: {
            lead_id: leadId, direction: 'inbound', status: null, body, phone,
            sent_at: m.receivedAt, created_by: 'WhatsApp', created_at: now,
          },
        });

        const assigneeName = assignee
          ? (await tx.users.findUnique({ where: { id: assignee }, select: { name: true } }))?.name ?? null
          : null;

        await tx.whatsapp_intake.create({
          data: {
            wa_message_id: m.id.slice(0, 128),
            lead_id: leadId,
            from_phone: phone.slice(0, 32),
            profile_name: m.profileName?.slice(0, 255) ?? null,
            message_type: (m.type || 'text').slice(0, 24),
            body,
            is_new_lead: isNew,
            assigned_user_id: assignee,
            assigned_user_name: assigneeName,
            slot_starts_at: slot?.starts_at ?? null,
            slot_ends_at: slot?.ends_at ?? null,
            received_at: m.receivedAt,
            created_at: now,
          },
        });

        // The lead screen's ownership history: who it went to, and in which turn.
        if (slot) {
          await tx.crm_lead_assignment_events.create({
            data: {
              lead_id: leadId,
              action: 'agent_assigned',
              to_user_id: slot.user_id,
              to_user_name: assigneeName ?? slot.name,
              actor_user_id: null,
              actor_name: ACTOR,
              description: `${assigneeName ?? slot.name} assigned as handling agent (${ACTOR}, ${turnLabel(slot)})`,
              created_at: now,
            },
          });
        }

        return {
          outcome: isNew ? 'created' : 'appended',
          leadId, leadName, firstName, lastName, assignedUserId: assignee, byRotation: slot !== null,
        };
      });
    } catch (err) {
      // Two deliveries of one message racing: the unique message id let exactly one through.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { outcome: 'duplicate' };
      }
      throw err;
    }

    if (result.assignedUserId && result.byRotation) {
      await this.events.leadAssigned(
        { id: result.leadId, first_name: result.firstName ?? result.leadName, last_name: result.lastName },
        result.assignedUserId, null, ACTOR,
      );
    } else if (result.assignedUserId) {
      await this.messageNotice(result.assignedUserId, result.leadId, result.leadName, body, m.id);
    }
    this.log.log(`WhatsApp ${m.id} from ${phone}: ${result.outcome} lead #${result.leadId}`
      + (result.assignedUserId ? ` → user #${result.assignedUserId}` : ' (nobody on duty — left unassigned)'));
    return { outcome: result.outcome, leadId: result.leadId, assignedUserId: result.assignedUserId };
  }

  /** "New WhatsApp message" for the person already handling the lead. In-app and push, no email. */
  private async messageNotice(userId: number, leadId: number, leadName: string, body: string, messageId: string): Promise<void> {
    try {
      await this.dispatcher.dispatch({
        category: 'lead_assigned',
        userId,
        title: 'New WhatsApp message',
        body: `${leadName}: ${body.length > 140 ? `${body.slice(0, 140)}…` : body}`,
        link: `/crm/lead/${leadId}`,
        dedupeKey: `whatsapp-message:${messageId}`.slice(0, 190),
        channels: ['in_app', 'push'],
      });
    } catch (err) {
      this.log.warn(`Could not notify user #${userId} about WhatsApp message ${messageId}: ${(err as Error).message}`);
    }
  }
}
