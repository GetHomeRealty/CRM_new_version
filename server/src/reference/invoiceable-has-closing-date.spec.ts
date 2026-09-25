import { INVOICEABLE_TYPES, LISTING_TYPES, isListingType } from './transaction.constants';
import { requiredColumnsFor } from '../reports/import-template';

/*
 * TD-034 - AN INVOICE WITH NO DUE DATE IS NEVER CHASED, AND NOTHING WOULD TELL YOU.
 *
 * The brokerage's default terms are 'Due on Closing'. TransactionInvoiceService.dueDate then
 * returns the deal's closing date, or NULL when it has none - and a null due date drops the
 * invoice out of the overdue view (`due_date: { lt: now }` cannot match NULL) and out of the
 * reminder sweep. It would sit unpaid and unchased for ever, showing as perfectly ordinary.
 *
 * MEASURED 2026-09-25: 0 of 279 invoices have no due date and 0 of 890 deals have no closing
 * date. It cannot happen today, and the reason is a COINCIDENCE BETWEEN TWO LISTS: no listing
 * type is invoiceable, and every non-listing type must carry a closing date - on the screen and
 * in the bulk import alike.
 *
 * That coincidence is what these pin. Add a listing type to INVOICEABLE_TYPES, or relax the
 * closing date for one of them, and TODAY NOTHING WOULD FAIL - invoices would simply begin
 * appearing that nobody ever chases. These fail instead.
 */

describe('an invoiceable deal always has a closing date to fall due on', () => {
  it('no invoiceable type is a listing type', () => {
    expect((INVOICEABLE_TYPES as readonly string[]).filter((t) => isListingType(t))).toEqual([]);
  });

  it('the bulk import demands a closing date for every invoiceable type', () => {
    for (const type of INVOICEABLE_TYPES) {
      expect(requiredColumnsFor(type)).toContain('Closing Date');
    }
  });

  it('and neither list is empty, so neither test above can pass vacuously', () => {
    expect(INVOICEABLE_TYPES.length).toBeGreaterThan(0);
    expect(LISTING_TYPES.length).toBeGreaterThan(0);
  });
});
