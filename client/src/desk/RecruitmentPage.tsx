import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { crmPath } from './area';
import {
  createCandidate, listCandidates, listInterviews, pendingFollowups, recruitmentStats,
} from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import RecruitmentSendMail from './RecruitmentSendMail';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import {
  CANDIDATE_STATUSES, INTERVIEW_STATUSES, type Candidate, type CandidateStatus, type InterviewList,
  type PendingFollowups, type RecruitmentStats,
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

  /*
   * Filters, ALL in the URL — status, recruiter, source and search — so a drill-down from a card or a
   * Reports row can be linked, survives a reload and tab switches, and is applied by the SERVER under
   * the same visibility scope the counts use. That is what makes a count equal the list it opens.
   *   recruiter: a user id, or `none` (unassigned).  source: a stored value, or `__none__` (not recorded).
   */
  const status = params.get('status') ?? '';
  const recruiter = params.get('recruiter') ?? '';
  const source = params.get('source') ?? '';
  const [search, setSearch] = useState(params.get('q') ?? '');
  // The page is in the URL too, so a refresh or Back keeps your place; any filter change resets it.
  const page = Math.max(1, Number(params.get('page')) || 1);
  // Optional `per_page` in the URL; absent means the server's default of 50.
  const perPage = Number(params.get('per_page')) || undefined;
  const [listMeta, setListMeta] = useState({ total: 0, page: 1, per_page: 50, last_page: 1 });
  /** Which filter the rows on screen were loaded for — so a card can wait for ITS list before scrolling. */
  const [listFor, setListFor] = useState<string | null>(null);
  const listTotal = listMeta.total;
  const goToPage = (n: number) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (n > 1) p.set('page', String(n)); else p.delete('page');
    return p;
  }, { replace: false });

  const setFilter = (key: 'status' | 'recruiter' | 'source', value: string) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    p.set('tab', 'candidates');
    p.delete('page');
    if (value) p.set(key, value); else p.delete(key);
    return p;
  }, { replace: true });

  const load = useCallback(async () => {
    try {
      const [s, list, f] = await Promise.all([
        recruitmentStats(),
        listCandidates({ status, q: params.get('q') ?? '', recruiter, source, page, perPage }),
        pendingFollowups(),
      ]);
      setStats(s);
      setRows(list.data);
      setListMeta({ total: list.total, page: list.page, per_page: list.per_page, last_page: list.last_page });
      setListFor(listKey(status, recruiter, source, params.get('q') ?? '', page));
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
  }, [status, recruiter, source, page, perPage, params]);

  useEffect(() => { void load(); }, [load]);

  // Every filter is applied by the server now, so what arrived is what is shown.
  const visible = rows;

  /*
   * The filter choices come from the REPORT figures, not from the rows on screen: a filtered list
   * contains only one recruiter, and options derived from it would vanish the moment one was picked.
   * A selected value the report does not list (a stale link) is still shown, so it stays visible.
   */
  const recruiters = useMemo(() => {
    const list: [string, string][] = (stats?.by_recruiter ?? []).map((r) => [r.key, r.name]);
    if (recruiter && !list.some(([k]) => k === recruiter)) list.push([recruiter, recruiter === 'none' ? 'Unassigned' : `Recruiter #${recruiter}`]);
    return list;
  }, [stats, recruiter]);

  const sources = useMemo(() => {
    const list: [string, string][] = (stats?.by_source ?? []).map((r) => [r.key, sourceLabel(r.source)]);
    if (source && !list.some(([k]) => k === source)) list.push([source, source === '__none__' ? 'Not recorded' : sourceLabel(source)]);
    return list;
  }, [stats, source]);

  /** A Reports row → Candidates showing exactly the candidates that row counted. */
  const openFiltered = (key: 'recruiter' | 'source', value: string) => {
    setSearch('');
    setParams(() => new URLSearchParams({ tab: 'candidates', [key]: value }), { replace: true });
  };

  /*
   * WHERE EACH CARD GOES. A candidate card opens Candidates filtered to that status (Total: every
   * status); an interview card opens Interviews filtered to that interview status. Every other filter
   * is cleared on the way, so the list shown is exactly what the card counted.
   */
  const openCandidates = (s: string) => {
    setSearch('');
    setParams(() => {
      const p = new URLSearchParams({ tab: 'candidates' });
      if (s) p.set('status', s);
      return p;
    }, { replace: true });
    requestScroll('candidates', s);
  };
  const openInterviews = (s: string) => {
    // A different list is coming: wait for it rather than scrolling to the one still on screen.
    if (tab !== 'interviews' || istatus !== s) setInterviewFor(null);
    setParams(() => new URLSearchParams({ tab: 'interviews', istatus: s }), { replace: true });
    requestScroll('interviews', s);
  };

  /*
   * THE CARD TAKES YOU TO ITS LIST. Each click records a request with a fresh number, so clicking
   * the same card again scrolls again even though no filter changed. The effect further down waits
   * until the destination list has rendered FOR THAT FILTER — an empty one included — and only then
   * scrolls, so the view never lands on a loading line that the rows then push off the screen.
   */
  const scrollSeq = useRef(0);
  const [scrollReq, setScrollReq] = useState<{ target: 'candidates' | 'interviews'; value: string; n: number } | null>(null);
  const requestScroll = (target: 'candidates' | 'interviews', value: string) => {
    scrollSeq.current += 1;
    setScrollReq({ target, value, n: scrollSeq.current });
  };

  /*
   * THE FOUR CARDS UNDER "Interviews and what is due", which differ from the cards above in one
   * way: they are PUSHED rather than replaced, so Back undoes the drill-down and returns to the
   * overview the card was read from. Replacing the entry — which the cards on the main grid do —
   * leaves Back to exit Recruitment entirely, and somebody who clicked a card to check a figure has
   * no way back to the figures.
   *
   * Every parameter is rebuilt from nothing, so no filter left over from an earlier drill-down can
   * narrow the destination below what the card counted. That is what keeps a count equal to the
   * list it opens.
   */
  const drillTo = (next: Record<string, string>) => {
    setSearch('');
    setParams(() => new URLSearchParams(next), { replace: false });
  };

  /*
   * Which follow-ups the section below shows: every pending one, or only the overdue. In the URL so
   * a refresh and Back both land on what was being looked at.
   */
  const dueFilter = params.get('due') ?? '';
  const setDueFilter = (v: string) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (v) p.set('due', v); else p.delete('due');
    // The scroll has already happened; keeping it would re-scroll on every later change.
    p.delete('focus');
    return p;
  }, { replace: true });

  // The Interviews list: across every candidate you may see, by the INTERVIEW's own status.
  const istatus = params.get('istatus') ?? '';
  const [interviewList, setInterviewList] = useState<InterviewList | null>(null);
  /** Which interview status the list on screen was loaded for (null while a new one is coming). */
  const [interviewFor, setInterviewFor] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'interviews') return;
    listInterviews(istatus).then((list) => {
      setInterviewList(list);
      setInterviewFor(istatus);
    }).catch((ex) => {
      setInterviewList(null);
      setInterviewFor(istatus);
      toast(apiErrorMessage(ex, 'Could not load interviews'), 'bad');
    });
  }, [tab, istatus, toast]);

  const applySearch = (value: string) => {
    setSearch(value);
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.delete('page');
      if (value) p.set('q', value); else p.delete('q');
      return p;
    }, { replace: true });
  };

  /*
   * Which candidate the composer is open for, by id. Held here rather than per row so that closing
   * it and reopening on another candidate cannot leave two composers mounted at once.
   */
  const [mailing, setMailing] = useState<number | null>(null);

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

  // From the scoped counts, not from the rows on screen — those may carry a drill-down filter.
  const interviewsSoon = stats?.candidates.interview ?? 0;

  /**
   * The follow-ups the section shows.
   *
   * THE OVERDUE ONES ARE THE FIRST `due.overdue` ROWS, and taking them by position rather than
   * re-testing each date against the clock is deliberate. The server sorts by `due_at` ascending
   * and counts overdue as `due_at < now` using ITS clock, so the overdue ones are exactly the
   * leading rows. Re-testing here would use the BROWSER's clock, a little later and possibly skewed,
   * and a follow-up falling due between the two readings would make the list disagree with the card
   * that opened it. Slicing cannot disagree.
   */
  const followupRows = useMemo(() => {
    if (!due) return [];
    return dueFilter === 'overdue' ? due.data.slice(0, due.overdue) : due.data;
  }, [due, dueFilter]);

  /*
   * Arriving at a section, rather than at the top of a page that happens to contain it. A card sits
   * above both lists, so without this the filter applied correctly and left the person looking at
   * the same cards, with the answer somewhere below the fold.
   */
  const focus = params.get('focus') ?? '';
  const interviewsRef = useRef<HTMLDivElement | null>(null);
  const followupsRef = useRef<HTMLDivElement | null>(null);
  const scrolledFor = useRef('');

  const candidatesRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!scrollReq) return;
    if (error) { setScrollReq(null); return; }
    const ready = scrollReq.target === 'candidates'
      ? tab === 'candidates' && loaded && listFor === listKey(scrollReq.value, '', '', '', 1)
      : tab === 'interviews' && interviewFor === scrollReq.value;
    if (!ready) return;
    const el = scrollReq.target === 'candidates' ? candidatesRef.current : interviewsRef.current;
    if (!el) return;
    setScrollReq(null);
    // After the browser has laid the list out, so its position is the final one.
    requestAnimationFrame(() => scrollToSection(el));
  }, [scrollReq, error, tab, loaded, listFor, interviewFor]);

  useEffect(() => {
    if (!focus) { scrolledFor.current = ''; return; }
    // Once per destination. Re-scrolling on every later render would fight anybody who had
    // deliberately scrolled away while reading.
    const key = `${focus}:${istatus}:${dueFilter}`;
    if (scrolledFor.current === key) return;
    /*
     * WAITS FOR THE DATA. Scrolling to "Loading interviews…" puts the view where one line is, and
     * the rows then arrive underneath and push the section back off the screen.
     */
    if (focus === 'interviews' ? !interviewList : !due) return;
    scrolledFor.current = key;
    const el = focus === 'interviews' ? interviewsRef.current : followupsRef.current;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus, istatus, dueFilter, interviewList, due]);

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
        {/* Each card opens the list it counts. */}
        <Stat label="Total Candidates" value={stats?.total ?? 0} onOpen={() => openCandidates('')} />
        <Stat label="New" value={stats?.candidates.new ?? 0} onOpen={() => openCandidates('new')} />
        <Stat label="Contacted" value={stats?.candidates.contacted ?? 0} onOpen={() => openCandidates('contacted')} />
        <Stat label="Interview" value={stats?.candidates.interview ?? 0} onOpen={() => openCandidates('interview')} />
        <Stat label="Approved" value={stats?.candidates.approved ?? 0} onOpen={() => openCandidates('approved')} />
        <Stat label="Onboarding" value={stats?.candidates.onboarding ?? 0} onOpen={() => openCandidates('onboarding')} />
        <Stat label="Active / Joined" value={stats?.candidates.active ?? 0} onOpen={() => openCandidates('active')} />
        <Stat label="Hold" value={stats?.candidates.hold ?? 0} onOpen={() => openCandidates('hold')} />
        <Stat label="Not Selected" value={stats?.candidates.not_selected ?? 0} onOpen={() => openCandidates('not_selected')} />
        <Stat label="Interviews Scheduled" value={stats?.interviews.scheduled ?? 0} onOpen={() => openInterviews('scheduled')} />
        <Stat label="Completed Interviews" value={stats?.interviews.completed ?? 0} onOpen={() => openInterviews('completed')} />
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
        <div className="card" ref={candidatesRef}>
          <div className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <input
              placeholder="Search name, email or phone"
              value={search}
              onChange={(e) => applySearch(e.target.value)}
              style={{ minWidth: 220 }}
            />
            <select aria-label="Status" value={status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Every status</option>
              {CANDIDATE_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
            <select aria-label="Recruiter" value={recruiter} onChange={(e) => setFilter('recruiter', e.target.value)}>
              <option value="">Every recruiter</option>
              {recruiters.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select>
            <select aria-label="Source" value={source} onChange={(e) => setFilter('source', e.target.value)}>
              <option value="">Every source</option>
              {sources.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            {(status || search || recruiter || source) && (
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => { setSearch(''); setParams({ tab: 'candidates' }, { replace: true }); }}
              >
                Clear filters
              </button>
            )}
          </div>
          {/* How many the filters matched — the figure a report row or card should equal. */}
          <p className="help" style={{ margin: '0 0 8px' }}>
            <span data-testid="candidate-total">{listTotal} candidate{listTotal === 1 ? '' : 's'}</span>
            {listTotal > 0 && (
              <span data-testid="candidate-range">
                {' · '}Showing {(listMeta.page - 1) * listMeta.per_page + 1}–{(listMeta.page - 1) * listMeta.per_page + rows.length} of {listTotal}
              </span>
            )}
          </p>

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
                        {/*
                          * Only when there IS an address and the person may send. A button that opens
                          * a composer purely to say "no email on file" is a wasted press.
                          */}
                        {canEdit && c.email && (
                          <button className="btn ghost sm" type="button" onClick={() => setMailing(c.id)}>
                            Send Mail
                          </button>
                        )}
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
                      <td>{c.source ? sourceLabel(c.source) : <span className="muted">Not recorded</span>}</td>
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
          <Pager page={listMeta.page} lastPage={listMeta.last_page} onPage={goToPage} />
        </div>
      ) : tab === 'interviews' ? (
        <div className="card">
          <div className="modal-sub">Interviews and what is due</div>
          {/*
            * Each card opens exactly what it counted. The first two filter the interview list by the
            * INTERVIEW's own status; the third leaves for Candidates, because "at interview stage" is
            * a CANDIDATE status and not an interview at all — one candidate at that stage may have
            * several interviews, or none yet booked.
            */}
          <div className="stat-grid" style={{ marginBottom: 12 }}>
            <Stat
              label="Scheduled"
              value={stats?.interviews.scheduled ?? 0}
              onOpen={() => drillTo({ tab: 'interviews', istatus: 'scheduled', focus: 'interviews' })}
            />
            <Stat
              label="Completed"
              value={stats?.interviews.completed ?? 0}
              onOpen={() => drillTo({ tab: 'interviews', istatus: 'completed', focus: 'interviews' })}
            />
            <Stat
              label="At interview stage"
              value={interviewsSoon}
              onOpen={() => drillTo({ tab: 'candidates', status: 'interview' })}
            />
            <Stat
              label="Follow-ups overdue"
              value={due?.overdue ?? 0}
              onOpen={() => drillTo({ tab: 'interviews', due: 'overdue', focus: 'followups' })}
            />
          </div>

          <div ref={interviewsRef} className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap', margin: '4px 0 10px' }}>
            <strong style={{ fontSize: 13 }}>Interviews{interviewList ? ` (${interviewList.total})` : ''}</strong>
            <select
              aria-label="Interview status"
              value={istatus}
              onChange={(e) => setParams((prev) => {
                const p = new URLSearchParams(prev);
                if (e.target.value) p.set('istatus', e.target.value); else p.delete('istatus');
                return p;
              }, { replace: true })}
            >
              <option value="">Every status</option>
              {INTERVIEW_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </div>
          {!interviewList ? (
            <p className="help">Loading interviews…</p>
          ) : interviewList.data.length === 0 ? (
            <p className="help">No interviews{istatus ? ` with the status ${statusLabel(istatus)}` : ''}.</p>
          ) : (
            <div className="lead-scroll" style={{ marginBottom: 16 }}>
              <table className="list-table">
                <thead><tr><th>When</th><th>Candidate</th><th>Interviewer</th><th>Mode</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {interviewList.data.map((iv) => (
                    <tr key={iv.id}>
                      <td>{iv.scheduled_at ? dateTime(iv.scheduled_at) : '—'}</td>
                      <td>
                        <strong>{iv.candidate.name}</strong>
                        <div className="muted">{statusLabel(iv.candidate.status)}</div>
                      </td>
                      <td>{iv.interviewer_name ?? '—'}</td>
                      <td>{iv.mode || '—'}{iv.location ? <div className="muted">{iv.location}</div> : null}</td>
                      <td><span className={statusPill(iv.status)}>{statusLabel(iv.status)}</span></td>
                      <td>
                        <button className="btn ghost sm" type="button" onClick={() => navigate(crmPath(`recruitment/${iv.candidate.id}`))}>Open</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div ref={followupsRef} className="toolbar-row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
            <div className="modal-sub">
              {dueFilter === 'overdue' ? `Follow-ups overdue (${due?.overdue ?? 0})` : 'Follow-ups due'}
            </div>
            {/*
              * SAYS THE LIST IS NARROWED, AND UNDOES IT. A section quietly showing fewer rows than
              * it did a moment ago reads as rows having gone missing.
              */}
            {dueFilter === 'overdue' && (
              <button className="btn ghost sm" type="button" onClick={() => setDueFilter('')}>
                Show all pending
              </button>
            )}
          </div>

          {!due || followupRows.length === 0 ? (
            <p className="help">
              {dueFilter === 'overdue'
                ? 'Nothing is overdue. Follow-ups still ahead of their date are under all pending.'
                : 'Nothing outstanding. Follow-ups you add on a candidate appear here.'}
            </p>
          ) : (
            <div className="lead-scroll">
              <table className="list-table">
                <thead><tr><th>Due</th><th>Follow-up</th><th>Candidate</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {followupRows.map((f) => {
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
                  {/* Each row opens Candidates filtered to exactly the candidates it counts. */}
                  {stats.by_recruiter.map((r) => (
                    <tr key={r.key} {...drillRow(`Show candidates of ${r.name}`, () => openFiltered('recruiter', r.key))}>
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
                    <tr key={r.key} {...drillRow(`Show candidates from ${sourceLabel(r.source)}`, () => openFiltered('source', r.key))}>
                      <td>{sourceLabel(r.source)}</td>
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

      {mailing !== null && (
        // The list shows no email state, so nothing here needs refreshing after a send.
        <RecruitmentSendMail candidateId={mailing} onClose={() => setMailing(null)} />
      )}
    </>
  );
}

/**
 * Previous · 1 2 3 … Next. Every page when there are seven or fewer; otherwise the first, the last
 * and two either side of the current one, with "…" for the gaps, so the control stays one line.
 */
function Pager({ page, lastPage, onPage }: { page: number; lastPage: number; onPage: (n: number) => void }) {
  if (lastPage <= 1) return null;
  const wanted = new Set([1, lastPage, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= lastPage));
  const shown = lastPage <= 7 ? Array.from({ length: lastPage }, (_, i) => i + 1) : [...wanted].sort((a, b) => a - b);
  const items: (number | 'gap')[] = [];
  shown.forEach((n, i) => { if (i > 0 && n - shown[i - 1] > 1) items.push('gap'); items.push(n); });
  return (
    <nav className="lead-pager" aria-label="Candidate pages">
      <span className="muted">Page {page} of {lastPage}</span>
      <div className="toolbar-row" style={{ gap: 4, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        {items.map((it, i) => (it === 'gap'
          ? <span key={`gap-${i}`} className="muted" aria-hidden="true">…</span>
          : (
            <button key={it} type="button" className={it === page ? 'btn primary sm' : 'btn ghost sm'}
              aria-current={it === page ? 'page' : undefined} aria-label={`Page ${it}`} onClick={() => onPage(it)}>
              {it}
            </button>
          )))}
        <button className="btn ghost sm" type="button" disabled={page >= lastPage} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </nav>
  );
}

/** A source as people read it: "referral" → "Referral". The stored value is still what filters. */
function sourceLabel(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** A Reports row that opens its drill-down — by mouse, or by keyboard (Tab, then Enter or Space). */
function drillRow(title: string, open: () => void) {
  return {
    role: 'link' as const,
    tabIndex: 0,
    title,
    onClick: open,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
    style: { cursor: 'pointer' },
  };
}

/** A count; with `onOpen`, a card that opens the list it counts (mouse or keyboard). */
/** The candidate-list request a filter combination makes, as one comparable string. */
function listKey(status: string, recruiter: string, source: string, q: string, page: number): string {
  return [status, recruiter, source, q, page].join('|');
}

/**
 * Scrolls whatever actually scrolls — the nearest scrollable ancestor, or the page — so that `el`
 * sits just below the sticky top bar instead of underneath it. Smooth unless the person has asked
 * the system for reduced motion.
 */
function scrollToSection(el: HTMLElement): void {
  const GAP = 12;
  const smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
  const header = document.querySelector('.topbar') as HTMLElement | null;
  const headerH = header ? header.getBoundingClientRect().height : 0;

  let box: HTMLElement | null = el.parentElement;
  while (box && box !== document.body) {
    const oy = getComputedStyle(box).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (box && box !== document.body) {
    // A scrolling panel: measure inside it, and allow for the bar only if the bar lives inside it too.
    const inside = header && box.contains(header) ? headerH : 0;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - inside - GAP;
    box.scrollTo({ top: Math.max(0, top), behavior });
    return;
  }
  const top = el.getBoundingClientRect().top + window.scrollY - headerH - GAP;
  window.scrollTo({ top: Math.max(0, top), behavior });
}

function Stat({ label, value, onOpen }: { label: string; value: number; onOpen?: () => void }) {
  const open = onOpen ? {
    role: 'link' as const,
    tabIndex: 0,
    title: `Show ${label}`,
    onClick: onOpen,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } },
    style: { cursor: 'pointer' },
  } : {};
  return (
    <div className="card meta-stat" {...open}>
      <div className="meta-stat-n">{value}</div>
      <div className="muted">{label}</div>
    </div>
  );
}
