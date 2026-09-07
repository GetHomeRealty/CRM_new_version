import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-040 — a form action that cannot proceed says so in the app, and never with a native dialog.
 *
 * THE ENTRY WAS FILED AS A HANG AND IS NOT ONE. `window.alert`, `window.confirm` and `window.prompt`
 * are native modals: they block the browser's main thread until somebody clicks. A tab with one open
 * cannot be scripted or screenshotted, which is exactly what "unresponsive for 45 seconds or more"
 * was measuring — the test tooling froze, not the application. A person at the screen saw a dialog.
 *
 * WHAT IS STILL REAL, and why the entry was fixed rather than withdrawn: every major browser offers
 * "prevent this page from creating additional dialogs" after a repeated one. A user who ticks it
 * stops receiving these messages ENTIRELY, and Save then does nothing and explains nothing — the
 * silent failure the entry describes, reachable in one click by the user themselves. There is no
 * equivalent way for a viewer to suppress a toast.
 *
 * THE RE-DIAGNOSIS FOUND ONE OF THREE. The 2026-09-06 note pins the cause on `LawyerModal`'s
 * `alert` and attributes the whole entry to it. The entry names THREE actions, and the other two —
 * Trade Sheet → Send and Request Deletion — are `window.prompt`, which blocks identically. Fixing
 * the alert alone would have left two of the three reproducers, so this spec asserts the surfaces
 * rather than the one call.
 *
 * The client has no unit runner, so the sources are read off disk, in the idiom
 * `inbox-setup-instructions.spec.ts` and `transaction-type-aliases.spec.ts` already use. Comments
 * are stripped: the notes left in place of the removed calls quote `window.alert` and
 * `window.prompt` verbatim to say what was wrong with them.
 */

const CLIENT = join(__dirname, '..', '..', '..', 'client', 'src', 'desk');

/** A file as it RUNS — block and line comments removed, so prose about the fault is not the fault. */
const code = (file: string): string =>
  readFileSync(join(CLIENT, file), 'utf8')
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The three screens TD-040 names, by the action it names them for. */
const SURFACES: [file: string, action: string][] = [
  ['LawyerModal.tsx', 'Lawyer Details → Save'],
  ['TradeSheetModal.tsx', 'Trade Sheet → Send'],
  ['TransactionDetailPage.tsx', 'Request Deletion'],
];

describe('the actions TD-040 names never open a native dialog', () => {
  for (const [file, action] of SURFACES) {
    it(`${action} (${file})`, () => {
      const src = code(file);
      // Named individually rather than as one regex, so a failure says WHICH kind came back.
      expect([action, /window\.alert\s*\(/.test(src)]).toEqual([action, false]);
      expect([action, /window\.confirm\s*\(/.test(src)]).toEqual([action, false]);
      expect([action, /window\.prompt\s*\(/.test(src)]).toEqual([action, false]);
      // A bare alert(...) is the same dialog without the qualifier.
      expect([action, /(?<![.\w])alert\s*\(/.test(src)]).toEqual([action, false]);
    });
  }

  it('reports the validation failure instead of swallowing it', () => {
    // The point is not merely that the alert is gone — a removed alert that told the user nothing
    // would be the silent failure the entry describes, arrived at deliberately.
    const src = code('LawyerModal.tsx');
    expect(src).toContain('const fail = (message: string)');
    expect(src).toContain("toast(message, 'bad')");
    expect(src).toContain('setError(message)');
    // All three validation branches route through it. The definition reads `fail = (`, so it is not
    // one of these matches - these are the call sites, and there are exactly three of them.
    expect((src.match(/\bfail\(/g) ?? []).length).toBe(3);
  });

  it('still asks for the things the prompts were collecting', () => {
    // A prompt removed without replacing what it gathered would take the recipient address and the
    // deletion reason away with it.
    const sheet = code('TradeSheetModal.tsx');
    expect(sheet).toContain('setSendOpen(true)');
    expect(sheet).toMatch(/value=\{sendTo\}/);

    const detail = code('TransactionDetailPage.tsx');
    expect(detail).toMatch(/askReason\('delete'\)/);
    expect(detail).toMatch(/askReason\('forward'\)/);
    expect(detail).toMatch(/askReason\('edit'\)/);
    expect(detail).toMatch(/value=\{reasonText\}/);
  });

  it('keeps a deletion request from being sent with no reason', () => {
    // The old prompt enforced this with `if (!reason.trim())` after the fact; the dialog now
    // refuses to enable its button, which is the same rule stated earlier.
    expect(code('TransactionDetailPage.tsx')).toContain('confirmDisabled: !reasonText.trim()');
  });

  it('builds the reason dialogs in the render, where a controlled field can update', () => {
    /*
     * The trap TD-016 documents: `ConfirmOptions` held in state is a SNAPSHOT, so a textarea inside
     * it freezes at its first value and the typing goes nowhere. Both new dialogs are therefore
     * built at render time. If somebody later moves them behind `setConfirm`/`useConfirm`, the
     * field stops working — and it fails silently, which is why it is asserted rather than trusted.
     */
    const detail = code('TransactionDetailPage.tsx');
    expect(detail).toMatch(/confirm=\{reasonAsk \?/);
    expect(detail).not.toMatch(/setConfirm\(\s*\{[\s\S]{0,400}?value=\{reasonText\}/);

    const sheet = code('TradeSheetModal.tsx');
    expect(sheet).toMatch(/confirm=\{sendOpen \?/);
  });
});
