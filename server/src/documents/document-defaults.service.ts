import { Injectable } from '@nestjs/common';

/** Type-specific default document checklists (port of DocumentService::defaultsFor).
 *  Documents are no longer flagged mandatory — every row is created with mandatory:false. */
@Injectable()
export class DocumentDefaultsService {
  defaultsFor(type: string): { title: string; mandatory: boolean }[] {
    const t = (type ?? '').toLowerCase();
    const rows = (pairs: string[]): { title: string; mandatory: boolean }[] => pairs.map((title) => ({ title, mandatory: false }));

    if (t === 'referral') return rows(['Referral doc', 'Notice of Sale', 'Trade Sheet']);
    if (t === 'preconstruction') return rows(['Agreement of Purchase and Sale (APS)', 'Broker Referral', 'Deposit Slip', 'Trade Sheet']);

    if (t.includes('listing')) {
      const isLeaseListing = t.includes('lease');
      return rows([
        'Listing agreement', 'MLS data sheet', 'Client Photo IDs', 'FINTRACK', 'Offer Summary Document',
        isLeaseListing ? 'Agreement to Lease' : 'Agreement of Purchase & Sale',
        'Confirmation of CO-OP', 'Schedule B', 'Deposit Receipt', 'MLS',
      ]);
    }
    if (t.includes('lease')) {
      return rows(['Offer Summary', 'Agreement to Lease', 'Schedule B', 'Confirmation of CO-OP', 'Tenant Representation', 'ORTA', 'Deposit Receipt', 'Client Photo IDs', 'FINTRACK']);
    }
    if (t.includes('buy')) {
      return rows(['Offer Summary', 'Agreement of Purchase and Sale', 'Schedule B', 'Confirmation of CO-OP', 'Buyer Representation', 'Deposit Receipt', 'MLS', 'Client Photo IDs', 'FINTRACK']);
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
