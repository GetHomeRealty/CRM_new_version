import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';

/**
 * The one place in this application that turns a password into a hash, or checks one against it.
 *
 * WHY THIS EXISTS. There were two. `AuthService` hashed at `config.bcryptRounds` (default 12) for
 * registration and self-service password changes; `UsersService` hashed at a hardcoded **10** for
 * admin-created accounts and admin password resets, ignoring the configuration entirely.
 *
 * That is not a rounding error in a config value. Public registration is CLOSED — `register()`
 * refuses once any user exists — so an administrator creates every account in the system, which
 * means the cost-10 path was the path essentially every password took. Raising `BCRYPT_ROUNDS`
 * would have changed nothing for them, and the comment on `AccountLockoutService` describing
 * "bcrypt at cost 12" as the thing that makes guessing expensive was describing a path most users
 * never went down.
 *
 * One service, one cost, one set of rules. Nothing outside this file calls bcrypt.
 */
@Injectable()
export class PasswordHashService {
  private readonly log = new Logger(PasswordHashService.name);
  private readonly rounds: number;

  constructor(config: ConfigService) {
    this.rounds = config.get<number>('bcryptRounds') ?? PasswordHashService.DEFAULT_ROUNDS;
  }

  /** Matches `configuration.ts`, so a missing config and a missing ConfigService agree. */
  static readonly DEFAULT_ROUNDS = 12;

  /**
   * bcrypt reads at most 72 BYTES and silently ignores the rest.
   *
   * Bytes, not characters: an accented or non-Latin password reaches the limit sooner than its
   * length suggests. Accepting a longer one would mean the part beyond 72 bytes is not protecting
   * anything, while the interface implies it is — so it is refused rather than quietly truncated.
   */
  static readonly MAX_PASSWORD_BYTES = 72;

  /** The cost new hashes are written at. Exposed so tests and diagnostics need not guess. */
  getConfiguredCost(): number {
    return this.rounds;
  }

  /** Whether a password can be used in full, or is longer than bcrypt will read. */
  fits(password: string): boolean {
    return Buffer.byteLength(password ?? '', 'utf8') <= PasswordHashService.MAX_PASSWORD_BYTES;
  }

  /** Hash at the configured cost. The only place a password hash is produced. */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.rounds);
  }

  /**
   * Check a password against a stored hash.
   *
   * Returns false rather than throwing on a malformed or empty hash: a user row with no usable
   * password must fail to sign in, not crash the login route. bcrypt's own comparison is constant
   * time for a given hash, which is what keeps this from leaking whether a password was close.
   */
  async verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
    if (!hash) return false;
    try {
      return await bcrypt.compare(password, hash);
    } catch {
      return false;
    }
  }

  /**
   * Is this hash weaker than the cost we now write at?
   *
   * The cost is embedded in the hash itself (`$2a$10$...`), so this needs no record of what the
   * setting used to be — which is what makes an upgrade possible at all. A hash that cannot be
   * parsed is treated as needing a rehash: an unreadable cost is not evidence of a strong one.
   *
   * Deliberately one-directional. A hash STRONGER than the configured cost is left alone, because
   * lowering `BCRYPT_ROUNDS` should never weaken passwords that are already better protected.
   */
  needsRehash(hash: string | null | undefined): boolean {
    if (!hash) return false;   // nothing to upgrade; the caller has a different problem
    const cost = this.costOf(hash);
    /*
     * `bcrypt.getRounds` answers NaN for a malformed hash rather than throwing — verified, not
     * assumed, and it is why this goes through `costOf` instead of comparing directly. `NaN < 12`
     * is FALSE, so a corrupt hash would have been reported as perfectly up to date and left alone
     * for ever, which is the opposite of what an unreadable hash deserves.
     */
    if (cost === null) {
      this.log.warn('Could not read the cost from a stored password hash; treating it as upgradable.');
      return true;
    }
    return cost < this.rounds;
  }

  /**
   * The cost recorded in a stored hash, or null when it cannot be read. Diagnostics only.
   */
  costOf(hash: string | null | undefined): number | null {
    if (!hash) return null;
    try {
      const cost = bcrypt.getRounds(hash);
      // NaN for anything that is not a bcrypt hash. Normalised to null so callers get one
      // "unknown" value instead of a number that fails every comparison silently.
      return Number.isInteger(cost) ? cost : null;
    } catch {
      return null;
    }
  }
}
