import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { col } from './report-columns';
import { docCounts, docStatus, isReceived, type DocRow } from './report-documents';
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

/**
 * THE LABEL WAS ONLY HALF OF IT.
 *
 * Naming the column 'Pending Validation' stopped the number lying, and left the reader without the
 * number they came for: there was no column anywhere in either documentation report for documents
 * RECEIVED — only pending, valid, invalid and total, every one a validation state. So the "5 / 10
 * received" on the deal's own panel could not be recovered from the report at any setting, and on
 * deal 4 an administrator was told to chase ten documents while seven sat in the folder.
 *
 * The entry asks for "a label OR a second column". The label alone leaves the reports unable to
 * answer the question they are opened to answer, so this is the second column.
 */
describe('the reports can answer what has actually ARRIVED (TD-089)', () => {
  const doc = (raw_status: string, validation: string): DocRow => ({
    raw_status, validation, status: docStatus({ status: raw_status, validation }),
  } as DocRow);

  it('counts receipt off documents.status, not off validation', () => {
    // The discriminating state, and the only one that separates the two axes: the document has
    // ARRIVED but nobody has checked it. Every earlier look missed this defect because the deals
    // examined had none in it.
    const counts = docCounts([
      doc('Received', 'Pending'),
      doc('Received', 'Valid'),
      doc('Pending', 'Pending'),
    ]);

    expect(counts.received).toBe(2);
    // Unchanged, and deliberately asserted beside it: the received-but-unchecked document is still
    // pending VALIDATION. Both numbers are right; they are answers to different questions.
    expect(counts.pending).toBe(2);
    expect(counts.total).toBe(3);
  });

  it('reads the receipt field the deal panel reads, however it is cased or spaced', () => {
    expect(isReceived({ raw_status: 'Received' })).toBe(true);
    expect(isReceived({ raw_status: ' received ' })).toBe(true);
    expect(isReceived({ raw_status: 'Pending' })).toBe(false);
    expect(isReceived({})).toBe(false);
  });

  it('names the column for the axis it counts', () => {
    expect(col.receivedDocs().label).toBe('Documents Received');
    expect(col.receivedDocs().key).toBe('received_docs');
  });

  it('offers it on both reports that were telling people to chase documents already on file', () => {
    for (const type of ['deal-documentation-status', 'reco-audit-readiness']) {
      const report = REPORTS.find((r) => r.type === type)!;
      const keys = report.columns.map((c) => c.key);
      // Present AND on by default: a column the reader has to go and enable does not correct a
      // figure they are already reading.
      expect([type, keys.includes('received_docs')]).toEqual([type, true]);
      expect([type, report.columns.find((c) => c.key === 'received_docs')?.default]).toEqual([type, true]);
    }
  });

  it('puts Received before the validation counts it is most confused with', () => {
    const keys = REPORTS.find((r) => r.type === 'deal-documentation-status')!.columns.map((c) => c.key);
    expect(keys.indexOf('received_docs')).toBeLessThan(keys.indexOf('pending_docs'));
  });
});
