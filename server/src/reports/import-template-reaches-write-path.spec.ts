import {
  IMPORT_FIELDS, FINANCIAL_FIELDS, CHILD_SHEETS, REQUIRED_COLUMNS, flatColumns, type ImportField,
} from './import-template';
import { FILL_KEYS } from '../transactions/transactions-write.service';

/**
 * EVERY COLUMN THE IMPORT TEMPLATE OFFERS MUST REACH THE WRITE PATH.
 *
 * import-template.ts declares, for every column, the `key` it sends: "Key sent to the transaction
 * write path." transactions-write.service.ts declares FILL_KEYS: what that path accepts. The two
 * lists have a stated relationship and until this file existed NOTHING CHECKED IT HELD.
 *
 * Three defects came out of that gap in one week, each found by hand, each the same shape - a
 * column declared in one list and missing from the other, with the review screen reporting the row
 * valid and the import reporting success:
 *   TD-147  requiredColumnsFor disagreed with the write path's own required list.
 *   TD-154  payment_type: template column, packaged by the importer, offered by Reports as a
 *           sortable default column, an export field and a filter - and absent from FILL_KEYS, so
 *           nothing could ever set it. Zero of 46 deals had one.
 *   TD-160  listing_price: writable only in the create block, absent from FILL_KEYS which is what
 *           update() iterates, and absent from the client entirely - while a default-on report
 *           column, a total, an export column and a whole report read it.
 *
 * This test is cheap, has no database and is DERIVED FROM THE DECLARATIONS THEMSELVES, so adding a
 * column to the template breaks it until somebody either wires the column up or writes down why it
 * does not need wiring. A hand-maintained list of columns to check would be a fourth list to forget.
 */

const all = (): ImportField[] => [...IMPORT_FIELDS, ...FINANCIAL_FIELDS];

/**
 * Columns that legitimately do NOT go through FILL_KEYS, each with the route it takes instead.
 * A reason is mandatory: an exemption without one is how a defect hides.
 */
const HANDLED_ELSEWHERE: Record<string, string> = {
  trade_no: 'allocated at create by TradeNumberService, or taken from the row as a manual trade number; never updated afterwards by design',
  status: 'written to the transaction_statuses table, not to a column on transactions',
  primary_agent: 'resolved at create into the agent name plus agent_user_id via PersonResolver',
  team_members: 'written to team_members by syncTeam, not to a column on transactions',
  brokerage_name: 'the separate brokerages table, one row per transaction',
  brokerage_email: 'the separate brokerages table, one row per transaction',
  brokerage_phone: 'the separate brokerages table, one row per transaction',
  brokerage_address: 'the separate brokerages table, one row per transaction',
  brokerage_agents: 'the separate brokerages table, one row per transaction',
};

/** Known to be broken, each naming its open defect. Empty is the goal. */
const KNOWN_GAPS: Record<string, string> = {
  listing_price: 'TD-160 - set only in the create block, missing from FILL_KEYS, and the client has no field for it at all',
};

describe('every import template column reaches the write path', () => {
  const fill = new Set<string>(FILL_KEYS as readonly string[]);

  it('has no column that is neither accepted by the write path nor documented', () => {
    const orphans = all()
      .filter((f) => !fill.has(f.key) && !(f.key in HANDLED_ELSEWHERE) && !(f.key in KNOWN_GAPS))
      .map((f) => `${f.column} -> ${f.key}`);
    expect(orphans).toEqual([]);
  });

  it('reports the known gaps loudly on every run', () => {
    const gaps = Object.entries(KNOWN_GAPS);
    if (gaps.length > 0) {
      console.warn(`import template: ${gaps.length} column(s) still not reaching the write path:`);
      for (const [k, why] of gaps) console.warn(`  ${k} - ${why}`);
    }
    expect(gaps.map(([k]) => k).filter((k) => fill.has(k))).toEqual([]);
  });

  it('carries no stale exemption - every exemption still names a real template column', () => {
    const keys = new Set(all().map((f) => f.key));
    const stale = [...Object.keys(HANDLED_ELSEWHERE), ...Object.keys(KNOWN_GAPS)].filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });

  it('carries no exemption that the write path actually handles', () => {
    expect(Object.keys(HANDLED_ELSEWHERE).filter((k) => fill.has(k))).toEqual([]);
  });

  it('gives every exemption a real reason', () => {
    const empty = Object.entries({ ...HANDLED_ELSEWHERE, ...KNOWN_GAPS })
      .filter(([, why]) => why.trim().length < 20)
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });
});

describe('the template itself is coherent', () => {
  it('offers no duplicate column heading', () => {
    const cols = flatColumns();
    const seen = new Set<string>();
    const dupes = cols.filter((c) => (seen.has(c) ? true : (seen.add(c), false)));
    expect(dupes).toEqual([]);
  });

  it('requires nothing it does not offer', () => {
    const cols = new Set(flatColumns());
    expect(REQUIRED_COLUMNS.filter((c) => !cols.has(c))).toEqual([]);
  });

  it('gives every child sheet unique keys within itself', () => {
    for (const child of CHILD_SHEETS) {
      const keys = child.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('gives every field a key, a hint and a type', () => {
    const bad = [...all(), ...CHILD_SHEETS.flatMap((c) => c.fields)]
      .filter((f) => !f.key || !f.hint || !f.type)
      .map((f) => f.column);
    expect(bad).toEqual([]);
  });
});
