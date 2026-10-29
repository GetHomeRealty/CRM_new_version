import { PrismaClient } from '@prisma/client';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import type { CrmEventNotifier } from '../notifications/crm-events.service';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { dutyAt, upcomingTurns } from './whatsapp-rotation';
import { inboundMessages } from './whatsapp.constants';
import { WhatsAppRotationService } from './whatsapp-rotation.service';
import { WhatsAppIntakeService, turnLabel } from './whatsapp-intake.service';
import { WhatsAppPublicController, signatureValid } from './whatsapp-public.controller';

/**
 * WHATSAPP AGENT INTAKE WITH A TIMED SUPPORT ROTATION.
 *
 *   Settings → WhatsApp Rotation   an administrator lists the support team in turn order, with how
 *                                  long each person's turn lasts
 *   an incoming WhatsApp message   becomes a lead, assigned to whoever is on duty when it arrived;
 *                                  when their turn ends the next message goes to the next person
 *
 * The intake runs its own transactions, so this file cannot use the roll-back-everything pattern.
 * It tags every row it makes and removes them afterwards, and puts back whatever rotation settings
 * the test database held before.
 */

const MIN = 60_000;
const T0 = new Date('2026-10-29T13:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

describe('who is on duty — pure arithmetic over the rota', () => {
  const rota = [
    { user_id: 1, name: 'Ravi', duration_minutes: 120 },
    { user_id: 2, name: 'Priya', duration_minutes: 60 },
    { user_id: 3, name: 'Akhil', duration_minutes: 30 },
  ];

  it('gives each member their own turn, in order, for their own length', () => {
    expect(dutyAt(rota, T0, at(0))).toMatchObject({ user_id: 1, starts_at: at(0), ends_at: at(120) });
    expect(dutyAt(rota, T0, at(119))?.user_id).toBe(1);
    expect(dutyAt(rota, T0, at(120))).toMatchObject({ user_id: 2, starts_at: at(120), ends_at: at(180) });
    expect(dutyAt(rota, T0, at(185))).toMatchObject({ user_id: 3, starts_at: at(180), ends_at: at(210) });
  });

  it('goes back to the first member after the last, for ever', () => {
    expect(dutyAt(rota, T0, at(210))).toMatchObject({ user_id: 1, starts_at: at(210), ends_at: at(330) });
    // 100 cycles of 210 minutes later, plus 130 minutes → Priya's turn.
    expect(dutyAt(rota, T0, at(100 * 210 + 130))).toMatchObject({ user_id: 2, starts_at: at(100 * 210 + 120) });
  });

  it('counts a moment before the start time into the previous cycle', () => {
    expect(dutyAt(rota, T0, at(-10))).toMatchObject({ user_id: 3, starts_at: at(-30), ends_at: at(0) });
  });

  it('has nobody on duty with no rota', () => {
    expect(dutyAt([], T0, at(5))).toBeNull();
  });

  it('lists the schedule ahead with names and times', () => {
    const turns = upcomingTurns(rota, T0, at(130), 4);
    expect(turns.map((t) => [t.name, t.starts_at.toISOString()])).toEqual([
      ['Priya', at(120).toISOString()],
      ['Akhil', at(180).toISOString()],
      ['Ravi', at(210).toISOString()],
      ['Priya', at(330).toISOString()],
    ]);
  });
});

describe('the turn as the lead history words it', () => {
  const env = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/Toronto'; });
  afterAll(() => { process.env.TZ = env; });

  it('names the date once for a turn inside one day, and twice for one that runs past midnight', () => {
    // 13:00Z = 9:00 a.m. in Toronto on 29 Oct (EDT).
    expect(turnLabel({ starts_at: at(0), ends_at: at(120) })).toBe('on duty Oct 29, 9:00 a.m. – 11:00 a.m.');
    expect(turnLabel({ starts_at: at(14 * 60), ends_at: at(16 * 60) })).toBe('on duty Oct 29, 11:00 p.m. – Oct 30, 1:00 a.m.');
  });
});

describe('reading a WhatsApp Cloud API delivery', () => {
  it('takes customer messages with their words and profile name, and leaves delivery receipts out', () => {
    const got = inboundMessages(payload([
      { id: 'wamid.A', from: '14165550101', type: 'text', text: { body: 'Looking for a 3 bed in Brampton' } },
      { id: 'wamid.B', from: '14165550101', type: 'image', image: { caption: 'this one' } },
      { id: 'wamid.C', from: '14165550101', type: 'interactive', interactive: { type: 'button_reply', button_reply: { title: 'Book a showing' } } },
      { id: 'wamid.D', from: '14165550101', type: 'reaction', reaction: { emoji: '👍' } },
    ], 'Asha Patel', { statuses: [{ id: 'wamid.OUT', status: 'delivered' }] }));
    expect(got.map((m) => [m.id, m.text, m.profileName])).toEqual([
      ['wamid.A', 'Looking for a 3 bed in Brampton', 'Asha Patel'],
      ['wamid.B', '[Image] this one', 'Asha Patel'],
      ['wamid.C', 'Book a showing', 'Asha Patel'],
    ]);
    expect(got[0].receivedAt.toISOString()).toBe(T0.toISOString());
  });

  it('ignores anything that is not a WhatsApp business account delivery', () => {
    expect(inboundMessages({ object: 'page', entry: [] })).toEqual([]);
    expect(inboundMessages(null)).toEqual([]);
  });
});

describe('the webhook only believes Meta', () => {
  const SECRET = 'test-app-secret';
  const sign = (raw: Buffer) => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
  const env = { ...process.env };
  beforeEach(() => { process.env.WHATSAPP_APP_SECRET = SECRET; process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-me'; });
  afterEach(() => { process.env = { ...env }; });

  it('checks the HMAC over the exact bytes', () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    expect(signatureValid(raw, sign(raw), SECRET)).toBe(true);
    expect(signatureValid(raw, sign(Buffer.from('{}')), SECRET)).toBe(false);
    expect(signatureValid(raw, '', SECRET)).toBe(false);
  });

  it('refuses a delivery with a bad signature and takes nothing in', async () => {
    const ingest = jest.fn();
    const ctl = new WhatsAppPublicController({ ingest } as unknown as WhatsAppIntakeService);
    const body = payload([{ id: 'wamid.X', from: '14165550101', type: 'text', text: { body: 'hi' } }], 'X');
    const raw = Buffer.from(JSON.stringify(body));
    const res = { status: jest.fn() };
    const req = { rawBody: raw, body, headers: { 'x-hub-signature-256': 'sha256=forged' } };
    expect(await ctl.receive(req as never, res as never)).toEqual({ received: false });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(ingest).not.toHaveBeenCalled();

    const ok = { ...req, headers: { 'x-hub-signature-256': sign(raw) } };
    expect(await ctl.receive(ok as never, res as never)).toEqual({ received: true });
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('completes the subscription handshake only with the right verify token', () => {
    const ctl = new WhatsAppPublicController({} as WhatsAppIntakeService);
    const reply = () => { const r = { code: 0, sent: '', status(c: number) { r.code = c; return r; }, send(s: string) { r.sent = s; return r; } }; return r; };
    const good = reply();
    ctl.verify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' }, good as never);
    expect([good.code, good.sent]).toEqual([200, '12345']);
    const bad = reply();
    ctl.verify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '12345' }, bad as never);
    expect(bad.code).toBe(403);
  });
});

describe('end to end against the real schema', () => {
  const prisma = new PrismaClient();
  const db = prisma as unknown as PrismaService;
  const tag = `wa-${Date.now()}`;
  const userIds: number[] = [];
  let saved: Awaited<ReturnType<typeof prisma.whatsapp_rotation_settings.findMany>> = [];
  let savedMembers: Awaited<ReturnType<typeof prisma.whatsapp_rotation_members.findMany>> = [];

  const assigned: { leadId: number; userId: number; actor: string | null | undefined }[] = [];
  const notices: { userId: number; title: string; channels?: string[] }[] = [];
  const events = { leadAssigned: async (lead: { id: number }, userId: number, _a: unknown, actor?: string | null) => { assigned.push({ leadId: lead.id, userId, actor }); } } as unknown as CrmEventNotifier;
  const dispatcher = { dispatch: async (r: { userId: number; title: string; channels?: string[] }) => { notices.push(r); } } as unknown as NotificationDispatcher;
  const rotation = new WhatsAppRotationService(db);
  const intake = new WhatsAppIntakeService(db, rotation, events, dispatcher);

  let admin: AuthUserRecord;
  let agent: AuthUserRecord;
  let ravi: number; let priya: number; let akhil: number;
  // Distinct per run so leftovers from an interrupted run never match.
  const phone = (n: number) => `1416${String(Date.now()).slice(-5)}${n}`.slice(0, 11);

  beforeAll(async () => {
    saved = await prisma.whatsapp_rotation_settings.findMany();
    savedMembers = await prisma.whatsapp_rotation_members.findMany();
    await prisma.whatsapp_rotation_members.deleteMany({});
    await prisma.whatsapp_rotation_settings.deleteMany({});
    const now = new Date();
    const mk = async (label: string, role = 'agent') => {
      const u = await prisma.users.create({
        data: { name: `${label} ${tag}`, email: `${label}-${tag}@x.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
      });
      userIds.push(u.id);
      return u;
    };
    const a = await mk('admin', 'manager');
    admin = { id: a.id, name: a.name, role: 'manager', user_permissions: [] } as unknown as AuthUserRecord;
    const g = await mk('agent');
    agent = { id: g.id, name: g.name, role: 'agent', user_permissions: [] } as unknown as AuthUserRecord;
    ravi = (await mk('Ravi')).id;
    priya = (await mk('Priya')).id;
    akhil = (await mk('Akhil')).id;
  });

  afterAll(async () => {
    await prisma.leads.deleteMany({ where: { whatsapp_intake: { some: { assigned_user_name: { contains: tag } } } } });
    await prisma.leads.deleteMany({ where: { source: 'whatsapp', name: { contains: tag } } });
    await prisma.whatsapp_rotation_members.deleteMany({});
    await prisma.whatsapp_rotation_settings.deleteMany({});
    if (saved.length) await prisma.whatsapp_rotation_settings.createMany({ data: saved });
    if (savedMembers.length) await prisma.whatsapp_rotation_members.createMany({ data: savedMembers });
    await prisma.users.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  const message = (id: string, from: string, minutes: number, text = 'Need a 2 bed condo') => ({
    id: `${id}.${tag}`, from, profileName: `Customer ${id} ${tag}`, type: 'text', text, receivedAt: at(minutes), phoneNumberId: null,
  });

  it('lets only an administrator see or change the rotation', async () => {
    await expect(rotation.view(agent)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(rotation.save({ members: [] }, agent)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a rota that cannot work', async () => {
    await expect(rotation.save({ members: [{ user_id: ravi, duration_minutes: 2 }] }, admin)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(rotation.save({ members: [{ user_id: ravi, duration_minutes: 60 }, { user_id: ravi, duration_minutes: 60 }] }, admin))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(rotation.save({ enabled: true, members: [] }, admin)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('puts the FIRST person on duty straight after "start now", whatever the milliseconds', async () => {
    // 7:17:30.700 used to be stored as 7:17:31 (Postgres rounds), which made the last member "on duty".
    const now = new Date(T0.getTime() + 700);
    const view = await rotation.save({
      enabled: true, restart: true,
      members: [{ user_id: ravi, duration_minutes: 120 }, { user_id: priya, duration_minutes: 60 }],
    }, admin, now);
    expect(view.on_duty?.user_id).toBe(ravi);
    expect(view.cycle_starts_at).toBe(T0.toISOString());
    expect((await rotation.onDuty(now))?.user_id).toBe(ravi);
  });

  it('saves the team, the order and each turn length, and shows who is on duty and next', async () => {
    const view = await rotation.save({
      enabled: true,
      cycle_starts_at: T0.toISOString(),
      members: [
        { user_id: ravi, duration_minutes: 120 },
        { user_id: priya, duration_minutes: 60 },
        { user_id: akhil, duration_minutes: 30 },
      ],
    }, admin, at(130));
    expect(view.members.map((m) => [m.user_id, m.duration_minutes, m.is_active])).toEqual([[ravi, 120, true], [priya, 60, true], [akhil, 30, true]]);
    expect(view.on_duty).toMatchObject({ user_id: priya, starts_at: at(120).toISOString(), ends_at: at(180).toISOString() });
    expect(view.upcoming.slice(0, 3).map((t) => t.user_id)).toEqual([priya, akhil, ravi]);
  });

  it('assigns each new WhatsApp enquiry to whoever is on duty, moving on as each turn ends', async () => {
    const first = await intake.ingest(message('m1', phone(1), 10));    // Ravi's turn
    const second = await intake.ingest(message('m2', phone(2), 125));  // Priya's turn
    const third = await intake.ingest(message('m3', phone(3), 200));   // Akhil's turn
    const fourth = await intake.ingest(message('m4', phone(4), 215));  // back to Ravi
    expect([first, second, third, fourth].map((r) => [r.outcome, r.assignedUserId])).toEqual([
      ['created', ravi], ['created', priya], ['created', akhil], ['created', ravi],
    ]);

    const lead = await prisma.leads.findUniqueOrThrow({ where: { id: second.leadId! } });
    expect(lead).toMatchObject({ lead_source: 'whatsapp', source: 'whatsapp', assigned_to: priya, owner_user_id: null, team_id: null, message: 'Need a 2 bed condo' });

    const row = await prisma.whatsapp_intake.findFirstOrThrow({ where: { lead_id: second.leadId! } });
    expect(row).toMatchObject({ is_new_lead: true, assigned_user_id: priya, assigned_user_name: `Priya ${tag}`, slot_starts_at: at(120), slot_ends_at: at(180) });

    // The lead's ownership history names the person and their turn.
    const history = await prisma.crm_lead_assignment_events.findFirstOrThrow({ where: { lead_id: second.leadId! } });
    expect(history.to_user_id).toBe(priya);
    expect(history.actor_name).toBe('WhatsApp rotation');
    expect(history.description).toMatch(/^Priya .* assigned as handling agent \(WhatsApp rotation, on duty .+ – .+\)$/);

    // The message is on the lead's message history, and the assignee was notified.
    expect(await prisma.lead_messages.count({ where: { lead_id: second.leadId!, direction: 'inbound', created_by: 'WhatsApp' } })).toBe(1);
    expect(assigned).toEqual(expect.arrayContaining([{ leadId: second.leadId, userId: priya, actor: 'WhatsApp rotation' }]));
  });

  it('keeps a returning customer with the same person, even in somebody else\'s turn', async () => {
    const from = phone(5);
    const opened = await intake.ingest(message('m5', from, 20));            // Ravi
    const again = await intake.ingest(message('m6', from, 150, 'Is it still available?')); // Priya on duty
    expect(again).toMatchObject({ outcome: 'appended', leadId: opened.leadId, assignedUserId: ravi });
    expect(await prisma.lead_messages.count({ where: { lead_id: opened.leadId! } })).toBe(2);
    expect(notices.some((n) => n.userId === ravi && n.title === 'New WhatsApp message')).toBe(true);
  });

  it('records a message Meta delivers twice only once', async () => {
    const m = message('m7', phone(7), 30);
    const a = await intake.ingest(m);
    const b = await intake.ingest(m);
    expect(b).toMatchObject({ outcome: 'duplicate', leadId: a.leadId });
    expect(await prisma.whatsapp_intake.count({ where: { wa_message_id: m.id } })).toBe(1);
  });

  it('skips a paused member, so the others cover the whole cycle', async () => {
    await rotation.save({
      enabled: true,
      cycle_starts_at: T0.toISOString(),
      members: [
        { user_id: ravi, duration_minutes: 120 },
        { user_id: priya, duration_minutes: 60, is_active: false },
        { user_id: akhil, duration_minutes: 30 },
      ],
    }, admin, at(0));
    // Ravi 0–120, Akhil 120–150, Ravi 150–270 …
    expect((await intake.ingest(message('m8', phone(8), 125))).assignedUserId).toBe(akhil);
    expect((await intake.ingest(message('m9', phone(9), 155))).assignedUserId).toBe(ravi);
  });

  it('still takes the enquiry in, unassigned, when the rotation is switched off', async () => {
    await rotation.save({ enabled: false, members: [{ user_id: ravi, duration_minutes: 60 }] }, admin);
    const r = await intake.ingest(message('m10', phone(0), 40));
    expect(r).toMatchObject({ outcome: 'created', assignedUserId: null });
    const view = await rotation.view(admin);
    expect(view.on_duty).toBeNull();
    expect(view.recent.find((x) => x.lead_id === r.leadId)).toMatchObject({ assigned_user_id: null, is_new_lead: true });
  });
});

/** A WhatsApp Cloud API webhook body, as Meta sends it. */
function payload(messages: Record<string, unknown>[], profileName: string, extra: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550001111', phone_number_id: 'PNID' },
          contacts: [{ profile: { name: profileName }, wa_id: '14165550101' }],
          messages: messages.map((m) => ({ timestamp: String(T0.getTime() / 1000), ...m })),
          ...extra,
        },
      }],
    }],
  };
}
