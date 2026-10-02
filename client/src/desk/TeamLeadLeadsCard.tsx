import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { assignTeamLeadLead, getTeamLeadLeads, type TeamLeadLead, type TeamLeadLeadsPage } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { areaPath } from './area';

/**
 * THE LEADS A TEAM LEAD MAY HAND OUT, and who on their team is working each one.
 *
 * Two sources: the Team Lead's own leads, and brokerage leads an Admin shared with them by putting
 * the lead in a CRM team they lead (Leads screen). Assign / Reassign hands a lead to one of the
 * Team Lead's own Active Agents; the owner (Team Lead or brokerage) and the team stay as they were,
 * and only the handling Agent changes. The picker lists exactly what the server allows —
 * the server re-checks every rule before writing, so this is a convenience, not the guard.
 *
 * An Agent who has since been made Inactive stays shown against their leads, marked Inactive, so
 * the Team Lead can see what needs handing to somebody else.
 */
export default function TeamLeadLeadsCard() {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<TeamLeadLeadsPage | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [source, setSource] = useState('');
  const [choice, setChoice] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    getTeamLeadLeads({ page, search: search.trim() || undefined, filter: filter || undefined, source: source || undefined })
      .then(setData)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load your leads'), 'bad'));
  }, [page, search, filter, source, toast]);

  // A short pause while typing, so a search is one request rather than one per key.
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const assign = async (lead: TeamLeadLead) => {
    const agentId = Number(choice[lead.id]);
    if (!agentId) { toast('Choose an agent first', 'bad'); return; }
    setBusy(lead.id);
    try {
      const r = await assignTeamLeadLead(lead.id, agentId);
      toast(`${lead.name} ${lead.assigned_to && !lead.with_team_lead ? 'reassigned' : 'assigned'} to ${r.assigned_name}`, 'ok');
      setChoice((c) => { const n = { ...c }; delete n[lead.id]; return n; });
      load();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not assign this lead'), 'bad');
    } finally { setBusy(null); }
  };

  if (!data) return null;
  const pages = Math.max(1, Math.ceil(data.total / data.per_page));

  return (
    <div className="card">
      <div className="card-h" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h3 style={{ margin: 0 }}>Leads — Assign to My Agents</h3>
          <p className="help" style={{ margin: '3px 0 0' }}>
            Your own leads and leads an Admin assigned to you or shared with your team. The owner never
            changes — the agent you choose is responsible for working the lead. Only your active agents are listed.
          </p>
        </div>
        <select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} style={{ width: 'auto' }} aria-label="Source">
          <option value="">All my leads</option>
          <option value="own">My own leads</option>
          <option value="admin">Assigned by Admin</option>
          <option value="shared">Shared with my team</option>
        </select>
        <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }} style={{ width: 'auto' }} aria-label="Show">
          <option value="">Assigned or not</option>
          <option value="unassigned">Unassigned</option>
          <option value="assigned">Assigned</option>
        </select>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search name, email or phone" aria-label="Search my leads" style={{ width: 220 }} />
      </div>

      {data.agents.length === 0 && (
        <p className="help" style={{ margin: '0 0 8px' }}>
          You have no active agents yet. Create one under <strong>My Team</strong> to start assigning leads.
        </p>
      )}

      <table className="list-table">
        <thead><tr><th>Lead</th><th>Source</th><th>Status</th><th>Assigned Agent</th><th style={{ minWidth: 260 }}>Assign / Reassign</th></tr></thead>
        <tbody>
          {data.leads.length === 0 ? (
            <tr><td colSpan={5} className="help" style={{ padding: 16 }}>
              {search.trim() || filter || source ? 'No lead matches.' : 'You have no leads of your own and none from an Admin yet.'}
            </td></tr>
          ) : data.leads.map((l) => {
            const inactive = !!l.assigned_to && !l.with_team_lead && l.assigned_status !== 'Active';
            const hasAgent = !!l.assigned_to && !l.with_team_lead;
            return (
              <tr key={l.id}>
                <td>
                  <button type="button" className="link" style={{ fontWeight: 600, background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                    onClick={() => navigate(areaPath('crm', `lead/${l.id}`))}>{l.name}</button>
                  <div className="muted" style={{ fontSize: 11.5 }}>{[l.email, l.phone].filter(Boolean).join(' · ') || '—'}</div>
                </td>
                <td>{l.source === 'own'
                  ? <span className="pill ok" style={{ fontSize: 10 }}>Mine</span>
                  : l.source === 'admin'
                    ? <span className="pill info" style={{ fontSize: 10 }} title="Brokerage lead an Admin assigned to you">Assigned by Admin</span>
                    : <span title="Brokerage lead an Admin shared with your team">
                      <span className="pill info" style={{ fontSize: 10 }}>Shared with my team</span>
                      {l.team_name && <div className="muted" style={{ fontSize: 11 }}>{l.team_name}</div>}
                    </span>}</td>
                <td>{l.lead_status ? <span className="pill info" style={{ textTransform: 'capitalize' }}>{l.lead_status}</span> : <span className="muted">—</span>}</td>
                <td>
                  {l.with_team_lead
                    ? <span className="muted">With you — not yet given to an agent</span>
                    : l.assigned_to
                    ? (<>
                      {l.assigned_name ?? `User #${l.assigned_to}`}
                      {inactive && <span className="pill bad" style={{ marginLeft: 6, fontSize: 10 }}>Inactive</span>}
                      {!inactive && !l.assigned_in_team && <span className="pill warn" style={{ marginLeft: 6, fontSize: 10 }}>Not on your team</span>}
                    </>)
                    : <span className="muted">Unassigned</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select value={choice[l.id] ?? ''} onChange={(e) => setChoice((c) => ({ ...c, [l.id]: e.target.value }))}
                      disabled={data.agents.length === 0} aria-label={`Agent for ${l.name}`} style={{ flex: 1 }}>
                      <option value="">Choose an agent…</option>
                      {data.agents.filter((a) => a.id !== l.assigned_to).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <button className="btn primary sm" type="button" disabled={!choice[l.id] || busy === l.id} onClick={() => void assign(l)}>
                      {busy === l.id ? '…' : (hasAgent ? 'Reassign Agent' : 'Assign Agent')}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>Page {data.page} of {pages} · {data.total} leads</span>
          <button className="btn ghost sm" type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <button className="btn ghost sm" type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
