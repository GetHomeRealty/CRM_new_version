import { lawyerSideGiven, missingLawyerParties } from './lawyer-details';

/**
 * TD-159 - what counts as a lawyer side having been GIVEN.
 *
 * The brokerage's rule of 2026-09-24: name, email and phone. The address is wanted but must never
 * block anything. This is the rule the reminder and the Lawyer Details screen now share; before
 * today they disagreed, and that disagreement was the defect - the screen demanded four fields and
 * the reminder accepted one, so an agent who had three could save nothing and was chased weekly
 * for details he was not permitted to record.
 */
describe('what counts as a lawyer side being given', () => {
  const full = { buyer_lawyer_name: 'Ada', buyer_lawyer_email: 'ada@lawyers.test', buyer_lawyer_phone: '416-555-0100' };

  it('is satisfied by a name, an email and a phone', () => {
    expect(lawyerSideGiven(full, 'buyer')).toBe(true);
  });

  it('does NOT require an address', () => {
    expect(lawyerSideGiven({ ...full, buyer_lawyer_address: '' } as never, 'buyer')).toBe(true);
  });

  it('is NOT satisfied by a name alone, which was the old rule', () => {
    expect(lawyerSideGiven({ buyer_lawyer_name: 'Ada' }, 'buyer')).toBe(false);
  });

  it('refuses a missing phone, and a missing email', () => {
    expect(lawyerSideGiven({ ...full, buyer_lawyer_phone: '' }, 'buyer')).toBe(false);
    expect(lawyerSideGiven({ ...full, buyer_lawyer_email: '' }, 'buyer')).toBe(false);
  });

  it('does not accept whitespace as a value', () => {
    expect(lawyerSideGiven({ ...full, buyer_lawyer_phone: '   ' }, 'buyer')).toBe(false);
  });

  it('keeps the two sides independent', () => {
    expect(missingLawyerParties(full)).toEqual(['seller']);
    expect(missingLawyerParties({})).toEqual(['buyer', 'seller']);
  });
});
