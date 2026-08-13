import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUserRecord } from '../auth.types';

export interface MfaPolicyView {
  role: string;
  required: boolean;
  grace_days: number;
}

export type MfaObligation =
  /** No policy applies, or one is already enrolled. Nothing to do. */
  | { state: 'none' }
  /** Required, not yet enrolled, still inside the grace period. Prompt, do not block. */
  | { state: 'grace'; days_left: number }
  /** Required, not enrolled, grace exhausted. The account may only finish enrolment. */
  | { state: 'overdue' };

/**
 * Whether a role must hold a second factor, per brokerage.
 *
 * WHY A GRACE PERIOD EXISTS AT ALL. Switching a policy on is a single click that would otherwise
 * lock out every person covered by it at once — including, on a bad day, the administrator who just
 * clicked it. The grace period turns that into a deadline everyone can see, and it is measured from
 * the LATER of the person's account creation and the policy's last change, so somebody hired after
 * the policy was set gets their own full window rather than a deadline that has already passed.
 *
 * DEFAULT IS OFF. With no rows in `mfa_policies` nothing is required of anyone, so installing this
 * feature changes nobody's sign-in until a brokerage decides otherwise.
 */
@Injectable()
export class MfaPolicyService {
  private readonly log = new Logger(MfaPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every policy row, for the settings screen. */
  async list(): Promise<MfaPolicyView[]> {
    const rows = await this.prisma.mfa_policies.findMany({
      orderBy: { role: 'asc' },
      select: { role: true, required: true, grace_days: true },
    });
    return rows;
  }

  /** Set the policy for one role. */
  async set(role: string, required: boolean, graceDays: number): Promise<MfaPolicyView> {
    const now = new Date();
    const grace = Number.isFinite(graceDays) && graceDays >= 0 ? Math.floor(graceDays) : 7;
    /*
     * `updated_at` moves on every change, and the grace period is measured from it. That is
     * deliberate: turning the requirement off and on again, or extending the grace, restarts the
     * clock rather than leaving people instantly overdue against a date they never saw.
     *
     * Find-then-write rather than `upsert`, because the uniqueness that made a keyed upsert possible
     * is now on `role` alone and Prisma exposes a compound accessor only while the compound key
     * exists. The unique index still refuses a second row for a role, so a concurrent double-create
     * fails loudly rather than duplicating the policy.
     */
    const existing = await this.prisma.mfa_policies.findFirst({ where: { role }, select: { id: true } });
    const row = existing
      ? await this.prisma.mfa_policies.update({
          where: { id: existing.id },
          data: { required, grace_days: grace, updated_at: now },
          select: { role: true, required: true, grace_days: true },
        })
      : await this.prisma.mfa_policies.create({
          data: { role, required, grace_days: grace, created_at: now, updated_at: now },
          select: { role: true, required: true, grace_days: true },
        });
    this.log.log(`Two-factor policy for "${role}" set to ${required ? 'required' : 'optional'} (grace ${grace}d).`);
    return row;
  }

  /**
   * What this person owes, given the policy and whether they have enrolled.
   *
   * `enrolled` is passed in rather than looked up so this stays a pure decision about the policy —
   * it is called on the sign-in path, where the caller already knows the answer.
   */
  async obligationFor(user: AuthUserRecord, enrolled: boolean, now: Date = new Date()): Promise<MfaObligation> {
    if (enrolled) return { state: 'none' };

    const policy = await this.prisma.mfa_policies.findFirst({
      where: { role: user.role || 'agent' },
      select: { required: true, grace_days: true, updated_at: true },
    });
    if (!policy?.required) return { state: 'none' };

    // The later of "when this policy last changed" and "when this account was created".
    const from = Math.max(
      policy.updated_at.getTime(),
      user.created_at ? user.created_at.getTime() : 0,
    );
    const deadline = from + policy.grace_days * 24 * 60 * 60 * 1000;
    const msLeft = deadline - now.getTime();

    if (msLeft <= 0) return { state: 'overdue' };
    return { state: 'grace', days_left: Math.ceil(msLeft / (24 * 60 * 60 * 1000)) };
  }
}
