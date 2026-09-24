import type { Prisma } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { checklistFor, interlinkGroupsFor } from './checklist-definitions';
import { governingStatus } from './document-defaults.service';

/**
 * DOCUMENTS THAT SATISFY EACH OTHER - TD-159 slice 3.
 *
 * The brokerage's rule, in their words: "Interlink with Notice of Fulfilment & Waiver ; if one of
 * these Documents uploaded, rest 2 remain Non-Mandatory", and for the two commercial lease forms
 * "Either this or the other sub-document. Both Mandatory until ONE is uploaded; the other then
 * becomes Non-Mandatory." THE RELAXED ROWS STAY ON SCREEN - they confirmed that explicitly. Nothing
 * here removes or hides anything; only the Mandatory flag moves.
 *
 * WHY THE ANSWER IS WRITTEN DOWN RATHER THAN WORKED OUT WHEN A LIST IS READ. "Is this document
 * still outstanding" is computed in three separate implementations - `docCounts` in TypeScript,
 * `report-docs.sql.ts` in raw SQL, and the dashboard's own Prisma counts - and read in about ten
 * places besides. Working the interlink out at read time would mean writing one rule three times in
 * three languages, which is precisely the shape that produced TD-201, TD-202 and TD-203: a rule
 * written twice with nothing to notice when the copies drift. Writing the flag at the moment a file
 * arrives makes every one of those readers correct without touching any of them.
 *
 * IT IS NOT A ONE-WAY DOOR. The target value is recomputed from the brokerage's own list every
 * time, never from what the row currently says, so removing the last file in a group puts the
 * others back to Mandatory. A row cannot drift by being visited repeatedly.
 *
 * AND A PERSON'S DECISION OUTRANKS IT, which the brokerage ruled on 2026-09-24: "their tick stands
 * - like the waiver & Notice of Fulfilment, both docs will be mandatory", and it applies to that
 * one deal only. `documents.mandatory_override` records that somebody set the flag by hand; a row
 * carrying one is never touched here. It is null on every row that existed before this shipped, so
 * the rule starts with no exceptions and only acquires them deliberately.
 */

/** The columns this rule needs. Deliberately narrow so callers can pass a light `select`. */
export interface InterlinkRow {
  id: number;
  title: string;
  mandatory: boolean;
  mandatory_override: boolean | null;
  file_path: string | null;
  files: string | null;
}

/**
 * Whether a checklist row HAS A FILE, for the purpose of satisfying its group.
 *
 * DRAFTS DO NOT COUNT. `draft_files` holds what an agent has uploaded but not submitted; treating
 * those as proof would let a deal's mandatory documents fall away before the brokerage has been
 * given anything. Both submitted shapes do count - the single `file_path` the older upload path
 * writes, and the `files` array the newer one appends to - because a document is a document
 * whichever route it arrived by.
 */
export function hasSubmittedFile(row: Pick<InterlinkRow, 'file_path' | 'files'>): boolean {
  if (row.file_path) return true;
  if (!row.files) return false;
  try {
    const parsed: unknown = JSON.parse(row.files);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // A files column that will not parse is not evidence of anything. Treated as empty rather than
    // as present, so a corrupt value can never relax a mandatory document.
    return false;
  }
}

/**
 * What this deal's interlinked rows SHOULD say, compared with what they do say.
 *
 * Pure: it reads rows and returns the changes, so the same function answers for a real deal, a
 * test, and the preview that slice 5 will need. Returns [] when nothing needs to move.
 */
export function interlinkChanges(
  type: string | null | undefined,
  status: string | null | undefined,
  rows: InterlinkRow[],
): { id: number; title: string; mandatory: boolean }[] {
  const groups = interlinkGroupsFor(type, status);
  if (Object.keys(groups).length === 0) return [];

  const fromTheSheet = new Map<string, boolean>();
  for (const item of checklistFor(type, status)) fromTheSheet.set(item.title, item.mandatory);

  const changes: { id: number; title: string; mandatory: boolean }[] = [];
  for (const titles of Object.values(groups)) {
    const members = rows.filter((r) => titles.includes(r.title));
    const satisfied = members.some(hasSubmittedFile);

    for (const row of members) {
      if (row.mandatory_override !== null) continue; // somebody decided this one by hand

      // The member that carries the file keeps its own value - it is satisfied anyway, and marking
      // it Non-Mandatory would say the brokerage does not want the document it has just been given.
      const target = satisfied && !hasSubmittedFile(row)
        ? false
        : (fromTheSheet.get(row.title) ?? row.mandatory);

      if (target !== row.mandatory) changes.push({ id: row.id, title: row.title, mandatory: target });
    }
  }
  return changes;
}

type Db = Pick<Prisma.TransactionClient, 'documents' | 'transactions'>;

const log = new Logger('document-interlinks');

/**
 * Recompute one deal's interlinked rows and write whatever moved.
 *
 * Best-effort by design: it is called after a file has already been stored, and an upload must not
 * fail because a Mandatory flag could not be adjusted. Returns the rows it changed so the caller
 * can record them.
 */
export async function applyInterlinks(db: Db, txnId: number): Promise<{ id: number; title: string; mandatory: boolean }[]> {
  try {
    const txn = await db.transactions.findFirst({
      where: { id: txnId, deleted_at: null },
      select: { type: true, transaction_statuses: { select: { status: true } } },
    });
    if (!txn) return [];

    const status = governingStatus(txn.type ?? '', (txn.transaction_statuses ?? []).map((s) => s.status));
    const rows = await db.documents.findMany({
      where: { transaction_id: txnId, deleted_at: null },
      select: { id: true, title: true, mandatory: true, mandatory_override: true, file_path: true, files: true },
    });

    const changes = interlinkChanges(txn.type, status, rows);
    const now = new Date();
    for (const change of changes) {
      await db.documents.update({ where: { id: change.id }, data: { mandatory: change.mandatory, updated_at: now } });
    }
    return changes;
  } catch (err) {
    /*
     * BEST-EFFORT, AND THE HEADER OF THIS FILE PROMISED AS MUCH - the first version did not deliver
     * it. Every caller runs this AFTER the file has been stored and the audit written, so a throw
     * here fails the request on work that has already succeeded, and the person is told their
     * upload did not work when it did.
     *
     * NOTHING IS LOST BY CARRYING ON. The rule recomputes from the brokerage's list on the deal's
     * next document action - and there are eight places that trigger it - so a transient failure
     * repairs itself. It is logged rather than swallowed, because a rule that stops working
     * silently is how a compliance figure drifts without anybody noticing.
     */
    log.warn(`interlink recalculation failed for transaction ${txnId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
