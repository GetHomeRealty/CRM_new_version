import { useState } from 'react';
import { changePassword } from '../lib/api';
import { useToast } from './toast';
import PasswordInput from './PasswordInput';
import SavedBadge from './SavedBadge';

export default function ChangePasswordModal({ open, onClose }) {
  const toast = useToast();
  const [form, setForm] = useState({ current_password: '', password: '', password_confirmation: '' });
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  if (!open) return null;

  const save = async () => {
    if (!form.current_password || !form.password) { toast('Please fill all password fields', 'bad'); return; }
    if (form.password !== form.password_confirmation) { toast('New passwords do not match', 'bad'); return; }
    setSaving(true);
    try {
      await changePassword(form);
      setSavedOk(true);
      setTimeout(() => { setSavedOk(false); onClose(); }, 1600);
    } catch (e) {
      const errs = e.response?.data?.errors;
      toast(errs ? Object.values(errs)[0][0] : (e.response?.data?.message || 'Could not change password'), 'bad');
      setSaving(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Change Password</div>
        <div className="field"><label>Current Password <span className="req">*</span></label>
          <PasswordInput value={form.current_password} onChange={(e) => set('current_password', e.target.value)} autoFocus /></div>
        <div className="field"><label>New Password <span className="req">*</span></label>
          <PasswordInput value={form.password} onChange={(e) => set('password', e.target.value)} /></div>
        <div className="field"><label>Confirm New Password <span className="req">*</span></label>
          <PasswordInput value={form.password_confirmation} onChange={(e) => set('password_confirmation', e.target.value)} /></div>
        <span className="help">Use at least 8 characters.</span>
        <SavedBadge show={savedOk} label="Password updated" />
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving || savedOk}>{savedOk ? '✓ Saved' : (saving ? 'Saving…' : 'Update Password')}</button>
        </div>
      </div>
    </div>
  );
}
