import { Prisma } from '@prisma/client';
import { checklistFor } from './checklist-definitions';

/**
 * BRINGING A DEAL'S CHECKLIST UP TO ITS TYPE AND STATUS - WITHOUT EVER REMOVING ANYTHING.
 *
 * THE BROKERAGE RULED ON 2026-09-25, in their own words: "remain on list but as non-mandatory.
 * even if any document already exists, those items remain as is & do not remove item as well as
 * document. any document should not be deleted by default without approvals."
 *
 * So this does three things and no fourth:
 *   1. ADDS a document the deal's new checklist asks for and the deal does not have.
 *   2. CORRECTS the Mandatory flag of a document that checklist does ask for.
 *   3. Sets NON-MANDATORY a document that checklist does not mention.
 * Nothing is deleted, nothing is soft-deleted, and no file is touched by any path through here.
 *
 * WHAT IT REFUSES TO SPEAK FOR. A row added by hand (manual) and a row belonging to a condition
 * were never put there by a checklist, so no checklist may move them - the brokerage's third
 * answer, and the same rule syncConditionDocs needs in reverse. A row whose mandatory_override is
 * set was ticked or unticked by a PERSON (TD-159), and a person outranks a default.
 *
 * TITLES ARE MATCHED CASE-INSENSITIVELY AND TRIMMED, because the same document has been typed
 * three ways across the brokerage's history and a checklist that adds a second copy of a document
 * the deal already holds is worse than one that adds nothing.
 */
export interface ChecklistSyncResult {
  /** Documents the new checklist asked for that the deal did not have. */
  added: number;
  /** Documents whose Mandatory flag the new checklist moved. */
  flagged: number;
  /** Documents the new checklist does not mention, set non-mandatory rather than removed. */
  relaxed: number;
}

const key = (s: string): string => (s ?? '').trim().toLowerCase();

/**
 * Reconcile one deal's checklist against `type` and `status`, and report what it did.
 *
 * NOT best-effort, deliberately: it runs inside the caller's transaction, and a half-applied
 * checklist is worse than an unchanged one.
 */
export async function syncChecklistToStatus(
  db: Prisma.TransactionClient,
  txnId: number,
  type: string,
  status: string,
): Promise<ChecklistSyncResult> {
  const out: ChecklistSyncResult = { added: 0, flagged: 0, relaxed: 0 };
  const wanted = checklistFor(type, status);
  // No checklist is defined for this pairing. Say nothing, rather than relax every row on the deal.
  if (wanted.length === 0) return out;

  const existing = await db.documents.findMany({
    where: { transaction_id: txnId, deleted_at: null },
    select: {
      id: true, title: true, mandatory: true, manual: true,
      is_condition: true, mandatory_override: true, position: true,
    },
  });
  const untouched = (d: { manual: boolean; is_condition: boolean; mandatory_override: boolean | null }): boolean =>
    d.manual || d.is_condition || (d.mandatory_override ?? null) !== null;

  const owned = new Map<string, (typeof existing)[number]>();
  for (const d of existing) if (!untouched(d) && !owned.has(key(d.title))) owned.set(key(d.title), d);

  const now = new Date();
  let position = existing.reduce((m, d) => Math.max(m, d.position ?? 0), -1);

  for (const w of wanted) {
    const have = owned.get(key(w.title));
    if (!have) {
      position += 1;
      await db.documents.create({
        data: { transaction_id: txnId, title: w.title, mandatory: w.mandatory, position, created_at: now, updated_at: now },
      });
      out.added += 1;
    } else if (have.mandatory !== w.mandatory) {
      await db.documents.update({ where: { id: have.id }, data: { mandatory: w.mandatory, updated_at: now } });
      out.flagged += 1;
    }
  }

  const asked = new Set(wanted.map((w) => key(w.title)));
  for (const d of existing) {
    if (untouched(d) || asked.has(key(d.title)) || !d.mandatory) continue;
    await db.documents.update({ where: { id: d.id }, data: { mandatory: false, updated_at: now } });
    out.relaxed += 1;
  }

  return out;
}
