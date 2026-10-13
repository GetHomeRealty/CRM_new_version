import { useEffect, useState } from 'react';
import { requestTransactionEdit } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

/**
 * DOCUMENTATION ASKS FOR A NEW CLOSING DATE; A SUPER ADMIN APPROVES IT.
 *
 * This role cannot write Basic Info, so the Closing Date pencil opens this dialog instead of
 * unlocking the field. It files a `closing_date` edit request carrying the new date; approving it
 * applies the date through the ordinary write path, rejecting it leaves the deal as it is.
 *
 * A dialog rather than an unlocked input on purpose: the detail page auto-saves its form, and this
 * keeps the request entirely outside that path, so nothing else on the page behaves differently.
 */
export default function ClosingDateRequestDialog({ open, onClose, transactionId, current, onSent }: {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  /** The saved closing date, YYYY-MM-DD, or '' when there is none. */
  current: string;
  onSent: () => void;
}) {
  const toast = useToast();
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (open) { setDate(current); setReason(''); setError(''); } }, [open, current]);

  if (!open) return null;

  const unchanged = !date || date === current;
  const send = async () => {
    if (unchanged) { setError('Pick a new closing date first.'); return; }
    if (!reason.trim()) { setError('Give a reason for the change.'); return; }
    setBusy(true);
    setError('');
    try {
      await requestTransactionEdit(transactionId, reason.trim(), 'closing_date', { closing_date: date });
      toast('Closing date change sent to a Super Admin for approval', 'ok');
      onClose();
      onSent();
    } catch (e) {
      // On the dialog, not as a toast: what was typed is still there and this says why it stayed.
      setError(apiErrorMessage(e, 'The request could not be sent'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 60 }} data-testid="closing-date-request-dialog">
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-h">Request closing date change</div>
        <p style={{ fontSize: 13, marginTop: 4 }}>
          A Super Admin reviews this. The closing date stays as it is until they approve it.
        </p>
        <div className="g2" style={{ marginTop: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Current Closing Date</label>
            <input type="date" value={current} disabled data-testid="closing-date-current" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>New Closing Date <span className="req">*</span></label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="closing-date-new" />
          </div>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Reason <span className="req">*</span></label>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="closing-date-reason"
            placeholder="e.g. Builder extended the closing per the amendment" />
        </div>
        {error && <p className="help bad" role="alert" style={{ margin: '4px 0 0' }}>{error}</p>}
        <div className="actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" data-testid="closing-date-submit"
            onClick={() => void send()} disabled={busy || unchanged || !reason.trim()}>
            {busy ? 'Sending…' : 'Send for approval'}
          </button>
        </div>
      </div>
    </div>
  );
}
