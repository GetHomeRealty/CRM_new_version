import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SECURED_DEAL_TYPES, TRANSACTION_TYPES, isListingStatusFamily, statusOptionsFor, statusSetProblem,
} from '../reference/transaction.constants';

/**
 * TD-015 — changing a deal's type carries its status across, and asks before dropping one.
 *
 * THE DEFECT. The type selector reset the status to the new family's default on every change, with
 * nothing said. A deal marked "Secured Firm" whose type was corrected came back "Open", and the
 * only way to notice was to remember what it had been. Status decides the edit-lock, the commission
 * layout and every status filter in the reports, so a silent reset is not cosmetic.
 *
 * THE EXPECTED RESULT NAMES BOTH ACCEPTABLE ANSWERS — "either preserve a still-valid status or warn
 * the user that status will reset" — and the fix does both: what can come across does, and what
 * cannot is named in a confirmation before it goes.
 *
 * WHY THIS SPEC LIVES ON THE SERVER. The change is in `TransactionDetailPage.tsx` and the client has
 * no unit runner, but the RULE being mirrored is the server's: `statusSetProblem` decides what a
 * type may hold, and since TD-071 it refuses a status the deal is merely still carrying. So the
 * property worth proving is that no carry-over the client can produce is a save the API would
 * reject — and that is provable here, against the real rule, rather than by trusting the client.
 */

const CLIENT = join(__dirname, '..', '..', '..', 'client', 'src', 'desk');
const page = readFileSync(join(CLIENT, 'TransactionDetailPage.tsx'), 'utf8');
const format = readFileSync(join(CLIENT, 'format.ts'), 'utf8');

/**
 * `normalizeStatus` from the client, mirrored.
 *
 * It is the client's because that is where a type change happens, and the test below has to apply
 * it to be about anything. The last case in this file asserts the original still says exactly this,
 * so the mirror cannot drift without something failing.
 */
const normalizeStatus = (type: string, s: string): string => {
  if ((SECURED_DEAL_TYPES as readonly string[]).includes(type) && (s === 'Open' || s === 'Hold')) return 'Secured Conditional';
  if (s === 'Hold') return 'Open';
  if (s === 'Mutual release') return 'Mutual Release';
  if (s === 'Sold conditional') return /lease/i.test(type) ? 'Lease Conditional' : 'Sold Conditional';
  if (isListingStatusFamily(type)) {
    if (s === 'Open') return 'Active';
    if (s === 'Sold' && /lease/i.test(type)) return 'Leased';
  }
  return s;
};

/** The carry-over, mirrored from `carryStatuses`: map into the new vocabulary, keep what it has. */
const carry = (was: string[], newType: string): { keep: string[]; lost: string[] } => {
  const options = statusOptionsFor(newType);
  const keep: string[] = [];
  const lost: string[] = [];
  for (const s of was.filter(Boolean)) {
    const mapped = normalizeStatus(newType, s);
    if (!options.includes(mapped)) lost.push(s);
    else if (!keep.includes(mapped)) keep.push(mapped);
  }
  return { keep, lost };
};

/** Every status set a type may legally hold, singles and pairs — the server's own rule decides. */
function legalSets(type: string): string[][] {
  const all = statusOptionsFor(type);
  const sets: string[][] = all.map((s) => [s]);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (statusSetProblem(type, [all[i], all[j]]) === null) sets.push([all[i], all[j]]);
    }
  }
  return sets;
}

describe('a type change never produces a status the new type cannot hold (TD-015)', () => {
  it('is accepted by the API for every type, from every legal starting set', () => {
    /*
     * The interlock with TD-071. That entry made the API refuse a type change whose deal still
     * holds a foreign status, which is only safe to carry statuses across if the carry-over can
     * never produce one. Every type, every legal set it can hold, every destination.
     */
    let checked = 0;
    for (const from of TRANSACTION_TYPES) {
      for (const set of legalSets(from)) {
        for (const to of TRANSACTION_TYPES) {
          const { keep } = carry(set, to);
          expect([to, keep, statusSetProblem(to, keep)]).toEqual([to, keep, null]);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000); // the sweep really ran
  });

  it('keeps a status the destination shares, rather than resetting it', () => {
    // The reported case: a secured deal whose type is corrected to another secured type.
    expect(carry(['Secured Firm'], 'Residential Lease')).toEqual({ keep: ['Secured Firm'], lost: [] });
  });

  it('carries a status across families under the name that family uses', () => {
    // Not a loss — the same position in the lifecycle, said the way the new type says it.
    expect(carry(['Open'], 'Residential Sale Listing').keep).toEqual(['Active']);
    expect(carry(['Sold'], 'Residential Lease Listing').keep).toEqual(['Leased']);
    expect(carry(['Open'], 'Residential Buying').keep).toEqual(['Secured Conditional']);
  });

  it('reports what genuinely cannot come across, rather than dropping it quietly', () => {
    const { keep, lost } = carry(['Secured Firm'], 'Residential Sale Listing');
    expect(keep).toEqual([]);
    expect(lost).toEqual(['Secured Firm']);
  });

  it('never turns one status into two, or loses one to a duplicate', () => {
    // 'Open' and 'Active' both map to 'Active' on a listing: one status, not a repeated one.
    expect(carry(['Open', 'Active'], 'Residential Sale Listing').keep).toEqual(['Active']);
  });
});

describe('the screen asks before it drops a status (TD-015)', () => {
  it('routes the type selector through the carry-over, not through a reset', () => {
    expect(page).toContain('const carryStatuses =');
    expect(page).toContain('onChange={(e) => onTypeChange(e.target.value)}');
    // The old line set `statuses` from the default alone, on every change, with no confirmation.
    expect(page).not.toContain('const onTypeChange = (newType: string) => setForm(');
  });

  it('names the status it is about to remove, and what the deal will be left as', () => {
    expect(page).toContain('Change the transaction type?');
    expect(page).toContain('will be removed');
    expect(page).toContain("confirmLabel: 'Change type'");
  });

  it('still falls back to the family default when nothing can come across', () => {
    expect(page).toContain('defaultStatusFor(newType) ? [defaultStatusFor(newType)] : []');
  });

  it('mirrors the client mapping this file assumes', () => {
    // If `normalizeStatus` grows a rule, the mirror above is stale and the sweep proves less than
    // it claims. These are its cases, as the client writes them.
    for (const rule of [
      "if (SECURED_DEAL_TYPES.includes(type) && (s === 'Open' || s === 'Hold')) return 'Secured Conditional';",
      "if (s === 'Hold') return 'Open';",
      "if (s === 'Mutual release') return 'Mutual Release';",
      "if (s === 'Sold conditional') return /lease/i.test(type) ? 'Lease Conditional' : 'Sold Conditional';",
      "if (s === 'Open') return 'Active';",
      "if (s === 'Sold' && /lease/i.test(type)) return 'Leased';",
    ]) expect(format).toContain(rule);
  });
});
