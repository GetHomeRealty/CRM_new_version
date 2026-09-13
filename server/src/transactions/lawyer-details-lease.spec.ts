import { tracksBothLawyers, isBuyingType } from './lawyer-details';

/**
 * WHO IS CHASED FOR LAWYER DETAILS.
 *
 * ================================================================================================
 * THE DEFECT THIS PINS DOWN. Leases were chased for buyer and seller lawyer details while the
 * Transaction Detail screen hid the Lawyer Details button on every lease. The agent received an
 * email asking for something the screen would not accept, and it repeated on the reminder schedule
 * until the closing date passed. Six live lease deals were being chased when it was found.
 * ================================================================================================
 *
 * The document send-gates are deliberately NOT covered by this rule - they use `isBuyingType` - so
 * this test also holds the two apart, because merging them is the obvious future mistake.
 */
describe('lawyer-detail reminders cover Buying deals only', () => {
  it.each(['Residential Buying', 'Commercial Property Buying', 'Business Buying'])(
    '%s is chased - the screen offers the fields',
    (type) => expect(tracksBothLawyers(type)).toBe(true),
  );

  it.each(['Residential Lease', 'Commercial Property Lease'])(
    '%s is NOT chased - the screen hides the Lawyer Details button',
    (type) => expect(tracksBothLawyers(type)).toBe(false),
  );

  it.each(['Residential Sale Listing', 'Residential Lease Listing', 'Preconstruction', 'Referral'])(
    '%s is NOT chased',
    (type) => expect(tracksBothLawyers(type)).toBe(false),
  );

  it('leaves the Notice of Sale gate alone - it asks isBuyingType, not this', () => {
    expect(isBuyingType('Residential Buying')).toBe(true);
    expect(isBuyingType('Residential Lease')).toBe(false);
  });

  it('handles a missing type without throwing', () => {
    expect(tracksBothLawyers(null)).toBe(false);
    expect(tracksBothLawyers(undefined)).toBe(false);
    expect(tracksBothLawyers('')).toBe(false);
  });
});
