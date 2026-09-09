import { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';

/**
 * Type-specific default document checklists.
 *
 * TD-149 - THE BROKERAGE SUPPLIED THIS LIST ON 2026-09-08, WHICH IT NEVER HAD BEFORE.
 *
 * This file used to open by refusing to seed anything as mandatory, on the grounds that which
 * documents a brokerage is obliged to hold is a RECO question with a real answer that had never
 * been recorded anywhere in this codebase, and that inventing one would put a compliance assertion
 * into the product on no authority. That refusal was right. It was also, by then, out of date: the
 * code below had already been changed to mark every default mandatory bar a few exceptions, and the
 * comment saying otherwise stayed. Asking Get Home Realty settled it, and their answer corrected
 * three things the invented list had wrong.
 *
 * CONFIRMED BY THE BROKERAGE, 2026-09-08:
 *   Residential Buying   12 documents, all mandatory. Already correct.
 *   Referral              3 documents, all mandatory. Already correct.
 *   Residential Lease    14 documents; Offer Summary and Rental Application optional. MLS was
 *                        MISSING from this type entirely and is added.
 *   Preconstruction       6 documents; Deposit Slip and RECO Guide optional. Notice of Sale was
 *                        MISSING and is added, and the optional set was close to inverted - the
 *                        system required Deposit Slip and RECO Guide, which the brokerage does not,
 *                        and treated Trade Sheet as optional, which the brokerage requires.
 *
 *   Sale Listing        13 documents; MLS data sheet and RECO Guide optional, the rest mandatory.
 *   Lease Listing       16 documents; MLS data sheet, RECO Guide, Offer Summary Document and
 *                       Rental Application optional. Rental Application, Schedule A and ORTA were
 *                       missing and are added; one of them existed on no type at all.
 *
 * ALL SIX TYPES ARE NOW THE BROKERAGE'S OWN LIST. Nothing in this file is invented any more, which
 * is what its original author asked for and could not get.
 */
@Injectable()
export class DocumentDefaultsService {
  defaultsFor(type: string): { title: string; mandatory: boolean }[] {
    const t = (type ?? '').toLowerCase();
    const optional = new Set<string>(
      t === 'preconstruction' ? ['Deposit Slip', 'RECO Guide']
      : t.includes('listing') ? (t.includes('lease')
          ? ['MLS data sheet', 'RECO Guide', 'Offer Summary Document', 'Rental Application']
          : ['MLS data sheet', 'RECO Guide'])
      : t.includes('lease') ? ['Offer Summary', 'Rental Application']
      : []);
    const rows = (pairs: string[]): { title: string; mandatory: boolean }[] => pairs.map((title) => ({ title, mandatory: !optional.has(title) }));

    if (t === 'referral') return rows(['Referral doc', 'Notice of Sale', 'Trade Sheet']);
    if (t === 'preconstruction') return rows(['Agreement of Purchase and Sale (APS)', 'Broker Referral', 'Deposit Slip', 'RECO Guide', 'Trade Sheet', 'Notice of Sale']);

    if (t.includes('listing')) {
      /*
       * TD-149 - THE BROKERAGE'S RULING, 2026-09-08: 'Listing agreement' is the mandatory row and
       * covers the MLS Draft Preview, the Listing Agreement, the MLS Data Sheet form and the RECO
       * Guide. The separate 'MLS data sheet' and 'RECO Guide' rows are KEPT and marked optional
       * rather than folded in and deleted, so nothing disappears off the three live listing deals
       * and the checklist still shows them.
       *
       * That choice also settled a mechanical problem the alternative created:
     * ensureRecoGuide() used to recreate a RECO Guide row on every load of every deal.
     * IT WAS DELETED 2026-09-09: the brokerage ruled that a Referral carries three
     * documents and no RECO Guide, and Referral was the only type whose list omits it,
     * so the function only ever fired where it should not have.
       */
      if (t.includes('lease')) {
        return rows(['Listing agreement', 'MLS data sheet', 'Client Photo IDs', 'FINTRACK',
          'Offer Summary Document', 'Rental Application', 'Agreement to Lease', 'Schedule A',
          'Schedule B', 'Confirmation of CO-OP', 'ORTA', 'Deposit Receipt', 'MLS', 'RECO Guide',
          'Trade Sheet', 'Notice of Sale']);
      }
      return rows(['Listing agreement', 'MLS data sheet', 'Client Photo IDs', 'FINTRACK',
        'Offer Summary Document', 'Agreement of Purchase & Sale', 'Confirmation of CO-OP',
        'Schedule B', 'Deposit Receipt', 'MLS', 'RECO Guide', 'Trade Sheet', 'Notice of Sale']);
    }
    if (t.includes('lease')) {
      return rows(['Offer Summary', 'Agreement to Lease', 'Schedule B', 'Confirmation of CO-OP', 'Tenant Representation', 'ORTA', 'Deposit Receipt', 'MLS', 'Client Photo IDs', 'FINTRACK', 'Rental Application', 'RECO Guide', 'Trade Sheet', 'Notice of Sale']);
    }
    if (t.includes('buy')) {
      return rows(['Offer Summary', 'Agreement of Purchase and Sale', 'Schedule B', 'Confirmation of CO-OP', 'Buyer Representation', 'Deposit Receipt', 'MLS', 'Client Photo IDs', 'FINTRACK', 'RECO Guide', 'Trade Sheet', 'Notice of Sale']);
    }
    return [];
  }
}

/** Stateless - the class holds no state and takes no constructor arguments. */
const DEFAULTS = new DocumentDefaultsService();

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
 * A TYPE WITH NO LIST IS LEFT ALONE, AND THAT IS DELIBERATE. `defaultsFor` returns [] for anything
 * that is not referral, preconstruction, listing, lease or buy - Business Sale today, and any
 * blank or misspelled type. Writing even one row would make documents.count() non-zero forever,
 * so index()'s `count === 0` guard could never fire again and CORRECTING THE TYPE LATER WOULD NO
 * LONGER REPAIR THE CHECKLIST. On a migration of 1,200 deals nobody opens, that is precisely the
 * population where a type-mapping mistake is found after loading. Zero rows keeps today's
 * behaviour: the deal is seeded from its then-current type whenever it is first opened.
 * See TD-159 for the missing lists themselves.
 *
 * NO ROW IS ADDED THAT THE TYPE LIST DOES NOT NAME. The brokerage ruled 2026-09-09 that a
 * Referral carries three documents and no RECO Guide. Every other list names RECO Guide
 * itself, so ensureRecoGuide() - which used to add one to every deal of every type on every
 * load - was deleted rather than mirrored here.
 */
export async function seedDocumentDefaults(
  db: Pick<Prisma.TransactionClient, 'documents'>,
  txnId: number,
  type: string,
): Promise<number> {
  const now = new Date();
  const rows: Prisma.documentsCreateManyInput[] = DEFAULTS.defaultsFor(type).map((r, i) => ({
    transaction_id: txnId, title: r.title, mandatory: r.mandatory, position: i,
    created_at: now, updated_at: now,
  }));
  if (rows.length === 0) return 0;
  await db.documents.createMany({ data: rows });
  return rows.length;
}

/** §13 checklist row kind (port of Document::kind()). */
export function documentKind(d: { is_condition: boolean; title: string }): string {
  if (d.is_condition) return 'condition';
  const t = (d.title ?? '').toLowerCase();
  if (t.includes('deposit receipt') || t.includes('deposit slip')) return 'multi';
  if (t.includes('photo id') || t.includes('fintrac')) return 'per_client';
  return 'single';
}
