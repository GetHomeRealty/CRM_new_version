import { useEffect, useState } from 'react';
import { requestTransactionEdit } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { formatCurrency, parseNumber } from './format';
import MoneyInput from './MoneyInput';
import { useToast } from './toast';

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * DOCUMENTATION ASKS FOR A NEW PRICE OR DEPOSIT FROM BASIC INFO; A SUPER ADMIN APPROVES IT.
 *
 * The Basic Info twin of ClosingDateRequestDialog, opened by the pencils beside Total Price and
 * Deposit (brokerage request, 2026-10-19). It files the same `commission` edit request the Financial
 * panel's Price/Deposit pencils file — `COMMISSION_PROPOSABLE` on the server already takes `price`
 * and `deposit` — so approving it applies the figures through the ordinary write path and the
 * reviewer sees it where they already review those requests. Only the values that differ from the
 * saved deal are sent.
 */
export default function PriceDepositRequestDialog({ open, onClose, transactionId, priceLabel, currentPrice, currentDeposit, showDeposit, onSent }: {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  /** "Total lease price", "Total Sale Price" or "Total Purchase Price" — as Basic Info labels it. */
  priceLabel: string;
  currentPrice: number | string | null | undefined;
  currentDeposit: number | string | null | undefined;
  /** False on a Referral, which has no deposit. */
  showDeposit: boolean;
  onSent: () => void;
}) {
  const toast = useToast();
  const [price, setPrice] = useState<string>('');
  const [deposit, setDeposit] = useState<string>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const amt = (v: number | string | null | undefined): number => r2(parseNumber(v ?? 0) || 0);

  useEffect(() => {
    if (open) { setPrice(String(currentPrice ?? '')); setDeposit(String(currentDeposit ?? '')); setReason(''); setError(''); }
  }, [open, currentPrice, currentDeposit]);

  if (!open) return null;

  const proposed: Record<string, number> = {};
  if (amt(price) !== amt(currentPrice)) proposed.price = amt(price);
  if (showDeposit && amt(deposit) !== amt(currentDeposit)) proposed.deposit = amt(deposit);
  const unchanged = Object.keys(proposed).length === 0;

  const send = async () => {
    if (unchanged) { setError('Change the price or the deposit first.'); return; }
    if (!reason.trim()) { setError('Give a reason for the change.'); return; }
    setBusy(true);
    setError('');
    try {
      await requestTransactionEdit(transactionId, reason.trim(), 'commission', proposed);
      toast('Change request sent to a Super Admin for approval', 'ok');
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
      <div className="modal" style={{ maxWidth: 480, margin: 0 }} data-testid="price-deposit-request-dialog">
        <div className="modal-h">Request {showDeposit ? 'price / deposit' : 'price'} change</div>
        <p style={{ fontSize: 13, marginTop: 4 }}>
          A Super Admin reviews this. The figures stay as they are until they approve it.
        </p>
        <div className="g2" style={{ marginTop: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{priceLabel}</label>
            <MoneyInput value={price} onChange={setPrice} data-testid="price-request-new" />
            <span className="help">Now: {formatCurrency(amt(currentPrice))}</span>
          </div>
          {showDeposit && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Deposit</label>
              <MoneyInput value={deposit} onChange={setDeposit} data-testid="deposit-request-new" />
              <span className="help">Now: {formatCurrency(amt(currentDeposit))}</span>
            </div>
          )}
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Reason <span className="req">*</span></label>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="price-deposit-reason"
            placeholder="e.g. Amended lease — rent changed to $2,950" />
        </div>
        {error && <p className="help bad" role="alert" style={{ margin: '4px 0 0' }}>{error}</p>}
        <div className="actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" data-testid="price-deposit-submit"
            onClick={() => void send()} disabled={busy || unchanged || !reason.trim()}>
            {busy ? 'Sending…' : 'Send for approval'}
          </button>
        </div>
      </div>
    </div>
  );
}
