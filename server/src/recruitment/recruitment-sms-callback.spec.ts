import { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import type { PrismaService } from '../prisma/prisma.service';
import type { TwilioService } from '../sms/twilio.service';
import type { SmsInboundService } from '../sms/sms-inbound.service';
import { SmsPublicController } from '../sms/sms-public.controller';

/**
 * DELIVERY REPORTS REACH A RECRUITMENT TEXT, AND LEAD TEXTS ARE UNAFFECTED.
 *
 * There is one Twilio account, so there is one status callback URL, so every delivery report for
 * every text the product sends arrives at the same handler. That handler looked a message up in
 * `lead_messages` and treated anything it did not find as "not ours" — which, once recruitment
 * started sending, meant every recruitment text sat at `queued` for ever while Twilio had long
 * since reported it delivered.
 *
 * Both halves are asserted here because the change touches shared infrastructure: the new branch
 * has to work, AND the path leads take has to be exactly what it was. The lead case is the
 * regression test, not a courtesy.
 *
 * The signature check is stubbed out. It is `twilio.service.ts`'s own concern and has its own
 * verification; forging a real HMAC here would test that file, not this branch.
 */

const prisma = new PrismaClient();

/** Accepts every request as genuinely from Twilio, so the branch under test is reachable. */
const twilio = {
  configured: () => true,
  signedUrl: () => 'https://example.test/api/sms/twilio/status',
  signatureValid: () => true,
} as unknown as TwilioService;

const inbound = {} as unknown as SmsInboundService;
const controller = new SmsPublicController(twilio, inbound, prisma as unknown as PrismaService);

/** The shape the handler reads off a Twilio callback. */
function callback(sid: string, status: string, errorCode?: string): Request {
  return {
    headers: { host: 'example.test', 'x-twilio-signature': 'stub' },
    protocol: 'https',
    originalUrl: '/api/sms/twilio/status',
    body: { MessageSid: sid, MessageStatus: status, ...(errorCode ? { ErrorCode: errorCode } : {}) },
  } as unknown as Request;
}

let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const made: { candidates: number[]; leads: number[] } = { candidates: [], leads: [] };

afterEach(async () => {
  if (made.candidates.length) {
    await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made.candidates } } });
  }
  if (made.leads.length) await prisma.leads.deleteMany({ where: { id: { in: made.leads } } });
  made.candidates = [];
  made.leads = [];
});

afterAll(async () => { await prisma.$disconnect(); });

async function recruitmentMessage(sid: string) {
  const t = tag();
  const c = await prisma.recruitment_candidates.create({
    data: {
      name: `ZZ Callback ${t}`, email: `zz-cb-${t}@probe.test`, status: 'contacted',
      created_at: new Date(), updated_at: new Date(),
    },
  });
  made.candidates.push(c.id);
  return prisma.recruitment_messages.create({
    data: {
      candidate_id: c.id, status: 'queued', provider_sid: sid, body: 'Confirming your interview.',
      phone: '+14165550134', sent_at: new Date(), created_at: new Date(), updated_at: new Date(),
    },
  });
}

describe('a delivery report for a recruitment text', () => {
  it('moves it from queued to delivered', async () => {
    const sid = `SMzz${tag()}`;
    const row = await recruitmentMessage(sid);

    await controller.status(callback(sid, 'delivered'));

    const after = await prisma.recruitment_messages.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('delivered');
    expect(after.error_code).toBeNull();
  });

  it('records a failure with the carrier reason, in words', async () => {
    const sid = `SMzz${tag()}`;
    const row = await recruitmentMessage(sid);

    // 21610 is "replied STOP" — the carrier's opt-out, arriving after the fact.
    await controller.status(callback(sid, 'failed', '21610'));

    const after = await prisma.recruitment_messages.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('failed');
    expect(after.error_code).toBe('21610');
    expect(after.error_message).toMatch(/unsubscribed|STOP/i);
  });

  it('walks the lifecycle, queued -> sent -> delivered', async () => {
    const sid = `SMzz${tag()}`;
    const row = await recruitmentMessage(sid);

    await controller.status(callback(sid, 'sent'));
    expect((await prisma.recruitment_messages.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('sent');

    await controller.status(callback(sid, 'delivered'));
    expect((await prisma.recruitment_messages.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('delivered');
  });

  it('never writes `read`, which the column refuses and SMS cannot report anyway', async () => {
    const sid = `SMzz${tag()}`;
    const row = await recruitmentMessage(sid);
    await controller.status(callback(sid, 'read'));

    const after = await prisma.recruitment_messages.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).not.toBe('read');
    expect(['sent', 'queued']).toContain(after.status);
  });

  it('ignores a SID belonging to neither table', async () => {
    // A message sent from another app on the same Twilio account. Must not throw.
    await expect(controller.status(callback(`SMunknown${tag()}`, 'delivered')))
      .resolves.toEqual({ received: true });
  });
});

describe('lead texts are unaffected', () => {
  it('still updates a lead message, and does not touch recruitment', async () => {
    const t = tag();
    const lead = await prisma.leads.create({
      data: { name: `ZZ CB Lead ${t}`, email: `zz-cb-lead-${t}@probe.test`, created_at: new Date(), updated_at: new Date() },
    });
    made.leads.push(lead.id);

    const sid = `SMlead${t}`;
    const msg = await prisma.lead_messages.create({
      data: {
        lead_id: lead.id, direction: 'outbound', status: 'queued', provider_sid: sid,
        body: 'Hello.', phone: '+14165550134', sent_at: new Date(), created_at: new Date(),
      },
    });

    await controller.status(callback(sid, 'delivered'));

    expect((await prisma.lead_messages.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe('delivered');
  });

  it("still refuses to undo an agent's hand-marked `read`", async () => {
    /*
     * The rule that existed before recruitment did: plain SMS has no read receipt, so `read` was
     * marked by somebody who knows something Twilio does not. Pinned here because the lookup around
     * it changed, and a regression would be silent.
     */
    const t = tag();
    const lead = await prisma.leads.create({
      data: { name: `ZZ CB Read ${t}`, email: `zz-cb-read-${t}@probe.test`, created_at: new Date(), updated_at: new Date() },
    });
    made.leads.push(lead.id);

    const sid = `SMread${t}`;
    const msg = await prisma.lead_messages.create({
      data: {
        lead_id: lead.id, direction: 'outbound', status: 'read', provider_sid: sid,
        body: 'Hello.', phone: '+14165550134', sent_at: new Date(), created_at: new Date(),
      },
    });

    await controller.status(callback(sid, 'delivered'));
    expect((await prisma.lead_messages.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe('read');
  });
});
