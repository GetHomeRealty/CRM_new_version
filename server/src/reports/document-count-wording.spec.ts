import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { col } from './report-columns';
import { docStatus } from './report-documents';
import { REPORTS } from './report-registry';

/**
 * TD-089 — a document count is labelled with WHICH question it answers.
 *
 * A document row carries two independent fields:
 *
 *   `status`     — Pending / Received        has the file arrived?
 *   `validation` — Pending / Valid / Invalid has it been checked?
 *
 * The Deal Documentation Status Report counts the VALIDATION axis; the deal's own Legal &
 * Documentation panel counts RECEIPT and reads "5 / 10 received". On a deal where one document had
 * arrived but had not been checked, the panel said five outstanding and the report said eleven.
 * Both were right. Neither said what it was counting, on the report a compliance reviewer uses to
 * decide whether a file is complete.
 *
 * AND THERE WAS A THIRD ANSWER. The Dashboard's "Documents Outstanding" tile counts `status:
 * 'Pending'` — the RECEIPT axis — under the same word "pending" the report used for validation. Two
 * screens, one word, two meanings, and no way to reconcile the figures.
 *
 * NOTHING IS RECOMPUTED. Each figure is worth having and each is correct; the defect is that
 * "Pending Documents" is the wrong name for either of them on its own. These tests pin the wording
 * to the axis it describes — including the Dashboard's, read off the client, because a third
 * surface drifting back to a bare "pending" is what made the set unreconcilable in the first place.
 */

describe('the documentation counts say which axis they count (TD-089)', () => {
  it('labels the validation-derived count as validation', () => {
    expect(col.pendingDocs().label).toBe('Pending Validation');
    // The key is untouched: it is the API's contract and every saved column selection uses it.
    expect(col.pendingDocs().key).toBe('pending_docs');
  });

  it('still counts what it always counted — a received-but-unchecked document is pending', () => {
    // The state that discriminates the two readings, and the one QA had to create to prove it.
    expect(docStatus({ status: 'Received', validation: 'Pending' })).toBe('Pending');
    expect(docStatus({ status: 'Pending', validation: 'Pending' })).toBe('Pending');
    expect(docStatus({ status: 'Received', validation: 'Valid' })).toBe('Valid');
    expect(docStatus({ status: 'Received', validation: 'Invalid' })).toBe('Invalid');
  });

  it('carries the same wording to every report that shows the column', () => {
    // The RECO Audit Readiness Report shows it too, and a reviewer reads the two side by side.
    const showing = REPORTS.filter((r) => r.columns.some((c) => c.key === 'pending_docs'));
    expect(showing.length).toBeGreaterThan(1);
    for (const report of showing) {
      const column = report.columns.find((c) => c.key === 'pending_docs')!;
      expect([report.type, column.label]).toEqual([report.type, 'Pending Validation']);
    }
  });

  it('leaves the receipt-side wording on the Dashboard tile, which counts the other axis', () => {
    // Read off the client because that is where the third answer lived. The tile's headline is
    // `documents.pending`, which is `status: 'Pending'` — documents that have not ARRIVED.
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'DeskDashboardPage.tsx'),
      'utf8',
    );
    const tile = source.slice(source.indexOf('Documents Outstanding'), source.indexOf('mandatory missing'));
    expect(tile).toContain("label: 'awaiting receipt'");
    expect(tile).not.toContain("label: 'pending'");
  });
});
