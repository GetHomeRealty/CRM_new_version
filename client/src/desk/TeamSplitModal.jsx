import { useState } from 'react';
import { updateTransaction } from '../lib/api';
import { useToast } from './toast';

const blank = (name = '', primary = false) => ({ name, split: primary ? 100 : 0, agent_pct: 90, brok_pct: 10, is_primary: primary, scope: 'Entire', terms: [] });

export default function TeamSplitModal({ open, onClose, transactionId, primaryAgent, initialTeam, agents, isPrecon, termCount = 0, onSaved }) {
  const toast = useToast();
  const seed = () => {
    if (initialTeam && initialTeam.length) return initialTeam.map((m) => ({ ...m }));
    return primaryAgent ? [blank(primaryAgent, true)] : [];
  };
  const [members, setMembers] = useState(seed);
  const [isSplit, setIsSplit] = useState(() => !(initialTeam?.length <= 1));
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const total = members.reduce((s, m) => s + (parseFloat(m.split) || 0), 0);
  const set = (i, k, v) => setMembers((ms) => ms.map((m, idx) => idx === i ? { ...m, [k]: v } : m));
  const add = () => setMembers((ms) => [...ms, blank()]);
  const rm = (i) => setMembers((ms) => ms.filter((_, idx) => idx !== i));
  const toggleTerm = (i, term) => setMembers((ms) => ms.map((m, idx) => {
    if (idx !== i) return m;
    const terms = m.terms || [];
    return { ...m, terms: terms.includes(term) ? terms.filter((x) => x !== term) : [...terms, term] };
  }));

  const save = async () => {
    let team;
    if (!isSplit) {
      team = primaryAgent ? [{ ...blank(primaryAgent, true) }] : [];
    } else {
      team = members
        .map((m, i) => ({ ...m, name: i === 0 && primaryAgent ? primaryAgent : m.name, is_primary: i === 0, split: parseFloat(m.split) || 0, agent_pct: parseFloat(m.agent_pct) || 0, brok_pct: parseFloat(m.brok_pct) || 0 }))
        .filter((m) => m.name);
      const t = team.reduce((s, m) => s + m.split, 0);
      if (Math.round(t * 100) / 100 !== 100) { toast('Total must equal 100% — please adjust', 'bad'); return; }
    }
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, { team });
      toast('Team split saved', 'ok');
      onSaved?.(updated);
      onClose();
    } catch (err) {
      toast(err.response?.data?.message || 'Could not save team split', 'bad');
    } finally { setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Team Split</div>

        <div className="field" style={{ maxWidth: 200 }}>
          <label>Is this a Team Split?</label>
          <select value={isSplit ? 'Yes' : 'No'} onChange={(e) => setIsSplit(e.target.value === 'Yes')}>
            <option>No</option><option>Yes</option>
          </select>
        </div>

        {!isSplit ? (
          <div style={{ padding: 16, background: '#f9fafb', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 14 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
              The single agent assigned in Basic Info{primaryAgent ? <> (<strong>{primaryAgent}</strong>)</> : ''} will receive 100% of the commission.
            </p>
          </div>
        ) : (
          <>
            {members.map((m, i) => (
              <div className="team-card" key={i}>
                {i !== 0 && <button className="row-rm" style={{ position: 'absolute', top: 8, right: 8 }} onClick={() => rm(i)}>🗑️</button>}
                <strong style={{ fontSize: 13 }}>{i === 0 ? 'Primary Agent' : `Team Member ${i + 1}`}{i === 0 && <span className="pill" style={{ fontSize: 9, padding: '2px 6px', marginLeft: 6, background: '#f3f4f6', color: '#6b7280', border: '1px solid #e5e7eb' }}>🔒 Locked</span>}</strong>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Select Agent</label>
                  {i === 0
                    ? <input value={primaryAgent || m.name} readOnly style={{ background: '#f9fafb', cursor: 'not-allowed' }} title="Primary Agent is set in Basic Info" />
                    : <input list="agentList" value={m.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="Search agent..." />}
                  <datalist id="agentList">{(agents || []).map((a) => <option key={a} value={a} />)}</datalist>
                </div>
                <div className="g3">
                  <div className="field" style={{ marginBottom: 0 }}><label>Split %</label>
                    <input type="number" min="0" max="100" value={m.split} onChange={(e) => set(i, 'split', e.target.value)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Agent %</label>
                    <input type="number" min="0" max="100" value={m.agent_pct} onChange={(e) => set(i, 'agent_pct', e.target.value)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Brokerage %</label>
                    <input type="number" min="0" max="100" value={m.brok_pct} onChange={(e) => set(i, 'brok_pct', e.target.value)} /></div>
                </div>
                {isPrecon && (
                  <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                    <label>Split Scope</label>
                    <select value={m.scope || 'Entire'} onChange={(e) => set(i, 'scope', e.target.value)}>
                      <option value="Entire">Entire Transaction</option>
                      <option value="Particular">Particular Terms</option>
                    </select>
                    {m.scope === 'Particular' && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {Array.from({ length: termCount }, (_, k) => k + 1).map((term) => {
                          const on = (m.terms || []).includes(term);
                          return (
                            <label key={term} className={`ms-chip ${on ? 'on' : ''}`}>
                              <input type="checkbox" checked={on} onChange={() => toggleTerm(i, term)} />Term {term}
                            </label>
                          );
                        })}
                        {termCount === 0 && <span className="help" style={{ margin: 0 }}>Set "Commission Receivable in Terms" in Preconstruction Details first.</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            <button className="btn primary sm" onClick={add} style={{ marginBottom: 12 }}>+ Add Team Member</button>
            <div style={{ background: total === 100 ? '#f0fdf4' : '#f0f9ff', border: `1px solid ${total > 100 ? '#fecaca' : (total === 100 ? '#bbf7d0' : '#bae6fd')}`, borderRadius: 10, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Total Split:</strong>
              <span style={{ fontSize: 22, fontWeight: 700, color: total > 100 ? 'var(--bad)' : (total === 100 ? 'var(--ok)' : '#1d4ed8') }}>{total.toFixed(2)}%</span>
            </div>
            {total > 100 && <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6, fontWeight: 600 }}>⚠ Total exceeds 100%. Please adjust.</div>}
          </>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
