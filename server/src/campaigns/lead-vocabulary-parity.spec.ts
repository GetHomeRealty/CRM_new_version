import * as campaigns from './campaign.constants';
import * as leads from '../leads/lead.constants';

/**
 * The Campaigns audience builder must offer exactly the lead vocabulary Leads uses.
 *
 * These were four separate literal arrays in `campaign.constants.ts`, and they had quietly drifted:
 * campaigns lacked `closed` on status, `realtor` on type, and — the expensive one — `website` on
 * source.
 *
 * WHAT THAT COST. `campaigns.controller.ts` serves these as the audience dropdowns, so a lead whose
 * source is `website` could not be targeted by any campaign. Not filtered out, not refused —
 * simply never offered as a choice, with nothing reporting it. Against the scale model `website`
 * was one of the two commonest intake channels, so this plausibly hid a large share of the book
 * from marketing.
 *
 * The backend was never the obstacle, which is what made it invisible: `buildAudienceWhere` matches
 * whatever string it is given, so the same leads were reachable through the API the whole time. Only
 * the dropdown withheld them.
 *
 * The fix was to re-export rather than re-synchronise — a second copy that happens to agree today is
 * the same bug waiting to recur. This file is what makes that permanent: if anybody reintroduces a
 * local list, these assertions fail rather than the option quietly disappearing from a screen.
 */

describe('Campaigns offers exactly the Leads vocabulary', () => {
  it.each([
    ['lead status', campaigns.LEAD_STATUS, leads.LEAD_STATUS],
    ['lead type', campaigns.LEAD_TYPE, leads.LEAD_TYPE],
    ['lead source', campaigns.LEAD_SOURCE, leads.LEAD_SOURCE],
    ['client type', campaigns.CLIENT_TYPE, leads.CLIENT_TYPE],
  ])('%s is identical on both sides', (_name, fromCampaigns, fromLeads) => {
    // Order too, not just membership: these render as dropdowns, and two screens listing the same
    // options in different orders is its own small confusion.
    expect([...fromCampaigns]).toEqual([...fromLeads]);
  });

  it('is the SAME array, not a copy that currently matches', () => {
    /*
     * The assertion above would pass against a duplicated literal that happened to be in sync — the
     * exact state this file exists to prevent, since that is how the vocabulary drifted the first
     * time. Identity proves the re-export.
     */
    expect(campaigns.LEAD_STATUS).toBe(leads.LEAD_STATUS);
    expect(campaigns.LEAD_TYPE).toBe(leads.LEAD_TYPE);
    expect(campaigns.LEAD_SOURCE).toBe(leads.LEAD_SOURCE);
    expect(campaigns.CLIENT_TYPE).toBe(leads.CLIENT_TYPE);
  });

  it('the values that had gone missing are offered again', () => {
    // Named individually, so a regression says WHICH option a user lost rather than only that a
    // list changed length.
    expect(campaigns.LEAD_STATUS).toContain('closed');
    expect(campaigns.LEAD_SOURCE).toContain('website');
    expect(campaigns.LEAD_TYPE).toContain('realtor');
  });
});
