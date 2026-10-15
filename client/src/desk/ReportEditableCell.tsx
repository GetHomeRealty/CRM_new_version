import { useState } from 'react';
import { getTransaction, updateTransaction } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { roleLabel } from './format';
import { useToast } from './toast';
import type { ReportColumn } from '../types';

/**
 * Cells a report lets you edit in place (Pending Payments: Validation Status, Accounting Remarks).
 *
 * EVERY SAVE GOES THROUGH THE ORDINARY TRANSACTION UPDATE, so the same permissions, audit trail and
 * server rules apply as in the deal's own panels. Those panels save their whole JSON object, so the
 * deal is read fresh, ONE field changed, and the object written back — nothing else in the panel
 * is touched.
 */

export const VALIDATION_OPTIONS = ['Done', 'Pending', 'Invalid'];

type Row = Record<string, string | number | null>;
type Json = Record<string, unknown>;

/** Agent Payment Readiness → Final Validation, with the panel's rule for Ready to Process. */
async function saveFinalValidation(txnId: number, value: string): Promise<void> {
  const txn = await getTransaction(txnId) as unknown as { activity_tracker?: Json | null };
  const tracker: Json = { ...(txn.activity_tracker ?? {}) };
  tracker.final_validation = value;
  // As in the panel: Done → ready to process; anything else → not. N/A (nothing to pay) is kept.
  if (tracker.ready_to_process !== 'N/A') tracker.ready_to_process = value === 'Done' ? 'Yes' : 'No';
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
  // A preconstruction deal keeps these per term; the report cannot say which term to change.
  const perTerm = row.type === 'Preconstruction';
  const allowed = canEdit && Number.isInteger(txnId) && txnId > 0 && !perTerm;

  const run = async (fn: () => Promise<void>, value: string) => {
    setSaving(true);
    try {
      await fn();
      onSaved(value);
      setEditing(false);
      toast('Saved', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  if (column.edit === 'final_validation') {
    if (!allowed) return <span title={perTerm ? 'Set per term in Agent Payment Readiness' : undefined}>{current || '—'}</span>;
    return (
      <select value={VALIDATION_OPTIONS.includes(current) ? current : ''} disabled={saving} aria-label="Validation Status"
        style={{ minWidth: 104, padding: '4px 6px', fontSize: 12.5 }}
        onChange={(e) => { const v = e.target.value; if (v && v !== current) void run(() => saveFinalValidation(txnId, v), v); }}>
        {!VALIDATION_OPTIONS.includes(current) && <option value="">{current || 'Select'}</option>}
        {VALIDATION_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }

  // accounting_remarks
  if (editing) {
    return (
      <div style={{ display: 'grid', gap: 4, minWidth: 180 }}>
        <textarea rows={2} value={draft} autoFocus disabled={saving} placeholder="Add a remark…"
          onChange={(e) => setDraft(e.target.value)} style={{ fontSize: 12.5 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="btn primary sm" disabled={saving || !draft.trim()}
            onClick={() => void run(() => addAccountingRemark(txnId, draft.trim(), user ?? {}), draft.trim())}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn ghost sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <span style={{ flex: 1, whiteSpace: 'pre-line' }}>{current || '—'}</span>
      {allowed && (
        <button type="button" className="btn ghost sm" title="Add an accounting remark" aria-label="Add an accounting remark"
          style={{ padding: '2px 6px' }} onClick={() => { setDraft(''); setEditing(true); }}>✎</button>
      )}
    </div>
  );
}
