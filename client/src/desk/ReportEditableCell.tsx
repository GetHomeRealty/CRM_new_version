import { useState } from 'react';
import { saveReportRemark } from '../lib/reportsApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import type { ReportColumn } from '../types';

/**
 * Cells a report lets you edit in place (Pending Payments: Validation Comments, Accounting Remarks).
 *
 * Both open with the text the cell shows, so it can be changed or cleared, and save through the
 * report's own route (`PUT /api/reports/pending-payments/:id/remarks`). That route changes only
 * the one text field, keeps an Audit Trail entry, and — unlike the ordinary deal save — works on the
 * Closed deals this report lists, for Accounting as well as Super Admin.
 */

type Row = Record<string, string | number | null>;

export function ReportEditableCell({ row, column, canEdit, onSaved }: {
  row: Row;
  column: ReportColumn;
  /** Whether this viewer may make this kind of edit at all. */
  canEdit: boolean;
  onSaved: (value: string) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const txnId = Number(row.txn_id);
  const current = row[column.key] == null ? '' : String(row[column.key]);
  // A preconstruction deal keeps validation per term; the report cannot say which term to change.
  const perTerm = column.edit === 'validation_comments' && row.type === 'Preconstruction';
  const allowed = canEdit && !!column.edit && Number.isInteger(txnId) && txnId > 0 && !perTerm;

  const save = async () => {
    if (!column.edit) return;
    setSaving(true);
    try {
      const { value } = await saveReportRemark(txnId, column.edit, draft.trim());
      onSaved(value ?? '');
      setEditing(false);
      toast(draft.trim() ? 'Saved' : 'Cleared', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div style={{ display: 'grid', gap: 4, minWidth: 180 }}>
        <textarea rows={2} value={draft} autoFocus disabled={saving}
          placeholder={column.edit === 'validation_comments' ? 'Validation comments…' : 'Accounting remarks…'}
          onChange={(e) => setDraft(e.target.value)} style={{ fontSize: 12.5 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          {/* Saving an empty box clears the field. */}
          <button type="button" className="btn primary sm" disabled={saving || draft.trim() === current} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn ghost sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  const label = column.edit === 'validation_comments' ? 'Edit validation comments' : 'Edit accounting remarks';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <span style={{ flex: 1, whiteSpace: 'pre-line' }} title={perTerm ? 'Set per term in Agent Payment Readiness' : undefined}>{current || '—'}</span>
      {allowed && (
        <button type="button" className="btn ghost sm" title={label} aria-label={label}
          style={{ padding: '2px 6px' }} onClick={() => { setDraft(current); setEditing(true); }}>✎</button>
      )}
    </div>
  );
}
