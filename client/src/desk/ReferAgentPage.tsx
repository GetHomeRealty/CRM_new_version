import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { referCandidate } from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import { areaPath } from './area';

const EMPTY = { name: '', phone: '', email: '', note: '' };

/**
 * Agent Recruitment → Refer an Agent: an agent passing somebody to the recruitment team.
 *
 * SUBMISSION ONLY. There is no list, no history and no status here, because agents have no access
 * to Recruitment: the server's answer is a confirmation sentence and nothing that identifies the
 * record. The referring agent and the date are taken from the session on the server.
 *
 * AGENTS ONLY. The sidebar shows this to agents alone, and anyone else who reaches the URL is sent
 * to their dashboard. That is a courtesy — the endpoint refuses non-agents on its own.
 */
export default function ReferAgentPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY, v: string) => { setForm((f) => ({ ...f, [k]: v })); setConfirmation(null); };

  if (user?.role !== 'agent') return <Navigate to={areaPath('crm')} replace />;

  const submit = async () => {
    if (!form.name.trim()) { toast('Enter the candidate\'s name.', 'bad'); return; }
    if (!form.phone.trim()) { toast('Enter the candidate\'s phone number.', 'bad'); return; }
    setSaving(true);
    try {
      const res = await referCandidate({
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim() || undefined,
        note: form.note.trim() || undefined,
      });
      setForm(EMPTY);
      setConfirmation(res.message);
      toast(res.message, 'ok');
    } catch (ex) {
      toast(apiErrorMessage(ex, 'The referral could not be sent'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <div className="modal-sub">Refer an Agent</div>
      <p className="help" style={{ marginTop: 0 }}>
        Know somebody who would make a good agent? Send their details and the recruitment team will take it from here.
      </p>
      {confirmation && <p className="help" role="status" style={{ fontSize: 14, color: 'var(--ok-700, #15803d)' }}>✓ {confirmation}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="field"><label htmlFor="ref-name">Candidate name <span className="req">*</span></label>
          <input id="ref-name" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={255} autoFocus /></div>
        <div className="field"><label htmlFor="ref-phone">Phone number <span className="req">*</span></label>
          <input id="ref-phone" type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={64} /></div>
        <div className="field"><label htmlFor="ref-email">Email</label>
          <input id="ref-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} maxLength={255} /></div>
        <div className="field"><label htmlFor="ref-note">Referral note</label>
          <textarea id="ref-note" value={form.note} onChange={(e) => set('note', e.target.value)} maxLength={2000} rows={4}
            placeholder="How you know them, what they are looking for…" /></div>
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn primary" type="submit" disabled={saving}>{saving ? 'Sending…' : 'Submit referral'}</button>
        </div>
      </form>
    </div>
  );
}
