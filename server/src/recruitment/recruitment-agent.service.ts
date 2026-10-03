import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordHashService } from '../auth/password-hash.service';
import { passwordProblem } from '../auth/password-policy';
import type { AuthUserRecord } from '../auth/auth.types';
import { can } from '../core/authz';
import { RecruitmentService } from './recruitment.service';

const str = (v: unknown): string => String(v ?? '').trim();

/** Postgres's unique-violation code, which is how a race announces itself here. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * THE ONE PLACE A CANDIDATE BECOMES SOMEBODY WHO CAN SIGN IN.
 *
 * Everything else in this module is record-keeping. This creates a user, and once created that
 * person has a password and an account, so the checks are not advisory and the whole thing happens
 * inside one transaction: a half-finished conversion would leave either an account nobody can trace
 * to an application, or an application claiming an account that was never made.
 *
 * WHAT DECIDES A RACE. Two administrators pressing the button at the same moment would both read a
 * candidate with `agent_user_id` NULL and both proceed — a plain read tells neither what the other is
 * doing. So the candidate row is locked before it is read (step 1): the second conversion of the same
 * candidate waits, then sees the first one's committed link and is refused with step 2's message.
 *
 * Underneath that, the database still guarantees one account. The user row is inserted BEFORE the
 * link, with the candidate's own address, so it is the UNIQUE index on `users.email` that refuses a
 * second account — not the one on `agent_user_id`, which a same-address second insert never reaches.
 * That index is also what settles two DIFFERENT candidates sharing an address, which the row lock
 * does not serialise. The checks below exist to produce a good MESSAGE; the constraints exist to be
 * right whatever happens.
 */
@Injectable()
export class RecruitmentAgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHashService,
    private readonly recruitment: RecruitmentService,
  ) {}

  /**
   * Create the agent account for an approved candidate.
   *
   * THE ADMINISTRATOR CHOOSES THE PASSWORD, exactly as they do on the Users screen. This service
   * generated one and returned it in the response, which read well — nobody had to invent a password
   * — but it meant the plaintext travelled back through the API, into the browser's memory and
   * whatever sits between, for an account that can sign in. One workflow for setting a first
   * password is also one rule to keep correct; two was how the old eight-character minimum survived
   * in three files out of four. See `password-policy.ts`.
   *
   * Returns the candidate and the new user, AND NOT THE PASSWORD: the administrator typed it, so
   * they already have it, and the response is the one copy that need not exist.
   */
  async createAgent(user: AuthUserRecord, candidateId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!can(user, 'recruitment.decide')) {
      throw new ForbiddenException({
        message: 'Only an administrator can create an agent account from a candidate.',
      });
    }

    const username = str(body.username) || null;
    const role = str(body.role) || 'agent';

    /*
     * THE PASSWORD IS CHECKED BEFORE THE TRANSACTION OPENS, and deliberately so. It needs no row
     * from the database to judge, and hashing is slow on purpose — doing either inside the
     * transaction would hold a write lock on the candidate for the length of a bcrypt round while
     * answering a question that was already answerable.
     *
     * NOT TRIMMED. A password's leading or trailing space is part of it, and `str()` would quietly
     * remove it here and not at sign-in, locking the person out of the account just created.
     */
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
      throw new BadRequestException({ message: 'Enter an initial password for the agent account.' });
    }
    if (body.password_confirmation !== password) {
      throw new BadRequestException({ message: 'The password confirmation does not match.' });
    }
    const weak = passwordProblem(password);
    if (weak) throw new BadRequestException({ message: weak });

    /* Hashed out here too, for the same reason: bcrypt is deliberately slow. */
    const hashed = await this.passwords.hashPassword(password);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        /*
         * 1. LOCK THE CANDIDATE, THEN READ IT, inside the transaction. A copy fetched earlier could
         *    already be stale by the time the write happens, which is the whole of the race.
         *
         *    The lock is what makes the second of two conversions of ONE candidate wait here until
         *    the first commits. At READ COMMITTED (this transaction's level) its read then returns the
         *    row as committed — linked — and step 2 gives the true answer. Without it, both read an
         *    unlinked candidate and the loser was told the address "was created a moment ago", or to
         *    "link or rename" the account just made for this very person. Two DIFFERENT candidates
         *    are two rows and are not serialised by this; their clash is the address, below.
         */
        await tx.$queryRaw`SELECT id FROM recruitment_candidates WHERE id = ${candidateId} FOR UPDATE`;
        const candidate = await tx.recruitment_candidates.findFirst({
          where: { id: candidateId, deleted_at: null },
        });
        if (!candidate) throw new NotFoundException({ message: 'Candidate not found.' });

        /*
         * 2. ALREADY CONVERTED IS ASKED FIRST, and the order is load-bearing.
         *
         * Creating the account sets the status to `active`, which is not one of the statuses this
         * step accepts. So the second of two attempts — whether a moment later or a moment too late
         * in a race — would fail the status check and be told the candidate "has not been approved
         * yet", about somebody who was approved, hired and given an account. The true answer is
         * that the account exists, and it is true whatever the status says.
         */
        if (candidate.agent_user_id) {
          throw new BadRequestException({ message: 'An Agent account already exists for this candidate.' });
        }

        // 3. The brokerage must have accepted them. Onboarding counts; it follows approval.
        if (!['approved', 'onboarding'].includes(candidate.status)) {
          throw new BadRequestException({
            message: 'This candidate has not been approved yet. Approve them first, then create the account.',
          });
        }

        /*
         * 4. The address must be free. `users.email` is unique, so this would be refused anyway —
         *    the point of asking first is to say WHICH field clashes and with whom, rather than
         *    returning a constraint name to somebody who cannot act on it.
         */
        const clash = await tx.users.findFirst({
          where: { OR: [{ email: candidate.email }, ...(username ? [{ username }] : [])] },
          select: { id: true, email: true, username: true, name: true },
        });
        if (clash) {
          throw new BadRequestException({
            message: clash.email?.toLowerCase() === candidate.email.toLowerCase()
              ? `A user already exists with the address ${candidate.email} (${clash.name}). `
                + 'Link or rename that account rather than creating a second one.'
              : `The username ${username} is already taken.`,
          });
        }

        const now = new Date();

        // 5. The account.
        const created = await tx.users.create({
          data: {
            name: candidate.name,
            email: candidate.email,
            username,
            password: hashed,
            role,
            status: 'Active',
            created_at: now,
            updated_at: now,
          },
        });

        /*
         * 6-8. Link it, and say so on the candidate. `agent_user_id` is UNIQUE, so if another
         *      transaction got here first this update is what fails — which is the point. The
         *      status becomes `active` HERE and only here: it means an account exists, so nothing
         *      that is not creating one may set it.
         */
        const linked = await tx.recruitment_candidates.update({
          where: { id: candidate.id },
          data: { agent_user_id: created.id, activated_at: now, status: 'active', updated_at: now },
        });

        // 9. History, in the same transaction, so it cannot outlive a rollback.
        await this.recruitment.event(
          tx, candidate.id, 'agent_created',
          `Agent account created for ${candidate.email} (user #${created.id}, role ${role}).`,
          user,
        );

        return { candidate: linked, user: { id: created.id, name: created.name, email: created.email, role: created.role } };
      });

      /*
       * 10. Committed. The password is NOT echoed: the administrator typed it, and the account now
       *     holds nothing but its hash.
       */
      return result;
    } catch (e) {
      throw this.friendly(e);
    }
  }

  /**
   * Turn a lost race into the same sentence the ordinary case gives.
   *
   * Both administrators asked a reasonable question and one of them lost; the loser should be told
   * what is true — the account exists — not shown `agent_user_id_key`. A violation on `users` is
   * reported separately, because that one means somebody else took the address in between and the
   * answer is different.
   */
  private friendly(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === UNIQUE_VIOLATION) {
      const target = String((e.meta as { target?: string | string[] } | undefined)?.target ?? '');
      if (target.includes('agent_user_id')) {
        return new BadRequestException({ message: 'An Agent account already exists for this candidate.' });
      }
      if (target.includes('email')) {
        return new BadRequestException({
          message: 'A user with that email address was created a moment ago. Refresh and check before trying again.',
        });
      }
      if (target.includes('username')) {
        return new BadRequestException({ message: 'That username was taken a moment ago. Choose another.' });
      }
    }
    return e;
  }

}
