import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { isAgent } from '../core/authz';

const str = (v: unknown): string => String(v ?? '').trim();
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTE_MAX = 2_000;

/**
 * An agent referring somebody to the brokerage — SUBMISSION ONLY.
 *
 * WHY THIS IS NOT `RecruitmentService.create`. That method is the recruiter's: it sits behind
 * `recruitment: 'edit'`, returns the candidate, and assigns it to whoever created it. An agent holds
 * none of the Recruitment permissions and must gain none, so this is a separate, narrower door:
 *
 *   - it can only CREATE. There is no read, update or delete here, and nothing returned names the
 *     candidate's id or status, so the response cannot be used to look the record up afterwards;
 *   - the referring agent is taken from the session, never from the request body;
 *   - the candidate lands exactly where the existing workflow picks new people up — status `new`,
 *     source `referral`, UNASSIGNED — so the Admin / Recruiter queue (`recruitment.view-all`) sees
 *     it and assigns a recruiter as it would any other.
 *
 * The note goes in as the candidate's first note, so the recruiter reads it where they read every
 * other note, and the history records the referral like any other event.
 */
@Injectable()
export class RecruitmentReferralService {
  constructor(private readonly prisma: PrismaService) {}

  async refer(user: AuthUserRecord, body: Record<string, unknown>): Promise<{ message: string }> {
    if (!isAgent(user) || !user.id) {
      throw new ForbiddenException({ message: 'Only agents can refer a candidate here.' });
    }

    const name = str(body.name);
    const phone = str(body.phone);
    const email = str(body.email).toLowerCase();
    const note = str(body.note);

    if (!name) throw new BadRequestException({ message: 'Enter the candidate\'s name.' });
    if (name.length > 255) throw new BadRequestException({ message: 'The name is too long.' });
    if (phone.replace(/\D/g, '').length < 7) throw new BadRequestException({ message: 'Enter the candidate\'s phone number.' });
    if (phone.length > 64) throw new BadRequestException({ message: 'The phone number is too long.' });
    if (email && (!EMAIL_SHAPE.test(email) || email.length > 255)) {
      throw new BadRequestException({ message: 'That email address does not look right. Leave it blank if you do not have one.' });
    }
    if (note.length > NOTE_MAX) throw new BadRequestException({ message: `Keep the note under ${NOTE_MAX} characters.` });

    const now = new Date();
    // One statement: the candidate, its note and its history entry exist together or not at all.
    await this.prisma.recruitment_candidates.create({
      data: {
        name,
        // The column is required; an empty value means "not given" and the recruiter fills it in.
        email,
        phone,
        source: 'referral',
        referred_by_user_id: user.id,
        assigned_recruiter_id: null,
        status: 'new',
        created_by: user.name ?? null,
        created_at: now,
        updated_at: now,
        ...(note ? { notes: { create: { body: note, author: user.name ?? null, user_id: user.id, created_at: now } } } : {}),
        events: {
          create: {
            action: 'referred',
            detail: `Referred by ${user.name ?? 'an agent'}.`,
            actor_name: user.name ?? null,
            actor_id: user.id,
            created_at: now,
          },
        },
      },
      select: { id: true },
    });

    return { message: `Thank you — ${name} has been referred to the recruitment team.` };
  }
}
