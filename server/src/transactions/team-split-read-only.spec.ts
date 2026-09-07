import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-058 — a View Only transaction cannot be given a commission split it will not keep.
 *
 * THE DEFECT. Opening a deal without entering Edit Mode and using Quick Actions → Team Split, the
 * 'Is this a Team Split?' selector switched to Yes, the form unfolded, Split % accepted 100, Total
 * Split recalculated to 100.00% and turned green — and closing the panel discarded all of it with no
 * warning, no confirmation and no toast. Nothing was ever written. Somebody can set up a split,
 * watch the total confirm it, close, and believe it is saved.
 *
 * WHY IT SURVIVED TWO ROUNDS OF FIXING, and this is the part worth recording. The panel wraps its
 * body in `<fieldset disabled={readOnly}>`, which genuinely blocks a person: the controls match
 * `:disabled`, take no input and submit nothing. What it does not do is set `element.disabled` —
 * that property reflects a control's OWN attribute and says nothing about its ancestors. So a check
 * that reads it sees an editable field, and a scripted `dispatchEvent` still reaches React's
 * onChange where a click could not.
 *
 * The evidence lines up exactly with that: the controls reported as "still live" are precisely the
 * two carrying no attribute of their own, and the ones reported as "now correctly disabled" are
 * those that already had `readOnly` on the element. Whether the remaining two blocked a real user or
 * only looked as though they did not, the answer is the same and is not worth arguing about — every
 * control states its own rule, so the behaviour and any measurement of it now agree.
 *
 * The client has no unit runner, so the panel is read off disk, in the idiom this suite already uses.
 */

const SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'TeamSplitModal.tsx'),
  'utf8',
);

/** The panel as it RUNS — the note explaining the fault is not the fault. */
const code = SOURCE.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');

/** The line rendering one control, found by something only that control says. */
const line = (marker: string): string => {
  const found = code.split('\n').find((l) => l.includes(marker));
  expect(found).toBeDefined();
  return found!;
};

describe('every editable control in Team Split reads the read-only state (TD-058)', () => {
  it('the selector that unfolds the whole form', () => {
    // The one control the 2026-09-05 run found live on an otherwise locked panel: setting it to Yes
    // opened a fully live form in a mode with no Save button.
    expect(line("onToggleSplit(e.target.value === 'Yes')")).toContain('disabled={readOnly || lockAgents}');
  });

  it('Split % — the money field the entry is named for', () => {
    // Set to 100, Total Split recalculated to 100.00% and went green, and closing threw it away.
    expect(line("set(i, 'split', e.target.value)")).toContain('disabled={readOnly || lockAgents}');
  });

  it('the agent picker and the access level beside it', () => {
    expect(line("set(i, 'name', e.target.value)")).toContain('disabled={readOnly || lockAgents}');
    expect(line("set(i, 'access', e.target.value)")).toContain('disabled={readOnly || lockAgents}');
  });

  it('does not offer buttons that add or remove a member it cannot save', () => {
    // A disabled button is still an invitation; in a mode that cannot save, these are not offered.
    expect(line('+ Add Team Member')).toContain('!readOnly');
    expect(line('onClick={() => rm(i)}')).toContain('!readOnly');
  });

  it('keeps the fieldset as well, rather than trading one guard for another', () => {
    // Defence in depth: the fieldset is what actually stops a person, and a control added later
    // without its own attribute is still covered by it.
    expect(code).toContain('<fieldset disabled={readOnly}');
  });

  it('still has no Save button in read-only, so nothing implies the form would keep anything', () => {
    expect(code).toContain('{!readOnly && <button className="btn primary" onClick={save}');
  });
});

describe('the rules that are NOT read-only are untouched (TD-058)', () => {
  it('leaves Agent % and Brokerage % read-only for everyone, as they always were', () => {
    // These come from the agent's registered split and are changed under Financial Information.
    // They were correct before this entry and must not become editable in Edit Mode by accident.
    const agentPct = line('title="Editable under Financial Information → Agent Commission"');
    expect(agentPct).toContain('readOnly');
  });

  it('keeps the post-Notice-of-Sale lock working on its own', () => {
    // `lockAgents` is a different rule from `readOnly` — a deal whose Notice of Sale has gone out
    // locks its agents even in Edit Mode. Both are ORed, so neither can be lost by fixing the other.
    for (const marker of ["onToggleSplit(e.target.value === 'Yes')", "set(i, 'split', e.target.value)"]) {
      expect(line(marker)).toContain('lockAgents');
    }
  });
});
