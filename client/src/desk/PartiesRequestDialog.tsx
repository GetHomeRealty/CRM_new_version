import { useEffect, useState } from 'react';
import { requestTransactionEdit } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import Icon from '../ui/Icon';
import { useToast } from './toast';

export interface PartyBrokerage { name: string; address: string; email: string; invoice_email: string; agent_email: string; phone: string; agents: string[]; }
export interface PartyClient { name: string; email: string | null; phone: string | null; }

/**
 * DOCUMENTATION AND ACCOUNTING ASK FOR BROKERAGE OR CLIENT CHANGES; A SUPER ADMIN APPROVES THEM.
 *
 * Brokerage request, 2026-10-22: the Listing / Co-op Brokerage Information and Client Information
 * cards stopped saving directly for these two roles (the server drops them from a save) and are
 * proposed instead, like Price. The pencil on each card opens this dialog with a copy of the card;
 * Send files a 'brokerage' or 'clients' edit request carrying the whole card, which approval writes
 * through the ordinary save path.
 *
 * A dialog for the same reason as ClosingDateRequestDialog: the detail page auto-saves its form, and
 * keeping the edit outside that path means nothing else on the page behaves differently.
 */
export default function PartiesRequestDialog({ open, onClose, transactionId, scope, brokLabel, currentBrokerage, currentClients, onSent }: {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  scope: 'brokerage' | 'clients';
  /** "Listing" or "Co-op", as the card heading says. */
  brokLabel: string;
  currentBrokerage: PartyBrokerage;
  currentClients: PartyClient[];
  onSent: () => void;
}) {
  const toast = useToast();
  const [brok, setBrok] = useState<PartyBrokerage>(currentBrokerage);
  const [clients, setClients] = useState<PartyClient[]>(currentClients);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setBrok({ ...currentBrokerage, agents: currentBrokerage.agents.length ? [...currentBrokerage.agents] : [''] });
    setClients(currentClients.map((c) => ({ ...c })));
    setReason('');
    setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const title = scope === 'brokerage' ? `${brokLabel} Brokerage Information` : 'Client Information';
  const setB = <K extends keyof PartyBrokerage>(k: K, v: PartyBrokerage[K]) => setBrok((b) => ({ ...b, [k]: v }));
  const setC = (i: number, k: keyof PartyClient, v: string) => setClients((cs) => cs.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)));

  const send = async () => {
    if (!reason.trim()) { setError('Give a reason for the change.'); return; }
    if (scope === 'clients') {
      const unnamed = clients.findIndex((c) => !c.name.trim());
      if (unnamed >= 0) { setError(`Client ${unnamed + 1} needs a name.`); return; }
    }
    setBusy(true);
    setError('');
    try {
      const proposed = scope === 'brokerage'
        ? { brokerage: { ...brok, agents: brok.agents.map((a) => a.trim()).filter(Boolean) } }
        : { clients: clients.map((c) => ({ name: c.name.trim(), email: (c.email || '').trim() || null, phone: (c.phone || '').trim() || null })) };
      await requestTransactionEdit(transactionId, reason.trim(), scope, proposed);
      toast(`${scope === 'brokerage' ? 'Brokerage' : 'Client'} change sent to a Super Admin for approval`, 'ok');
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
      <div className="modal" style={{ maxWidth: 760, width: 'calc(100% - 32px)', margin: 0, maxHeight: '90vh', overflowY: 'auto' }} data-testid={`${scope}-request-dialog`}>
        <div className="modal-h">Request change: {title}</div>
        <p style={{ fontSize: 13, marginTop: 4 }}>
          A Super Admin reviews this. The card stays as it is until they approve it.
        </p>

        {scope === 'brokerage' ? (
          <>
            <div className="field"><label>{brokLabel} Brokerage Name</label>
              <input value={brok.name} onChange={(e) => setB('name', e.target.value)} data-testid="brokerage-req-name" /></div>
            <div className="field" style={{ marginBottom: 6 }}><label>{brokLabel} Agent Name(s)</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {brok.agents.map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: 4 }}>
                    <input value={a} onChange={(e) => setB('agents', brok.agents.map((x, idx) => (idx === i ? e.target.value : x)))} placeholder="Agent name..." style={{ minWidth: 0 }} />
                    {brok.agents.length > 1 && (
                      <button type="button" className="row-rm" aria-label={`Remove agent ${i + 1}`} onClick={() => setB('agents', brok.agents.filter((_, idx) => idx !== i))}><Icon name="trash" size={13} /></button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <button type="button" className="btn primary sm" style={{ marginBottom: 12 }} onClick={() => setB('agents', [...brok.agents, ''])}>+ Add Agent</button>
            <div className="field"><label>Brokerage Address</label><input value={brok.address} onChange={(e) => setB('address', e.target.value)} /></div>
            <div className="g2">
              <div className="field"><label>Brokerage Email</label><input type="email" value={brok.email} onChange={(e) => setB('email', e.target.value)} /></div>
              <div className="field"><label>Invoice Email</label><input type="email" value={brok.invoice_email} onChange={(e) => setB('invoice_email', e.target.value)} /></div>
              <div className="field"><label>Agent Email</label><input type="email" value={brok.agent_email} onChange={(e) => setB('agent_email', e.target.value)} /></div>
              <div className="field"><label>Phone Number</label><input value={brok.phone} onChange={(e) => setB('phone', e.target.value)} placeholder="+1 000-000-0000" /></div>
            </div>
          </>
        ) : (
          <>
            {clients.length === 0 && <div className="help" style={{ marginBottom: 8 }}>No clients. Add one below.</div>}
            {clients.map((c, i) => (
              <div key={i} className="g3" style={{ alignItems: 'end', marginBottom: 8 }}>
                <div className="field" style={{ marginBottom: 0 }}><label>Full Name <span className="req">*</span></label>
                  <input value={c.name} onChange={(e) => setC(i, 'name', e.target.value)} data-testid={`client-req-name-${i}`} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label>Email</label><input type="email" value={c.email || ''} onChange={(e) => setC(i, 'email', e.target.value)} /></div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}>
                  <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 0 }}><label>Phone</label><input value={c.phone || ''} onChange={(e) => setC(i, 'phone', e.target.value)} placeholder="+1 000-000-0000" /></div>
                  <button type="button" className="row-rm" style={{ paddingBottom: 10 }} aria-label={`Remove client ${i + 1}`} onClick={() => setClients((cs) => cs.filter((_, idx) => idx !== i))}><Icon name="trash" size={13} /></button>
                </div>
              </div>
            ))}
            <button type="button" className="btn primary sm" style={{ marginBottom: 12 }} onClick={() => setClients((cs) => [...cs, { name: '', email: null, phone: null }])}>+ Add Client</button>
          </>
        )}

        <div className="field" style={{ marginTop: 6 }}>
          <label>Reason <span className="req">*</span></label>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`${scope}-req-reason`}
            placeholder={scope === 'brokerage' ? 'e.g. Co-op brokerage name corrected per the APS' : 'e.g. Second buyer added per the amendment'} />
        </div>
        {error && <p className="help bad" role="alert" style={{ margin: '4px 0 0' }}>{error}</p>}
        <div className="actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" data-testid={`${scope}-req-submit`} onClick={() => void send()} disabled={busy || !reason.trim()}>
            {busy ? 'Sending…' : 'Send for approval'}
          </button>
        </div>
      </div>
    </div>
  );
}
