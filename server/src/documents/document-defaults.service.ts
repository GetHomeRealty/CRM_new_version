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
 * NOT YET CONFIRMED, AND STILL CARRYING THE EARLIER UNVERIFIED LIST: the two LISTING types. The
 * brokerage describes "Listing agreement" as covering the MLS Draft Preview, the Listing Agreement,
 * the MLS Data Sheet form and the RECO Guide, and has not yet said whether that is one checklist row
 * or four. Until it does, both listing types are left exactly as they were. Lease Listing is also
 * short of Rental Application, Schedule A and ORTA on the brokerage's list; Schedule A exists on no
 * type today. Do not "tidy" either list without that answer.
 *
 * ONE MECHANICAL CONSTRAINT for whoever takes that on: DocumentsService.ensureRecoGuide() recreates
 * a RECO Guide row on every load of every deal, so RECO Guide cannot be removed from a type here
 * alone - it would come straight back.
 */
@Injectable()
export class DocumentDefaultsService {
  defaultsFor(type: string): { title: string; mandatory: boolean }[] {
    const t = (type ?? '').toLowerCase();
    const optional = new Set<string>(t === 'preconstruction' ? ['Deposit Slip', 'RECO Guide'] : t.includes('listing') ? (t.includes('lease') ? ['Offer Summary Document'] : []) : t.includes('lease') ? ['Offer Summary', 'Rental Application'] : []);
    const rows = (pairs: string[]): { title: string; mandatory: boolean }[] => pairs.map((title) => ({ title, mandatory: !optional.has(title) }));

    if (t === 'referral') return rows(['Referral doc', 'Notice of Sale', 'Trade Sheet']);
    if (t === 'preconstruction') return rows(['Agreement of Purchase and Sale (APS)', 'Broker Referral', 'Deposit Slip', 'RECO Guide', 'Trade Sheet', 'Notice of Sale']);

    if (t.includes('listing')) {
      const isLeaseListing = t.includes('lease');
      return rows([
        'Listing agreement', 'MLS data sheet', 'Client Photo IDs', 'FINTRACK', 'Offer Summary Document',
        isLeaseListing ? 'Agreement to Lease' : 'Agreement of Purchase & Sale',
        'Confirmation of CO-OP', 'Schedule B', 'Deposit Receipt', 'MLS', 'RECO Guide', 'Trade Sheet', 'Notice of Sale',
      ]);
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

/** §13 checklist row kind (port of Document::kind()). */
export function documentKind(d: { is_condition: boolean; title: string }): string {
  if (d.is_condition) return 'condition';
  const t = (d.title ?? '').toLowerCase();
  if (t.includes('deposit receipt') || t.includes('deposit slip')) return 'multi';
  if (t.includes('photo id') || t.includes('fintrac')) return 'per_client';
  return 'single';
}
