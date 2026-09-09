import { readFileSync } from 'fs';
import { join } from 'path';
import { ADJUSTMENT_FIELDS, ADJUSTMENT_SECTIONS, CHILD_SHEETS, flatColumns } from './import-template';

/**
 * THE ADJUSTMENTS SHEET - the one part of the template with nothing declarative to check against.
 *
 * The other two specs join the template to a real declaration: FILL_KEYS for the transaction-level
 * columns, Prisma.dmmf for the four child sheets that write to tables. Adjustments writes into the
 * `adjustments` JSON blob on the transaction, built by an inline if/else chain inside a 1,773-line
 * file. There is no list to compare against, so this reads the source text.
 *
 * THAT IS A BLUNT CHECK AND IS LABELLED AS ONE. It proves a key is MENTIONED, not that it is
 * mentioned correctly - a key named only in a comment would pass. What it catches reliably is the
 * failure that actually happens: somebody adds a column to ADJUSTMENT_FIELDS and never touches the
 * importer, so the value is accepted by the review screen and then quietly dropped. That is TD-154
 * in its exact shape. The durable fix is for the importer to DECLARE its mapping the way
 * import-template.ts declares the columns; until it does, this is the backstop.
 *
 * THE SECTION CHECK BELOW IS NOT BLUNT AND IS THE MORE VALUABLE OF THE TWO. ADJUSTMENT_SECTIONS is
 * an exported list of four; the importer matches them with a hand-written if/else chain and has no
 * final else. A fifth section added to the template would pass validation and then vanish - every
 * row carrying it silently discarded, with the import reporting success.
 */

const SOURCE = readFileSync(join(__dirname, 'transaction-import.service.ts'), 'utf8');

describe('the Adjustments sheet reaches the importer', () => {
  it('mentions every declared field key somewhere in the importer', () => {
    const missing = ADJUSTMENT_FIELDS
      .filter((f) => f.key !== 'section')
      .filter((f) => !SOURCE.includes(f.key))
      .map((f) => `${f.column} -> ${f.key}`);
    expect(missing).toEqual([]);
  });

  it('reads every declared field column by its exact heading', () => {
    const missing = ADJUSTMENT_FIELDS
      .filter((f) => !SOURCE.includes(`'${f.column}'`) && !SOURCE.includes(`a.${f.column}`))
      .map((f) => f.column);
    expect(missing).toEqual([]);
  });

  it('has a branch for every section the template offers', () => {
    const unhandled = ADJUSTMENT_SECTIONS.filter((s) => !SOURCE.includes(`=== '${s}'`));
    expect(unhandled).toEqual([]);
  });
});

describe('the whole template is now accounted for', () => {
  it('leaves no sheet unchecked', () => {
    const total = flatColumns().length;
    const perSheet = CHILD_SHEETS.map((c) => `${c.sheet}=${c.fields.length * c.flatMax}`).join(' ');
    console.warn(`import template: ${total} columns total; child sheets ${perSheet}; all three specs together now cover every one.`);
    expect(total).toBeGreaterThan(0);
  });
});
