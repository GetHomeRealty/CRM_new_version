import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsSystem } from '../../core/tenant-context';
import { hashOneTimeValue } from './mfa-crypto';

/**
 * Recovery codes — the way back in when the second factor is gone.
 *
 * WHY THEY ARE NOT OPTIONAL. A phone is lost, stolen, wiped or replaced, and an authenticator's
 * secrets do not always survive it. Without recovery codes the only route back is an administrator,
 * and for the administrator's own account there is no route at all — which is how a two-factor
 * rollout locks a brokerage out of its own system. They are issued at enrolment, before the factor
 * is even confirmed working.
 *
 * WHY SHOWN ONCE. They are stored hashed, so this application genuinely cannot show them again. The
 * alternative — storing them readably so they can be re-displayed — would make the database a list
 * of working second-factor bypasses.
 */
@Injectable()
export class RecoveryCodeService {
  private readonly log = new Logger(RecoveryCodeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** How many are issued at a time. Ten is enough to survive a bad week and few enough to print. */
  static readonly COUNT = 10;

  /**
   * Crockford-style: no I, L, O, U, or digits 1 and 0.
   *
   * These get written down and typed back in — often from a photograph, sometimes months later. The
   * excluded characters are exactly the pairs people transcribe wrongly, and `1/I/l` and `0/O` are
   * the ones that turn a valid code into a support call nobody can diagnose.
   */
  private static readonly ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

  /** One code: 10 characters from a 30-character alphabet — a little over 49 bits. */
  private generateCode(): string {
    const chars = Array.from(
      { length: 10 },
      () => RecoveryCodeService.ALPHABET[randomInt(0, RecoveryCodeService.ALPHABET.length)],
    );
    // Grouped for transcription; the hash ignores the separator, so either form is accepted back.
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
  }

  /**
   * Replace every code this person holds with a fresh set, and return the plaintext ONCE.
   *
   * Replacing rather than adding is deliberate: "regenerate" has to invalidate a list that may have
   * been photographed, emailed to oneself, or left in a drawer at a previous job. Adding to it would
   * leave every one of those working.
   */
  async issue(userId: number, companyId: number): Promise<string[]> {
    const codes = Array.from({ length: RecoveryCodeService.COUNT }, () => this.generateCode());
    const now = new Date();

    await runAsSystem(async () => {
      await this.prisma.mfa_recovery_codes.deleteMany({ where: { user_id: userId } });
      await this.prisma.mfa_recovery_codes.createMany({
        data: codes.map((code) => ({
          user_id: userId,
          code_hash: hashOneTimeValue(code),
          created_at: now,
          company_id: companyId,
        })),
      });
    });

    this.log.log(`Issued ${codes.length} recovery codes for user #${userId}.`);
    return codes;
  }

  /** How many are left unspent — shown on the security screen so nobody runs out unknowingly. */
  async remaining(userId: number): Promise<number> {
    return runAsSystem(() => this.prisma.mfa_recovery_codes.count({
      where: { user_id: userId, used_at: null },
    }));
  }

  /**
   * Spend a code. Returns true only if it was unused and belonged to this person.
   *
   * THE UPDATE IS THE CHECK. Marking it used is an `updateMany` filtered on `used_at: null`, so two
   * simultaneous attempts with the same code cannot both succeed — the second updates zero rows.
   * Reading the row and then writing it would leave exactly that race open, and a recovery code is
   * the one credential where a race means two sessions from one single-use secret.
   */
  async redeem(userId: number, code: string, ip: string | null): Promise<boolean> {
    const hash = hashOneTimeValue(code);
    if (!code || !hash) return false;

    const result = await runAsSystem(() => this.prisma.mfa_recovery_codes.updateMany({
      where: { user_id: userId, code_hash: hash, used_at: null },
      data: { used_at: new Date(), used_ip: ip?.slice(0, 64) ?? null },
    }));

    if (result.count > 0) {
      this.log.log(`Recovery code redeemed for user #${userId}.`);
      return true;
    }
    return false;
  }

  /** Drop every code — used when two-factor is turned off, so nothing outlives it. */
  async revokeAll(userId: number): Promise<void> {
    await runAsSystem(() => this.prisma.mfa_recovery_codes.deleteMany({ where: { user_id: userId } }));
  }
}
