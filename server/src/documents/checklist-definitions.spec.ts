import { DOC, checklistFor, everyChecklist } from './checklist-definitions';
import type { ChecklistItem } from './checklist-definitions';
import { statusSetProblem } from '../reference/transaction.constants';

/**
 * TD-159 - the brokerage's document checklists.
 *
 * These tests guard a TRANSCRIBED TABLE, so they are shaped differently from most specs here: the
 * file they cover has almost no logic, and the way it goes wrong is an edit nobody notices. The
 * counts are therefore asserted exactly, on purpose - add or drop a row and a test fails, so the
 * change has to be made deliberately rather than discovered later on a live deal.
 *
 * The first version of that table applied three of the brokerage's sixty-seven removals and was
 * then checked against the working copy it had been generated from, so the check passed on a
 * faithful copy of the mistake. THAT IS WHY THE CORRECTIONS BELOW ARE SPELLED OUT ONE BY ONE rather
 * than asserted in bulk: when one fails, the failure names the decision it broke.
 */

const titles = (items: ChecklistItem[]): string[] => items.map((i) => i.title);
const mandatory = (items: ChecklistItem[], title: string): boolean | undefined =>
  items.find((i) => i.title === title)?.mandatory;
const has = (items: ChecklistItem[], title: string): boolean => titles(items).includes(title);

const BUYING_TYPES = ['Residential Buying', 'Business Buying', 'Commercial Property Buying'];
const SALE_LISTINGS = ['Residential Sale Listing', 'Commercial Property Sale Listing'];
const LEASE_LISTINGS = ['Residential Lease Listing', 'Commercial Property Lease Listing'];
const DEAL_STATUSES = ['Secured Firm', 'Secured Conditional', 'Closed', 'Mutual Release', 'DFT', 'Void'];

describe('document checklist definitions', () => {
  describe('the table as a whole', () => {
    it('covers the eleven deal types the brokerage answered for, and no others', () => {
      const types = [...new Set(everyChecklist().map((e) => e.type))].sort();
      expect(types).toEqual(
        [
          'Business Buying',
          'Commercial Property Buying',
          'Commercial Property Lease',
          'Commercial Property Lease Listing',
          'Commercial Property Sale Listing',
          'Preconstruction',
          'Referral',
          'Residential Buying',
          'Residential Lease',
          'Residential Lease Listing',
          'Residential Sale Listing',
        ].sort(),
      );
    });

    it('holds exactly the 78 type/status pairs and 814 rows that survive the brokerage remarks', () => {
      // 890 lines came back; 76 were marked for removal. 890 - 76 = 814.
      const all = everyChecklist();
      expect(all).toHaveLength(78);
      expect(all.reduce((n, e) => n + e.items.length, 0)).toBe(814);
    });

    // These three collect every offender before asserting, so a failure names the checklist that is
    // wrong instead of stopping at the first one.
    it('never answers a defined pair with an empty list', () => {
      const empty = everyChecklist()
        .filter((e) => e.items.length === 0)
        .map((e) => `${e.type} / ${e.status}`);
      expect(empty).toEqual([]);
    });

    it('lists no document twice in the same checklist', () => {
      const repeated: string[] = [];
      for (const { type, status, items } of everyChecklist()) {
        const seen = new Set<string>();
        for (const name of titles(items)) {
          if (seen.has(name)) repeated.push(`${type} / ${status} / ${name}`);
          seen.add(name);
        }
      }
      expect(repeated).toEqual([]);
    });

    it('uses only the brokerage-approved document names', () => {
      const approved = new Set<string>(Object.values(DOC));
      const strays: string[] = [];
      for (const { type, status, items } of everyChecklist()) {
        for (const item of items) {
          if (!approved.has(item.title)) strays.push(`${type} / ${status} / ${item.title}`);
        }
      }
      expect(strays).toEqual([]);
    });

    it('spells every document name only once across the whole vocabulary', () => {
      const names = Object.values(DOC);
      expect(names).toHaveLength(new Set(names).size);
    });

    it('defines no status the app itself would refuse for that type', () => {
      // THE DRIFT-CATCHER. This table and the app's status vocabulary are two statements of the
      // same fact, written in different files - the shape that produced TD-201, TD-202 and TD-203,
      // where a rule lived on the screen and again on the server and the two quietly disagreed.
      // statusSetProblem is what the server already uses to refuse a status that does not belong to
      // a type, so asking it about every pair here ties the two together permanently.
      const refused: string[] = [];
      for (const { type, status } of everyChecklist()) {
        const problem = statusSetProblem(type, [status]);
        if (problem) refused.push(`${type} / ${status}: ${problem}`);
      }
      expect(refused).toEqual([]);
    });

    it('leaves no document defined but unused', () => {
      const used = new Set<string>(everyChecklist().flatMap((e) => titles(e.items)));
      expect(Object.values(DOC).filter((n) => !used.has(n))).toEqual([]);
    });
  });

  describe('the families the brokerage declared identical', () => {
    // Not an optimisation. The brokerage said Business and Commercial Buying follow Residential
    // Buying exactly, and likewise for the two sale listings and the two lease listings. If these
    // ever stop matching, someone has edited one of a pair by hand.
    it('gives all three Buying types the same list at every status', () => {
      for (const status of DEAL_STATUSES) {
        const [first, ...rest] = BUYING_TYPES.map((t) => checklistFor(t, status));
        for (const other of rest) expect(other).toEqual(first);
      }
    });

    it('gives both sale listings, and both lease listings, the same list at every status', () => {
      for (const { types, statuses } of [
        {
          types: SALE_LISTINGS,
          statuses: ['Active', 'Sold Conditional', 'Sold', 'Closed', 'Mutual Release', 'DFT', 'Void',
            'Suspended', 'Terminated', 'Expired'],
        },
        {
          types: LEASE_LISTINGS,
          statuses: ['Active', 'Lease Conditional', 'Leased', 'Closed', 'Mutual Release', 'DFT', 'Void',
            'Suspended', 'Terminated', 'Expired'],
        },
      ]) {
        for (const status of statuses) {
          expect(checklistFor(types[1], status)).toEqual(checklistFor(types[0], status));
        }
      }
    });
  });

  describe('what it refuses to answer', () => {
    // An unknown pair returns nothing rather than a guess. Seeding even one row would make the
    // checklist non-empty for ever, and correcting the deal's type afterwards would no longer help.
    it('has no list for Business Sale, which the brokerage set aside', () => {
      expect(checklistFor('Business Sale', 'Secured Firm')).toEqual([]);
    });

    it('has no list for an unknown type, a blank one, or nothing at all', () => {
      expect(checklistFor('Timeshare', 'Closed')).toEqual([]);
      expect(checklistFor('', 'Closed')).toEqual([]);
      expect(checklistFor(null, 'Closed')).toEqual([]);
      expect(checklistFor(undefined, undefined)).toEqual([]);
    });

    it('has no list for a status that type never reaches', () => {
      // 'Active' belongs to listings; a Buying deal never has it.
      expect(checklistFor('Residential Buying', 'Active')).toEqual([]);
      expect(checklistFor('Referral', 'Secured Firm')).toEqual([]);
      expect(everyChecklist().filter((e) => e.type === 'Referral')).toHaveLength(2);
    });

    it('ignores surrounding spaces rather than failing to match', () => {
      expect(checklistFor('  Residential Buying  ', ' Closed ')).toEqual(checklistFor('Residential Buying', 'Closed'));
    });
  });

  it('hands out a fresh copy, so a caller cannot rewrite the brokerage table', () => {
    const first = checklistFor('Residential Buying', 'Closed');
    const length = first.length;
    first.pop();
    first[0].title = 'tampered';
    first[0].mandatory = false;

    const second = checklistFor('Residential Buying', 'Closed');
    expect(second).toHaveLength(length);
    expect(second[0].title).toBe(DOC.OFFER_SUMMARY);
    expect(second[0].mandatory).toBe(true);
  });

  describe('the commercial Agreement to Lease pair', () => {
    // The only place in the table where one requirement is met by either of two forms.
    it('marks the long and short forms as sitting under the commercial ATL, and nothing else does', () => {
      for (const { type, items } of everyChecklist()) {
        for (const item of items) {
          if (!item.parent) continue;
          expect([DOC.ATL_LONG, DOC.ATL_SHORT]).toContain(item.title);
          expect(item.parent).toBe(DOC.ATL_COMMERCIAL);
          expect(type).toBe('Commercial Property Lease');
        }
      }
    });

    it('always lists the parent alongside them', () => {
      for (const { items } of everyChecklist()) {
        for (const item of items) {
          if (item.parent) expect(titles(items)).toContain(item.parent);
        }
      }
    });

    it("carries the pair at all six of that type's statuses", () => {
      for (const status of DEAL_STATUSES) {
        const items = checklistFor('Commercial Property Lease', status);
        expect(has(items, DOC.ATL_LONG)).toBe(true);
        expect(has(items, DOC.ATL_SHORT)).toBe(true);
        expect(has(items, DOC.ATL_COMMERCIAL)).toBe(true);
      }
    });
  });

  describe('the corrections the brokerage wrote on the sheet', () => {
    it('drops Schedule A once a deal ends without completing, on all three Buying types', () => {
      for (const type of BUYING_TYPES) {
        for (const status of ['Mutual Release', 'DFT', 'Void']) {
          expect(has(checklistFor(type, status), DOC.SCHEDULE_A)).toBe(false);
        }
        // but it stays, optional, while the deal is alive
        expect(mandatory(checklistFor(type, 'Secured Firm'), DOC.SCHEDULE_A)).toBe(false);
      }
    });

    it('does not ask for the final MLS sheet while a listing is Active or still conditional', () => {
      // JUDGEMENT CALL, recorded in the definitions file: the remark naming where this document
      // belongs was written on the conditional row, and in that sheet a remark always means the row
      // changes. The conditional stages already carry the draft sheet and the data information form.
      for (const type of SALE_LISTINGS) {
        expect(has(checklistFor(type, 'Active'), DOC.MLS_FINAL)).toBe(false);
        expect(has(checklistFor(type, 'Sold Conditional'), DOC.MLS_FINAL)).toBe(false);
        expect(mandatory(checklistFor(type, 'Sold Conditional'), DOC.MLS_DRAFT)).toBe(true);
      }
      for (const type of LEASE_LISTINGS) {
        expect(has(checklistFor(type, 'Active'), DOC.MLS_FINAL)).toBe(false);
        expect(has(checklistFor(type, 'Lease Conditional'), DOC.MLS_FINAL)).toBe(false);
        expect(mandatory(checklistFor(type, 'Lease Conditional'), DOC.MLS_DRAFT)).toBe(true);
      }
    });

    it('requires the final MLS sheet once a listing is sold, leased or closed', () => {
      for (const type of SALE_LISTINGS) {
        expect(mandatory(checklistFor(type, 'Sold'), DOC.MLS_FINAL)).toBe(true);
        expect(mandatory(checklistFor(type, 'Closed'), DOC.MLS_FINAL)).toBe(true);
      }
      for (const type of LEASE_LISTINGS) {
        expect(mandatory(checklistFor(type, 'Leased'), DOC.MLS_FINAL)).toBe(true);
        expect(mandatory(checklistFor(type, 'Closed'), DOC.MLS_FINAL)).toBe(true);
      }
    });

    it('drops the final MLS sheet where the listing was released, voided or suspended', () => {
      for (const type of [...SALE_LISTINGS, ...LEASE_LISTINGS]) {
        for (const status of ['Mutual Release', 'Void', 'Suspended']) {
          expect(has(checklistFor(type, status), DOC.MLS_FINAL)).toBe(false);
        }
      }
    });

    it('requires Schedule B from the conditional stage onwards on every listing', () => {
      for (const type of SALE_LISTINGS) {
        for (const status of ['Sold Conditional', 'Sold', 'Closed']) {
          expect(mandatory(checklistFor(type, status), DOC.SCHEDULE_B)).toBe(true);
        }
      }
      for (const type of LEASE_LISTINGS) {
        for (const status of ['Lease Conditional', 'Leased', 'Closed', 'Mutual Release', 'DFT', 'Void']) {
          expect(mandatory(checklistFor(type, status), DOC.SCHEDULE_B)).toBe(true);
        }
      }
    });

    it('treats Schedule A as mandatory on a lease listing but optional on a sale listing', () => {
      // JUDGEMENT CALL, recorded in the definitions file. The brokerage wrote "Change this to
      // Mandatory" against Schedule A twelve times on the lease listing side while REMOVING it
      // outright on the sale listing side, so the two families genuinely differ here.
      for (const type of LEASE_LISTINGS) {
        for (const status of ['Lease Conditional', 'Leased', 'Closed', 'Mutual Release', 'DFT', 'Void']) {
          expect(mandatory(checklistFor(type, status), DOC.SCHEDULE_A)).toBe(true);
        }
      }
      for (const type of SALE_LISTINGS) {
        expect(mandatory(checklistFor(type, 'Sold'), DOC.SCHEDULE_A)).toBe(false);
        expect(has(checklistFor(type, 'Mutual Release'), DOC.SCHEDULE_A)).toBe(false);
      }
    });

    it('stops insisting on Fintrac once a listing is released or fell through', () => {
      for (const type of [...SALE_LISTINGS, ...LEASE_LISTINGS]) {
        expect(mandatory(checklistFor(type, 'Mutual Release'), DOC.FINTRAC)).toBe(false);
        expect(mandatory(checklistFor(type, 'DFT'), DOC.FINTRAC)).toBe(false);
      }
    });

    it('asks a listing for no buyer-side or tenant-side representation agreement at all', () => {
      // A listing is the other side of the trade; the brokerage removed these outright.
      for (const { type, items } of everyChecklist()) {
        if (SALE_LISTINGS.includes(type)) expect(has(items, DOC.BUYER_REP)).toBe(false);
        if (LEASE_LISTINGS.includes(type)) expect(has(items, DOC.TENANT_REP)).toBe(false);
      }
    });

    it('treats the RECO guide as optional on a pre-construction deal, and drops Schedule A there', () => {
      for (const status of ['Secured Firm', 'Secured Conditional', 'Closed']) {
        expect(mandatory(checklistFor('Preconstruction', status), DOC.RECO)).toBe(false);
      }
      // Schedule A was struck off every pre-construction status EXCEPT Secured Conditional, where
      // it was added as part of a brand-new list. Written as the brokerage wrote it, and raised
      // with them as a possible oversight rather than smoothed over here.
      for (const status of ['Secured Firm', 'Closed', 'Mutual Release', 'DFT', 'Void']) {
        expect(has(checklistFor('Preconstruction', status), DOC.SCHEDULE_A)).toBe(false);
      }
      expect(mandatory(checklistFor('Preconstruction', 'Secured Conditional'), DOC.SCHEDULE_A)).toBe(false);
    });

    it('drops Schedule A from a referral entirely', () => {
      expect(has(checklistFor('Referral', 'Open'), DOC.SCHEDULE_A)).toBe(false);
      expect(has(checklistFor('Referral', 'Closed'), DOC.SCHEDULE_A)).toBe(false);
    });

    it('adds the rental application to a residential lease', () => {
      for (const status of ['Secured Conditional', 'Closed']) {
        expect(has(checklistFor('Residential Lease', status), DOC.RENTAL_APPLICATION)).toBe(true);
      }
    });
  });

  describe('pre-construction follows the secured statuses, not Open', () => {
    // The brokerage replaced this type's 'Open' with Secured Firm / Secured Conditional and the 49
    // live deals were migrated to match. A list keyed on 'Open' here would seed nothing at all.
    it('answers for Secured Firm and Secured Conditional', () => {
      expect(checklistFor('Preconstruction', 'Secured Firm').length).toBeGreaterThan(0);
      expect(checklistFor('Preconstruction', 'Secured Conditional').length).toBeGreaterThan(0);
    });

    it('does not answer for Open', () => {
      expect(checklistFor('Preconstruction', 'Open')).toEqual([]);
    });

    it('still answers for Open on a Referral, which is the one type that keeps it', () => {
      expect(checklistFor('Referral', 'Open').length).toBeGreaterThan(0);
    });
  });
});
