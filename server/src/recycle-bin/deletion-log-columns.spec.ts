import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-018 — the Deletion Log's action and section are two facts, and must not arrive as one run of
 * text.
 *
 * `action` and `section` are separate columns on the audit row and are joined nowhere but in this
 * table, where they shared a single 'What' cell: the action in a pill, the section in a <div>
 * beneath it. On screen that reads as two lines, and the TEXT of the cell was
 * 'RemovedProperty Information' — no separator of any kind — which is what a copy-paste, a screen
 * reader, and the QA scrape that filed this all see. 'RemovedProperty' is not a phrase.
 *
 * WHY THIS SPEC IS SHAPED THE WAY IT IS. TD-018 was closed twice by checks that COUNTED COLUMNS:
 * first against the wrong table entirely (the Transactions tab's eight), then against the right one
 * (six, 'properly separated'). Both passed while the text inside the cell stayed broken, because
 * counting columns cannot see inside one. So the assertion that carries this spec is not the number
 * of columns — it is that the cell rendering the action does not also render the section. A seventh
 * column would satisfy a counting check while a regression that merged them back would not be
 * caught by it; this is the other way round.
 *
 * The client has no unit runner, so the table is read off disk, in the idiom
 * `inbox-setup-instructions.spec.ts` and `transaction-type-aliases.spec.ts` already use. Comments
 * are stripped first: the note left in place of the old markup quotes 'RemovedProperty Information'
 * verbatim to say what was wrong with it, and a check reading the raw file would find the very
 * string it forbids sitting inside the explanation of its removal.
 */

const SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'RecycleBinPage.tsx'),
  'utf8',
);

/** The file as it renders — JSX comments removed, so prose about the fault is not read as the fault. */
const code = SOURCE.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** The Deletion Log table alone. The page has five other tables, and none of them is under test. */
const table = ((): string => {
  const at = code.indexOf("{tab === 'log' && (");
  expect(at).toBeGreaterThan(-1);
  const end = code.indexOf('</table>', at);
  expect(end).toBeGreaterThan(at);
  return code.slice(at, end);
})();

/** Each <td> of the body row, split on the cell boundary rather than parsed. */
const cells = table.split(/<td\b/).slice(1);

describe('the Deletion Log keeps the action and the section apart (TD-018)', () => {
  it('does not render the section inside the cell that renders the action', () => {
    // THE DEFECT, STATED DIRECTLY. Was: one <td> holding <span class="pill bad">{e.action}</span>
    // followed by <div>{e.section}</div>, whose combined text is 'RemovedProperty Information'.
    const actionCell = cells.find((c) => c.includes('{e.action}'));
    expect(actionCell).toBeDefined();
    expect(actionCell).not.toContain('e.section');
  });

  it('gives the section a cell of its own', () => {
    const sectionCell = cells.find((c) => c.includes('{e.section'));
    expect(sectionCell).toBeDefined();
    expect(sectionCell).not.toContain('e.action');
  });

  it('names both in the header, so neither column is unlabelled', () => {
    expect(table).toContain('<th>Action</th>');
    expect(table).toContain('<th>Section</th>');
    // 'What' was the header over the merged cell; a column named for two fields is what let them merge.
    expect(table).not.toContain('<th>What</th>');
  });

  it('separates the Shared badge from the action it sits beside', () => {
    // The same fault one element along: an adjacent pill with only a CSS margin between them reads
    // back as 'RemovedShared'. A margin is not a separator to anything reading the text.
    const actionCell = cells.find((c) => c.includes('{e.action}'))!;
    expect(actionCell).toMatch(/\{' '\}\s*<span className="pill info"/);
  });

  it('spans the empty-state row across every column the header declares', () => {
    // Not the load-bearing assertion — a consistency check, so the count and the markup cannot drift.
    const headers = (table.match(/<th>/g) ?? []).length;
    expect(headers).toBeGreaterThan(0);
    expect(table).toContain(`colSpan={${headers}}`);
  });
});
