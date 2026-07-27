/**
 * Buyer/seller lawyer-detail helpers, shared by the reminder emails and the send-gates on the
 * Notice of Sale and Trade Record Sheet. The lawyer NAME is the presence signal — if it is blank,
 * the details have not been entered.
 */

export type LawyerParty = 'buyer' | 'seller';

interface LawyerFields {
  buyer_lawyer_name?: string | null;
  seller_lawyer_name?: string | null;
}

/** Which of buyer/seller lawyer details are still missing, in a stable order. */
export function missingLawyerParties(t: LawyerFields): LawyerParty[] {
  const out: LawyerParty[] = [];
  if (!String(t.buyer_lawyer_name ?? '').trim()) out.push('buyer');
  if (!String(t.seller_lawyer_name ?? '').trim()) out.push('seller');
  return out;
}

/** "buyer and seller" | "buyer" | "seller" — the wording that names the missing parties. */
export function lawyerPartyLabel(parties: LawyerParty[]): string {
  return parties.length >= 2 ? 'buyer and seller' : (parties[0] ?? '');
}

/** e.g. "Please update seller lawyer details for the transaction 212 Prosser Circle." */
export function lawyerReminderMessage(parties: LawyerParty[], txnName: string): string {
  return `Please update ${lawyerPartyLabel(parties)} lawyer details for the transaction ${txnName}.`;
}

/** Only Buying and Lease deals carry both sides' lawyer details (a bare listing has no deal yet). */
export function isBuyingType(type: string | null | undefined): boolean {
  return /buying/i.test(type ?? '');
}
export function tracksBothLawyers(type: string | null | undefined): boolean {
  const s = (type ?? '').toLowerCase();
  return /buying|lease/.test(s) && !/listing/.test(s);
}
