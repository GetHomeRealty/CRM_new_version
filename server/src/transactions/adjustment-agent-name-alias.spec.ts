import { clearSwitchedOffSections } from './transactions-write.service';

/*
 * TD-108 - an adjustment or advance row that names its agent in `agent_name` is stored with `agent`,
 * the only key the commission engine matches on. Before, it was stored as sent, matched nobody and
 * moved no money, with no error.
 */
const rows = (v: unknown, key: string) => (v as Record<string, Record<string, unknown>[]>)[key];

describe('adjustment and advance rows name their agent the way the engine reads it', () => {
  it('reads agent_name as agent on an adjustment row', () => {
    const out = clearSwitchedOffSections({ agent_adjust: 'Yes', adjustment_rows: [{ agent_name: 'Asha', amount: -500 }] });
    expect(rows(out, 'adjustment_rows')[0]).toEqual({ agent: 'Asha', amount: -500 });
  });
  it('and on an advance row', () => {
    const out = clearSwitchedOffSections({ advance_payment: 'Yes', advance_rows: [{ agent_name: 'Ravi', amount: 1000 }] });
    expect(rows(out, 'advance_rows')[0]).toEqual({ agent: 'Ravi', amount: 1000 });
  });
  it('never overwrites an agent that is already there', () => {
    const out = clearSwitchedOffSections({ agent_adjust: 'Yes', adjustment_rows: [{ agent: 'Asha', agent_name: 'Someone Else', amount: 1 }] });
    expect(rows(out, 'adjustment_rows')[0]).toEqual({ agent: 'Asha', amount: 1 });
  });
  it('leaves an ordinary row exactly as it was', () => {
    const row = { agent: 'Asha', amount: -1500, status: 'Yet to Adjust', remarks: 'x', is_loan: false };
    const out = clearSwitchedOffSections({ agent_adjust: 'Yes', adjustment_rows: [row] });
    expect(rows(out, 'adjustment_rows')[0]).toEqual(row);
  });
});
