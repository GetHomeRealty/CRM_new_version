import {
  docStatus, docCategory, isAmendment, isWaiver, docCounts, documentationStatus,
  groupStatus, expiryStatus, daysUntil, remainingTime, type DocRow,
} from './report-documents';

const doc = (over: Partial<DocRow> & { title: string; status: DocRow['status'] }): DocRow => ({
  id: 1, category: 'Other', raw_status: 'Pending', validation: 'Pending', mandatory: false,
  is_condition: false, uploaded: false, reminder_sent: false, file_name: null,
  uploaded_at: null, reviewed_at: null, remarks: null, ...over,
});

describe('documentation status', () => {
  it('maps the two stored axes onto one reporting status', () => {
    // documents.status says whether the file arrived; documents.validation whether it passed
    expect(docStatus({ status: 'Received', validation: 'Invalid' })).toBe('Invalid');
    expect(docStatus({ status: 'Received', validation: 'Valid' })).toBe('Valid');
    expect(docStatus({ status: 'Received', validation: 'Pending' })).toBe('Pending'); // arrived, unchecked
    expect(docStatus({ status: 'Pending', validation: 'Pending' })).toBe('Pending');  // never arrived
  });
  it('treats an invalid document as invalid even once received', () => {
    expect(docStatus({ status: 'Received', validation: 'invalid' })).toBe('Invalid'); // case-insensitive
  });
});

describe('document categories', () => {
  it('classifies an amendment ahead of the agreement it amends', () => {
    expect(docCategory('Amendment to Agreement of Purchase and Sale')).toBe('Amendments');
    expect(docCategory('Agreement of Purchase and Sale')).toBe('Agreements');
  });
  it('recognises the categories the ZIP structure needs', () => {
    expect(docCategory('Waiver of Conditions')).toBe('Waivers');
    expect(docCategory('Deposit Receipt')).toBe('Deposits');
    expect(docCategory('Client Photo IDs')).toBe('Identification');
    expect(docCategory('FINTRAC')).toBe('FINTRAC');
    expect(docCategory('RECO Guide')).toBe('RECO Compliance');
    expect(docCategory('Notice of Sale')).toBe('Notices');
    expect(docCategory('Something unusual')).toBe('Other');
  });
  it('identifies amendment and waiver documents', () => {
    expect(isAmendment('price change amend')).toBe(true);
    expect(isAmendment('Agreement to Lease')).toBe(false);
    expect(isWaiver('Waiver — financing')).toBe(true);
  });
});

describe('document counts', () => {
  const docs = [
    doc({ title: 'A', status: 'Pending' }),
    doc({ title: 'B', status: 'Pending', mandatory: true }),
    doc({ title: 'C', status: 'Invalid', mandatory: true }),
    doc({ title: 'D', status: 'Valid', mandatory: true }),
    doc({ title: 'E', status: 'Valid', uploaded: true, reminder_sent: true }),
  ];
  it('never merges pending and invalid', () => {
    const c = docCounts(docs);
    expect(c.pending).toBe(2);
    expect(c.invalid).toBe(1);
    expect(c.valid).toBe(2);
    expect(c.pending + c.invalid + c.valid).toBe(c.total);
  });
  it('counts a mandatory document as missing until it is valid', () => {
    const c = docCounts(docs);
    expect(c.mandatory).toBe(3);
    expect(c.missing_mandatory).toBe(2); // the pending one and the invalid one
  });
  it('tracks uploads and reminders separately', () => {
    const c = docCounts(docs);
    expect(c.uploaded).toBe(1);
    expect(c.reminders_sent).toBe(1);
  });
  it('surfaces invalid documentation ahead of pending', () => {
    expect(documentationStatus(docCounts(docs))).toBe('Invalid Documentation');
    expect(documentationStatus(docCounts([doc({ title: 'A', status: 'Pending' })]))).toBe('Pending Documentation');
    expect(documentationStatus(docCounts([doc({ title: 'A', status: 'Valid' })]))).toBe('Complete');
    expect(documentationStatus(docCounts([]))).toBe('No Documents');
  });
  it('reports a missing group rather than a false "valid"', () => {
    expect(groupStatus([])).toBe('Missing');
    expect(groupStatus([doc({ title: 'W', status: 'Valid' })])).toBe('Valid');
    expect(groupStatus([doc({ title: 'W', status: 'Valid' }), doc({ title: 'X', status: 'Invalid' })])).toBe('Invalid');
    expect(groupStatus([doc({ title: 'W', status: 'Valid' }), doc({ title: 'X', status: 'Pending' })])).toBe('Pending');
  });
});

describe('condition expiry', () => {
  const today = '2026-07-21';
  it('computes days relative to today', () => {
    expect(daysUntil('2026-07-24', today)).toBe(3);
    expect(daysUntil('2026-07-20', today)).toBe(-1);
    expect(daysUntil(null, today)).toBeNull();
  });
  it('derives expiry status from the deadline', () => {
    expect(expiryStatus({ status: 'Pending', deadline: '2026-07-30' }, today)).toBe('Active');
    expect(expiryStatus({ status: 'Pending', deadline: '2026-07-24' }, today)).toBe('Expiring Soon');
    expect(expiryStatus({ status: 'Pending', deadline: '2026-07-21' }, today)).toBe('Expiring Soon');
    expect(expiryStatus({ status: 'Pending', deadline: '2026-07-20' }, today)).toBe('Expired');
    expect(expiryStatus({ status: 'Pending', deadline: null }, today)).toBe('Active');
  });
  it('lets a recorded outcome override the date', () => {
    // a fulfilled condition is not "Expired" just because its deadline has passed
    expect(expiryStatus({ status: 'Fulfilled', deadline: '2020-01-01' }, today)).toBe('Fulfilled');
    expect(expiryStatus({ status: 'Waived', deadline: '2020-01-01' }, today)).toBe('Waived');
    expect(expiryStatus({ status: 'Extended', deadline: '2020-01-01' }, today)).toBe('Extended');
  });
  it('describes the remaining time in words', () => {
    expect(remainingTime('2026-07-21', today)).toBe('Today');
    expect(remainingTime('2026-07-22', today)).toBe('in 1 day');
    expect(remainingTime('2026-07-26', today)).toBe('in 5 days');
    expect(remainingTime('2026-07-18', today)).toBe('3 days overdue');
    expect(remainingTime(null, today)).toBe('—');
  });
});
