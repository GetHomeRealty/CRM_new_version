import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { can, type Principal } from '../core/authz';

/**
 * CHANGING WHETHER A DOCUMENT IS MANDATORY IS A SUPER ADMIN ACTION - the brokerage's ruling of
 * 2026-09-24: "tick & Untick mandatory option can only be under 'Super Admin' Approval method only".
 *
 * WHY THIS FLAG AND NOT THE REST OF THE ROW. Mandatory is what the compliance figures COUNT. The
 * Documentation Status and RECO Audit Readiness reports, the Dashboard's outstanding tile and the
 * deal's own panel all reduce to "mandatory and not yet Valid", so unticking one box removes an
 * outstanding document from every one of them at once. Title, Status and Validation describe a
 * document; Mandatory decides whether its absence is a problem.
 *
 * IT RIDES ON THE APPROVAL QUEUE THE APPLICATION ALREADY HAS rather than introducing a second one.
 * `transaction_edit_requests` already carries who asked, why, whether it is pending, and who
 * reviewed it; financial fields and DFT-locked deals both work this way, and a Super Admin approves
 * from the screen the office already uses. A parallel mechanism would mean two queues to watch and
 * two sets of words for one idea.
 *
 * THE APPROVAL IS SPENT, NOT MERELY CHECKED. The DFT lock marks its request `applied` once used;
 * the financial path only tests that one exists, which means a single "yes" authorises every later
 * change to that deal's money. This follows the DFT pattern deliberately: an approval is permission
 * for the change that was asked about, not a standing licence.
 */

/** What the caller already holds: the incoming row as the screen sent it, with Mandatory normalised. */
export interface IncomingMandatory {
  id?: number | null;
  title: string;
  mandatory: boolean;
}

/** What the deal currently says. */
export interface StoredMandatory {
  id: number;
  title: string;
  mandatory: boolean;
}

export interface MandatoryMove {
  id: number;
  title: string;
  from: boolean;
  to: boolean;
}

/**
 * Which rows this save would MOVE the Mandatory flag on.
 *
 * ROWS THAT DID NOT MOVE ARE NOT CHANGES, and that distinction is the whole guard. The screen sends
 * every row on every save, so testing "did the payload mention Mandatory" would refuse every save
 * anybody made. A new row is not a move either - it has no previous value to differ from, and the
 * seeded checklist decides what it starts as.
 */
export function mandatoryMoves(incoming: IncomingMandatory[], stored: StoredMandatory[]): MandatoryMove[] {
  const byId = new Map<number, StoredMandatory>(stored.map((s) => [s.id, s]));
  const moves: MandatoryMove[] = [];
  for (const row of incoming) {
    const id = Number(row.id ?? 0);
    if (!id) continue;
    const was = byId.get(id);
    if (!was) continue;
    if (was.mandatory !== row.mandatory) {
      moves.push({ id, title: was.title, from: was.mandatory, to: row.mandatory });
    }
  }
  return moves;
}

/** The sentence somebody sees when they are not the one who may make this change. */
export function mandatoryRefusal(moves: MandatoryMove[]): string {
  const names = moves.map((m) => m.title).join(', ');
  const one = moves.length === 1;
  return `Changing whether ${names} ${one ? 'is' : 'are'} Mandatory needs Super Admin approval, because `
    + `${one ? 'it decides' : 'they decide'} whether a missing document is reported as outstanding. `
    + 'Ask a Super Admin to approve the change - use "Request Edit" - then save again.';
}

type Db = Pick<Prisma.TransactionClient, 'transaction_edit_requests'>;

/**
 * Let this change through, or refuse it.
 *
 * A Super Admin changes Mandatory directly, exactly as they already edit financial fields and
 * closed deals directly. Anybody else needs an approved request against this deal, and using it
 * spends it.
 */
export async function requireMandatoryApproval(
  db: Db,
  user: Principal | null | undefined,
  txnId: number,
  moves: MandatoryMove[],
): Promise<void> {
  if (moves.length === 0) return;
  if (can(user, 'documents.set-mandatory')) return;

  const approved = await db.transaction_edit_requests.findFirst({
    where: { transaction_id: txnId, scope: 'mandatory', status: 'approved' },
    orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
  });
  if (!approved) throw new ForbiddenException({ message: mandatoryRefusal(moves) });

  await db.transaction_edit_requests.update({
    where: { id: approved.id },
    data: { status: 'applied', updated_at: new Date() },
  });
}
