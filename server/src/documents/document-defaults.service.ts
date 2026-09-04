import { Injectable } from '@nestjs/common';

/**
 * Type-specific default document checklists (port of DocumentService::defaultsFor).
 *
 * NOTHING IS SEEDED AS MANDATORY, and that is a policy gap rather than a decision this file makes.
 * Which documents a brokerage is obliged to hold for each transaction type is a RECO/compliance
 * question with a real answer, and it has never been recorded anywhere in this codebase — the file
 * was born with `mandatory: false` on every row. Inventing a list here would put a compliance
 * assertion into the product on no authority.
 *
 * Until the brokerage supplies that list, `mandatory` is an ADMINISTRATOR'S FLAG: the Mandatory
 * checkbox in Legal & Documentation sets it per document per deal, `bulkUpdate` saves it, and it now
 * survives (a reset on every load used to wipe it — see `DocumentsService.index`). The Dashboard
 * tile and the reports therefore count exactly what somebody has actually marked.
 *
 * TO TURN ON DEFAULTS: replace the `false` in `rows()` with a per-title decision — the checklist
 * titles below are already the per-type vocabulary, so it is one map from title to boolean. Every
 * downstream consumer already reads the column and needs no change.
 */
@Injectable()
export class DocumentDefaultsService {
  defaultsFor(type: string): { title: string; mandatory: boolean }[] {
    const t = (type ?? '').toLowerCase();
    const optional = new Set<string>(t === 'preconstruction' ? ['Trade Sheet'] : t.includes('listing') ? (t.includes('lease') ? ['Offer Summary Document'] : []) : t.includes('lease') ? ['Offer Summary', 'Rental Application'] : []);
    const rows = (pairs: string[]): { title: string; mandatory: boolean }[] => pairs.map((title) => ({ title, mandatory: !optional.has(title) }));

    if (t === 'referral') return rows(['Referral doc', 'Notice of Sale', 'Trade Sheet']);
    if (t === 'preconstruction') return rows(['Agreement of Purchase and Sale (APS)', 'Broker Referral', 'Deposit Slip', 'RECO Guide', 'Trade Sheet']);

    if (t.includes('listing')) {
      const isLeaseListing = t.includes('lease');
      return rows([
        'Listing agreement', 'MLS data sheet', 'Client Photo IDs', 'FINTRACK', 'Offer Summary Document',
        isLeaseListing ? 'Agreement to Lease' : 'Agreement of Purchase & Sale',
        'Confirmation of CO-OP', 'Schedule B', 'Deposit Receipt', 'MLS', 'RECO Guide', 'Trade Sheet', 'Notice of Sale',
      ]);
    }
    if (t.includes('lease')) {
      return rows(['Offer Summary', 'Agreement to Lease', 'Schedule B', 'Confirmation of CO-OP', 'Tenant Representation', 'ORTA', 'Deposit Receipt', 'Client Photo IDs', 'FINTRACK', 'Rental Application', 'RECO Guide', 'Trade Sheet', 'Notice of Sale']);
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
