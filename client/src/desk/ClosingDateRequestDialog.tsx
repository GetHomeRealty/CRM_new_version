import { useEffect, useState } from 'react';
import { requestTransactionEdit } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

/**
 * The Basic Info fields this dialog can ask for. Closing Date first (Documentation, then
 * Accounting); Offer Date and the MLS number joined on 2026-10-22 for Accounting. Each is its own
 * request scope on the server, named after the field, so the wording, input and test ids below are
 * all that differ.
 */
const DATE_FIELDS = {
  closing_date: { label: 'Closing Date', lower: 'closing date', testid: 'closing-date', input: 'date', toast: 'Closing date', example: 'e.g. Builder extended the closing per the amendment' },
  offer_date: { label: 'Offer Date', lower: 'offer date', testid: 'offer-date', input: 'date', toast: 'Offer date', example: 'e.g. Offer date entered wrong; the signed APS is dated 28 Aug' },
  mls_num: { label: 'MLS #', lower: 'MLS number', testid: 'mls-num', input: 'text', toast: 'MLS number', example: 'e.g. MLS number corrected to match the listing' },
} as const;

/**
 * DOCUMENTATION ASKS FOR A NEW CLOSING DATE; A SUPER ADMIN APPROVES IT.
 *
 * This role cannot write Basic Info, so the Closing Date pencil opens this dialog instead of
 * unlocking the field. It files a `closing_date` edit request carrying the new date; approving it
 * applies the date through the ordinary write path, rejecting it leaves the deal as it is.
 * Accounting's Offer Date pencil opens the same dialog with `field="offer_date"`.
 *
 * A dialog rather than an unlocked input on purpose: the detail page auto-saves its form, and this
 * keeps the request entirely outside that path, so nothing else on the page behaves differently.
 */
export default function ClosingDateRequestDialog({ open, onClose, transactionId, current, onSent, field = 'closing_date' }: {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  /** The saved date, YYYY-MM-DD, or '' when there is none. */
  current: string;
  onSent: () => void;
  /** Which date is being asked for. Closing Date unless said otherwise. */
  field?: keyof typeof DATE_FIELDS;
}) {
  const toast = useToast();
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const f = DATE_FIELDS[field];

  useEffect(() => { if (open) { setDate(current); setReason(''); setError(''); } }, [open, current]);

  if (!open) return null;

  const unchanged = !date.trim() || date.trim() === current;
  const send = async () => {
    if (unchanged) { setError(`${f.input === 'date' ? 'Pick' : 'Enter'} a new ${f.lower} first.`); return; }
    if (!reason.trim()) { setError('Give a reason for the change.'); return; }
    setBusy(true);
    setError('');
    try {
      await requestTransactionEdit(transactionId, reason.trim(), field, { [field]: date.trim() });
      toast(`${f.toast} change sent to a Super Admin for approval`, 'ok');
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
    <div className="overlay open" style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" style={{ maxWidth: 460, margin: 0 }} data-testid={`${f.testid}-request-dialog`}>
        <div className="modal-h">Request {f.lower} change</div>
        <p style={{ fontSize: 13, marginTop: 4 }}>
          A Super Admin reviews this. The {f.lower} stays as it is until they approve it.
        </p>
        <div className="g2" style={{ marginTop: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Current {f.label}</label>
            <input type={f.input} value={current} disabled data-testid={`${f.testid}-current`} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>New {f.label} <span className="req">*</span></label>
            <input type={f.input} value={date} data-testid={`${f.testid}-new`}
              onChange={(e) => setDate(f.input === 'text' ? e.target.value.toUpperCase() : e.target.value)} />
          </div>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Reason <span className="req">*</span></label>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`${f.testid}-reason`}
            placeholder={f.example} />
        </div>
        {error && <p className="help bad" role="alert" style={{ margin: '4px 0 0' }}>{error}</p>}
        <div className="actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" data-testid={`${f.testid}-submit`}
            onClick={() => void send()} disabled={busy || unchanged || !reason.trim()}>
            {busy ? 'Sending…' : 'Send for approval'}
          </button>
        </div>
      </div>
    </div>
  );
}
