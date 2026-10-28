import { otherReviewerWhat } from './edit-requests.service';

/**
 * The message the other reviewer gets reads "approved X's request to edit ___ of <address>". It used to
 * read "request to change an edit" for a financial request (Sai, 28 Oct 2026).
 */
describe('what the other reviewer is told the request was about', () => {
  it('names each kind of request', () => {
    expect(otherReviewerWhat('financial')).toBe('the financial details');
    expect(otherReviewerWhat('commission')).toBe('the commission');
    expect(otherReviewerWhat('mandatory')).toBe('the required details');
  });

  it('never says "an edit"', () => {
    for (const s of ['financial', 'commission', 'mandatory', 'something-new', '', null, undefined]) {
      expect(otherReviewerWhat(s)).not.toContain('an edit');
    }
  });
});
