import { interlinkChanges, hasSubmittedFile } from './document-interlinks';
import type { InterlinkRow } from './document-interlinks';
import { DOC } from './checklist-definitions';

/**
 * TD-159 slice 3 - documents that satisfy each other.
 *
 * The rule only ever moves the Mandatory flag. Nothing here should ever remove, hide or reorder a
 * row, and the brokerage was explicit that the relaxed documents STAY ON SCREEN - so these tests
 * check the changes list names only what changed, and never more.
 */

let nextId = 1;
const row = (title: string, mandatory: boolean, extra: Partial<InterlinkRow> = {}): InterlinkRow => ({
  id: nextId++, title, mandatory, mandatory_override: null, file_path: null, files: null, ...extra,
});

/** A Residential Buying deal at Secured Conditional, as the brokerage's sheet seeds it. */
const conditionalDeal = (over: Partial<Record<string, Partial<InterlinkRow>>> = {}): InterlinkRow[] => [
  row(DOC.APS, true),
  row(DOC.AMENDMENT, false, over[DOC.AMENDMENT]),
  row(DOC.NOF, true, over[DOC.NOF]),
  row(DOC.WAIVER, true, over[DOC.WAIVER]),
  row(DOC.DEPOSIT_RECEIPT, true),
];

const TYPE = 'Residential Buying';
const AT = 'Secured Conditional';

describe('which rows count as having a file', () => {
  it('counts the single file path the older upload route writes', () => {
    expect(hasSubmittedFile({ file_path: 'deals/1/a.pdf', files: null })).toBe(true);
  });

  it('counts a non-empty files array, which the newer route appends to', () => {
    expect(hasSubmittedFile({ file_path: null, files: '[{"file_path":"deals/1/b.pdf"}]' })).toBe(true);
  });

  it('does not count an empty array or a missing value', () => {
    expect(hasSubmittedFile({ file_path: null, files: '[]' })).toBe(false);
    expect(hasSubmittedFile({ file_path: null, files: null })).toBe(false);
    expect(hasSubmittedFile({ file_path: '', files: '' })).toBe(false);
  });

  it('does not count a files column that will not parse', () => {
    // A corrupt value is not evidence of anything, and must never be able to relax a mandatory
    // document. Treated as empty rather than as present.
    expect(hasSubmittedFile({ file_path: null, files: 'not json at all' })).toBe(false);
  });
});

describe('the Amendment / Notice of Fulfilment / Waiver trio', () => {
  it('changes nothing while none of them has a file', () => {
    expect(interlinkChanges(TYPE, AT, conditionalDeal())).toEqual([]);
  });

  it('relaxes the other two once one of them is uploaded', () => {
    const rows = conditionalDeal({ [DOC.NOF]: { file_path: 'deals/1/nof.pdf' } });
    const changes = interlinkChanges(TYPE, AT, rows);

    // Amendment is already Non-Mandatory on this list, so only the Waiver moves.
    expect(changes.map((c) => c.title)).toEqual([DOC.WAIVER]);
    expect(changes[0].mandatory).toBe(false);
  });

  it('leaves the uploaded document itself alone', () => {
    // Marking the one they have just been given as Non-Mandatory would say the brokerage does not
    // want it. Only "the rest" relax - their words.
    const rows = conditionalDeal({ [DOC.NOF]: { file_path: 'deals/1/nof.pdf' } });
    expect(interlinkChanges(TYPE, AT, rows).map((c) => c.title)).not.toContain(DOC.NOF);
  });

  it('puts them back once the last file is removed', () => {
    // The target is recomputed from the brokerage's list every time, never from what the row
    // currently says - so this is not a one-way door.
    const relaxed = conditionalDeal({ [DOC.WAIVER]: { mandatory: false } });
    const changes = interlinkChanges(TYPE, AT, relaxed);
    expect(changes.map((c) => c.title)).toEqual([DOC.WAIVER]);
    expect(changes[0].mandatory).toBe(true);
  });

  it('settles: applying it twice changes nothing the second time', () => {
    const rows = conditionalDeal({ [DOC.NOF]: { file_path: 'deals/1/nof.pdf' } });
    const first = interlinkChanges(TYPE, AT, rows);
    for (const c of first) rows.find((r) => r.id === c.id)!.mandatory = c.mandatory;
    expect(interlinkChanges(TYPE, AT, rows)).toEqual([]);
  });

  it('touches nothing outside its own group', () => {
    const rows = conditionalDeal({ [DOC.NOF]: { file_path: 'deals/1/nof.pdf' } });
    const moved = interlinkChanges(TYPE, AT, rows).map((c) => c.title);
    expect(moved).not.toContain(DOC.APS);
    expect(moved).not.toContain(DOC.DEPOSIT_RECEIPT);
  });
});

describe("a person's tick outranks the rule", () => {
  // The brokerage ruled 2026-09-24: "their tick stands - like the waiver & Notice of Fulfilment,
  // both docs will be mandatory", and it applies to that one deal only.
  it('never moves a row somebody set by hand, even when the group is satisfied', () => {
    const rows = conditionalDeal({
      [DOC.NOF]: { file_path: 'deals/1/nof.pdf' },
      [DOC.WAIVER]: { mandatory_override: true },
    });
    expect(interlinkChanges(TYPE, AT, rows)).toEqual([]);
  });

  it('never restores a row somebody set by hand either', () => {
    const rows = conditionalDeal({ [DOC.WAIVER]: { mandatory: false, mandatory_override: false } });
    expect(interlinkChanges(TYPE, AT, rows)).toEqual([]);
  });

  it('still relaxes the rows nobody has touched', () => {
    const rows = [
      row(DOC.AMENDMENT, true, { mandatory_override: true }),
      row(DOC.NOF, true, { file_path: 'deals/1/nof.pdf' }),
      row(DOC.WAIVER, true),
    ];
    const changes = interlinkChanges(TYPE, AT, rows);
    expect(changes.map((c) => c.title)).toEqual([DOC.WAIVER]);
  });
});

describe('the two commercial Agreement to Lease forms', () => {
  const COMMERCIAL = 'Commercial Property Lease';
  const pair = (over: Partial<Record<string, Partial<InterlinkRow>>> = {}): InterlinkRow[] => [
    row(DOC.ATL_COMMERCIAL, true),
    row(DOC.ATL_LONG, true, over[DOC.ATL_LONG]),
    row(DOC.ATL_SHORT, true, over[DOC.ATL_SHORT]),
    row(DOC.COOP, true),
  ];

  it('needs both until one arrives', () => {
    expect(interlinkChanges(COMMERCIAL, 'Secured Firm', pair())).toEqual([]);
  });

  it('relaxes the other form once one is uploaded', () => {
    const changes = interlinkChanges(COMMERCIAL, 'Secured Firm', pair({ [DOC.ATL_LONG]: { file_path: 'x.pdf' } }));
    expect(changes.map((c) => c.title)).toEqual([DOC.ATL_SHORT]);
    expect(changes[0].mandatory).toBe(false);
  });

  it('leaves the parent requirement alone, which is not part of the pair', () => {
    const changes = interlinkChanges(COMMERCIAL, 'Secured Firm', pair({ [DOC.ATL_SHORT]: { file_path: 'x.pdf' } }));
    expect(changes.map((c) => c.title)).not.toContain(DOC.ATL_COMMERCIAL);
  });
});

describe('where the rule does not apply at all', () => {
  it('does nothing on a status the brokerage gave no interlink for', () => {
    // Secured Firm has no conditions to prove, so the trio is not grouped there.
    const rows = conditionalDeal({ [DOC.NOF]: { file_path: 'deals/1/nof.pdf' } });
    expect(interlinkChanges(TYPE, 'Secured Firm', rows)).toEqual([]);
  });

  it('does nothing on a type or status it has no list for', () => {
    expect(interlinkChanges('Business Sale', 'Sold', conditionalDeal())).toEqual([]);
    expect(interlinkChanges(TYPE, '', conditionalDeal())).toEqual([]);
    expect(interlinkChanges(null, null, conditionalDeal())).toEqual([]);
  });

  it('does nothing when the deal is missing the grouped rows entirely', () => {
    expect(interlinkChanges(TYPE, AT, [row(DOC.APS, true)])).toEqual([]);
  });

  it('does not relax a lone member that has no partner on the deal', () => {
    // One document cannot satisfy itself. A Waiver alone stays exactly as the sheet left it.
    const changes = interlinkChanges(TYPE, AT, [row(DOC.WAIVER, true, { file_path: 'w.pdf' })]);
    expect(changes).toEqual([]);
  });
});
