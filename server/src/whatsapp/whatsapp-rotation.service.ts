import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isAdminOrAbove } from '../core/authz';
import { throwValidation } from '../common/laravel-exceptions';
import type { AuthUserRecord } from '../auth/auth.types';
import { DutySlot, MAX_TURN_MINUTES, MIN_TURN_MINUTES, RotaMember, dutyAt, upcomingTurns } from './whatsapp-rotation';
import { isWhatsAppConfigured, whatsappPhoneNumberId } from './whatsapp.constants';

export interface RotationMemberView {
  user_id: number;
  name: string;
  role: string | null;
  duration_minutes: number;
  /** Taking turns. A paused member keeps their place but is skipped. */
  is_active: boolean;
  /** The person's account is active. An Inactive account is skipped like a paused member. */
  user_active: boolean;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const slotView = (s: DutySlot) => ({ user_id: s.user_id, name: s.name, starts_at: iso(s.starts_at), ends_at: iso(s.ends_at) });

/**
 * CRM → Settings → WhatsApp Rotation: the rota itself, and the one question the intake asks of it
 * — "who is on duty right now?".
 *
 * Administrators only, like Settings → Teams: choosing who receives the brokerage's WhatsApp
 * enquiries decides whose book those leads land in.
 */
@Injectable()
export class WhatsAppRotationService {
  constructor(private readonly prisma: PrismaService) {}

  private assertManage(user: AuthUserRecord): void {
    if (!isAdminOrAbove(user)) {
      throw new ForbiddenException({ message: 'Only an administrator can manage the WhatsApp rotation.' });
    }
  }

  private settings() {
    return this.prisma.whatsapp_rotation_settings.findFirst({ orderBy: { id: 'asc' } });
  }

  private async members(): Promise<RotationMemberView[]> {
    const rows = await this.prisma.whatsapp_rotation_members.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] });
    if (!rows.length) return [];
    const users = await this.prisma.users.findMany({
      where: { id: { in: rows.map((r) => r.user_id) } },
      select: { id: true, name: true, role: true, status: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = byId.get(r.user_id);
      return {
        user_id: r.user_id,
        name: u?.name ?? `User #${r.user_id}`,
        role: u?.role ?? null,
        duration_minutes: r.duration_minutes,
        is_active: r.is_active,
        user_active: !!u && u.status !== 'Inactive',
      };
    });
  }

  /** The people who actually take turns, in order. */
  private static turnTakers(members: RotationMemberView[]): RotaMember[] {
    return members
      .filter((m) => m.is_active && m.user_active)
      .map((m) => ({ user_id: m.user_id, name: m.name, duration_minutes: m.duration_minutes }));
  }

  /** Who a WhatsApp message arriving at `at` goes to, or null when nobody is (rota off or empty). */
  async onDuty(at: Date = new Date()): Promise<DutySlot | null> {
    const s = await this.settings();
    if (!s || !s.is_enabled) return null;
    return dutyAt(WhatsAppRotationService.turnTakers(await this.members()), s.cycle_starts_at, at);
  }

  /** Everything the settings screen shows. */
  async view(user: AuthUserRecord, now: Date = new Date()) {
    this.assertManage(user);
    const [s, members] = await Promise.all([this.settings(), this.members()]);
    const takers = WhatsAppRotationService.turnTakers(members);
    const turns = s ? upcomingTurns(takers, s.cycle_starts_at, now, 8) : [];
    const recent = await this.prisma.whatsapp_intake.findMany({
      orderBy: [{ received_at: 'desc' }, { id: 'desc' }],
      take: 30,
      select: {
        id: true, lead_id: true, from_phone: true, profile_name: true, body: true, is_new_lead: true,
        assigned_user_id: true, assigned_user_name: true, slot_starts_at: true, slot_ends_at: true, received_at: true,
        leads: { select: { name: true } },
      },
    });
    return {
      enabled: s?.is_enabled ?? false,
      cycle_starts_at: iso(s?.cycle_starts_at),
      updated_by: s?.updated_by ?? null,
      updated_at: iso(s?.updated_at),
      members,
      on_duty: s?.is_enabled && turns[0] ? slotView(turns[0]) : null,
      upcoming: turns.map(slotView),
      recent: recent.map((r) => ({
        id: r.id,
        lead_id: r.lead_id,
        lead_name: r.leads?.name ?? r.profile_name ?? r.from_phone,
        from_phone: r.from_phone,
        body: r.body.length > 200 ? `${r.body.slice(0, 200)}…` : r.body,
        is_new_lead: r.is_new_lead,
        assigned_user_id: r.assigned_user_id,
        assigned_user_name: r.assigned_user_name,
        slot_starts_at: iso(r.slot_starts_at),
        slot_ends_at: iso(r.slot_ends_at),
        received_at: iso(r.received_at),
      })),
      webhook: {
        configured: isWhatsAppConfigured(),
        path: '/api/whatsapp/webhook',
        phone_number_filter: whatsappPhoneNumberId() !== '',
      },
    };
  }

  /**
   * Replace the rota. `members` is the whole list in turn order. `restart` makes member 1's turn
   * begin now; otherwise `cycle_starts_at` (or the existing start, or now for a first save) is kept.
   */
  async save(body: Record<string, unknown>, user: AuthUserRecord, now: Date = new Date()) {
    this.assertManage(user);
    const errors: Record<string, string[]> = {};
    const add = (f: string, m: string) => { (errors[f] ??= []).push(m); };

    const raw = Array.isArray(body.members) ? (body.members as unknown[]) : [];
    const members: { user_id: number; duration_minutes: number; is_active: boolean }[] = [];
    const seen = new Set<number>();
    raw.forEach((item, i) => {
      const m = (item ?? {}) as Record<string, unknown>;
      const userId = Number(m.user_id);
      const minutes = Number(m.duration_minutes);
      if (!Number.isInteger(userId) || userId <= 0) return add('members', `Row ${i + 1}: choose a person.`);
      if (seen.has(userId)) return add('members', `Row ${i + 1}: that person is already on the rota.`);
      seen.add(userId);
      if (!Number.isInteger(minutes) || minutes < MIN_TURN_MINUTES || minutes > MAX_TURN_MINUTES) {
        return add('members', `Row ${i + 1}: a turn must be between ${MIN_TURN_MINUTES} minutes and 7 days.`);
      }
      members.push({ user_id: userId, duration_minutes: minutes, is_active: m.is_active !== false });
    });

    if (members.length) {
      const existing = await this.prisma.users.findMany({ where: { id: { in: members.map((m) => m.user_id) } }, select: { id: true } });
      const known = new Set(existing.map((u) => u.id));
      const missing = members.filter((m) => !known.has(m.user_id));
      if (missing.length) add('members', `Unknown user${missing.length > 1 ? 's' : ''}: ${missing.map((m) => `#${m.user_id}`).join(', ')}.`);
    }

    const enabled = body.enabled !== false;
    if (enabled && !members.some((m) => m.is_active)) add('members', 'Add at least one active person, or switch the rotation off.');

    const current = await this.settings();
    let start = current?.cycle_starts_at ?? now;
    if (body.restart === true) start = now;
    else if (body.cycle_starts_at !== undefined && body.cycle_starts_at !== null && body.cycle_starts_at !== '') {
      const parsed = new Date(String(body.cycle_starts_at));
      if (Number.isNaN(parsed.getTime())) add('cycle_starts_at', 'That is not a valid date and time.');
      else start = parsed;
    }

    if (Object.keys(errors).length) throwValidation(errors);
    // Whole seconds, rounded DOWN. The column is TIMESTAMP(0), and Postgres ROUNDS fractions: a
    // "start now" at 7:17:30.7 was stored as 7:17:31, which put this moment a fraction of a second
    // before the cycle began — and so in the previous cycle's LAST member's turn, not the first's.
    start = new Date(Math.floor(start.getTime() / 1000) * 1000);

    await this.prisma.$transaction(async (tx) => {
      await tx.whatsapp_rotation_members.deleteMany({});
      if (members.length) {
        await tx.whatsapp_rotation_members.createMany({
          data: members.map((m, i) => ({ ...m, position: i + 1, created_at: now, updated_at: now })),
        });
      }
      const data = { is_enabled: enabled, cycle_starts_at: start, updated_by: user.name ?? null, updated_at: now };
      if (current) await tx.whatsapp_rotation_settings.update({ where: { id: current.id }, data });
      else await tx.whatsapp_rotation_settings.create({ data });
    });

    return this.view(user, now);
  }
}
