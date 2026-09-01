import { useEffect, useState } from 'react';
import { updateTransaction, getAgentCommissions } from '../lib/api';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import SavedBadge from './SavedBadge';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import type { AgentCommissionMap, TeamMemberData, Transaction } from '../types';

// agent_pct/brok_pct start null → the backend fills them from the agent's registered
// User profile split, and they're only overridden via Financial Information.
// access: 'full' → same edit rights as the primary agent; 'docs' → upload docs only.
const blank = (name = '', primary = false): TeamMemberData => ({ name, split: primary ? 100 : 0, agent_pct: null, brok_pct: null, is_primary: primary, access: primary ? 'full' : 'docs', scope: 'Entire', terms: [] });
const clampPct = (n: number | string | null | undefined): number => Math.max(0, Math.min(100, Number.isFinite(Number(n)) ? Number(n) : 0));

/** Keys of a member that the split-editor UI can change (agent/brok are paired). */
type EditableMemberKey = 'name' | 'split' | 'agent_pct' | 'brok_pct' | 'access' | 'scope';

interface TeamSplitModalProps {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  primaryAgent?: string | null;
  initialTeam?: TeamMemberData[] | null;
  agents?: string[];
  isPrecon?: boolean;
  isLease?: boolean;
  termCount?: number;
  onSaved?: (updated: Transaction) => void;
  readOnly?: boolean;
  lockAgents?: boolean;
  isAgent?: boolean;
  canManageAccess?: boolean;
}

export default function TeamSplitModal({ open, onClose, transactionId, primaryAgent, initialTeam, agents, isPrecon, isLease = false, termCount = 0, onSaved, readOnly = false, lockAgents = false, isAgent = false, canManageAccess = false }: TeamSplitModalProps) {
  const toast = useToast();
  const seed = (): TeamMemberData[] => {
    if (initialTeam && initialTeam.length) return initialTeam.map((m) => ({ ...m }));
    return primaryAgent ? [blank(primaryAgent, true)] : [];
  };
  const [members, setMembers] = useState<TeamMemberData[]>(seed);
  // Preserve the original JS default: `!(initialTeam?.length <= 1)` — with no team,
  // `undefined <= 1` is false, so isSplit defaults to true.
  const [isSplit, setIsSplit] = useState<boolean>(() => { const n = initialTeam?.length; return !(n !== undefined && n <= 1); });
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false); // §3.2 — show "Saved" briefly, then auto-close
  const [agentComm, setAgentComm] = useState<AgentCommissionMap>({}); // registered agent splits (User profiles)
  const { confirm, askDelete, closeConfirm } = useConfirm();

  useEffect(() => { if (open) getAgentCommissions().then(setAgentComm).catch(() => {}); }, [open]);

  if (!open) return null;

  // Registered Agent % for a name (lease deals use the lease %); 90/95 fallback.
  const splitFor = (name: string): number => {
    const d = agentComm[name];
    const v = d ? (isLease ? d.lease_pct : d.agent_pct) : null;
    return (v === null || v === undefined) ? (isLease ? 95 : 90) : v;
  };

  // §Team Splits — enabling a split resets every agent (incl. primary) to 0%.
  const onToggleSplit = (yes: boolean) => {
    setIsSplit(yes);
    if (yes) {
      setMembers((ms) => {
        const base = ms.length ? ms : (primaryAgent ? [blank(primaryAgent, true)] : []);
        return base.map((m) => ({ ...m, split: 0 }));
      });
    }
  };

  const total = members.reduce((s, m) => s + (parseFloat(String(m.split)) || 0), 0);
  // Agent % and Brokerage % are complementary — editing one fills the remainder.
  const set = (i: number, k: EditableMemberKey, v: string) => setMembers((ms) => ms.map((m, idx) => {
    if (idx !== i) return m;
    if (k === 'agent_pct') return { ...m, agent_pct: v, brok_pct: clampPct(100 - clampPct(v)) };
    if (k === 'brok_pct') return { ...m, brok_pct: v, agent_pct: clampPct(100 - clampPct(v)) };
    return { ...m, [k]: v };
  }));
  const add = () => setMembers((ms) => [...ms, blank()]);
  const rm = (i: number) => askDelete({
    title: 'Delete team member?',
    message: `Remove team member "${members[i]?.name || `#${i + 1}`}" from the split?`,
    linked: [
      'Commission splits & per-agent totals in Financial Information',
      'Agent breakdown / per-agent status in Agent Payment Readiness',
      'Signatories on the Notice of Sale',
    ],
    note: 'Remaining splits may no longer total 100% — adjust before saving.',
    onConfirm: () => setMembers((ms) => ms.filter((_, idx) => idx !== i)),
  });
  const toggleTerm = (i: number, term: number) => setMembers((ms) => ms.map((m, idx) => {
    if (idx !== i) return m;
    const terms = m.terms || [];
    return { ...m, terms: terms.includes(term) ? terms.filter((x) => x !== term) : [...terms, term] };
  }));

  const save = async () => {
    let team: TeamMemberData[];
    if (!isSplit) {
      team = primaryAgent ? [{ ...blank(primaryAgent, true) }] : [];
      // §3.2 — a single-agent transaction still needs that agent present.
      if (!team.length) { window.alert('Missing required block — Team Split:\n\nNo agent is assigned. Set the Agent in Basic Info, or enable a Team Split and add agents totalling 100%.'); return; }
    } else {
      // Keep agent_pct/brok_pct null when unset so the backend applies the agent's
      // registered split; an explicit (Financial) value is preserved.
      const pct = (v: number | string | null | undefined): number | null => (v === null || v === undefined || v === '' ? null : (parseFloat(String(v)) || 0));
      team = members
        .map((m, i): TeamMemberData => ({ ...m, name: i === 0 && primaryAgent ? primaryAgent : m.name, is_primary: i === 0, access: i === 0 ? 'full' : (m.access || 'docs'), split: parseFloat(String(m.split)) || 0, agent_pct: pct(m.agent_pct), brok_pct: pct(m.brok_pct) }))
        .filter((m) => m.name);
      // §Team Splits / §3.2 — block empty or incomplete splits with an explanatory pop-up.
      if (!team.length) { window.alert('Missing required block — Team Split:\n\nA team split is enabled but no agents are added. Add at least one agent and make the splits total 100%.'); return; }
      // No agent may appear more than once in the split.
      const names = team.map((m) => m.name.trim().toLowerCase());
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) { window.alert('Duplicate agent in Team Split:\n\nEach agent can be added only once. Please remove the repeated agent before saving.'); return; }
      const t = team.reduce((s, m) => s + (Number(m.split) || 0), 0);
      if (Math.round(t * 100) / 100 !== 100) { window.alert(`Incomplete Team Split:\n\nThe split percentages currently total ${Math.round(t * 100) / 100}%. They must total exactly 100% before saving.`); return; }
    }
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, { team });
      onSaved?.(updated);
      // §3.2 — show "Saved" for a short delay, then auto-close.
      setSavedOk(true);
      setTimeout(() => { setSavedOk(false); onClose(); }, 2000);
    } catch (err) {
      toast(apiErrorMessage(err, 'Could not save team split'), 'bad');
      setSaving(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Team Split</div>

        {readOnly && !isAgent && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: 'var(--info-bg)', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--info-ink)' }}>🔒 View-only — click <strong>Edit</strong> on the transaction to make changes.</span>
          </div>
        )}
        {!readOnly && lockAgents && (
          <div className="card" style={{ borderLeft: '4px solid #d97706', background: 'var(--warn-bg-2)', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--warn-900)' }}>🔒 Notice of Sale has been sent for signing — team-split agents can no longer be added, removed or renamed.</span>
          </div>
        )}

        <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>

        <div className="field" style={{ maxWidth: 200 }}>
          <label>Is this a Team Split?</label>
          <select value={isSplit ? 'Yes' : 'No'} disabled={lockAgents} onChange={(e) => onToggleSplit(e.target.value === 'Yes')}>
            <option>No</option><option>Yes</option>
          </select>
        </div>

        {!isSplit ? (
          <div style={{ padding: 16, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 14 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
              The single agent assigned in Basic Info{primaryAgent ? <> (<strong>{primaryAgent}</strong>)</> : ''} will receive 100% of the commission.
            </p>
          </div>
        ) : (
          <>
            {members.map((m, i) => (
              <div className="team-card" key={i}>
                {i !== 0 && !lockAgents && <button className="row-rm" style={{ position: 'absolute', top: 8, right: 8 }} onClick={() => rm(i)}>🗑️</button>}
                <strong style={{ fontSize: 13 }}>{i === 0 ? 'Primary Agent' : `Team Member ${i + 1}`}{i === 0 && <span className="pill" style={{ fontSize: 9, padding: '2px 6px', marginLeft: 6, background: 'var(--surface-3)', color: '#6b7280', border: '1px solid var(--line)' }}>🔒 Locked</span>}</strong>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Select Agent</label>
                  {i === 0
                    ? <input value={primaryAgent || m.name} readOnly style={{ background: 'var(--surface-2)', cursor: 'not-allowed' }} title="Primary Agent is set in Basic Info" />
                    : <input list={`agentList-${i}`} value={m.name} disabled={lockAgents} onChange={(e) => set(i, 'name', e.target.value)} placeholder="Search agent..." />}
                  {/* Exclude agents already chosen in other rows so a member can't be added twice. */}
                  <datalist id={`agentList-${i}`}>{(agents || []).filter((a) => a === m.name || !members.some((x, idx) => idx !== i && x.name === a)).map((a) => <option key={a} value={a} />)}</datalist>
                </div>
                <div className="g3">
                  <div className="field" style={{ marginBottom: 0 }}><label>Split %</label>
                    <input type="number" min="0" max="100" value={m.split ?? ''} onChange={(e) => set(i, 'split', e.target.value)} /></div>
                  {/* Agent % / Brokerage % come from the agent's registered split and are
                      only changed under Financial Information → Agent Commission. Read-only here. */}
                  <div className="field" style={{ marginBottom: 0 }}><label>Agent %</label>
                    <input type="number" value={m.agent_pct ?? splitFor(i === 0 ? (primaryAgent || m.name) : m.name)} readOnly style={{ background: 'var(--surface-2)', cursor: 'not-allowed' }} title="Editable under Financial Information → Agent Commission" /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Brokerage %</label>
                    <input type="number" value={m.brok_pct ?? (100 - splitFor(i === 0 ? (primaryAgent || m.name) : m.name))} readOnly style={{ background: 'var(--surface-2)', cursor: 'not-allowed' }} title="Editable under Financial Information → Agent Commission" /></div>
                </div>
                {/* Portal access — 'Full' gives this member the same edit rights as the
                    primary agent; 'Docs only' limits them to uploading documents. The
                    primary agent is always Full. Visible/editable only to the primary
                    agent or an admin — hidden from other team members. */}
                {i !== 0 && canManageAccess && (
                  <div className="field" style={{ marginTop: 10, marginBottom: 0, maxWidth: 260 }}>
                    <label>Portal Access</label>
                    <select value={m.access || 'docs'} disabled={lockAgents} onChange={(e) => set(i, 'access', e.target.value)}>
                      <option value="docs">Docs only (upload documents)</option>
                      <option value="full">Full access (edit like primary)</option>
                    </select>
                    <span className="help">Full access lets this agent edit Basic Info, Lawyer &amp; Team Split — same as the primary agent.</span>
                  </div>
                )}
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
            {/* §Team Splits — once the split totals 100% (or agents are locked), no more agents can be added. */}
            {!lockAgents && total < 100 && <button className="btn primary sm" onClick={add} style={{ marginBottom: 12 }}>+ Add Team Member</button>}
            <div style={{ background: total === 100 ? 'var(--ok-bg)' : '#f0f9ff', border: `1px solid ${total > 100 ? 'var(--bad-ring)' : (total === 100 ? 'var(--ok-ring-2)' : '#bae6fd')}`, borderRadius: 10, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Total Split:</strong>
              <span style={{ fontSize: 22, fontWeight: 700, color: total > 100 ? 'var(--bad)' : (total === 100 ? 'var(--ok)' : 'var(--info-700)') }}>{total.toFixed(2)}%</span>
            </div>
            {total > 100 && <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6, fontWeight: 600 }}>⚠ Total exceeds 100%. Please adjust.</div>}
          </>
        )}

        </fieldset>

        <SavedBadge show={savedOk} />

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {!readOnly && <button className="btn primary" onClick={save} disabled={saving || savedOk}>{savedOk ? '✓ Saved' : (saving ? 'Saving…' : 'Save')}</button>}
        </div>
      </div>
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </div>
  );
}
