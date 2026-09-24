/**
 * Buyer/seller lawyer-detail helpers, shared by the reminder emails and the send-gates on the
 * Notice of Sale and Trade Record Sheet. A SIDE COUNTS AS GIVEN WHEN IT CARRIES A NAME, AN EMAIL AND A PHONE - the
 * brokerage's rule of 2026-09-24. The address is wanted but never blocks anything.
 */

export type LawyerParty = 'buyer' | 'seller';

interface LawyerFields {
  buyer_lawyer_name?: string | null;
  buyer_lawyer_email?: string | null;
  buyer_lawyer_phone?: string | null;
  seller_lawyer_name?: string | null;
  seller_lawyer_email?: string | null;
  seller_lawyer_phone?: string | null;
}

/**
 * Has this side been given? Name, email and phone - not the address.
 *
 * IT USED TO ASK FOR THE NAME ALONE, and the screen refused to save a side without all FOUR
 * fields including the address. So an agent who knew the name and phone could save nothing, and
 * was chased for details he was not allowed to record. Across the whole system these details had
 * been saved through that screen EXACTLY ONCE. The two now ask the same question.
 */
export function lawyerSideGiven(t: LawyerFields, side: LawyerParty): boolean {
  const v = (f: string): string => String((t as Record<string, unknown>)[side + '_lawyer_' + f] ?? '').trim();
  return v('name') !== '' && v('email') !== '' && v('phone') !== '';
}

/** Which of buyer/seller lawyer details are still missing, in a stable order. */
export function missingLawyerParties(t: LawyerFields): LawyerParty[] {
  const out: LawyerParty[] = [];
  if (!lawyerSideGiven(t, 'buyer')) out.push('buyer');
  if (!lawyerSideGiven(t, 'seller')) out.push('seller');
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
