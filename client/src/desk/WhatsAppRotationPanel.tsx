import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getWhatsAppRotation, saveWhatsAppRotation, type WhatsAppRotation, type WhatsAppTurn,
} from '../lib/whatsappApi';
import { leadOptions } from '../lib/leadsApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { crmPath } from './area';
import { useToast } from './toast';
import Icon from '../ui/Icon';

type Unit = 'minutes' | 'hours';

interface DraftMember {
  user_id: string;
  amount: string;
  unit: Unit;
  is_active: boolean;
}

/** "Oct 29, 2:00 PM" in the viewer's own time. */
const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
/** "2:00 PM" — the end of a turn that started the same day reads shorter. */
const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const window_ = (t: { starts_at: string; ends_at: string }): string =>
  new Date(t.starts_at).toDateString() === new Date(t.ends_at).toDateString()
    ? `${when(t.starts_at)} – ${clock(t.ends_at)}`
    : `${when(t.starts_at)} – ${when(t.ends_at)}`;
const length = (minutes: number): string =>
  minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} min`;

/** ISO → the value a datetime-local input wants, in the viewer's own time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const toDraft = (r: WhatsAppRotation): DraftMember[] => r.members.map((m) => ({
  user_id: String(m.user_id),
  amount: String(m.duration_minutes % 60 === 0 ? m.duration_minutes / 60 : m.duration_minutes),
  unit: m.duration_minutes % 60 === 0 ? 'hours' : 'minutes',
  is_active: m.is_active,
}));

/**
 * CRM → Settings → WhatsApp Rotation.
 *
 * Every incoming WhatsApp message from a new number becomes a lead and goes, automatically, to
 * whoever is on duty when it arrives. The support team takes turns in the order listed here, each
 * for their own length of time, and starts again from the top after the last person.
 *
 * Administrators only; the server refuses everybody else regardless of what this screen shows.
 */
export default function WhatsAppRotationPanel() {
  const toast = useToast();
  const [data, setData] = useState<WhatsAppRotation | null>(null);
  const [users, setUsers] = useState<{ id: number; name: string; role: string }[]>([]);
  const [members, setMembers] = useState<DraftMember[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [startsAt, setStartsAt] = useState('');
  const [restart, setRestart] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const apply = useCallback((r: WhatsAppRotation) => {
    setData(r);
    setMembers(toDraft(r));
    setEnabled(r.cycle_starts_at ? r.enabled : true);
    setStartsAt(toLocalInput(r.cycle_starts_at));
    setRestart(!r.cycle_starts_at);
  }, []);

  const load = useCallback(async () => {
    try { apply(await getWhatsAppRotation()); } catch (e) {
      toast(apiErrorMessage(e, 'Could not load the WhatsApp rotation'), 'bad');
    }
  }, [apply, toast]);

  useEffect(() => {
    void load();
    // Active users only — the same list the lead form's assignee picker uses.
    leadOptions().then((o) => setUsers(o.users)).catch(() => setUsers([]));
  }, [load]);

  const set = (i: number, patch: Partial<DraftMember>) =>
    setMembers((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const move = (i: number, by: -1 | 1) => setMembers((ms) => {
    const j = i + by;
    if (j < 0 || j >= ms.length) return ms;
    const next = [...ms];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const remove = (i: number) => setMembers((ms) => ms.filter((_, j) => j !== i));
  const add = () => setMembers((ms) => [...ms, { user_id: '', amount: '2', unit: 'hours', is_active: true }]);

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const r = await saveWhatsAppRotation({
        enabled,
        members: members.map((m) => ({
          user_id: Number(m.user_id),
          duration_minutes: Math.round(Number(m.amount) * (m.unit === 'hours' ? 60 : 1)),
          is_active: m.is_active,
        })),
        restart,
        cycle_starts_at: !restart && startsAt ? new Date(startsAt).toISOString() : null,
      });
      apply(r);
      toast('WhatsApp rotation saved', 'ok');
    } catch (e) {
      setErrors(apiFieldErrors(e) ?? {});
      toast(apiErrorMessage(e, 'Could not save the WhatsApp rotation'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const err = (f: string) => errors[f]?.length ? <div className="field-err">{errors[f].join(' ')}</div> : null;
  const taken = new Set(members.map((m) => m.user_id));
  const nameOf = (id: string) => users.find((u) => String(u.id) === id)?.name
    ?? data?.members.find((m) => String(m.user_id) === id)?.name ?? '';
  const memberView = (id: string) => data?.members.find((m) => String(m.user_id) === id);

  if (!data) {
    return <div className="card"><div className="sk sk-line lg" /><div className="sk sk-line md" /></div>;
  }

  const duty: WhatsAppTurn | null = data.on_duty;

  return (
    <>
      <div className="card">
        <div className="card-h">
          <div>
            <h3 style={{ margin: 0 }}>WhatsApp Rotation</h3>
            <p className="help" style={{ margin: '3px 0 0' }}>
              Each new WhatsApp enquiry becomes a lead and is assigned automatically to whoever is <strong>on duty</strong> when
              it arrives. The team below takes turns in this order, each for their own length of time, then it starts again from
              the top. A customer who writes again stays with the person already handling them.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
          {!data.enabled ? (
            <span className="pill neutral">Rotation off — WhatsApp leads arrive unassigned</span>
          ) : duty ? (
            <span className="pill ok"><Icon name="clock" size={12} /> On duty now: <strong>{duty.name}</strong> until {when(duty.ends_at)}</span>
          ) : (
            <span className="pill warn">Nobody on duty — WhatsApp leads arrive unassigned</span>
          )}
          {data.webhook.configured ? (
            <span className="pill ok" title={`Meta webhook URL: <your API address>${data.webhook.path}`}>WhatsApp webhook ready</span>
          ) : (
            <span className="pill warn">WhatsApp webhook not configured on the server</span>
          )}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 10 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Assign WhatsApp leads automatically
        </label>

        {members.length === 0 ? (
          <p className="help">Nobody on the rotation yet. Add the support team members in the order they should take turns.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Turn</th><th>Team member</th><th>Turn length</th><th>Taking turns</th><th /></tr>
              </thead>
              <tbody>
                {members.map((m, i) => {
                  const v = memberView(m.user_id);
                  return (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>
                        <select value={m.user_id} aria-label={`Team member ${i + 1}`} onChange={(e) => set(i, { user_id: e.target.value })}>
                          <option value="">Choose a person…</option>
                          {m.user_id && !users.some((u) => String(u.id) === m.user_id) && <option value={m.user_id}>{nameOf(m.user_id)}</option>}
                          {users.filter((u) => String(u.id) === m.user_id || !taken.has(String(u.id))).map((u) => (
                            <option key={u.id} value={u.id}>{u.name}</option>
                          ))}
                        </select>
                        {v && !v.user_active && <span className="pill warn" style={{ marginLeft: 6 }}>inactive account — skipped</span>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <input type="number" min={1} step={1} value={m.amount} style={{ width: 72 }} aria-label={`Turn length for turn ${i + 1}`}
                          onChange={(e) => set(i, { amount: e.target.value })} />
                        <select value={m.unit} style={{ marginLeft: 6 }} aria-label={`Turn length unit for turn ${i + 1}`}
                          onChange={(e) => set(i, { unit: e.target.value as Unit })}>
                          <option value="minutes">minutes</option>
                          <option value="hours">hours</option>
                        </select>
                      </td>
                      <td>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                          <input type="checkbox" checked={m.is_active} onChange={(e) => set(i, { is_active: e.target.checked })} />
                          {m.is_active ? 'Yes' : 'Paused'}
                        </label>
                      </td>
                      <td className="lead-actions">
                        <button className="icon-btn" type="button" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                        <button className="icon-btn" type="button" title="Move down" aria-label="Move down" disabled={i === members.length - 1} onClick={() => move(i, 1)}>↓</button>
                        <button className="icon-btn" type="button" title="Remove" aria-label="Remove from rotation" onClick={() => remove(i)}>
                          <Icon name="trash" size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {err('members')}

        <button className="btn ghost sm" type="button" onClick={add} style={{ marginTop: 8 }}>
          <Icon name="plus" size={14} /> Add team member
        </button>

        <div className="field" style={{ marginTop: 14, maxWidth: 420 }}>
          <label>First turn starts at</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 6 }}>
            <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
            Start now with the first person in the list
          </label>
          {!restart && (
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          )}
          <div className="help">Turns follow on from this moment, one after another, round and round.</div>
          {err('cycle_starts_at')}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn ghost" type="button" onClick={() => apply(data)} disabled={busy}>Undo changes</button>
          <button className="btn primary" type="button" onClick={() => void save()}
            disabled={busy || members.some((m) => !m.user_id || !(Number(m.amount) > 0))}>
            {busy ? 'Saving…' : 'Save rotation'}
          </button>
        </div>
        {data.updated_at && (
          <p className="help" style={{ textAlign: 'right', margin: '6px 0 0' }}>
            Last saved {when(data.updated_at)}{data.updated_by ? ` by ${data.updated_by}` : ''}
          </p>
        )}
      </div>

      <div className="card">
        <div className="card-h"><h3 style={{ margin: 0 }}>Upcoming turns</h3></div>
        {!data.enabled || data.upcoming.length === 0 ? (
          <p className="help">No turns scheduled. Add at least one active team member and switch the rotation on.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Team member</th><th>On duty</th><th>Length</th></tr></thead>
              <tbody>
                {data.upcoming.map((t, i) => (
                  <tr key={`${t.user_id}-${t.starts_at}`}>
                    <td><strong>{t.name}</strong>{i === 0 && <span className="pill ok" style={{ marginLeft: 6 }}>now</span>}</td>
                    <td>{window_(t)}</td>
                    <td>{length(Math.round((new Date(t.ends_at).getTime() - new Date(t.starts_at).getTime()) / 60000))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-h">
          <h3 style={{ margin: 0 }}>Recent WhatsApp enquiries</h3>
          <button className="btn ghost sm" type="button" onClick={() => void load()}><Icon name="refresh" size={14} /> Refresh</button>
        </div>
        {data.recent.length === 0 ? (
          <p className="help">No WhatsApp messages received yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Received</th><th>Customer</th><th>Message</th><th>Assigned to</th><th>Their turn</th></tr></thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{when(r.received_at)}</td>
                    <td>
                      <Link to={crmPath(`lead/${r.lead_id}`)}>{r.lead_name}</Link>
                      <div className="muted" style={{ fontSize: 12 }}>{r.from_phone}</div>
                      <span className={`pill ${r.is_new_lead ? 'info' : 'neutral'}`}>{r.is_new_lead ? 'New lead' : 'Follow-up'}</span>
                    </td>
                    <td style={{ maxWidth: 320 }}>{r.body}</td>
                    <td>{r.assigned_user_name ?? <span className="muted">Unassigned</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.slot_starts_at && r.slot_ends_at
                        ? window_({ starts_at: r.slot_starts_at, ends_at: r.slot_ends_at })
                        : <span className="muted">{r.is_new_lead ? '—' : 'already handling'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
