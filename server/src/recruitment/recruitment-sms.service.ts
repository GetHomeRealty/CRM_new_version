import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../sms/twilio.service';
import { mapProviderStatus } from '../sms/sms.constants';
import { toE164 } from '../leads/lead-activity.service';
import { RecruitmentService } from './recruitment.service';
import { interviewWhen } from './recruitment-interview-notify.service';
import type { AuthUserRecord } from '../auth/auth.types';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * How long a single text may be.
 *
 * Not a protocol limit — Twilio will happily segment a long message and bill per segment. It is a
 * guard against a composer that lets somebody paste an essay and discover the cost afterwards.
 * Three segments of GSM-7 is generous for a confirmation.
 */
const MAX_BODY = 480;

/**
 * Texting a candidate from Recruitment.
 *
 * ======================================================================================
 * THE NUMBER COMES FROM THE CANDIDATE, NEVER FROM THE REQUEST.
 *
 * This is not a preference. `lead-activity.service.ts` carries a comment describing the same rule
 * and why it exists there: the lead endpoint once took `body.phone` and handed it straight to the
 * gateway, so anybody who could edit a lead could send arbitrary text to any number on Earth on the
 * brokerage's Twilio account — toll fraud, harassment, and unsolicited commercial SMS under CASL,
 * billed to the brokerage and logged against somebody who had nothing to do with it.
 *
 * A recruitment composer is the same shape of endpoint and would be the same hole. The composer
 * SHOWS the number so the sender can see where it is going; the server reads it from the candidate
 * row and ignores anything the request says about it. Somebody who wants to text a different number
 * corrects it on the candidate first, which is the point at which scope, history and the audit
 * trail actually apply to it.
 * ======================================================================================
 *
 * CONSENT AND OPT-OUT ARE THE ONES THAT ALREADY EXIST, which for SMS means the carrier's. Twilio's
 * Messaging Service holds the STOP list and refuses a message to anybody on it with error 21610;
 * that refusal is surfaced in the sender's own words and recorded as a failure, rather than being
 * swallowed as a generic error. There is no second, app-level opt-out flag for candidates, and this
 * does not invent one — see the note returned with the project report.
 */
@Injectable()
export class RecruitmentSmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly recruitment: RecruitmentService,
  ) {}

  /**
   * What the composer opens with: the number it will dial, whether it can, and a suggested message.
   *
   * THE SUGGESTION IS A STARTING POINT, NOT A FORM. It is returned as plain text for an editable
   * box, because a confirmation that cannot be adjusted gets abandoned the first time somebody
   * needs to add "ask for Priya at reception".
   */
  async composer(user: AuthUserRecord, candidateId: number): Promise<Record<string, unknown>> {
    const candidate = await this.recruitment.candidateFor(user, candidateId);

    const to = toE164(candidate.phone);
    const interview = await this.prisma.recruitment_interviews.findFirst({
      where: { candidate_id: candidate.id, status: 'scheduled' },
      orderBy: { scheduled_at: 'asc' },
    });

    const blocked = this.blockedReason(candidate, to);

    return {
      candidate: { id: candidate.id, name: candidate.name, phone: candidate.phone },
      /** E.164, exactly what would be dialled. Null when there is nothing dialable. */
      to: to || null,
      can_send: !blocked,
      /** Why not, in words the sender can act on. Null when sending is possible. */
      blocked_reason: blocked,
      /*
       * The recorded answer, so the screen can offer to record one rather than only refusing.
       * `null` here means nobody has asked — which is not the same as "no" and must not read as it.
       */
      consent: {
        answer: candidate.sms_consent,
        at: candidate.sms_consent_at,
        by: candidate.sms_consent_by,
        note: candidate.sms_consent_note,
      },
      template: this.confirmationTemplate(candidate.name, interview),
      gateway_configured: this.twilio.configured(),
    };
  }

  /**
   * The one sentence explaining why Send is disabled, or null when it is not.
   *
   * CONSENT IS ASKED FIRST, ahead of the number and the gateway. The order is what the sentence
   * says: telling somebody "fix the phone number" about a candidate who never agreed to be texted
   * sends them off to correct the wrong thing, and they arrive back at the same refusal.
   */
  private blockedReason(c: {
    name: string; phone: string | null; sms_consent: boolean | null;
  }, to: string): string | null {
    if (c.sms_consent !== true) {
      return c.sms_consent === false
        ? `${c.name} has asked not to be texted. Record a new agreement before sending anything.`
        : `There is no record of ${c.name} agreeing to be texted. Ask them, record the answer on `
          + 'their file, and then send.';
    }
    if (!c.phone) return `${c.name} has no phone number on file, so there is nothing to text.`;
    if (!to) {
      return `${c.name}'s phone number (${c.phone}) is not a number this can dial. Correct it on the candidate first.`;
    }
    if (!this.twilio.configured()) {
      return 'No SMS gateway is connected, so nothing can be sent from here.';
    }
    return null;
  }

  /**
   * The interview-confirmation text.
   *
   * Carries the date, the time, the zone, and where to go — which for a video interview is the link
   * and for an in-person one is the address. A confirmation missing any of those produces a reply
   * asking for it, which is the thing it was sent to avoid.
   */
  private confirmationTemplate(
    name: string,
    interview: { scheduled_at: Date | null; mode: string | null; location: string | null } | null,
  ): string {
    const first = name.split(' ')[0] || name;
    if (!interview?.scheduled_at) {
      return `Hi ${first}, this is Get Home Realty. We'd like to arrange your interview — `
        + 'please reply with a couple of times that suit you. Thank you.';
    }
    const where = interview.location
      ? (interview.mode === 'video' ? `Join here: ${interview.location}` : `Where: ${interview.location}`)
      : 'We will confirm the location separately.';
    return `Hi ${first}, confirming your interview with Get Home Realty on ${interviewWhen(interview.scheduled_at)}. `
      + `${where} Please reply to confirm. Thank you.`;
  }

  /**
   * Send it, and record what became of it.
   *
   * THE ROW IS WRITTEN WHATEVER HAPPENS, including when Twilio refuses. The lead path throws and
   * records nothing, which is defensible there — but a recruitment history that silently omits the
   * texts that failed would let somebody conclude a candidate was never contacted when in fact they
   * were texted three times at a number that bounces. The failure is the fact worth keeping.
   *
   * The send happens BEFORE the row is written only in the sense that the SID is needed for it; a
   * refusal is caught, written as a `failed` row, and then re-thrown so the sender sees the reason.
   */
  async send(user: AuthUserRecord, candidateId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const candidate = await this.recruitment.candidateFor(user, candidateId);

    const text = str(body.body);
    if (!text) throw new BadRequestException({ message: 'There is no message to send.' });
    if (text.length > MAX_BODY) {
      throw new BadRequestException({
        message: `A text may be at most ${MAX_BODY} characters; this one is ${text.length}. Shorten it, or send the detail by email.`,
      });
    }

    /*
     * See the class comment. Anything `body.phone` says is ignored — and consent is re-read from
     * the row here rather than trusted from the composer, because the composer was opened at some
     * earlier moment and the answer may have been withdrawn since.
     */
    const to = toE164(candidate.phone);
    const blocked = this.blockedReason(candidate, to);
    if (blocked) throw new BadRequestException({ message: blocked });

    const now = new Date();
    let sid: string | null = null;
    let status = 'queued';
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let failure: Error | null = null;

    try {
      const result = await this.twilio.send(to, text);
      sid = result.sid;
      status = mapProviderStatus(result.status) ?? 'queued';
      // `read` is not a status this table holds; nothing Twilio returns maps to it, but the column
      // has a CHECK constraint and a surprise here would fail the insert rather than the send.
      if (status === 'read') status = 'sent';
    } catch (ex) {
      failure = ex as Error;
      status = 'failed';
      const payload = (ex as { response?: { message?: string; code?: string } }).response;
      errorCode = payload?.code ?? null;
      errorMessage = (payload?.message ?? failure.message ?? 'The gateway refused the message.').slice(0, 255);
    }

    const row = await this.prisma.recruitment_messages.create({
      data: {
        candidate_id: candidate.id,
        status,
        provider_sid: sid,
        error_code: errorCode,
        error_message: errorMessage,
        body: text,
        phone: to,
        sent_at: now,
        created_by: user.name ?? null,
        user_id: user.id ?? null,
        created_at: now,
        updated_at: now,
      },
    });

    /*
     * The history the recruiter reads. Written for a failure as well as a success, and says which —
     * "we texted them" and "we tried to text them and it bounced" are different facts about a
     * candidate, and only one of them means they heard from the brokerage.
     */
    await this.recruitment.event(
      this.prisma,
      candidate.id,
      failure ? 'sms_failed' : 'sms_sent',
      failure
        ? `Text to ${to} failed: ${errorMessage}`
        : `Text sent to ${to}: ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`,
      user,
    );

    if (failure) {
      // Re-thrown so the composer shows Twilio's own reason; the row above is already recorded.
      throw new BadRequestException({ message: errorMessage, code: errorCode ?? undefined });
    }
    return { data: row };
  }

  /**
   * Record whether this candidate agreed to be texted.
   *
   * WRITTEN WITH A NAME AND A TIME, always. A bare "yes" that nobody put their name to is not a
   * record of consent, and the column's CHECK constraint refuses one — so this sets all three
   * together or not at all.
   *
   * WITHDRAWING IS RECORDING `false`, NOT CLEARING THE FIELD. Back to NULL would say "nobody ever
   * asked", which would be false, and would quietly lose the fact that somebody said no.
   */
  async setConsent(user: AuthUserRecord, candidateId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const candidate = await this.recruitment.candidateFor(user, candidateId);

    const raw = body.consent;
    if (raw !== true && raw !== false && raw !== 'true' && raw !== 'false') {
      throw new BadRequestException({ message: 'Record whether the candidate agreed to be texted: yes or no.' });
    }
    const answer = raw === true || raw === 'true';
    const note = str(body.note).slice(0, 255) || null;
    const now = new Date();

    const row = await this.prisma.recruitment_candidates.update({
      where: { id: candidate.id },
      data: {
        sms_consent: answer,
        sms_consent_at: now,
        sms_consent_by: user.name ?? 'Unknown',
        sms_consent_note: note,
        updated_at: now,
      },
    });

    await this.recruitment.event(
      this.prisma, candidate.id,
      answer ? 'sms_consent_given' : 'sms_consent_withdrawn',
      answer
        ? `Agreed to be texted${note ? ` — ${note}` : ''}.`
        : `Asked not to be texted${note ? ` — ${note}` : ''}.`,
      user,
    );

    return { data: row };
  }

  /** Every text sent to this candidate, newest first — the delivery record behind the history. */
  async list(user: AuthUserRecord, candidateId: number): Promise<Record<string, unknown>> {
    const candidate = await this.recruitment.candidateFor(user, candidateId);
    const data = await this.prisma.recruitment_messages.findMany({
      where: { candidate_id: candidate.id },
      orderBy: { sent_at: 'desc' },
      take: 100,
    });
    return { data };
  }
}
