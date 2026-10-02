import { useEffect, useMemo, useState } from 'react';
import { crmTeamLookup, setLeadTeamAssignment, type CrmTeamLookup } from '../lib/crmTeamsApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useToast } from './toast';
import type { LeadDetail, LeadOptions } from '../types';

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

/**
 * TEAM & ASSIGNMENT on one lead: who OWNS it, who is HANDLING it, and every change to either.
 *
 * The controls shown are exactly what the server says this viewer may change
 * (`assignment_permissions`): an administrator may move the lead between teams and choose any
 * handler; a team lead may choose, change or clear the handler among the team's active members; an
 * agent sees the facts and the history but no controls. The server applies the same rules again.
 *
 * The Assigned Agent list holds only the selected team's active members — the only people its leads
 * may be handed to.
 */
export default function LeadTeamAssignmentPanel({ lead, options, canEdit, onChanged }: {
  lead: LeadDetail;
  options: LeadOptions | null;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const perms = lead.assignment_permissions ?? { change_team: false, change_agent: false };
  const mayEdit = canEdit && (perms.change_team || perms.change_agent);

  const [lookup, setLookup] = useState<CrmTeamLookup | null>(null);
  const [teamId, setTeamId] = useState<string>(lead.team_id ? String(lead.team_id) : '');
  const [agentId, setAgentId] = useState<string>(lead.assigned_to ? String(lead.assigned_to) : '');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!mayEdit) return;
    crmTeamLookup().then(setLookup).catch(() => setLookup(null));
  }, [mayEdit]);

  // Follow the lead when it reloads after a save.
  useEffect(() => {
    setTeamId(lead.team_id ? String(lead.team_id) : '');
    setAgentId(lead.assigned_to ? String(lead.assigned_to) : '');
    setErrors({});
  }, [lead.team_id, lead.assigned_to]);

  const team = lookup?.teams.find((t) => String(t.id) === teamId) ?? null;

  // Who may be chosen as handler. Within a team: its active members. Without one: any active user,
  // which only an administrator is ever offered (a team lead's lead always has a team).
  const agents = useMemo(() => {
    if (teamId) return (team?.members ?? []).map((m) => ({ id: m.user_id, name: m.name }));
    return (options?.users ?? []).map((u) => ({ id: u.id, name: u.name }));
  }, [teamId, team, options]);

  // Moving to a team the current handler is not in: say so, rather than silently dropping them.
  const agentStillValid = !agentId || agents.some((a) => String(a.id) === agentId);

  const changed = teamId !== (lead.team_id ? String(lead.team_id) : '') || agentId !== (lead.assigned_to ? String(lead.assigned_to) : '');

  const save = async () => {
    setBusy(true);
    setErrors({});
    const body: { team_id?: number | null; assigned_to?: number | null } = {
      assigned_to: agentId && agentStillValid ? Number(agentId) : null,
    };
    if (perms.change_team) body.team_id = teamId ? Number(teamId) : null;
    try {
      await setLeadTeamAssignment(lead.id, body);
      toast('Assignment saved', 'ok');
      onChanged();
    } catch (e) {
      setErrors(apiFieldErrors(e) ?? {});
      toast(apiErrorMessage(e, 'Could not change the assignment'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const owner = lead.ownership_type === 'TEAM' ? lead.team_name ?? 'A team'
    : lead.ownership_type === 'PRIVATE' ? 'Private — the agent’s own lead'
      : 'Brokerage';
  const history = lead.assignment_history ?? [];
  const err = (f: string) => (errors[f]?.length ? <div className="field-err">{errors[f][0]}</div> : null);

  return (
    <div className="card">
      <div className="modal-sub" style={{ marginTop: 0 }}>Team &amp; Assignment</div>
      <dl className="lead-dl">
        <dt>Owner</dt><dd>{owner}</dd>
        <dt>Handled By</dt><dd>{lead.assigned_to_name ?? <span className="muted">Unassigned</span>}</dd>
      </dl>

      {mayEdit && lead.ownership_type !== 'PRIVATE' && (
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr', alignItems: 'end', marginTop: 8 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Team</label>
            {perms.change_team ? (
              <select value={teamId} disabled={busy || !lookup} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">No team — brokerage lead</option>
                {(lookup?.teams ?? [])
                  .filter((t) => t.is_active || String(t.id) === teamId)
                  .map((t) => <option key={t.id} value={t.id}>{t.name}{t.is_active ? '' : ' (inactive)'}</option>)}
              </select>
            ) : (
              <input value={lead.team_name ?? '—'} disabled title="Only an administrator can move a lead to another team." />
            )}
            {err('team_id')}
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Assigned Agent</label>
            <select value={agentStillValid ? agentId : ''} disabled={busy || (!!teamId && !lookup)} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Unassigned</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {err('assigned_to')}
          </div>
          {!agentStillValid && (
            <p className="help" style={{ gridColumn: '1 / -1', margin: 0 }}>
              {lead.assigned_to_name} is not a member of the selected team, so the lead will arrive there unassigned.
            </p>
          )}
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn primary sm" type="button" disabled={busy || !changed} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save assignment'}
            </button>
          </div>
        </div>
      )}
      {lead.ownership_type === 'TEAM' && !mayEdit && (
        <p className="help" style={{ margin: '6px 0 0' }}>The team lead routes this team&rsquo;s leads.</p>
      )}

      <div className="modal-sub">Ownership History</div>
      {history.length === 0 ? (
        <p className="help" style={{ margin: 0 }}>No team or handler changes recorded yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 13 }}>
          {history.map((h) => (
            <li key={h.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
              {h.description}
              <div className="muted" style={{ fontSize: 11 }}>
                {h.actor_name ? `by ${h.actor_name}` : 'by the system'} · {stamp(h.created_at)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
