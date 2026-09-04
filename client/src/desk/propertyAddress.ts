/**
 * TD-036 — one stored address, split into the boxes OREA Form 640 actually provides.
 *
 * A transaction holds `property` as a single free-text line. The form's Property row is not one
 * box: it is six, laid out left to right as
 *
 *     [streetnum] [street] [unit] [city] [prov] [postal]
 *
 * and each carries its own `maxLength` — street 50, city 40, prov 2, postal 10. Writing the whole
 * address into `txtp_street` alone put a 51-character address into a 50-character box, which
 * pdf-lib refuses; the refusal was swallowed and the Property line came out EMPTY on a compliance
 * document. Using the boxes as designed roughly triples the room and is what the form expects.
 *
 * THE PARSE IS DELIBERATELY CONSERVATIVE, and reads from the RIGHT, because that end of a Canadian
 * address is the part with recognisable shapes — a postal code and a province are identifiable on
 * sight, a street name is not. Anything not positively identified stays in `street`.
 *
 * ITS FAILURE MODE IS THE POINT. The six boxes sit on one line in this order, so even a wrong split
 * still prints the address in its original word order — "Toronto" landing in `street` rather than
 * `city` looks like a slightly odd line, not like missing data. That is why guessing is acceptable
 * here when it would not be somewhere the pieces are used separately.
 */

export interface PropertyAddressParts {
  streetnum: string;
  street: string;
  unit: string;
  city: string;
  state: string;
  zip: string;
}

const EMPTY: PropertyAddressParts = { streetnum: '', street: '', unit: '', city: '', state: '', zip: '' };

/** A Canadian postal code, with or without its separator. */
const POSTAL = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;

/** A leading civic number — "300", "12A", "1234-B" — which the form gives its own box. */
const CIVIC = /^(\d+[A-Za-z]?(?:-[A-Za-z0-9]+)?)\s+(.*)$/;

const PROVINCES: Record<string, string> = {
  ab: 'AB', alberta: 'AB',
  bc: 'BC', 'british columbia': 'BC',
  mb: 'MB', manitoba: 'MB',
  nb: 'NB', 'new brunswick': 'NB',
  nl: 'NL', newfoundland: 'NL', 'newfoundland and labrador': 'NL',
  ns: 'NS', 'nova scotia': 'NS',
  nt: 'NT', 'northwest territories': 'NT',
  nu: 'NU', nunavut: 'NU',
  on: 'ON', ontario: 'ON',
  pe: 'PE', pei: 'PE', 'prince edward island': 'PE',
  qc: 'QC', quebec: 'QC', québec: 'QC',
  sk: 'SK', saskatchewan: 'SK',
  yt: 'YT', yukon: 'YT',
};

/**
 * Split a stored property line into the Form 640 boxes.
 *
 * `Canada` is dropped: the form is Ontario-specific and the country box does not exist, so carrying
 * it would only eat into the city box. Everything else is preserved somewhere.
 */
export function splitPropertyAddress(raw: string | null | undefined): PropertyAddressParts {
  const text = String(raw ?? '').trim();
  if (!text) return { ...EMPTY };

  const parts = text.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return { ...EMPTY };

  const out: PropertyAddressParts = { ...EMPTY };

  // The country, when somebody typed it, belongs to no box on this form.
  if (parts.length > 1 && /^canada$/i.test(parts[parts.length - 1])) parts.pop();

  /*
   * The last segment often carries the province and the postal code together — "ON L1N 6B1" — so
   * it is peeled token by token from the right before whole segments are considered.
   *
   * THIS RUNS EVEN WHEN THERE IS ONLY ONE SEGMENT, because plenty of addresses are typed without
   * commas at all: "1234 Long Boulevard Name West Mississauga ON L5B 3C7" is 52 characters, and
   * leaving it whole would put it back over the street box's fifty and lose the end of it. `floor`
   * is what keeps that safe — on a lone segment at least one token stays behind as the street, so
   * a bare "L1N 6B1" is treated as the line it was given rather than eaten entirely.
   */
  {
    const tokens = parts[parts.length - 1].split(/\s+/);
    const floor = parts.length === 1 ? 1 : 0;
    if (tokens.length - 2 >= floor && POSTAL.test(tokens.slice(-2).join(' '))) {
      out.zip = tokens.splice(-2, 2).join(' ');
    } else if (tokens.length - 1 >= floor && POSTAL.test(tokens[tokens.length - 1])) {
      out.zip = tokens.pop() as string;
    }
    if (tokens.length - 1 >= floor && PROVINCES[tokens[tokens.length - 1].toLowerCase()]) {
      out.state = PROVINCES[(tokens.pop() as string).toLowerCase()];
    }
    if (tokens.length === 0) parts.pop();
    else parts[parts.length - 1] = tokens.join(' ');
  }

  // A whole segment that is only a postal code, or only a province.
  if (parts.length > 1 && !out.zip && POSTAL.test(parts[parts.length - 1])) out.zip = parts.pop() as string;
  if (parts.length > 1 && !out.state && PROVINCES[parts[parts.length - 1].toLowerCase()]) {
    out.state = PROVINCES[(parts.pop() as string).toLowerCase()];
  }

  /*
   * The city is whatever segment is left at the end — but only when something remains in front of
   * it. A single-segment address is a street, not a city: "300 QA Ave" must not become a city with
   * no street, which would leave the line looking empty where anyone would read it.
   */
  if (parts.length > 1) out.city = parts.pop() as string;

  let street = parts.join(', ');
  const civic = CIVIC.exec(street);
  if (civic) { out.streetnum = civic[1]; street = civic[2]; }
  out.street = street;

  return out;
}
