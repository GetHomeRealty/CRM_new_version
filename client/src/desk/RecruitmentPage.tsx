import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { crmPath } from './area';
import {
  createCandidate, listCandidates, pendingFollowups, recruitmentStats,
} from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import {
  CANDIDATE_STATUSES, type Candidate, type CandidateStatus, type PendingFollowups,
  type RecruitmentStats,
} from '../types/recruitment';

/** Not Selected is two words everywhere a person reads it; the underscore is a column name. */
export function statusLabel(s: string): string {
  return s === 'not_selected' ? 'Not Selected' : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The pill colour carries meaning, so it follows the OUTCOME rather than the order of the list.
 * Approved and Active are good news, Not Selected is an ending, Hold is neither.
 */
export function statusPill(s: string): string {
  if (s === 'active' || s === 'approved') return 'pill ok';
  if (s === 'not_selected') return 'pill bad';
  if (s === 'hold') return 'pill warn';
  return 'pill info';
}

const date = (v: string | null): string => (v ? new Date(v).toLocaleDateString() : '—');
const dateTime = (v: string | null): string => (v ? new Date(v).toLocaleString() : '—');

type Tab = 'candidates' | 'interviews' | 'reports';

/**
 * A blank add-candidate form.
 *
 * EMPTY STRINGS, NOT NULLS. The form speaks in form values; the server reads an empty string as
 * "not provided" and stores NULL, which is the one place that translation belongs. Declared out here
 * so resetting the form after a save and initialising it are literally the same value.
 */
const BLANK_CANDIDATE = {
  name: '', email: '', phone: '', location: '', source: '',
  has_real_estate_experience: '', years_experience: '', is_licensed: '',
  licence_number: '', brokerage_name: '', availability: '', training_needs: '',
};

/**
 * Recruitment & Interview.
 *
 * WHAT THE SCREEN SHOWS IS NOT WHAT PROTECTS THE DATA. Everything here is filtered by what the
 * server already decided: a recruiter's list contains their own candidates because the API returns
 * only those, not because this page filters them. Hiding a control is a courtesy — it keeps people
 * from pressing something that will be refused — and the refusal is what actually holds.
 */
export default function RecruitmentPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can, isAdminOrAbove } = useAuth();
  const [params, setParams] = useSearchParams();

  const canEdit = can('recruitment', 'edit');
  /** Approval and account creation. `recruitment.decide` is admin and manager — Super Admin and Admin. */
  const canDecide = isAdminOrAbove;

  const tab = (params.get('tab') as Tab) || 'candidates';
  const setTab = (next: Tab) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    p.set('tab', next);
    return p;
  }, { replace: true });

  const [stats, setStats] = useState<RecruitmentStats | null>(null);
  const [rows, setRows] = useState<Candidate[]>([]);
  const [due, setDue] = useState<PendingFollowups | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Filters. `status` lives in the URL so a filtered list can be linked and survives a reload.
  const status = params.get('status') ?? '';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [recruiter, setRecruiter] = useState('');
  const [source, setSource] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, list, f] = await Promise.all([recruitmentStats(), listCandidates({ status, q: params.get('q') ?? '' }), pendingFollowups()]);
      setStats(s);
      setRows(list.data);
      setDue(f);
      setError('');
    } catch (ex) {
      // Said here rather than in a toast: a screen with no data must explain itself, and a toast
      // disappears before somebody who stepped away can read it.
      setError(apiErrorMessage(ex, 'Could not load recruitment'));
      setRows([]);
      setStats(null);
    } finally {
      setLoaded(true);
    }
  }, [status, params]);

  useEffect(() => { void load(); }, [load]);

  /*
   * Recruiter and source are filtered HERE because the list arrives already scoped and capped at
   * 200 rows — narrowing it further is a question about what is on screen, not a new question for
   * the server. Status and search go to the API, because those decide which rows exist at all.
   */
  const visible = useMemo(() => rows.filter((r) => {
    if (recruiter && String(r.assigned_recruiter_id ?? '') !== recruiter) return false;
    if (source && (r.source ?? '') !== source) return false;
    return true;
  }), [rows, recruiter, source]);

  const recruiters = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.assigned_recruiter_id == null) { seen.set('', 'Unassigned'); continue; }
      seen.set(String(r.assigned_recruiter_id), r.assigned_recruiter_name ?? `User #${r.assigned_recruiter_id}`);
    }
    return [...seen.entries()];
  }, [rows]);

  const sources = useMemo(() => [...new Set(rows.map((r) => r.source).filter((v): v is string => !!v))], [rows]);

  const applySearch = (value: string) => {
    setSearch(value);
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (value) p.set('q', value); else p.delete('q');
      return p;
    }, { replace: true });
  };

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(BLANK_CANDIDATE);

  const add = async () => {
    if (!form.name.trim() || !form.email.trim()) {
      toast('A candidate needs a name and an email address.', 'bad');
      return;
    }
    setBusy(true);
    try {
      const res = await createCandidate(form);
      toast(`${res.data.name} added.`, 'ok');
      setAdding(false);
      setForm(BLANK_CANDIDATE);
      navigate(crmPath(`recruitment/${res.data.id}`));
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not add the candidate'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const interviewsSoon = useMemo(
    () => rows.filter((r) => r.status === 'interview').length,
    [rows],
  );

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="meta-title">Recruitment</h2>
            <p className="help" style={{ marginTop: 2 }}>
              Candidates applying to join the brokerage, from first contact to an agent account.
            </p>
          </div>
          {canEdit && (
            <button className="btn primary" type="button" onClick={() => setAdding(true)}>+ Add Candidate</button>
          )}
        </div>
      </div>

      {/* The pipeline at a glance. Figures come from the API already scoped to what you may see. */}
      <div className="stat-grid">
        <Stat label="Total Candidates" value={stats?.total ?? 0} />
        <Stat label="New" value={stats?.candidates.new ?? 0} />
        <Stat label="Interviews Scheduled" value={stats?.interviews.scheduled ?? 0} />
        <Stat label="Approved" value={stats?.candidates.approved ?? 0} />
        <Stat label="Onboarding" value={stats?.candidates.onboarding ?? 0} />
        <Stat label="Active / Joined" value={stats?.candidates.active ?? 0} />
        <Stat label="Hold" value={stats?.candidates.hold ?? 0} />
        <Stat label="Not Selected" value={stats?.candidates.not_selected ?? 0} />
      </div>

      {!!due?.overdue && (
        <div className="card meta-alert warn">
          <strong>{due.overdue} follow-up{due.overdue === 1 ? '' : 's'} overdue.</strong>{' '}
          <button className="prop-link" type="button" onClick={() => setTab('interviews')}>See what is due</button>
        </div>
      )}

      <div className="toolbar-row" style={{ gap: 8, marginBottom: 12 }}>
        {(['candidates', 'interviews', 'reports'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? 'btn primary sm' : 'btn ghost sm'}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t === 'candidates' ? 'Candidates' : t === 'interviews' ? 'Interviews' : 'Reports'}
          </button>
        ))}
      </div>

      {error ? (
        <div className="card"><p className="help bad">{error}</p></div>
      ) : !loaded ? (
        <div className="card"><p className="help">Loading recruitment…</p></div>
      ) : tab === 'candidates' ? (
        <div className="card">
          <div className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <input
              placeholder="Search name, email or phone"
              value={search}
              onChange={(e) => applySearch(e.target.value)}
              style={{ minWidth: 220 }}
            />
            <select
              value={status}
              onChange={(e) => setParams((prev) => {
                const p = new URLSearchParams(prev);
                if (e.target.value) p.set('status', e.target.value); else p.delete('status');
                return p;
              }, { replace: true })}
            >
              <option value="">Every status</option>
              {CANDIDATE_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
            <select value={recruiter} onChange={(e) => setRecruiter(e.target.value)}>
              <option value="">Every recruiter</option>
              {recruiters.map(([id, name]) => <option key={id || 'none'} value={id}>{name}</option>)}
            </select>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Every source</option>
              {sources.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {(status || search || recruiter || source) && (
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => { setRecruiter(''); setSource(''); setSearch(''); setParams({}, { replace: true }); }}
              >
                Clear filters
              </button>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="help">
              {rows.length === 0
                ? 'No candidates yet. Add the first one and the pipeline starts here.'
                : 'No candidate matches these filters.'}
            </p>
          ) : (
            <div className="lead-scroll">
              <table className="list-table">
                <thead>
                  <tr>
                    <th>Name</th><th>Contact</th><th>Recruiter</th><th>Status</th>
                    <th>Source</th><th>Added</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        {c.agent_user_id && <div className="muted">Agent account active</div>}
                      </td>
                      <td>
                        <div>{c.email}</div>
                        <div className="muted">{c.phone || 'No phone'}</div>
                      </td>
                      {/* Resolved by the server on each row, so no directory is needed here. */}
                      <td>{c.assigned_recruiter_name ?? 'Unassigned'}</td>
                      <td>
                        <span className={statusPill(c.status)}>{statusLabel(c.status)}</span>
                        {/* The recruiter's advice, shown as advice and never as a decision. */}
                        {c.recommendation && !c.approved_at && (
                          <div className="muted">Recommended: {statusLabel(c.recommendation)}</div>
                        )}
                      </td>
                      <td>{c.source || '—'}</td>
                      <td>{date(c.created_at)}</td>
                      <td>
                        <button className="btn ghost sm" type="button" onClick={() => navigate(crmPath(`recruitment/${c.id}`))}>Open</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : tab === 'interviews' ? (
        <div className="card">
          <div className="modal-sub">Interviews and what is due</div>
          <div className="stat-grid" style={{ marginBottom: 12 }}>
            <Stat label="Scheduled" value={stats?.interviews.scheduled ?? 0} />
            <Stat label="Completed" value={stats?.interviews.completed ?? 0} />
            <Stat label="At interview stage" value={interviewsSoon} />
            <Stat label="Follow-ups overdue" value={due?.overdue ?? 0} />
          </div>

          {!due || due.data.length === 0 ? (
            <p className="help">Nothing outstanding. Follow-ups you add on a candidate appear here.</p>
          ) : (
            <div className="lead-scroll">
              <table className="list-table">
                <thead><tr><th>Due</th><th>Follow-up</th><th>Candidate</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {due.data.map((f) => {
                    const overdue = new Date(f.due_at) < new Date();
                    return (
                      <tr key={f.id}>
                        <td>
                          {dateTime(f.due_at)}
                          {overdue && <div><span className="pill bad">Overdue</span></div>}
                        </td>
                        <td>{f.title}</td>
                        <td>{f.candidate.name}</td>
                        <td><span className={statusPill(f.candidate.status)}>{statusLabel(f.candidate.status)}</span></td>
                        <td>
                          <button className="btn ghost sm" type="button" onClick={() => navigate(crmPath(`recruitment/${f.candidate.id}`))}>Open</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="g2">
          <div className="card">
            <div className="modal-sub">Candidates by status</div>
            <table className="list-table">
              <tbody>
                {CANDIDATE_STATUSES.map((s) => (
                  <tr key={s}>
                    <td><span className={statusPill(s)}>{statusLabel(s)}</span></td>
                    <td style={{ textAlign: 'right' }}>{stats?.candidates[s as CandidateStatus] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="modal-sub" style={{ marginTop: 16 }}>Interviews</div>
            <table className="list-table">
              <tbody>
                {(['scheduled', 'completed', 'approved', 'hold', 'not_selected'] as const).map((s) => (
                  <tr key={s}>
                    <td>{statusLabel(s)}</td>
                    <td style={{ textAlign: 'right' }}>{stats?.interviews[s] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="modal-sub">Candidates by recruiter</div>
            {!stats || stats.by_recruiter.length === 0 ? (
              <p className="help">Nothing to report yet.</p>
            ) : (
              <table className="list-table">
                <tbody>
                  {stats.by_recruiter.map((r) => (
                    <tr key={r.recruiter_id ?? 'none'}>
                      <td>{r.name}</td>
                      <td style={{ textAlign: 'right' }}>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="modal-sub" style={{ marginTop: 16 }}>Where candidates came from</div>
            {!stats || stats.by_source.length === 0 ? (
              <p className="help">No sources recorded yet.</p>
            ) : (
              <table className="list-table">
                <tbody>
                  {stats.by_source.map((r) => (
                    <tr key={r.source}>
                      <td>{r.source}</td>
                      <td style={{ textAlign: 'right' }}>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {!canDecide && (
              <p className="help" style={{ marginTop: 12 }}>
                These figures cover the candidates assigned to you.
              </p>
            )}
          </div>
        </div>
      )}

      {adding && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) setAdding(false); }}>
          <div className="modal">
            <button className="close" type="button" onClick={() => setAdding(false)} aria-label="Close">✕</button>
            <div className="modal-h">Add a candidate</div>
            <div className="g2">
              <div className="field">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="field">
                <label>Email *</label>
                <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="field">
                <label>Phone</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="field">
                <label>Location</label>
                <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Source</label>
              <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                <option value="">Not recorded</option>
                <option value="referral">Referral</option>
                <option value="website">Website</option>
                <option value="walk-in">Walk-in</option>
                <option value="agency">Agency</option>
                <option value="other">Other</option>
              </select>
            </div>

            {/*
              * ALL OPTIONAL, AND BLANK BY DEFAULT. A recruiter taking a name down over the phone has
              * not asked any of this yet, and a blank field records that honestly — whereas a
              * dropdown defaulting to "No" would record an answer nobody gave.
              */}
            <div className="modal-sub" style={{ marginTop: 10 }}>Experience &amp; licence</div>
            <div className="g2">
              <div className="field">
                <label>Real estate experience</label>
                <select
                  value={form.has_real_estate_experience}
                  onChange={(e) => setForm({ ...form, has_real_estate_experience: e.target.value })}
                >
                  <option value="">Not asked</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
              <div className="field">
                <label>Years of experience</label>
                <input
                  type="number"
                  min={0}
                  max={80}
                  value={form.years_experience}
                  onChange={(e) => setForm({ ...form, years_experience: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Licensed</label>
                <select value={form.is_licensed} onChange={(e) => setForm({ ...form, is_licensed: e.target.value })}>
                  <option value="">Not asked</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
              <div className="field">
                <label>Licence number</label>
                <input
                  value={form.licence_number}
                  onChange={(e) => setForm({ ...form, licence_number: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Brokerage (current or previous)</label>
                <input
                  value={form.brokerage_name}
                  onChange={(e) => setForm({ ...form, brokerage_name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Availability</label>
                <select value={form.availability} onChange={(e) => setForm({ ...form, availability: e.target.value })}>
                  <option value="">Not asked</option>
                  <option value="full_time">Full time</option>
                  <option value="part_time">Part time</option>
                  <option value="flexible">Flexible</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>Training needs</label>
              <textarea
                rows={2}
                value={form.training_needs}
                onChange={(e) => setForm({ ...form, training_needs: e.target.value })}
              />
            </div>

            <p className="help">
              Adding a candidate creates a recruitment record only. It does not create an account and
              gives nobody access to anything.
            </p>
            <div className="toolbar-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" type="button" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn primary" type="button" disabled={busy} onClick={() => void add()}>
                {busy ? 'Adding…' : 'Add candidate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card meta-stat">
      <div className="meta-stat-n">{value}</div>
      <div className="muted">{label}</div>
    </div>
  );
}
