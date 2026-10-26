import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/axios';
import { apiErrorMessage } from '../lib/apiError';
import { deskPath } from './area';

/**
 * MY TEAM (Sai, 25 Oct 2026) - a Documentation / Accounting Team Lead's own team on the Dashboard:
 * each member with their requests waiting and the open deals they handle, the team's waiting
 * requests (each opens the deal, where the lead can approve or reject it), and each member's history.
 */
type Member = { id: number; name: string; is_lead: boolean; requests_waiting: number; open_deals_handled: number };
type Waiting = { id: number; transaction_id: number; trade_no: string | null; property: string | null; scope: string | null; requested_by_name: string | null; reason: string | null; stamp: string | null };
type Team = { team: string; members: Member[]; waiting: Waiting[] };
type HistoryRow = { id: number; at: string | null; section: string | null; field: string | null; action: string | null; old: string | null; new: string | null; transaction_id: number | null; trade_no: string | null; property: string | null };

const day = (v: string | null) => (v ? new Date(v).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export default function MyTeamCard() {
  const navigate = useNavigate();
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<{ member: Member; rows: HistoryRow[] | null } | null>(null);

  useEffect(() => {
    api.get<{ data: Team }>('/api/desk-team/mine').then((r) => setTeam(r.data.data)).catch((e) => setError(apiErrorMessage(e, 'Could not load your team.')));
  }, []);

  const openHistory = (m: Member) => {
    setHistory({ member: m, rows: null });
    api.get<{ data: HistoryRow[] }>(`/api/desk-team/history/${m.id}`)
      .then((r) => setHistory({ member: m, rows: r.data.data }))
      .catch(() => setHistory({ member: m, rows: [] }));
  };
  const openDeal = (id: number | null) => { if (id) navigate(`${deskPath(`transactions/${id}`)}?section=approvals`); };

  if (error) return <div className="card"><div className="modal-h" style={{ fontSize: 14 }}>My team</div><p className="help bad">{error}</p></div>;
  if (!team) return null;
  const th = { textAlign: 'left' as const, fontSize: 11.5, color: 'var(--muted)', padding: '6px 8px', borderBottom: '1px solid var(--line)' };
  const td = { padding: '7px 8px', fontSize: 13, borderBottom: '1px solid var(--surface-3)' };

  return (
    <div className="card" data-testid="my-team">
      <div className="modal-h" style={{ fontSize: 14 }}>My team - {team.team}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>Person</th><th style={th}>Requests waiting</th><th style={th}>Open deals they handle</th><th style={th}></th></tr></thead>
        <tbody>
          {team.members.map((m) => (
            <tr key={m.id}>
              <td style={td}>{m.name}{m.is_lead ? <span className="pill info" style={{ marginLeft: 6, fontSize: 10.5 }}>Team Lead</span> : null}</td>
              <td style={td}>{m.requests_waiting}</td>
              <td style={td}>{m.open_deals_handled}</td>
              <td style={{ ...td, textAlign: 'right' }}><button className="btn ghost sm" type="button" onClick={() => openHistory(m)}>History</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="modal-sub" style={{ marginTop: 14 }}>Requests waiting for you ({team.waiting.length})</div>
      {team.waiting.length === 0
        ? <p className="help">Nothing waiting. When someone in your team asks for a change, it shows here and in your bell.</p>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {team.waiting.map((w) => (
              <button key={w.id} type="button" className="btn ghost" style={{ justifyContent: 'space-between', textAlign: 'left' }} onClick={() => openDeal(w.transaction_id)}>
                <span><strong>{w.requested_by_name || 'Someone'}</strong> - {w.scope ? w.scope.replace(/_/g, ' ') : 'edit'} on {w.trade_no ? `#${w.trade_no} ` : ''}{w.property || ''}{w.reason ? ` - ${w.reason}` : ''}</span>
                <span className="muted" style={{ fontSize: 11.5 }}>{day(w.stamp)}</span>
              </button>
            ))}
          </div>
        )}

      {history && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) setHistory(null); }}>
          <div className="modal lg" style={{ maxHeight: '88vh', overflowY: 'auto' }}>
            <button className="close" onClick={() => setHistory(null)}>✕</button>
            <div className="modal-h">History - {history.member.name}</div>
            {history.rows === null && <p className="help">Loading…</p>}
            {history.rows?.length === 0 && <p className="help">No changes recorded.</p>}
            {!!history.rows?.length && (
              <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="team-history">
                <thead><tr><th style={th}>When</th><th style={th}>Deal</th><th style={th}>What</th><th style={th}>From</th><th style={th}>To</th></tr></thead>
                <tbody>
                  {history.rows.map((r) => (
                    <tr key={r.id} style={{ cursor: r.transaction_id ? 'pointer' : 'default' }} onClick={() => r.transaction_id && navigate(deskPath(`transactions/${r.transaction_id}`))}>
                      <td style={td}>{day(r.at)}</td>
                      <td style={td}>{r.trade_no ? `#${r.trade_no} ` : ''}{r.property || ''}</td>
                      <td style={td}>{[r.section, r.field].filter(Boolean).join(' - ')}{r.action && r.action !== 'Updated' ? ` (${r.action})` : ''}</td>
                      <td style={td}>{r.old || ''}</td>
                      <td style={td}>{r.new || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="actions"><button className="btn ghost" onClick={() => setHistory(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
