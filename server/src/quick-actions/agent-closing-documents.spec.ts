import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-116 — an agent produces the Trade Sheet and Notice of Sale for their own file.
 *
 * Both actions were gated `!isAgent` on the transaction header, so the role was offered neither in
 * either mode and neither phrase appeared anywhere on the page. What made it a defect rather than a
 * policy is the other half: the Lawyer Details modal an agent IS asked to complete carries the
 * footnote 'Used to auto-fill the Notice of Sale and Trade Sheet documents', so the product
 * explained the purpose of eight required fields to the one role it then refused the payoff to. The
 * brokerage answered the question the entry parks — grant the actions — which makes the footnote
 * true rather than needing a rewrite.
 *
 * WHY THIS SPEC READS BOTH SIDES. TD-116 was closed once already, against a change to
 * `document-defaults.service.ts` that added these two documents to the CHECKLIST. That change was
 * real and verified, and it is a different surface: adding a row to a document list does not give
 * an agent a control that produces the document. So the assertions below name the header buttons
 * specifically, and pin the footnote that has to stay true beside them.
 */

const CLIENT = join(__dirname, '..', '..', '..', 'client', 'src', 'desk');
const strip = (f: string): string =>
  readFileSync(join(CLIENT, f), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const page = strip('TransactionDetailPage.tsx');
const lawyer = strip('LawyerModal.tsx');

/** The single JSX line that renders one header button, found by its label. */
const control = (label: string): string => {
  const line = page.split('\n').find((l) => l.includes(`> ${label}`) && l.includes('<button'));
  expect(line).toBeDefined();
  return line!;
};

describe('an agent can produce the closing paperwork for their own deal (TD-116)', () => {
  for (const label of ['Trade Sheet', 'Notice of Sale']) {
    describe(label, () => {
      it('is no longer hidden from the agent role outright', () => {
        // Was: {!isAgent && !docsOnly && …} — absent on the agent's own deal, in both modes.
        expect(control(label)).not.toMatch(/\{!isAgent &&/);
      });

      it('is offered to the deal’s own agent and to a full team member', () => {
        expect(control(label)).toContain('(!isAgent || isFullAgent)');
      });

      it('still respects the status rules, which are not about role', () => {
        // docsOnly is Void / Mutual Release; hideTradeSheet and hideStmtNos are statuses too early
        // for the document to mean anything. They hide these from an administrator too.
        expect(control(label)).toContain('!docsOnly');
        expect(control(label)).toContain(label === 'Trade Sheet' ? '!hideTradeSheet' : '!hideStmtNos');
      });
    });
  }

  it('grants exactly what the server already allows, rather than a second rule', () => {
    // `isFullAgent` is the deal's own agent or a full team member — the population
    // `ResourceAccessService.assertTransaction` admits, minus the docs-only members. A view-only
    // split viewer is still offered nothing.
    expect(page).toContain("const isFullAgent = isAgent && (isOwnerAgent || myTeamAccess === 'full');");
    expect(page).toContain('const isOwnerAgent = isAgent && form.agent === user?.name;');
  });

  it('leaves the Lawyer Details footnote true for the role that reads it', () => {
    // The footnote is the half that turned a gate into a defect. It stays as it is BECAUSE the
    // actions were granted; had the brokerage chosen the other branch, this is the line that would
    // have had to change instead, and this assertion would have been its opposite.
    expect(lawyer).toContain('Used to auto-fill the Notice of Sale and Trade Sheet documents');
  });
});
