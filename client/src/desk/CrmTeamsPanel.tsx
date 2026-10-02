import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createCrmTeam, crmTeamActivity, crmTeamReport, deleteCrmTeam, listCrmTeams, updateCrmTeam,
  type CrmTeam, type CrmTeamActivity, type CrmTeamReport,
} from '../lib/crmTeamsApi';
import { leadOptions } from '../lib/leadsApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { crmPath } from './area';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { useToast } from './toast';
import Icon from '../ui/Icon';

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

/** A button that reads as a link — for counts that open the list behind them. */
const LINK = { background: 'none', border: 0, padding: 0, color: 'var(--brand)', cursor: 'pointer', font: 'inherit' } as const;

interface Draft {
  name: string;
  description: string;
  team_lead_user_id: string;
  is_active: boolean;
  member_ids: number[];
}

const EMPTY: Draft = { name: '', description: '', team_lead_user_id: '', is_active: true, member_ids: [] };

/**
 * CRM → Settings → Teams.
 *
 * A team OWNS leads; one of its members may HANDLE each one. This screen manages the teams
 * themselves — name, team lead, members, active or not — and shows how each is doing. Routing an
 * individual lead happens on the lead, in its Team &amp; Assignment card.
 *
 * Administrators only: choosing who is in a team decides whose leads a person can read. The server
 * refuses everybody else regardless of what this screen shows.
 */
export default function CrmTeamsPanel() {
  const toast = useToast();
  const { confirm, askDelete, closeConfirm } = useConfirm();
  const [teams, setTeams] = useState<CrmTeam[] | null>(null);
  const [users, setUsers] = useState<{ id: number; name: string; role: string }[]>([]);
  const [editing, setEditing] = useState<CrmTeam | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [reportKey, setReportKey] = useState(0);

  const load = useCallback(async () => {
    try { setTeams(await listCrmTeams()); } catch (e) {
      toast(apiErrorMessage(e, 'Could not load teams'), 'bad');
      setTeams([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    // Active users only — the same list the lead form's assignee picker uses.
    leadOptions().then((o) => setUsers(o.users)).catch(() => setUsers([]));
  }, [load]);

  const open = (t: CrmTeam | 'new') => {
    setErrors({});
    setEditing(t);
    setDraft(t === 'new' ? EMPTY : {
      name: t.name,
      description: t.description ?? '',
      team_lead_user_id: t.team_lead_user_id ? String(t.team_lead_user_id) : '',
      is_active: t.is_active,
      member_ids: t.members.filter((m) => m.is_active).map((m) => m.user_id),
    });
  };

  const toggleMember = (id: number) => setDraft((d) => ({
    ...d, member_ids: d.member_ids.includes(id) ? d.member_ids.filter((x) => x !== id) : [...d.member_ids, id],
  }));

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setErrors({});
    const body = {
      name: draft.name,
      description: draft.description || null,
      team_lead_user_id: draft.team_lead_user_id ? Number(draft.team_lead_user_id) : null,
      is_active: draft.is_active,
      member_ids: draft.member_ids,
    };
    try {
      if (editing === 'new') await createCrmTeam(body); else await updateCrmTeam(editing.id, body);
      toast(editing === 'new' ? 'Team created' : 'Team saved', 'ok');
      setEditing(null);
      await load();
      setReportKey((k) => k + 1);
    } catch (e) {
      setErrors(apiFieldErrors(e) ?? {});
      toast(apiErrorMessage(e, 'Could not save the team'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const remove = (t: CrmTeam) => askDelete({
    title: `Delete ${t.name}?`,
    message: 'The team and its membership list are removed. Only a team that has never owned a lead can be deleted — otherwise deactivate it.',
    onConfirm: () => {
      deleteCrmTeam(t.id)
        .then(() => { toast('Team deleted', 'ok'); void load(); setReportKey((k) => k + 1); })
        .catch((e) => toast(apiErrorMessage(e, 'Could not delete the team'), 'bad'));
    },
  });

  const err = (f: string) => errors[f]?.length ? <div className="field-err">{errors[f][0]}</div> : null;

  // People who are being removed from the team in this edit, to warn about their leads.
  const leaving = editing && editing !== 'new'
    ? editing.members.filter((m) => m.is_active && !draft.member_ids.includes(m.user_id) && String(m.user_id) !== draft.team_lead_user_id)
    : [];

  return (
    <>
      <div className="card">
        <div className="card-h">
          <div>
            <h3 style={{ margin: 0 }}>Teams</h3>
            <p className="help" style={{ margin: '3px 0 0' }}>
              A team <strong>owns</strong> leads; one of its members can be chosen to <strong>handle</strong> each
              one, or it can wait unassigned for the team lead to route. Changing the handler never changes the
              team. An agent&rsquo;s private leads are never part of a team.
            </p>
          </div>
          <button className="btn primary sm" type="button" onClick={() => open('new')}>
            <Icon name="plus" size={14} /> New team
          </button>
        </div>

        {teams === null ? (
          <div><div className="sk sk-line lg" /><div className="sk sk-line md" /></div>
        ) : teams.length === 0 ? (
          <p className="help">No teams yet. Create one to start giving leads to a team.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Team</th><th>Team Lead</th><th>Members</th><th>Leads</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {teams.map((t) => {
                  const active = t.members.filter((m) => m.is_active);
                  return (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.name}</strong>
                        {t.description && <div className="muted" style={{ fontSize: 12 }}>{t.description}</div>}
                      </td>
                      <td>
                        {t.team_lead_name ?? <span className="muted">None</span>}
                        {t.team_lead_name && !t.team_lead_active && <span className="pill warn" style={{ marginLeft: 6 }}>inactive</span>}
                      </td>
                      <td title={active.map((m) => m.name).join(', ')}>
                        {active.length}
                        {active.some((m) => !m.user_active) && <span className="pill warn" style={{ marginLeft: 6 }}>includes inactive users</span>}
                      </td>
                      <td>{t.lead_count}</td>
                      <td><span className={`pill ${t.is_active ? 'ok' : 'neutral'}`}>{t.is_active ? 'Active' : 'Inactive'}</span></td>
                      <td className="lead-actions">
                        <button className="icon-btn" type="button" title="Edit" aria-label={`Edit ${t.name}`} onClick={() => open(t)}>
                          <Icon name="edit" size={15} />
                        </button>
                        {t.lead_count === 0 && (
                          <button className="icon-btn" type="button" title="Delete" aria-label={`Delete ${t.name}`} onClick={() => remove(t)}>
                            <Icon name="trash" size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <TeamReportCard key={`r${reportKey}`} />
      {teams && teams.length > 0 && <TeamActivityCard teams={teams.map((t) => ({ id: t.id, name: t.name }))} />}

      {editing && (
        <div className="overlay open" onClick={() => !busy && setEditing(null)}>
          <div className="modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              {editing === 'new' ? 'New team' : `Edit ${editing.name}`}
              <button className="close" type="button" onClick={() => setEditing(null)} disabled={busy} aria-label="Close">
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="modal-b">
              <div className="field">
                <label>Team Name</label>
                <input value={draft.name} maxLength={120} placeholder="e.g. Pre-Con East"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                {err('name')}
              </div>
              <div className="field">
                <label>Description <span className="muted">(optional)</span></label>
                <textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                {err('description')}
              </div>
              <div className="field">
                <label>Team Lead</label>
                <select value={draft.team_lead_user_id} onChange={(e) => setDraft({ ...draft, team_lead_user_id: e.target.value })}>
                  <option value="">No team lead</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <div className="help">Sees every lead the team owns and routes them among its members. Added as a member automatically.</div>
                {err('team_lead_user_id')}
              </div>
              <div className="field">
                <label>Team Members</label>
                <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px' }}>
                  {users.map((u) => (
                    <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13, cursor: 'pointer' }}>
                      <input type="checkbox"
                        checked={draft.member_ids.includes(u.id) || String(u.id) === draft.team_lead_user_id}
                        disabled={String(u.id) === draft.team_lead_user_id}
                        onChange={() => toggleMember(u.id)} />
                      {u.name} <span className="muted" style={{ fontSize: 11 }}>{u.role}</span>
                    </label>
                  ))}
                </div>
                {err('member_ids')}
              </div>
              {leaving.length > 0 && (
                <p className="help" style={{ color: 'var(--warn-ink)' }}>
                  Removing {leaving.map((m) => m.name).join(', ')}: any of this team&rsquo;s leads they are handling
                  stay with the team and become unassigned, and they stop seeing the team&rsquo;s leads.
                </p>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />
                Active
              </label>
              {!draft.is_active && (
                <p className="help">An inactive team keeps its leads, but its members stop seeing them through the team and no new leads can be given to it.</p>
              )}
            </div>
            <div className="modal-f">
              <button className="btn ghost" type="button" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
              <button className="btn primary" type="button" onClick={() => void save()} disabled={busy || !draft.name.trim()}>
                {busy ? 'Saving…' : editing === 'new' ? 'Create team' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}

/**
 * Team report: Team Owner, Assigned Agent, totals and conversion — by team and by agent.
 *
 * Owner and handler are shown as the separate things they are. The team's figures count every lead
 * the team OWNS; each agent line counts the leads that agent is HANDLING within it. Administrators
 * see every team; a team lead sees their own (the server decides which).
 */
export function TeamReportCard({ teamId }: { teamId?: number }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [report, setReport] = useState<CrmTeamReport | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    crmTeamReport(teamId).then(setReport).catch((e) => {
      toast(apiErrorMessage(e, 'Could not load the team report'), 'bad');
      setReport({ teams: [], totals: { total: 0, assigned: 0, unassigned: 0, converted: 0, conversion_rate: 0 } });
    });
  }, [teamId, toast]);

  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const openList = (q: Record<string, string | number>) =>
    navigate(`${crmPath('lead')}?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString()}`);

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3 style={{ margin: 0 }}>Team performance</h3>
          <p className="help" style={{ margin: '3px 0 0' }}>
            Team figures count the leads each team <strong>owns</strong>; agent lines count the leads each person
            is <strong>handling</strong>. Reassigning a handler moves a lead between agent lines, never between teams.
          </p>
        </div>
      </div>
      {report === null ? (
        <div className="sk sk-line lg" />
      ) : report.teams.length === 0 ? (
        <p className="help">No teams to report on.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Team Owner</th><th>Team Lead / Assigned Agent</th><th>Total Leads</th><th>Assigned</th>
                <th>Unassigned</th><th>Converted</th><th>Conversion</th>
              </tr>
            </thead>
            <tbody>
              {report.teams.map((t) => (
                <TeamReportRows key={t.team_id} t={t} open={open.has(t.team_id)} onToggle={() => toggle(t.team_id)} onOpen={openList} />
              ))}
            </tbody>
            {report.teams.length > 1 && (
              <tfoot>
                <tr>
                  <th>All teams</th><th />
                  <th>{report.totals.total}</th><th>{report.totals.assigned}</th><th>{report.totals.unassigned}</th>
                  <th>{report.totals.converted}</th><th>{report.totals.conversion_rate}%</th>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

function TeamReportRows({ t, open, onToggle, onOpen }: {
  t: CrmTeamReport['teams'][number]; open: boolean; onToggle: () => void; onOpen: (q: Record<string, string | number>) => void;
}) {
  const link = (n: number, q: Record<string, string | number>) => (
    <button type="button" style={LINK} onClick={() => onOpen({ teamId: t.team_id, ...q })} title="Open these leads">{n}</button>
  );
  return (
    <>
      <tr>
        <td>
          <button type="button" style={LINK} onClick={onToggle} aria-expanded={open}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /> <strong>{t.team_name}</strong>
          </button>
          {!t.is_active && <span className="pill neutral" style={{ marginLeft: 6 }}>inactive</span>}
        </td>
        <td>{t.team_lead_name ?? <span className="muted">No team lead</span>}</td>
        <td>{link(t.total, {})}</td>
        <td>{t.assigned}</td>
        <td>{link(t.unassigned, { assignedTo: 'unassigned' })}</td>
        <td>{link(t.converted, { leadConversion: 'converted' })}</td>
        <td>{t.conversion_rate}%</td>
      </tr>
      {open && (t.agents.length === 0 ? (
        <tr><td /><td colSpan={6} className="muted">Nobody is handling any of this team&rsquo;s leads yet.</td></tr>
      ) : t.agents.map((a) => (
        <tr key={a.user_id} className="muted">
          <td />
          <td>
            {a.name}
            {!a.is_member && <span className="pill warn" style={{ marginLeft: 6 }} title="Handling a lead of this team without being an active member">not a member</span>}
          </td>
          <td />
          <td>{link(a.assigned, { assignedTo: a.user_id })}</td>
          <td />
          <td>{a.converted}</td>
          <td>{a.conversion_rate}%</td>
        </tr>
      )))}
    </>
  );
}

/** What has happened on a team's leads lately, each line naming the person who did it. */
export function TeamActivityCard({ teams }: { teams: { id: number; name: string }[] }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [teamId, setTeamId] = useState<number>(teams[0]?.id ?? 0);
  const [rows, setRows] = useState<CrmTeamActivity[] | null>(null);

  useEffect(() => {
    if (!teamId) return;
    setRows(null);
    crmTeamActivity(teamId).then(setRows).catch((e) => {
      toast(apiErrorMessage(e, 'Could not load team activity'), 'bad');
      setRows([]);
    });
  }, [teamId, toast]);

  const ICON: Record<string, string> = useMemo(() => ({ assignment: 'users', note: 'file', call: 'phone', task: 'calendar' }), []);

  return (
    <div className="card">
      <div className="card-h">
        <h3 style={{ margin: 0 }}>Team activity</h3>
        {teams.length > 1 && (
          <select value={teamId} onChange={(e) => setTeamId(Number(e.target.value))} aria-label="Team">
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
      </div>
      {rows === null ? (
        <div className="sk sk-line lg" />
      ) : rows.length === 0 ? (
        <p className="help">Nothing has happened on this team&rsquo;s leads yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r, i) => (
            <li key={`${r.type}-${r.lead_id}-${i}`} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
              <Icon name={ICON[r.type] ?? 'info'} size={14} />
              <div style={{ flex: 1 }}>
                <strong>{r.actor}</strong> {r.summary}{' '}
                <button type="button" style={LINK} onClick={() => navigate(crmPath(`lead/${r.lead_id}`))}>{r.lead_name}</button>
              </div>
              <span className="muted" style={{ whiteSpace: 'nowrap' }}>{stamp(r.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
