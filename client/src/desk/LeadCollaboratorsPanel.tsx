import { useEffect, useState } from 'react';
import api from '../lib/axios';
import { updateLead } from '../lib/leadsApi';
import { apiErrorMessage } from '../lib/apiError';
import type { LeadDetail, LeadOptions } from '../types';

export default function LeadCollaboratorsPanel({ lead, options, canEdit, userId, onChanged, onTransferred }: {
  lead: LeadDetail; options: LeadOptions | null; canEdit: boolean; userId?: number;
  onChanged: () => void; onTransferred: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState('');
  const [recipient, setRecipient] = useState('');
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setSelected(String(lead.assigned_to ?? '')); setError(''); }, [lead.id, lead.assigned_to]);
  const collaborators = lead.collaborators ?? [];
  const mayAssign = canEdit && lead.can_choose_assignment_mode;
  const mayShare = canEdit && lead.can_manage_collaborators;
  const users = options?.users ?? [];
  const candidates = users.filter(u => u.id !== lead.assigned_to && !collaborators.some(c => c.id === u.id));
  const saveAssignment = async () => {
    if (busy || !selected) return;
    if (Number(selected) !== userId && !keep && !window.confirm('Hand this lead over without keeping yourself as a collaborator? Existing ownership and administrator access still apply.')) return;
    setBusy(true); setError('');
    try {
      const result = await updateLead(lead.id, { assigned_to: Number(selected), ...(Number(selected) !== userId ? { assignment_mode: keep ? 'keep' : 'transfer' } : {}) });
      setEditing(false);
      if (result.removed_from_my_leads) onTransferred(); else onChanged();
    } catch (e) { setError(apiErrorMessage(e, 'Could not save assignment.')); }
    finally { setBusy(false); }
  };
  const share = async (id: number, action: 'add' | 'remove') => {
    if (busy) return;
    if (action === 'remove' && !window.confirm('Remove this collaborator? Access granted by their ownership, assignment or admin role will remain.')) return;
    setBusy(true); setError('');
    try {
      await api.put(`/api/leads/${lead.id}/collaborators`, { user_id: id, action });
      setAdding(false); setRecipient(''); onChanged();
    } catch (e) { setError(apiErrorMessage(e, 'Could not update collaborators.')); }
    finally { setBusy(false); }
  };
  return <section className="card" aria-label="Assignment and collaborators" style={{ padding: 18 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><strong>Assigned Agent</strong>{mayAssign && <button className="btn" disabled={busy} aria-expanded={editing} onClick={() => {setEditing(!editing); setKeep(true); setSelected(String(lead.assigned_to ?? ''));}}>{editing ? 'Cancel' : 'Assign / Reassign'}</button>}</div>
    <p style={{ margin: '12px 0' }}>{lead.assigned_to_name ?? 'Unassigned'}</p>
    {editing && <div style={{ display: 'grid', gap: 12, paddingBottom: 16 }}>
      <label htmlFor="lead-card-agent">Select agent</label>
      <select id="lead-card-agent" disabled={busy} value={selected} onChange={e => setSelected(e.target.value)} style={{ width: '100%' }}><option value="">Choose an agent</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      {Number(selected) !== userId && <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" style={{ width: 16, height: 16, flexShrink: 0 }} disabled={busy} checked={keep} onChange={e => setKeep(e.target.checked)} />Keep me as a collaborator</label>}
      <small className="muted">Continue editing and following up on the same lead. Brokerage/admin access stays unchanged.</small>
      <button className="btn primary" disabled={busy || !selected} onClick={() => void saveAssignment()}>{busy ? 'Saving…' : 'Save assignment'}</button>
    </div>}
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><strong>Collaborators ({collaborators.length})</strong>{mayShare && <button className="btn" disabled={busy} aria-label="Add collaborator" aria-expanded={adding} onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : '+ Add'}</button>}</div>
    <p className="muted" style={{ fontSize: 12 }}>Work together on this lead.</p>
    {collaborators.map(c => <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}><div style={{ flex: 1 }}><strong>{c.name}{c.id === userId ? ' (You)' : ''}</strong><div className="muted" style={{ fontSize: 12 }}>Can edit &amp; follow up</div></div>{mayShare && <button className="btn" disabled={busy} aria-label={`Remove ${c.name} as collaborator`} onClick={() => void share(c.id, 'remove')}>×</button>}</div>)}
    {!collaborators.length && <p className="muted">No collaborators added.</p>}
    {adding && <div style={{ display: 'grid', gap: 10, marginTop: 12 }}><label htmlFor="lead-card-collaborator">Add a team member</label><select id="lead-card-collaborator" disabled={busy} value={recipient} onChange={e => setRecipient(e.target.value)}><option value="">Choose a person</option>{candidates.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select><button className="btn primary" disabled={busy || !recipient} onClick={() => void share(Number(recipient), 'add')}>Add collaborator</button></div>}
    {error && <p role="alert" className="field-err">{error}</p>}
  </section>;
}
