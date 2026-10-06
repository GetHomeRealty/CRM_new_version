import { PrismaClient } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentSmsService } from './recruitment-sms.service';

/**
 * TEXTING A CANDIDATE — what is dialled, what is recorded, and who may do it.
 *
 * ======================================================================================
 * NOTHING HERE REACHES TWILIO. The gateway is a stub, and that is not only about cost: these cases
 * include numbers that bounce and a candidate on the carrier's STOP list, and the only way to
 * exercise those for real would be to send real texts to real handsets.
 *
 * THE FIRST TEST IS THE ONE THAT MATTERS. `lead-activity.service.ts` carries a comment about a
 * hole this exact shape of endpoint once had: it took the phone number from the REQUEST and handed
 * it to the gateway, so anybody who could edit a record could text any number on Earth on the
 * brokerage's account. This file asserts the recruitment composer cannot be made to do that.
 * ======================================================================================
 */

const prisma = new PrismaClient();

/** Stands in for Twilio. Records what it was asked to send; fails on demand. */
function stubTwilio(opts: { configured?: boolean; fail?: { message: string; code?: string } } = {}) {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    sent,
    configured: () => opts.configured !== false,
    send: async (to: string, body: string) => {
      if (opts.fail) {
        throw new BadRequestException({ message: opts.fail.message, code: opts.fail.code });
      }
      sent.push({ to, body });
      return { sid: `SM${Date.now()}${sent.length}`, status: 'queued' };
    },
  };
}

let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const made: { candidates: number[]; users: number[] } = { candidates: [], users: [] };

const ADMIN: AuthUserRecord = { id: 1, name: 'ZZ Admin', role: 'admin' } as unknown as AuthUserRecord;

/**
 * A candidate who HAS agreed to be texted, unless a case says otherwise.
 *
 * Spelled out in the fixture rather than defaulted in the schema, which is the whole point of the
 * consent column: a candidate with no recorded answer cannot be texted, so every test that expects
 * a send to happen has to state that somebody asked.
 */
async function candidate(over: Record<string, unknown> = {}) {
  const t = tag();
  const row = await prisma.recruitment_candidates.create({
    data: {
      name: `ZZ Text ${t}`, email: `zz-text-${t}@probe.test`, status: 'contacted',
      phone: '416-555-0134',
      sms_consent: true, sms_consent_at: new Date(), sms_consent_by: 'ZZ Admin',
      created_at: new Date(), updated_at: new Date(), ...over,
    },
  });
  made.candidates.push(row.id);
  return row;
}

function serviceWith(twilio: ReturnType<typeof stubTwilio>) {
  const recruitment = new RecruitmentService(prisma as unknown as PrismaService);
  return new RecruitmentSmsService(prisma as unknown as PrismaService, twilio as never, recruitment);
}

afterEach(async () => {
  if (made.candidates.length) {
    await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made.candidates } } });
  }
  if (made.users.length) await prisma.users.deleteMany({ where: { id: { in: made.users } } });
  made.candidates = [];
  made.users = [];
});

afterAll(async () => { await prisma.$disconnect(); });

describe('where the text actually goes', () => {
  it('DIALS THE CANDIDATE AND IGNORES ANY NUMBER IN THE REQUEST', async () => {
    /*
     * The whole security of this endpoint. A request naming somebody else's number must change
     * nothing about where the message is sent.
     */
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate({ phone: '416-555-0134' });

    await sms.send(ADMIN, c.id, {
      body: 'Confirming your interview.',
      phone: '+15559998888',              // an attacker's number
      to: '+15559998888',
    });

    expect(twilio.sent).toHaveLength(1);
    expect(twilio.sent[0].to).toBe('+14165550134');
    expect(twilio.sent[0].to).not.toContain('5559998888');

    const row = await prisma.recruitment_messages.findFirstOrThrow({ where: { candidate_id: c.id } });
    expect(row.phone).toBe('+14165550134');
  });

  it('normalizes the number the way the rest of the product does', async () => {
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate({ phone: '(416) 555-0134' });
    await sms.send(ADMIN, c.id, { body: 'Hello.' });
    expect(twilio.sent[0].to).toBe('+14165550134');
  });
});

describe('when it will not send', () => {
  it('refuses a candidate with no phone number, and sends nothing', async () => {
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate({ phone: null });

    await expect(sms.send(ADMIN, c.id, { body: 'Hello.' }))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('no phone number') } });
    expect(twilio.sent).toHaveLength(0);
    // Nothing was attempted, so nothing is recorded — this is not a failed send.
    expect(await prisma.recruitment_messages.count({ where: { candidate_id: c.id } })).toBe(0);
  });

  it('refuses a number that cannot be dialled', async () => {
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate({ phone: 'ask reception' });

    await expect(sms.send(ADMIN, c.id, { body: 'Hello.' }))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('not a number this can dial') } });
    expect(twilio.sent).toHaveLength(0);
  });

  it('refuses when no gateway is connected', async () => {
    const twilio = stubTwilio({ configured: false });
    const sms = serviceWith(twilio);
    const c = await candidate();
    await expect(sms.send(ADMIN, c.id, { body: 'Hello.' }))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('No SMS gateway') } });
  });

  it('refuses an empty message, and one longer than a sender would mean to send', async () => {
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate();
    await expect(sms.send(ADMIN, c.id, { body: '   ' })).rejects.toBeDefined();
    await expect(sms.send(ADMIN, c.id, { body: 'x'.repeat(481) }))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('at most 480') } });
    expect(twilio.sent).toHaveLength(0);
  });

  it('tells the composer why Send is disabled, before anybody presses it', async () => {
    const sms = serviceWith(stubTwilio());
    const none = await candidate({ phone: null });
    const bad = await candidate({ phone: 'ask reception' });
    const ok = await candidate();

    expect((await sms.composer(ADMIN, none.id)).can_send).toBe(false);
    expect((await sms.composer(ADMIN, none.id)).blocked_reason).toContain('no phone number');
    expect((await sms.composer(ADMIN, bad.id)).can_send).toBe(false);
    expect((await sms.composer(ADMIN, ok.id)).can_send).toBe(true);
    expect((await sms.composer(ADMIN, ok.id)).blocked_reason).toBeNull();
  });
});

describe('permission to text, recorded rather than assumed', () => {
  const unasked = { sms_consent: null, sms_consent_at: null, sms_consent_by: null };

  it('REFUSES A CANDIDATE NOBODY HAS ASKED, and dials nothing', async () => {
    /*
     * The default state for every candidate who existed before the column. Null is not "no" — it is
     * "nobody asked" — but it is equally not permission, so nothing goes out.
     */
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate(unasked);

    await expect(sms.send(ADMIN, c.id, { body: 'Hello.' }))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('no record of') } });
    expect(twilio.sent).toHaveLength(0);
    expect(await prisma.recruitment_messages.count({ where: { candidate_id: c.id } })).toBe(0);
  });

  it('refuses a candidate who asked not to be texted, in different words', async () => {
    // "They said no" and "nobody asked" lead to different actions, so they must read differently.
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate({ sms_consent: false });

    await expect(sms.send(ADMIN, c.id, { body: 'Hello.' }))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('asked not to be texted') } });
    expect(twilio.sent).toHaveLength(0);
  });

  it('asks about consent BEFORE the phone number, so the refusal sends you to the right place', async () => {
    const sms = serviceWith(stubTwilio());
    const c = await candidate({ ...unasked, phone: null });
    const { blocked_reason } = await sms.composer(ADMIN, c.id) as { blocked_reason: string };
    expect(blocked_reason).toContain('no record of');
    expect(blocked_reason).not.toContain('no phone number');
  });

  it('records the answer with a name and a time, and says so in the history', async () => {
    const sms = serviceWith(stubTwilio());
    const c = await candidate(unasked);

    await sms.setConsent(ADMIN, c.id, { consent: true, note: 'Said yes on the phone' });

    const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.sms_consent).toBe(true);
    expect(after.sms_consent_by).toBe('ZZ Admin');
    expect(after.sms_consent_at).not.toBeNull();
    expect(after.sms_consent_note).toBe('Said yes on the phone');

    const events = await prisma.recruitment_events.findMany({
      where: { candidate_id: c.id, action: 'sms_consent_given' },
    });
    expect(events).toHaveLength(1);
  });

  it('withdrawing records `false` rather than clearing the answer', async () => {
    // Back to null would say nobody ever asked, which would be false and would lose the refusal.
    const sms = serviceWith(stubTwilio());
    const c = await candidate();
    await sms.setConsent(ADMIN, c.id, { consent: false, note: 'Asked us to stop' });

    const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.sms_consent).toBe(false);
    expect(after.sms_consent).not.toBeNull();
    expect(after.sms_consent_by).toBe('ZZ Admin');
  });

  it('refuses to record anything other than yes or no', async () => {
    const sms = serviceWith(stubTwilio());
    const c = await candidate();
    for (const bad of [undefined, null, '', 'maybe', 1]) {
      await expect(sms.setConsent(ADMIN, c.id, { consent: bad })).rejects.toBeDefined();
    }
  });

  it('the database refuses a yes with nobody behind it', async () => {
    /*
     * The CHECK constraint, which matters for a route this service does not own — an import, or a
     * hand-written UPDATE. A recorded agreement with no name and no date is not a record.
     */
    const c = await candidate();
    await expect(prisma.$executeRawUnsafe(
      'UPDATE "recruitment_candidates" SET "sms_consent" = true, "sms_consent_at" = NULL, '
      + `"sms_consent_by" = NULL WHERE "id" = ${c.id}`,
    )).rejects.toThrow(/sms_consent_chk/);
  });

  it('consent is re-read at send time, not trusted from when the composer opened', async () => {
    /*
     * The composer may have been open for an hour. If the answer was withdrawn in between, the
     * send must fail — reading it again at send time is what makes that true.
     */
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate();

    expect((await sms.composer(ADMIN, c.id)).can_send).toBe(true);
    await sms.setConsent(ADMIN, c.id, { consent: false });

    await expect(sms.send(ADMIN, c.id, { body: 'Hello.' })).rejects.toBeDefined();
    expect(twilio.sent).toHaveLength(0);
  });

  it('consent does not override the carrier: a STOP reply is still a failure', async () => {
    // Two different agreements. Ours cannot overrule the one the recipient gave the carrier.
    const twilio = stubTwilio({
      fail: { message: 'The lead has unsubscribed from your messages (replied STOP).', code: '21610' },
    });
    const sms = serviceWith(twilio);
    const c = await candidate();     // consent recorded as true

    await expect(sms.send(ADMIN, c.id, { body: 'Hello.' })).rejects.toBeDefined();
    const row = await prisma.recruitment_messages.findFirstOrThrow({ where: { candidate_id: c.id } });
    expect(row.error_code).toBe('21610');
    expect(row.status).toBe('failed');
  });

  it('a recruiter cannot record consent for a candidate who is not theirs', async () => {
    const sms = serviceWith(stubTwilio());
    const theirs = await candidate({ assigned_recruiter_id: 999_001 });
    const other: AuthUserRecord = { id: 999_002, name: 'ZZ Other', role: 'recruiter' } as unknown as AuthUserRecord;
    await expect(sms.setConsent(other, theirs.id, { consent: true })).rejects.toBeDefined();
  });
});

describe('what is recorded', () => {
  it('records a successful send, its status and who sent it', async () => {
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate();

    await sms.send(ADMIN, c.id, { body: 'Confirming your interview.' });

    const row = await prisma.recruitment_messages.findFirstOrThrow({ where: { candidate_id: c.id } });
    expect(row.status).toBe('queued');          // what the gateway returned, not a guess
    expect(row.provider_sid).toMatch(/^SM/);    // so the status callback can find it later
    expect(row.body).toBe('Confirming your interview.');
    expect(row.created_by).toBe('ZZ Admin');
    expect(row.user_id).toBe(1);

    const events = await prisma.recruitment_events.findMany({ where: { candidate_id: c.id, action: 'sms_sent' } });
    expect(events).toHaveLength(1);
    expect(events[0].actor_name).toBe('ZZ Admin');
  });

  it('RECORDS A FAILURE TOO, rather than losing it', async () => {
    /*
     * The lead path throws and records nothing. Here the failure is the fact worth keeping: a
     * history that omitted it would let somebody conclude a candidate was never contacted when in
     * truth they were texted three times at a number that bounces.
     */
    const twilio = stubTwilio({ fail: { message: 'The number is a landline and cannot receive texts.', code: '21614' } });
    const sms = serviceWith(twilio);
    const c = await candidate();

    await expect(sms.send(ADMIN, c.id, { body: 'Confirming your interview.' }))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('landline') } });

    const row = await prisma.recruitment_messages.findFirstOrThrow({ where: { candidate_id: c.id } });
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('21614');
    expect(row.error_message).toContain('landline');
    expect(row.provider_sid).toBeNull();        // it never got a SID; there was no message

    const events = await prisma.recruitment_events.findMany({ where: { candidate_id: c.id, action: 'sms_failed' } });
    expect(events).toHaveLength(1);
  });

  it("records a carrier opt-out as the failure it is", async () => {
    // 21610 is Twilio's "this person replied STOP". The brokerage's consent rule for SMS is the
    // carrier's list, and this is what honouring it looks like from in here.
    const twilio = stubTwilio({
      fail: { message: 'The lead has unsubscribed from your messages (replied STOP).', code: '21610' },
    });
    const sms = serviceWith(twilio);
    const c = await candidate();

    await expect(sms.send(ADMIN, c.id, { body: 'Hello again.' })).rejects.toBeDefined();

    const row = await prisma.recruitment_messages.findFirstOrThrow({ where: { candidate_id: c.id } });
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('21610');
    expect(row.error_message).toContain('STOP');
  });

  it('distinguishes queued, sent, delivered and failed', async () => {
    // The four are different promises, and the column holds each of them distinctly.
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate();
    await sms.send(ADMIN, c.id, { body: 'One.' });

    const row = await prisma.recruitment_messages.findFirstOrThrow({ where: { candidate_id: c.id } });
    for (const status of ['sent', 'delivered', 'failed', 'queued']) {
      const updated = await prisma.recruitment_messages.update({ where: { id: row.id }, data: { status } });
      expect(updated.status).toBe(status);
    }
    // And `read` is refused by the CHECK constraint — plain SMS has no read receipt.
    await expect(
      prisma.recruitment_messages.update({ where: { id: row.id }, data: { status: 'read' } }),
    ).rejects.toThrow(/recruitment_messages_status_chk/);
  });

  it('lists what was sent, newest first', async () => {
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate();
    await sms.send(ADMIN, c.id, { body: 'First.' });
    await sms.send(ADMIN, c.id, { body: 'Second.' });

    const list = await sms.list(ADMIN, c.id) as { data: Array<{ body: string; sent_at: Date }> };
    expect(list.data).toHaveLength(2);
    expect(list.data[0].sent_at >= list.data[1].sent_at).toBe(true);
  });
});

describe('the composer', () => {
  it('offers an interview confirmation carrying the date, time, zone and where to go', async () => {
    const sms = serviceWith(stubTwilio());
    const c = await candidate();
    await prisma.recruitment_interviews.create({
      data: {
        candidate_id: c.id, status: 'scheduled', mode: 'video',
        location: 'https://meet.example.com/ghr-1',
        scheduled_at: new Date(Date.now() + 86_400_000),
        created_at: new Date(), updated_at: new Date(),
      },
    });

    const { template } = await sms.composer(ADMIN, c.id) as { template: string };
    expect(template).toMatch(/\b(EST|EDT|GMT|UTC)\b/);     // the zone, named
    expect(template).toMatch(/\d{1,2}:\d{2}/);              // the time
    expect(template).toMatch(/20\d\d/);                     // the date
    expect(template).toContain('https://meet.example.com/ghr-1');
  });

  it('asks for times instead when no interview is booked', async () => {
    const sms = serviceWith(stubTwilio());
    const c = await candidate();
    const { template } = await sms.composer(ADMIN, c.id) as { template: string };
    expect(template).toMatch(/arrange your interview/i);
  });

  it('ignores a cancelled interview when suggesting a confirmation', async () => {
    // Confirming an interview that is off would be worse than sending nothing.
    const sms = serviceWith(stubTwilio());
    const c = await candidate();
    await prisma.recruitment_interviews.create({
      data: {
        candidate_id: c.id, status: 'cancelled',
        scheduled_at: new Date(Date.now() + 86_400_000),
        created_at: new Date(), updated_at: new Date(),
      },
    });
    const { template } = await sms.composer(ADMIN, c.id) as { template: string };
    expect(template).toMatch(/arrange your interview/i);
  });
});

describe('scope', () => {
  it('a recruiter cannot text a candidate who is not theirs', async () => {
    /*
     * The same `mine` check every other recruitment endpoint makes. Without it a texting endpoint
     * would hand somebody the phone number of a candidate the list refuses to show them.
     */
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const theirs = await candidate({ assigned_recruiter_id: 999_001 });

    const otherRecruiter: AuthUserRecord = {
      id: 999_002, name: 'ZZ Other', role: 'recruiter',
    } as unknown as AuthUserRecord;

    await expect(sms.send(otherRecruiter, theirs.id, { body: 'Hello.' }))
      .rejects.toMatchObject({ response: { message: 'Candidate not found.' } });
    await expect(sms.composer(otherRecruiter, theirs.id)).rejects.toBeDefined();
    expect(twilio.sent).toHaveLength(0);
  });

  it('an administrator may text any candidate', async () => {
    const twilio = stubTwilio();
    const sms = serviceWith(twilio);
    const c = await candidate({ assigned_recruiter_id: 999_001 });
    await sms.send(ADMIN, c.id, { body: 'Hello.' });
    expect(twilio.sent).toHaveLength(1);
  });
});
