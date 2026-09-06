import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-132 — the preconstruction Commission Agent names WHICH person, rather than accepting any text.
 *
 * The control was an `<input list="agentList">`. A datalist only SUGGESTS: a shortened name, a
 * differing case or a trailing space was saved verbatim with no link to an account. That is the
 * shape TD-045 removed from the deal's Agent Name, on a different column — and it arrived here by
 * inheritance, because the two fields shared one datalist by id and removing Agent Name's copy left
 * this one pointing at nothing, so the list was restored beside it rather than the field being
 * reconsidered.
 *
 * The client has no unit runner, so the control is read off disk and asserted here, in the idiom
 * `transaction-type-aliases.spec.ts` and `inbox-setup-instructions.spec.ts` already use.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is load-bearing rather than tidiness: the comment left in
 * place of the old control quotes `<input list="agentList">` verbatim to say what was wrong with
 * it. A check that read the raw file would find the datalist it is meant to forbid, sitting inside
 * the note explaining its removal — and would then fail forever, or pass forever if written the
 * other way round. TD-018 is in this report twice for the same reason: a check must assert the
 * thing the entry actually claims.
 */

const SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'TransactionDetailPage.tsx'),
  'utf8',
);

/** The file as it renders — JSX comments removed, so prose about the fault is not read as the fault. */
const code = SOURCE.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** Just the Commission Agent control, so a `<select>` elsewhere on a 1500-line page cannot pass this. */
const field = ((): string => {
  const at = code.indexOf('<Field label="Commission Agent">');
  expect(at).toBeGreaterThan(-1);
  const end = code.indexOf('</Field>', at);
  return code.slice(at, end);
})();

describe('the preconstruction Commission Agent is picked, not typed (TD-132)', () => {
  it('is no longer an input that a datalist merely suggests values to', () => {
    // Was: <input list="agentList" value={form.commission_agent} … />
    expect(field).not.toMatch(/<input[^>]*\blist=/);
    expect(field).not.toContain('<datalist');
  });

  it('takes the value from a select bound to the commission agent', () => {
    expect(field).toMatch(/<select/);
    expect(field).toContain("set('commission_agent', e.target.value)");
  });

  it('offers every account as an option', () => {
    expect(field).toContain('agents.map((a) => <option key={a} value={a}>{a}</option>)');
  });

  it('keeps naming someone with no account possible, as a deliberate choice', () => {
    // A preconstruction commission can genuinely be payable to a person with no seat here. The
    // point of TD-132 is that this becomes a choice rather than a typo, so the escape hatch is
    // required to EXIST — its absence would be a different defect, not a stricter fix.
    expect(field).toContain('__external__');
    expect(field).toContain('External / co-op agent');
  });

  it('shows a stored name that matches no active user instead of silently blanking it', () => {
    // A variant spelling saved before this change, or an agent who has since left the brokerage:
    // a <select> whose value is not among its options renders empty, which would quietly drop the
    // name on the next save. The external branch catches exactly that case.
    expect(field).toContain('!!form.commission_agent && !agents.includes(form.commission_agent)');
  });

  it('leaves no shared agentList datalist behind on the page', () => {
    // The id this field borrowed from Agent Name, and then owned alone. Nothing points at it now.
    expect(code).not.toContain('id="agentList"');
    expect(code).not.toContain('list="agentList"');
  });
});
