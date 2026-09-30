import { toE164 } from './lead-activity.service';

/**
 * WHICH NUMBER A LEAD IS ACTUALLY DIALLED ON.
 *
 * WHAT WAS REPORTED. Indian numbers in the Lead list appeared as `+1`. Most of those were not the
 * application's doing — `mapMetaLead` stores the Meta answer verbatim, and the list does not
 * reformat it, so a number that shows `+1` arrived that way from the form. The display was right.
 *
 * WHERE THE SUSPICION WAS JUSTIFIED. `toE164` read:
 *
 *     if (s.length === 10) return `+1${s}`;   // NANP without country code
 *
 * AN INDIAN MOBILE IS EXACTLY TEN DIGITS. A lead who typed `9032763629` was therefore dialled as
 * `+19032763629` — a well-formed, reachable US number belonging to somebody else. It is reached by
 * `callLead`, the in-browser call and the outbound SMS, and it fails in the worst way available: the
 * call connects, to the wrong person, in the wrong country, and nothing on screen says so.
 *
 * WHAT THESE PIN. The ambiguous case — ten digits, no country code — is now answered by
 * `LEAD_DEFAULT_COUNTRY_CODE` rather than by a constant, and can be told to refuse instead of guess.
 * Everything that carried its own country code is untouched, which is most of the traffic and the
 * part that must not move.
 *
 * NOTHING IS DIALLED HERE. Only the conversion is exercised.
 */

const ORIGINAL = process.env.LEAD_DEFAULT_COUNTRY_CODE;
const withCode = (cc: string | undefined, fn: () => void) => {
  if (cc === undefined) delete process.env.LEAD_DEFAULT_COUNTRY_CODE;
  else process.env.LEAD_DEFAULT_COUNTRY_CODE = cc;
  try { fn(); } finally {
    if (ORIGINAL === undefined) delete process.env.LEAD_DEFAULT_COUNTRY_CODE;
    else process.env.LEAD_DEFAULT_COUNTRY_CODE = ORIGINAL;
  }
};

describe('a number that already carries its own country code', () => {
  /*
   * The majority case, and the one that must not move: Meta delivers most numbers in full
   * international form, and whatever it gave is the truth about which country to ring.
   */
  it('keeps an Indian number exactly as it arrived', () => {
    withCode('1', () => {
      expect(toE164('+919032763629')).toBe('+919032763629');
      expect(toE164('+91 90327 63629')).toBe('+919032763629');
    });
  });

  it('keeps a North American number exactly as it arrived', () => {
    withCode('91', () => {
      // Even with the default set to India: the number said +1, so it is +1.
      expect(toE164('+16163508368')).toBe('+16163508368');
      expect(toE164('+1 (416) 555-0100')).toBe('+14165550100');
    });
  });

  it('still reads eleven digits beginning 1 as North American', () => {
    // A bare leading `1` at that length has no other reading, so this needs no setting.
    withCode('91', () => { expect(toE164('16163508368')).toBe('+16163508368'); });
  });

  it('refuses a malformed international number rather than dialling it', () => {
    withCode('1', () => {
      expect(toE164('+0123')).toBe('');
      expect(toE164('+')).toBe('');
    });
  });
});

describe('ten digits and no country code — the ambiguous case', () => {
  it('THE DEFECT: an Indian mobile is no longer forced to +1', () => {
    /*
     * `9032763629` is a valid Indian mobile AND a valid NANP number (area code 903, Texas). Nothing
     * in the digits distinguishes them, which is exactly why guessing was wrong.
     */
    withCode('91', () => { expect(toE164('9032763629')).toBe('+919032763629'); });
  });

  it('defaults to +1 when nothing is configured, so nothing changes by upgrading', () => {
    // The safety property. A brokerage that sets no variable keeps the behaviour it has today.
    withCode(undefined, () => { expect(toE164('4165550100')).toBe('+14165550100'); });
  });

  it('refuses outright when the default is set to empty', () => {
    /*
     * For a brokerage that would rather a call fail loudly than connect to a stranger. Every caller
     * already handles '' — `callLead`, the in-browser call and the SMS path each raise a
     * BadRequestException naming the lead — so refusing here surfaces as a message, not a crash.
     */
    withCode('', () => { expect(toE164('9032763629')).toBe(''); });
  });

  it('ignores punctuation in the configured code', () => {
    withCode('+91', () => { expect(toE164('9032763629')).toBe('+919032763629'); });
  });
});

describe('what is not a dialable number at all', () => {
  it('refuses empty, missing and junk values', () => {
    withCode('1', () => {
      expect(toE164(null)).toBe('');
      expect(toE164(undefined)).toBe('');
      expect(toE164('')).toBe('');
      expect(toE164('   ')).toBe('');
      expect(toE164('not a phone')).toBe('');
    });
  });

  it('refuses a number too short to ring', () => {
    withCode('1', () => { expect(toE164('12345')).toBe(''); });
  });

  it('passes a long national number through with a plus, unchanged by the default', () => {
    // 12 digits is already country-code-bearing; the setting must not prepend a second one.
    withCode('91', () => { expect(toE164('919032763629')).toBe('+919032763629'); });
  });
});
