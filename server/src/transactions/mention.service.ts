import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import type { ResourceUser } from './transaction.resource';

export interface MentionCandidate {
  id: number;
  name: string;
}

export interface ResolvedMentions {
  /** Ids that survived every check and may be notified. */
  allowed: number[];
  /**
   * Ids that were asked for and refused, with the reason.
   *
   * Kept rather than silently dropped so the log can say why somebody was not told, and so a test
   * can prove the difference between "not mentioned" and "mentioned but refused".
   */
  refused: Array<{ id: number; reason: 'self' | 'unknown' | 'inactive' | 'no_access' }>;
}

/**
 * Who a chat message mentions, and who may be told about it.
 *
 * THE SECURITY RULE THIS FILE EXISTS FOR. A mention must only ever reach somebody who could already
 * open the deal. Without that check, typing `@` and a name is a way to tell an outsider that a
 * transaction exists, what property it concerns, and what the team is saying about it — and it
 * would not look like a leak from the inside, it would look like the feature working.
 *
 * So the ids arriving from the client are treated as a REQUEST, never as a decision:
 *
 *   client sends ids  →  drop the author  →  must exist  →  must be active
 *                     →  must be able to open THIS deal  →  allowed
 *
 * The client resolves `@John` to a person as it is typed, which is what stops two colleagues sharing
 * a first name from being confused for one another. That is a usability measure and nothing more —
 * every id is re-checked here, because anything the client sends is something a caller can forge.
 */
@Injectable()
export class MentionService {
  private readonly log = new Logger(MentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResourceAccessService,
  ) {}

  /** How many people one message may notify. A guard against a paste that names everybody. */
  static readonly MAX_MENTIONS = 20;

  /**
   * People the author may mention on this deal — what the client's autocomplete offers.
   *
   * Only those who can already open it, so the list itself cannot be used to discover who exists
   * outside the deal. The author is included: seeing yourself in the list is unsurprising, and
   * mentioning yourself simply does not notify you (see `resolve`).
   */
  /** How many names the autocomplete offers at once. */
  static readonly MAX_CANDIDATES = 25;

  /** Rows read per pass while looking for them. */
  private static readonly PAGE = 100;

  /**
   * The furthest this will read before giving up.
   *
   * Reachability is one query per person, so an unbounded search would cost a query per member of
   * staff on every keystroke. Five passes is the compromise: deep enough that the cap is not the
   * thing deciding who appears, bounded enough that a brokerage of thousands cannot turn one
   * autocomplete into a scan of the whole user table.
   */
  private static readonly MAX_SCAN = 500;

  async candidates(user: ResourceUser | null, txnId: number, search?: string): Promise<MentionCandidate[]> {
    await this.access.assertTransaction(user, txnId);

    const needle = (search ?? '').trim();
    const where = {
      status: 'Active',
      ...(needle ? { name: { contains: needle, mode: 'insensitive' as const } } : {}),
    };

    /*
     * PAGED, BECAUSE THE CAP USED TO DECIDE THE ANSWER.
     *
     * This read the first 100 active users by name and only THEN asked which of them could open the
     * deal. Past a hundred staff, whether somebody appeared in the autocomplete depended on where
     * their name fell in the alphabet rather than on whether they were on the deal: a colleague
     * sorting after the hundredth name could never be offered, and nothing said so. It failed
     * quietly, which is the worst way for a permissions-shaped list to fail.
     *
     * It became visible when this brokerage's active users reached exactly 100 and a test that
     * creates a "ZZ ..." colleague started failing with no code change - the fixture sorted last, so
     * it was always the first casualty.
     *
     * The filter is still applied after the read, because reachability is not expressible in the
     * query. What changed is that a short page no longer ends the search.
     */
    const reachable: MentionCandidate[] = [];
    for (let skip = 0; skip < MentionService.MAX_SCAN; skip += MentionService.PAGE) {
      const people = await this.prisma.users.findMany({
        where,
        select: { id: true, name: true, role: true },
        orderBy: { name: 'asc' },
        skip,
        take: MentionService.PAGE,
      });
      if (!people.length) break;

      for (const person of people) {
        if (await this.access.canReachTransaction(person, txnId)) {
          reachable.push({ id: person.id, name: person.name });
          if (reachable.length >= MentionService.MAX_CANDIDATES) return reachable;
        }
      }
      // A short page is the end of the table, not the end of the budget.
      if (people.length < MentionService.PAGE) break;
    }
    return reachable;
  }

  /**
   * Turn the ids a client sent into the ids that may be notified.
   *
   * Deduplicated first, so naming the same person twice in one message is one mention — the message
   * says something once, and being told about it twice is a bug people notice immediately.
   */
  async resolve(author: ResourceUser | null, txnId: number, requested: unknown): Promise<ResolvedMentions> {
    const ids = this.sanitise(requested);
    const result: ResolvedMentions = { allowed: [], refused: [] };
    if (!ids.length) return result;

    const people = await this.prisma.users.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, role: true, status: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));

    for (const id of ids) {
      // Mentioning yourself is allowed and simply does not notify: people write "@me" as a note to
      // themselves, and a notification about something you just typed is noise.
      if (author?.id === id) { result.refused.push({ id, reason: 'self' }); continue; }

      const person = byId.get(id);
      if (!person) { result.refused.push({ id, reason: 'unknown' }); continue; }
      if ((person.status ?? 'Active') === 'Inactive') { result.refused.push({ id, reason: 'inactive' }); continue; }

      if (!(await this.access.canReachTransaction(person, txnId))) {
        // The one that matters. Logged, because somebody repeatedly naming people who cannot see a
        // deal is worth being able to notice.
        this.log.warn(`Mention of user #${id} on transaction ${txnId} refused: no access to that deal.`);
        result.refused.push({ id, reason: 'no_access' });
        continue;
      }

      result.allowed.push(id);
    }
    return result;
  }

  /** Whatever arrived over the wire, reduced to a sane list of distinct positive integers. */
  private sanitise(requested: unknown): number[] {
    const raw = Array.isArray(requested) ? requested : [];
    const ids: number[] = [];
    for (const value of raw) {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (!ids.includes(id)) ids.push(id);       // deduplicated: one mention per person per message
      if (ids.length >= MentionService.MAX_MENTIONS) break;
    }
    return ids;
  }

  /** The stored form. Null rather than `[]` so an unmentioned message stores nothing. */
  static encode(ids: number[]): string | null {
    return ids.length ? JSON.stringify(ids) : null;
  }

  /** The stored form, read back. Never throws on a malformed value — it is only a highlight. */
  static decode(stored: string | null | undefined): number[] {
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed.filter((v) => Number.isInteger(v)) : [];
    } catch {
      return [];
    }
  }
}
