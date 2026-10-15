import { useState } from 'react';
import { getTransaction, updateTransaction } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { roleLabel } from './format';
import { useToast } from './toast';
import type { ReportColumn } from '../types';

/**
 * Cells a report lets you edit in place (Pending Payments: Validation Comments, Accounting Remarks).
 *
 * EVERY SAVE GOES THROUGH THE ORDINARY TRANSACTION UPDATE, so the same permissions, audit trail and
 * server rules apply as in the deal's own panels. Those panels save their whole JSON object, so the
 * deal is read fresh, ONE field changed, and the object written back — nothing else in the panel
 * is touched.
 */

type Row = Record<string, string | number | null>;
type Json = Record<string, unknown>;

/** Agent Payment Readiness → Final Validation Remarks, replaced as the panel's own field is. */
async function saveValidationComments(txnId: number, text: string): Promise<void> {
  const txn = await getTransaction(txnId) as unknown as { activity_tracker?: Json | null };
  const tracker: Json = { ...(txn.activity_tracker ?? {}) };
  tracker.final_validation_remarks = text;
  await updateTransaction(txnId, { activity_tracker: tracker });
}

/** Admin Activities → Remarks: a new note, stamped like the panel's own, so earlier notes are kept. */
async function addAccountingRemark(txnId: number, text: string, author: { name?: string | null; role?: string | null }): Promise<void> {
  const txn = await getTransaction(txnId) as unknown as { admin_activities?: Json | null };
  const admin: Json = { ...(txn.admin_activities ?? {}) };
  const now = new Date().toISOString();
  const notes = Array.isArray(admin.notes) ? admin.notes : [];
  admin.notes = [...notes, { text, date: now.slice(0, 10), created_at: now, author: author.name || '', role: roleLabel(author.role || '') }];
  await updateTransaction(txnId, { admin_activities: admin });
}

export function ReportEditableCell({ row, column, canEdit, user, onSaved }: {
  row: Row;
  column: ReportColumn;
  /** Whether this viewer may make this kind of edit at all. */
  canEdit: boolean;
  user: { name?: string | null; role?: string | null } | null;
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
  const allowed = canEdit && Number.isInteger(txnId) && txnId > 0 && !perTerm;
  // Comments are one field, edited in place; remarks are a log, so each save adds a note.
  const replaces = column.edit === 'validation_comments';

  const save = async () => {
    const text = draft.trim();
    setSaving(true);
    try {
      if (replaces) await saveValidationComments(txnId, text);
      else await addAccountingRemark(txnId, text, user ?? {});
      onSaved(text);
      setEditing(false);
      toast('Saved', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const unchanged = replaces ? draft.trim() === current : !draft.trim();
    return (
      <div style={{ display: 'grid', gap: 4, minWidth: 180 }}>
        <textarea rows={2} value={draft} autoFocus disabled={saving} placeholder={replaces ? 'Validation comments…' : 'Add a remark…'}
          onChange={(e) => setDraft(e.target.value)} style={{ fontSize: 12.5 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="btn primary sm" disabled={saving || unchanged} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn ghost sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  const label = replaces ? 'Edit validation comments' : 'Add an accounting remark';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <span style={{ flex: 1, whiteSpace: 'pre-line' }} title={perTerm ? 'Set per term in Agent Payment Readiness' : undefined}>{current || '—'}</span>
      {allowed && (
        <button type="button" className="btn ghost sm" title={label} aria-label={label}
          style={{ padding: '2px 6px' }} onClick={() => { setDraft(replaces ? current : ''); setEditing(true); }}>✎</button>
      )}
    </div>
  );
}
