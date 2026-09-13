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

/** Only Buying deals carry both sides' lawyer details (a bare listing has no deal yet). */
export function isBuyingType(type: string | null | undefined): boolean {
  return /buying/i.test(type ?? '');
}
/**
 * LEASES ARE DELIBERATELY EXCLUDED, 2026-09-13.
 *
 * This decides who gets chased for missing lawyer details, and it used to include leases. But the
 * Transaction Detail screen HIDES the Lawyer Details button on every lease - `lawyerHidden =
 * precon || /lease/i.test(form.type) || referral` - and Admin Activities hides its lawyer
 * sub-sections on a lease as well. So the reminder asked an agent for something the screen gave
 * them no way to enter, and repeated until the closing date passed. A reminder nobody can act on
 * is not a reminder.
 *
 * The brokerage found this on 2026-09-13, on six live lease deals, after 154 leases arrived in the
 * migration and made it visible. If lease lawyer details are ever wanted, the screen has to offer
 * them FIRST and this comes back with it.
 *
 * Used only by the three reminder services. The Notice of Sale and Quick Send gates use
 * `isBuyingType`, which is unchanged.
 */
export function tracksBothLawyers(type: string | null | undefined): boolean {
  const s = (type ?? '').toLowerCase();
  return /buying/.test(s) && !/listing/.test(s);
}
