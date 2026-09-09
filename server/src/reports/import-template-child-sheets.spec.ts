import { Prisma } from '@prisma/client';
import { CHILD_SHEETS, flatColumns, type ChildSheet } from './import-template';

/**
 * THE CHILD SHEETS, CHECKED AGAINST THE DATABASE ITSELF.
 *
 * The companion file checks the transaction-level columns against FILL_KEYS. These five sheets do
 * not go through FILL_KEYS at all - four of them write to their own tables, and Adjustments writes
 * into the `adjustments` JSON blob on the transaction.
 *
 * Both sides here are READ AT RUNTIME: the template from its own declarations, the tables from
 * Prisma.dmmf. Nothing is transcribed, so neither a new template column nor a new database column
 * can drift past this file unnoticed.
 *
 * THE REVERSE CHECK IS THE POINT. Asserting the template's keys exist is the easy half. The half
 * that finds defects is asking which COLUMNS THE TEMPLATE CANNOT FILL - because a column nothing
 * can write, that reports nonetheless read, is TD-154 and TD-160 exactly.
 */

const scalars = (model: string): string[] => {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
  if (!m) throw new Error(`no such Prisma model: ${model}`);
  return m.fields.filter((f) => f.kind === 'scalar').map((f) => f.name);
};

/** Which table each child sheet writes to. null = not a table. */
const TABLE: Record<ChildSheet['key'], string | null> = {
  team: 'team_members',
  clients: 'clients',
  conditions: 'conditions',
  preconTerms: 'precon_terms',
  adjustments: null,
};

/**
 * Columns the template deliberately does not offer, each with the reason. Anything not listed here
 * and not offered by the template fails the suite - which is the intended pressure.
 */
const HOUSEKEEPING = ['id', 'transaction_id', 'created_at', 'updated_at', 'position'];

const NOT_OFFERED: Record<string, Record<string, string>> = {
  team_members: {
    user_id: 'resolved from the agent name by PersonResolver; never supplied by a file',
    scope: 'Entire, or a preconstruction term scope with team_member_terms behind it. The template offers no Scope column, so an imported preconstruction deal cannot carry per-term team splits. Raise it if the brokerage needs them.',
  },
  clients: {},
  conditions: {},
  precon_terms: {
    term_no: 'the row order on the sheet is the term number; the first row is Term 1',
    bonus: 'TD-130 moved the builder bonus to the DEAL as precon_comm_bonus at the brokerage instruction, so the template fills that column instead. This one is left in place and unfilled.',
  },
};

describe('every child sheet column exists on the table it writes to', () => {
  for (const child of CHILD_SHEETS) {
    const table = TABLE[child.key];
    if (!table) continue;
    it(`${child.sheet} -> ${table}`, () => {
      const cols = new Set(scalars(table));
      const missing = child.fields.filter((f) => !cols.has(f.key)).map((f) => `${f.column} -> ${f.key}`);
      expect(missing).toEqual([]);
    });
  }
});

describe('every column on those tables is either offered by the template or explained', () => {
  for (const child of CHILD_SHEETS) {
    const table = TABLE[child.key];
    if (!table) continue;
    it(`${table} has no column the template silently cannot fill`, () => {
      const offered = new Set(child.fields.map((f) => f.key));
      const explained = NOT_OFFERED[table] ?? {};
      const orphans = scalars(table)
        .filter((c) => !HOUSEKEEPING.includes(c) && !offered.has(c) && !(c in explained));
      expect(orphans).toEqual([]);
    });
  }

  it('gives every explanation a real reason', () => {
    const thin = Object.entries(NOT_OFFERED)
      .flatMap(([t, m]) => Object.entries(m).map(([c, why]) => [`${t}.${c}`, why] as const))
      .filter(([, why]) => why.trim().length < 20)
      .map(([k]) => k);
    expect(thin).toEqual([]);
  });

  it('carries no explanation for a column that no longer exists', () => {
    const stale: string[] = [];
    for (const [table, m] of Object.entries(NOT_OFFERED)) {
      const cols = new Set(scalars(table));
      for (const c of Object.keys(m)) if (!cols.has(c)) stale.push(`${table}.${c}`);
    }
    expect(stale).toEqual([]);
  });
});

describe('coverage', () => {
  it('reports how much of the template these two specs now cover', () => {
    const total = flatColumns().length;
    const childCovered = CHILD_SHEETS
      .filter((c) => TABLE[c.key] !== null)
      .reduce((n, c) => n + c.fields.length * c.flatMax, 0);
    const uncovered = CHILD_SHEETS
      .filter((c) => TABLE[c.key] === null)
      .reduce((n, c) => n + c.fields.length * c.flatMax, 0);
    console.warn(`import template: ${total} columns; ${childCovered} child columns checked against the schema here, ${uncovered} still unchecked (the Adjustments sheet writes to a JSON blob, not a table).`);
    expect(childCovered).toBeGreaterThan(0);
  });
});
