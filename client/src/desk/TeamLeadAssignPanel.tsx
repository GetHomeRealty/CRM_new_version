import { useEffect, useState } from 'react';
import { assignTeamLeadLead, getTeamLeadLead, type TeamLeadLead } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';

/**
 * ASSIGN AGENT, on the lead's own page — for the Team Lead.
 *
 * Shown only when the server says this Team Lead may assign this lead: one of their own leads, or a
 * brokerage lead an Admin shared with their team. Everyone else, and every other lead, gets nothing,
 * because the lookup answers not found. The picker is the Team Lead's own Active Agents, and the
 * write goes through the same checked endpoint as the dashboard card, so the lead editor's locks
 * on contact details and source are untouched — only the handling Agent changes.
 */
export default function TeamLeadAssignPanel({ leadId, onAssigned }: { leadId: number; onAssigned: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<{ lead: TeamLeadLead; agents: { id: number; name: string }[] } | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const isTeamLead = !!user?.is_team_lead && !user?.is_super_admin;

  const load = () => {
    if (!isTeamLead) return;
    getTeamLeadLead(leadId).then(setData).catch(() => setData(null));
  };
  useEffect(load, [leadId, isTeamLead]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return null;
  const { lead, agents } = data;
  const hasAgent = !!lead.assigned_to && !lead.with_team_lead;
  const inactive = hasAgent && lead.assigned_status !== 'Active';

  const assign = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      const r = await assignTeamLeadLead(lead.id, Number(choice));
      toast(`${hasAgent ? 'Reassigned' : 'Assigned'} to ${r.assigned_name}`, 'ok');
      setChoice('');
      load();
      onAssigned();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not assign this lead'), 'bad');
    } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 600 }}>
            Assigned Agent:{' '}
            {hasAgent
              ? (lead.assigned_name ?? `User #${lead.assigned_to}`)
              : <span className="muted">{lead.with_team_lead ? 'With you — not yet given to an agent' : 'Unassigned'}</span>}
            {inactive && <span className="pill bad" style={{ marginLeft: 6, fontSize: 10 }}>Inactive</span>}
            <span className={`pill ${lead.source === 'own' ? 'ok' : 'info'}`} style={{ marginLeft: 8, fontSize: 10 }}>
              {lead.source === 'own' ? 'My lead'
                : lead.source === 'admin' ? 'Assigned to me by Admin'
                  : `Shared with my team${lead.team_name ? ` · ${lead.team_name}` : ''}`}
            </span>
          </div>
          <div className="help" style={{ margin: '2px 0 0' }}>
            {agents.length
              ? 'Choose one of your active agents to work this lead. The owner does not change.'
              : 'You have no active agents yet — create one under My Team.'}
          </div>
        </div>
        <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!agents.length}
          aria-label="Agent to assign" style={{ width: 'auto', minWidth: 200 }}>
          <option value="">Choose an agent…</option>
          {agents.filter((a) => a.id !== lead.assigned_to).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button className="btn primary sm" type="button" disabled={!choice || busy} onClick={() => void assign()}>
          {busy ? '…' : (hasAgent ? 'Reassign Agent' : 'Assign Agent')}
        </button>
      </div>
    </div>
  );
}
