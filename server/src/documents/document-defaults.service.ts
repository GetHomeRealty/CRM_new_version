import type { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { checklistFor, statusesDefinedFor } from './checklist-definitions';
import { isTerminalStatus } from '../reference/transaction.constants';

/**
 * The default document checklist for a deal.
 *
 * TD-159 - THE LISTS NOW DEPEND ON THE DEAL'S STATUS AS WELL AS ITS TYPE, which is what the
 * brokerage asked for and returned answered on 2026-09-23. They live in `checklist-definitions.ts`,
 * transcribed from their own workbook; that file's header records how it was produced and the two
 * judgement calls in it.
 *
 * WHAT THIS REPLACES, AND WHY THE HISTORY MATTERS. TD-149 (2026-09-08) put six hand-keyed lists
 * here, one per type, after the brokerage supplied them - which was itself a correction of an
 * INVENTED list that this file's original author had refused to write and someone else had written
 * anyway. The principle has not changed and is worth restating: which documents a brokerage is
 * obliged to hold is a RECO question with a real answer, and inventing one would put a compliance
 * assertion into the product on no authority. Every row below still comes from Get Home Realty.
 *
 * WHAT CHANGED BESIDES THE LISTS: a deal's status is now needed to seed it. Both callers already
 * have it to hand - the create path computes it a line earlier, and the lazy path reads it from
 * `transaction_statuses` - so nothing had to be looked up that was not already there.
 */
@Injectable()
export class DocumentDefaultsService {
  defaultsFor(type: string, status: string): { title: string; mandatory: boolean }[] {
    return checklistFor(type, status).map((r) => ({ title: r.title, mandatory: r.mandatory }));
  }
}

/** Stateless - the class holds no state and takes no constructor arguments. */
const DEFAULTS = new DocumentDefaultsService();

/**
 * Which of a deal's statuses the checklist follows.
 *
 * A deal holds a SET of statuses - a listing can be Active and Sold Conditional at once, and Sold
 * sits beside Closed on the way through - but the brokerage's sheet gives one list per status, so
 * one of them has to govern. TWO RULES, BOTH TAKEN FROM WHAT ALREADY EXISTS RATHER THAN INVENTED:
 *
 *   1. AN ENDING WINS. `statusSetProblem` already refuses more than one terminal status on a deal,
 *      so there can only ever be one, and it is the truest account of where the deal stands.
 *   2. OTHERWISE, WHATEVER IS FURTHEST ALONG. The order is the order the brokerage wrote the
 *      statuses in their own sheet, which is the order a deal moves through them - so Active plus
 *      Sold Conditional follows Sold Conditional.
 *
 * ON LIVE DATA THIS NEVER FIRES: all 891 deals hold exactly one status (checked 2026-09-24). It is
 * here because the schema and the write path both allow more, and a rule that is written down
 * cannot quietly become somebody's guess later.
 */
export function governingStatus(type: string, statuses: readonly string[]): string {
  const held = statuses.map((s) => String(s ?? '').trim()).filter((s) => s !== '');
  if (held.length <= 1) return held[0] ?? '';

  const ended = held.find(isTerminalStatus);
  if (ended) return ended;

  const order = statusesDefinedFor(type);
  let best = held[held.length - 1];
  let bestAt = -1;
  for (const s of held) {
    const at = order.indexOf(s);
    if (at > bestAt) {
      bestAt = at;
      best = s;
    }
  }
  return best;
}

/**
 * TD-155 - the checklist is created WITH the deal, not when somebody first opens it.
 *
 * Both callers come through here: the create path in transactions-write.service.ts, inside the
 * same database transaction that writes the deal, and DocumentsService.index(), which still seeds
 * lazily for deals written before this existed. ONE RULE IN ONE PLACE - the answer to the shape
 * that produced TD-066, TD-145, TD-147 and TD-151, a rule written down twice and updated once.
 *
 * `db` is whichever client the caller is already inside: the interactive transaction on the create
 * path, the plain client on the read path. Taking it as an argument rather than injecting one
 * keeps this file dependency-free and keeps the transactions module out of the documents module,
 * so no import cycle can form.
 *
 * A TYPE OR STATUS WITH NO LIST IS LEFT ALONE, AND THAT IS DELIBERATE. `defaultsFor` returns [] for
 * a type the brokerage did not answer for - Business Sale today - and, since TD-159, for a deal
 * carrying NO STATUS AT ALL, which the create path permits: `defaultStatusFor` deliberately returns
 * a blank for Buying, Lease and Preconstruction so the person chooses. Writing even one row would
 * make documents.count() non-zero forever, so index()'s `count === 0` guard could never fire again
 * and CORRECTING THE TYPE OR SETTING THE STATUS LATER WOULD NO LONGER REPAIR THE CHECKLIST. Zero
 * rows keeps the deal repairable: it is seeded from its then-current type and status whenever it is
 * next opened. No deal in the live data is in that position - all 891 hold a status - but the code
 * path is real and this is the behaviour that fails safe.
 *
 * NO ROW IS ADDED THAT THE LIST DOES NOT NAME. The brokerage ruled 2026-09-09 that a Referral
 * carries no RECO Guide, and ensureRecoGuide() - which used to add one to every deal of every type
 * on every load - was deleted rather than mirrored here.
 */
export async function seedDocumentDefaults(
  db: Pick<Prisma.TransactionClient, 'documents'>,
  txnId: number,
  type: string,
  status: string,
): Promise<number> {
  const now = new Date();
  const rows: Prisma.documentsCreateManyInput[] = DEFAULTS.defaultsFor(type, status).map((r, i) => ({
    transaction_id: txnId, title: r.title, mandatory: r.mandatory, position: i,
    created_at: now, updated_at: now,
  }));
  if (rows.length === 0) return 0;
  await db.documents.createMany({ data: rows });
  return rows.length;
}

/**
 * §13 checklist row kind (port of Document::kind()).
 *
 * 'deposit cheque' IS THE SAME ROW AS 'deposit slip' UNDER THE NAME THE BROKERAGE CHOSE. Their
 * 2026-09-23 sheet renamed the pre-construction Deposit Slip to Deposit Cheque, and the rename went
 * out on 184 live rows before anyone noticed that this function decides how many files a row
 * accepts by reading its title. Without the new spelling those rows silently stopped being
 * expandable in DocsModal and would take a single file each. The old spelling stays alongside it:
 * nothing renames history, and a deal restored from a backup still reads correctly.
 */
export function documentKind(d: { is_condition: boolean; title: string }): string {
  if (d.is_condition) return 'condition';
  const t = (d.title ?? '').toLowerCase();
  if (t.includes('deposit receipt') || t.includes('deposit slip') || t.includes('deposit cheque')) return 'multi';
  if (t.includes('photo id') || t.includes('fintrac')) return 'per_client';
  return 'single';
}
