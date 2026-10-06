import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { crmPath } from './area';
import {
  addCandidateNote, addFollowup, addOnboardingItem, completeFollowup, completeOnboardingItem,
  assignRecruiter, createAgentAccount, getCandidate, recommendCandidate, receiveDocument,
  candidateMessages, recruitmentPeople, requestDocument, scheduleInterview, setCandidateStatus,
  updateCandidate, updateInterview,
} from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import RecruitmentSendText, { messageStatusHint, messageStatusPill } from './RecruitmentSendText';
import { setSmsConsent } from '../lib/recruitmentApi';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { statusLabel, statusPill } from './RecruitmentPage';
import { availabilityLabel, yesNoUnknown } from '../types/recruitment';
import type {
  CandidateDetail, CandidateStatus, Recommendation, RecruitmentMessage, RecruitmentPerson,
} from '../types/recruitment';

/**
 * Mirrors `MIN_PASSWORD_LENGTH` in `server/src/auth/password-policy.ts`, which is what actually
 * decides. Repeated rather than imported because the client shares no code with the server; it is
 * used for the hint and the pre-check, so a drift would show as a form that accepts what the server
 * then refuses, not as a weakened rule.
 */
const MIN_PASSWORD_LENGTH = 12;

const dateTime = (v: string | null): string => (v ? new Date(v).toLocaleString() : '—');

/**
 * One candidate, and everything that has happened to them.
 *
 * THE DISTINCTION THIS SCREEN HAS TO MAKE VISIBLE. A recruiter RECOMMENDS and an administrator
 * DECIDES. Those are different rights on the server, and if the screen presented them as one row of
 * buttons the difference would only be discovered by being refused. So they are separate panels,
 * labelled for what they are, and the administrator's panel is not rendered at all for somebody who
 * does not hold `recruitment.decide`.
 *
 * Hiding it is not the control. The server checks the capability inside the transaction that does
 * the work, and every button below can be reached by hand and refused on its merits.
 */
export default function RecruitmentCandidatePage() {
  const { id } = useParams();
  const candidateId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const { can, isAdminOrAbove } = useAuth();
  const { confirm, askDelete, closeConfirm } = useConfirm();

  const canEdit = can('recruitment', 'edit');
  /** Approval, onboarding and account creation. Admin and Super Admin hold `recruitment.decide`. */
  const canDecide = isAdminOrAbove;

  const [data, setData] = useState<CandidateDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  /*
   * The password the administrator is typing for a new agent account. Held in state only while the
   * form is open, and cleared the moment the account is made — see the panel below.
   */
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  /*
   * The experience panel, open or closed. `null` is closed: the form's values are loaded FROM the
   * candidate when it opens, so there is no second copy of them sitting in state going stale while
   * somebody else edits the record.
   */
  const [exp, setExp] = useState<Record<string, string> | null>(null);
  const [texting, setTexting] = useState(false);
  const [messages, setMessages] = useState<RecruitmentMessage[]>([]);

  /*
   * ARRIVING FROM A NOTIFICATION. An interview alert links here with `?focus=interviews`, because
   * the thing the alert was about is a card some way down a long page. Without this the link opened
   * the right candidate and left the reader to hunt for what changed.
   */
  const [params] = useSearchParams();
  const focus = params.get('focus') ?? '';
  const interviewsRef = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);

  const [note, setNote] = useState('');
  const [followup, setFollowup] = useState({ title: '', due_at: '' });
  const [interview, setInterview] = useState({ scheduled_at: '', mode: '', location: '' });
  const [docName, setDocName] = useState('');
  const [stepTitle, setStepTitle] = useState('');
  /*
   * Only an administrator may assign, so only an administrator fetches the directory. A recruiter
   * is never handed a list of everyone in the brokerage for a control they cannot use.
   */
  const [people, setPeople] = useState<RecruitmentPerson[]>([]);

  const load = useCallback(async () => {
    try {
      setData(await getCandidate(candidateId));
      setError('');
    } catch (ex) {
      setError(apiErrorMessage(ex, 'Could not load this candidate'));
      setData(null);
    } finally {
      setLoaded(true);
    }
  }, [candidateId]);

  useEffect(() => { void load(); }, [load]);

  const loadMessages = useCallback(async () => {
    try {
      setMessages((await candidateMessages(candidateId)).data);
    } catch {
      // The history is a supporting panel; failing to load it must not blank the candidate.
      setMessages([]);
    }
  }, [candidateId]);

  useEffect(() => { void loadMessages(); }, [loadMessages]);

  useEffect(() => {
    if (focus !== 'interviews' || scrolled.current) return;
    // Waits for the candidate: scrolling to a card that has not rendered does nothing, and the
    // rows arriving afterwards would push it off the screen again.
    if (!data) return;
    scrolled.current = true;
    interviewsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus, data]);

  useEffect(() => {
    if (!canDecide) return;
    void recruitmentPeople().then((r) => setPeople(r.data)).catch(() => setPeople([]));
  }, [canDecide]);

  /** Every action goes through here, so a failure always says why and always reloads the truth. */
  const run = async (key: string, fn: () => Promise<unknown>, ok: string, done?: () => void) => {
    setBusy(key);
    try {
      await fn();
      toast(ok, 'ok');
      /*
       * ONLY ON SUCCESS. A panel that closed either way would throw away what somebody typed at the
       * exact moment they need it back — the save failed, so the text is the only copy left.
       */
      done?.();
      await load();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'That did not work'), 'bad');
    } finally {
      setBusy('');
    }
  };

  if (!loaded) return <div className="card"><p className="help">Loading candidate…</p></div>;

  if (error || !data) {
    return (
      <div className="card stub">
        <h2>Candidate not available</h2>
        <p className="help">{error || 'This candidate could not be found, or is not assigned to you.'}</p>
        <button className="btn ghost" type="button" onClick={() => navigate(crmPath('recruitment'))}>← Back to Recruitment</button>
      </div>
    );
  }

  const c = data.candidate;
  const hasAccount = !!c.agent_user_id;

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <button className="btn ghost sm" type="button" onClick={() => navigate(crmPath('recruitment'))}>← Back to Recruitment</button>
            <h2 className="lead-title">{c.name}</h2>
            <div className="lead-subtitle">
              <span className={statusPill(c.status)}>{statusLabel(c.status)}</span>
              {c.source && <span className="pill">{c.source}</span>}
              {hasAccount && <span className="pill ok">Agent Account Active</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="g2">
        <div>
          {/* ---------------------------------------------------------------- overview */}
          <div className="card">
            <div className="modal-sub">Overview</div>
            <dl className="lead-dl">
              <dt>Email</dt><dd>{c.email}</dd>
              <dt>Phone</dt>
              <dd>
                {c.phone || '—'}
                {canEdit && (
                  <>
                    {' '}
                    <button className="btn ghost sm" type="button" onClick={() => setTexting(true)}>
                      Send Text
                    </button>
                  </>
                )}
              </dd>
              {/*
                * THREE ANSWERS, SHOWN AS THREE. "Not recorded" is not "No" — one means nobody has
                * asked and the other means they declined, and a recruiter deciding whether to pick
                * up the phone needs to know which.
                */}
              <dt>Texting</dt>
              <dd>
                {c.sms_consent === true
                  ? `Agreed${c.sms_consent_by ? ` — recorded by ${c.sms_consent_by}` : ''}`
                  : c.sms_consent === false
                    ? 'Asked not to be texted'
                    : 'Not recorded — ask before texting'}
                {c.sms_consent_note && <div className="muted">{c.sms_consent_note}</div>}
                {canEdit && (
                  <div className="toolbar-row" style={{ gap: 6, marginTop: 4 }}>
                    {c.sms_consent !== true && (
                      <button
                        className="btn ghost sm"
                        type="button"
                        disabled={busy !== ''}
                        onClick={() => void run('consent', () => setSmsConsent(c.id, true), 'Agreement recorded.')}
                      >
                        They agreed
                      </button>
                    )}
                    {c.sms_consent !== false && (
                      <button
                        className="btn ghost sm"
                        type="button"
                        disabled={busy !== ''}
                        onClick={() => void run('consent', () => setSmsConsent(c.id, false), 'Recorded — they will not be texted.')}
                      >
                        They declined
                      </button>
                    )}
                  </div>
                )}
              </dd>
              <dt>Location</dt><dd>{c.location || '—'}</dd>
              <dt>Source</dt><dd>{c.source || 'Not recorded'}</dd>
              <dt>Recruiter</dt>
              <dd>
                {c.assigned_recruiter_name
                  ?? (c.assigned_recruiter_id ? `User #${c.assigned_recruiter_id}` : 'Unassigned')}
              </dd>
              <dt>Added</dt><dd>{dateTime(c.created_at)}{c.created_by ? ` by ${c.created_by}` : ''}</dd>
              {c.recommended_at && (
                <>
                  <dt>Recommendation</dt>
                  <dd>
                    {statusLabel(c.recommendation ?? '')} — {dateTime(c.recommended_at)}
                    {c.recommended_by_name ? ` by ${c.recommended_by_name}` : ''}
                  </dd>
                </>
              )}
              {c.approved_at && (
                <>
                  <dt>Approved</dt>
                  <dd>{dateTime(c.approved_at)}{c.approved_by_name ? ` by ${c.approved_by_name}` : ''}</dd>
                </>
              )}
              {hasAccount && (
                <>
                  <dt>Agent account</dt>
                  <dd>
                    {/* Linked where the CRM supports it: Users is Super Admin only, so this is a plain
                        reference for anyone who cannot open that screen rather than a dead link. */}
                    {c.agent_user_name ?? `User #${c.agent_user_id}`} · activated {dateTime(c.activated_at)}
                  </dd>
                </>
              )}
            </dl>
          </div>

          {/* ---------------------------------------------------------------- experience & licence */}
          <div className="card">
            <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
              <div className="modal-sub">Experience &amp; licence</div>
              {canEdit && exp === null && (
                <button
                  className="btn ghost sm"
                  type="button"
                  onClick={() => setExp({
                    /*
                     * BOOLEANS BECOME 'true' | 'false' | '', and null becomes the empty option. That
                     * third state is the whole point: a dropdown with only Yes and No would turn
                     * "nobody asked" into an answer the moment anybody saved the form.
                     */
                    has_real_estate_experience: c.has_real_estate_experience === null || c.has_real_estate_experience === undefined
                      ? '' : String(c.has_real_estate_experience),
                    years_experience: c.years_experience === null || c.years_experience === undefined
                      ? '' : String(c.years_experience),
                    is_licensed: c.is_licensed === null || c.is_licensed === undefined ? '' : String(c.is_licensed),
                    licence_number: c.licence_number ?? '',
                    brokerage_name: c.brokerage_name ?? '',
                    availability: c.availability ?? '',
                    training_needs: c.training_needs ?? '',
                  })}
                >
                  Edit
                </button>
              )}
            </div>

            {exp === null ? (
              <dl className="lead-dl">
                <dt>Real estate experience</dt><dd>{yesNoUnknown(c.has_real_estate_experience)}</dd>
                <dt>Years</dt>
                <dd>{c.years_experience === null || c.years_experience === undefined ? 'Not asked' : c.years_experience}</dd>
                <dt>Licensed</dt><dd>{yesNoUnknown(c.is_licensed)}</dd>
                <dt>Licence number</dt><dd>{c.licence_number || '—'}</dd>
                {/* Reads as current or previous from the licence answer, which is why one column serves both. */}
                <dt>{c.is_licensed === false ? 'Previous brokerage' : 'Brokerage'}</dt>
                <dd>{c.brokerage_name || '—'}</dd>
                <dt>Availability</dt><dd>{availabilityLabel(c.availability)}</dd>
                <dt>Training needs</dt><dd>{c.training_needs || '—'}</dd>
              </dl>
            ) : (
              <>
                <div className="g2">
                  <div className="field">
                    <label>Real estate experience</label>
                    <select
                      value={exp.has_real_estate_experience}
                      onChange={(e) => setExp({ ...exp, has_real_estate_experience: e.target.value })}
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
                      value={exp.years_experience}
                      onChange={(e) => setExp({ ...exp, years_experience: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Licensed</label>
                    <select value={exp.is_licensed} onChange={(e) => setExp({ ...exp, is_licensed: e.target.value })}>
                      <option value="">Not asked</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Licence number</label>
                    <input value={exp.licence_number} onChange={(e) => setExp({ ...exp, licence_number: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Brokerage (current or previous)</label>
                    <input value={exp.brokerage_name} onChange={(e) => setExp({ ...exp, brokerage_name: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Availability</label>
                    <select value={exp.availability} onChange={(e) => setExp({ ...exp, availability: e.target.value })}>
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
                    value={exp.training_needs}
                    onChange={(e) => setExp({ ...exp, training_needs: e.target.value })}
                  />
                </div>
                <div className="toolbar-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn ghost sm" type="button" disabled={busy !== ''} onClick={() => setExp(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn primary sm"
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => void run(
                      'exp',
                      /*
                       * Sent as the form holds them — empty string and all. The server reads '' as
                       * "clear this" and stores NULL, so a field somebody emptied is emptied rather
                       * than left at its old value.
                       */
                      () => updateCandidate(c.id, exp),
                      'Experience saved.',
                      () => setExp(null),
                    )}
                  >
                    Save
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ---------------------------------------------------------------- interviews */}
          <div className="card" ref={interviewsRef}>
            <div className="modal-sub">Interviews</div>
            {data.interviews.length === 0 ? (
              <p className="help">No interviews yet.</p>
            ) : data.interviews.map((iv) => (
              <div key={iv.id} className="card" style={{ marginBottom: 8 }}>
                <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <strong>{dateTime(iv.scheduled_at)}</strong>
                    <div className="muted">
                      {iv.mode || 'Mode not set'}{iv.location ? ` · ${iv.location}` : ''}
                      {iv.interviewer_name ? ` · ${iv.interviewer_name}` : iv.interviewer_id ? ` · interviewer #${iv.interviewer_id}` : ''}
                    </div>
                  </div>
                  <span className={statusPill(iv.status)}>{statusLabel(iv.status)}</span>
                </div>
                {iv.feedback && <p className="help" style={{ whiteSpace: 'pre-wrap' }}>{iv.feedback}</p>}
                {canEdit && iv.status === 'scheduled' && (
                  <div className="toolbar-row" style={{ gap: 8 }}>
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => void run(`iv-${iv.id}`, () => updateInterview(c.id, iv.id, { status: 'completed' }), 'Interview marked completed.')}
                    >
                      Mark completed
                    </button>
                    {/*
                      * CANCELLING IS CONFIRMED, because it tells two other people the interview is
                      * off and stops the reminders — and because, unlike marking an outcome, it is
                      * about an interview that has not happened and somebody may still be planning
                      * their day around.
                      */}
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => askDelete({
                        title: 'Cancel this interview?',
                        message: `The interview on ${dateTime(iv.scheduled_at)} will be marked cancelled. `
                          + 'Everyone who was told about it is told it is off, and its reminders stop. '
                          + 'Book a new one to rearrange.',
                        confirmLabel: 'Cancel interview',
                        onConfirm: () => {
                          closeConfirm();
                          void run(`iv-${iv.id}`, () => updateInterview(c.id, iv.id, { status: 'cancelled' }), 'Interview cancelled.');
                        },
                      })}
                    >
                      Cancel interview
                    </button>
                  </div>
                )}
                {canEdit && iv.status === 'completed' && (
                  <div>
                    <textarea
                      placeholder="Interview feedback"
                      defaultValue={iv.feedback ?? ''}
                      onBlur={(e) => {
                        if (e.target.value !== (iv.feedback ?? '')) {
                          void run(`fb-${iv.id}`, () => updateInterview(c.id, iv.id, { feedback: e.target.value }), 'Feedback saved.');
                        }
                      }}
                    />
                    <p className="help">
                      Recording an outcome here describes <strong>this interview</strong>. It does not
                      approve the candidate — that is an administrator's decision.
                    </p>
                    <div className="toolbar-row">
                      {(['approved', 'hold', 'not_selected'] as const).map((s) => (
                        <button
                          key={s}
                          className="btn ghost sm"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => void run(`ivs-${iv.id}`, () => updateInterview(c.id, iv.id, { status: s }), `Interview marked ${statusLabel(s)}.`)}
                        >
                          {statusLabel(s)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {canEdit && !hasAccount && (
              <div className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="datetime-local"
                  value={interview.scheduled_at}
                  onChange={(e) => setInterview({ ...interview, scheduled_at: e.target.value })}
                />
                <select value={interview.mode} onChange={(e) => setInterview({ ...interview, mode: e.target.value })}>
                  <option value="">Mode</option>
                  <option value="in-person">In person</option>
                  <option value="phone">Phone</option>
                  <option value="video">Video</option>
                </select>
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={busy !== '' || !interview.scheduled_at}
                  onClick={() => void run('schedule', () => scheduleInterview(c.id, interview), 'Interview scheduled.')}
                >
                  Schedule interview
                </button>
              </div>
            )}
          </div>

          {/* ---------------------------------------------------------------- texts sent */}
          {messages.length > 0 && (
            <div className="card">
              <div className="modal-sub">Texts sent</div>
              {/*
                * QUEUED, SENT, DELIVERED AND FAILED ARE FOUR DIFFERENT PROMISES and the screen says
                * which. "Sent" means the carrier took it, not that it arrived — the distinction
                * matters to a recruiter deciding whether to ring instead, so the pill carries the
                * meaning as a title rather than leaving the word to be guessed at.
                */}
              <div className="lead-scroll">
                <table className="list-table">
                  <thead><tr><th>When</th><th>To</th><th>Status</th><th>Message</th><th>By</th></tr></thead>
                  <tbody>
                    {messages.map((m) => (
                      <tr key={m.id}>
                        <td>{dateTime(m.sent_at)}</td>
                        <td>{m.phone}</td>
                        <td>
                          <span className={messageStatusPill(m.status)} title={messageStatusHint(m.status)}>
                            {m.status}
                          </span>
                          {m.error_message && <div className="muted">{m.error_message}</div>}
                        </td>
                        <td style={{ whiteSpace: 'pre-wrap' }}>{m.body}</td>
                        <td>{m.created_by || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ---------------------------------------------------------------- notes */}
          <div className="card">
            <div className="modal-sub">Notes</div>
            {data.notes.length === 0 && <p className="help">No notes yet.</p>}
            {data.notes.map((n) => (
              <div key={n.id} style={{ marginBottom: 8 }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                <div className="muted">{n.author || 'Someone'} · {dateTime(n.created_at)}</div>
              </div>
            ))}
            {canEdit && (
              <>
                <textarea placeholder="Add a note" value={note} onChange={(e) => setNote(e.target.value)} />
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={busy !== '' || !note.trim()}
                  onClick={() => void run('note', async () => { await addCandidateNote(c.id, note); setNote(''); }, 'Note added.')}
                >
                  Add note
                </button>
              </>
            )}
          </div>
        </div>

        <div>
          {/* ---------------------------------------------------------------- recruiter's panel */}
          {canEdit && !hasAccount && (
            <div className="card">
              <div className="modal-sub">Recommendation</div>
              <p className="help">
                Your recommendation is recorded against this candidate and shown to an administrator.
                <strong> It does not approve anybody.</strong>
              </p>
              {c.recommendation && (
                <p className="help">
                  Currently recommended: <strong>{statusLabel(c.recommendation)}</strong>
                  {c.approved_at ? ' · an administrator has since decided.' : ' · awaiting a decision.'}
                </p>
              )}
              <div className="toolbar-row" style={{ flexWrap: 'wrap' }}>
                {(['approved', 'hold', 'not_selected'] as Recommendation[]).map((r) => (
                  <button
                    key={r}
                    className="btn ghost sm"
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => void run(`rec-${r}`, () => recommendCandidate(c.id, r), `Recommended ${statusLabel(r)}.`)}
                  >
                    Recommend {statusLabel(r)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ---------------------------------------------------------------- assignment */}
          {canDecide && (
            <div className="card">
              <div className="modal-sub">Assigned recruiter</div>
              <p className="help">
                Who is working this candidate. A recruiter sees only the candidates assigned to
                them, so reassigning moves it out of one person’s list and into another’s.
              </p>
              <div className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <select
                  value={c.assigned_recruiter_id ?? ''}
                  disabled={busy !== ''}
                  onChange={(e) => {
                    const next = e.target.value ? Number(e.target.value) : null;
                    if (next === (c.assigned_recruiter_id ?? null)) return;
                    const to = next ? (people.find((p) => p.id === next)?.name ?? `user #${next}`) : null;

                    /*
                     * REASSIGNING IS CONFIRMED; FIRST ASSIGNMENT IS NOT. The difference is that
                     * reassignment TAKES something away — the current recruiter loses sight of a
                     * candidate they may be midway through — and that deserves a deliberate press
                     * rather than a stray click on a dropdown.
                     */
                    if (!c.assigned_recruiter_id) {
                      void run('assign', () => assignRecruiter(c.id, next), to ? `Assigned to ${to}.` : 'Recruiter cleared.');
                      return;
                    }
                    askDelete({
                      title: to ? 'Reassign this candidate?' : 'Remove the recruiter?',
                      message: to
                        ? `${c.name} moves from ${c.assigned_recruiter_name ?? 'the current recruiter'} to ${to}. `
                          + `${c.assigned_recruiter_name ?? 'They'} will no longer see this candidate.`
                        : `${c.name} will be left unassigned and will not appear in any recruiter’s list.`,
                      confirmLabel: to ? 'Reassign' : 'Unassign',
                      variant: 'primary',
                      onConfirm: () => {
                        closeConfirm();
                        void run('assign', () => assignRecruiter(c.id, next), to ? `Reassigned to ${to}.` : 'Recruiter cleared.');
                      },
                    });
                  }}
                >
                  <option value="">Unassigned</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
                </select>
                {busy === 'assign' && <span className="help">Saving…</span>}
              </div>
            </div>
          )}

          {/* ---------------------------------------------------------------- administrator's panel */}
          {canDecide && (
            <div className="card">
              <div className="modal-sub">Administrator decision</div>
              <p className="help">
                These are the brokerage's decisions, not a recommendation. Approving accepts the
                candidate; creating the account lets them sign in.
              </p>
              <div className="toolbar-row" style={{ flexWrap: 'wrap' }}>
                {(['approved', 'hold', 'not_selected', 'onboarding'] as CandidateStatus[]).map((s) => (
                  <button
                    key={s}
                    className="btn ghost sm"
                    type="button"
                    disabled={busy !== '' || hasAccount || c.status === s}
                    onClick={() => void run(`st-${s}`, () => setCandidateStatus(c.id, s), `Marked ${statusLabel(s)}.`)}
                  >
                    {s === 'onboarding' ? 'Start onboarding' : s === 'approved' ? 'Approve candidate' : `Mark ${statusLabel(s)}`}
                  </button>
                ))}
              </div>

              <div className="modal-sub" style={{ marginTop: 16 }}>Agent account</div>
              {hasAccount ? (
                <p className="help">
                  <span className="pill ok">Agent Account Active</span><br />
                  User #{c.agent_user_id}, activated {dateTime(c.activated_at)}. The recruitment
                  record is kept as that account's history.
                </p>
              ) : (
                <>
                  <p className="help">
                    Available once the candidate is Approved or in Onboarding. This creates a user
                    who can sign in and cannot be undone from here.
                  </p>
                  <div className="field">
                    <label>Initial password</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                    />
                  </div>
                  <div className="field">
                    <label>Confirm password</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={pw2}
                      onChange={(e) => setPw2(e.target.value)}
                    />
                  </div>
                  <p className="help">
                    {/*
                     * SAID BEFORE THE ACCOUNT IS MADE, not after. The old screen generated a
                     * password and showed it in a modal that could only be read once — so the one
                     * moment it mattered was the moment it was already too late to prepare for.
                     */}
                    Give this to {c.name.split(' ')[0]} by whatever means you normally would, and
                    have them change it at first sign-in. It is not stored in readable form and
                    cannot be shown again — if it is lost, reset it from the Users screen.
                  </p>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy !== '' || !['approved', 'onboarding'].includes(c.status)}
                    onClick={() => {
                      /*
                       * Checked here only to answer without a round trip. The server checks the same
                       * things against the shared policy and is what actually decides.
                       */
                      if (!pw) { toast('Enter an initial password for the account.', 'bad'); return; }
                      if (pw !== pw2) { toast('The password confirmation does not match.', 'bad'); return; }
                      if ([...pw].length < MIN_PASSWORD_LENGTH) {
                        toast(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'bad');
                        return;
                      }
                      askDelete({
                        title: 'Create the agent account?',
                        message: `This creates a user for ${c.name} (${c.email}) who can sign in immediately `
                          + 'with the password you entered. The recruitment record is kept and linked to the new account.',
                        confirmLabel: 'Create account',
                        variant: 'primary',
                        onConfirm: () => {
                          closeConfirm();
                          void (async () => {
                            setBusy('agent');
                            try {
                              await createAgentAccount(c.id, { password: pw, password_confirmation: pw2 });
                              /* Cleared on success so the plaintext does not sit in a live input. */
                              setPw('');
                              setPw2('');
                              toast('Agent account created.', 'ok');
                              await load();
                            } catch (ex) {
                              toast(apiErrorMessage(ex, 'Could not create the account'), 'bad');
                            } finally {
                              setBusy('');
                            }
                          })();
                        },
                      });
                    }}
                  >
                    {busy === 'agent' ? 'Creating…' : 'Create / activate agent account'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------------- follow-ups */}
          <div className="card">
            <div className="modal-sub">Follow-ups</div>
            {data.followups.length === 0 && <p className="help">Nothing scheduled.</p>}
            {data.followups.map((f) => {
              const overdue = !f.done_at && new Date(f.due_at) < new Date();
              return (
                <div key={f.id} className="toolbar-row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <div>
                    <div>{f.title}</div>
                    <div className="muted">
                      {dateTime(f.due_at)}{' '}
                      {f.done_at ? <span className="pill ok">Done</span> : overdue ? <span className="pill bad">Overdue</span> : <span className="pill info">Pending</span>}
                    </div>
                  </div>
                  {canEdit && !f.done_at && (
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => void run(`fu-${f.id}`, () => completeFollowup(c.id, f.id), 'Follow-up completed.')}
                    >
                      Done
                    </button>
                  )}
                </div>
              );
            })}
            {canEdit && (
              <div className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input placeholder="What needs doing" value={followup.title} onChange={(e) => setFollowup({ ...followup, title: e.target.value })} />
                <input type="datetime-local" value={followup.due_at} onChange={(e) => setFollowup({ ...followup, due_at: e.target.value })} />
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={busy !== '' || !followup.title.trim() || !followup.due_at}
                  onClick={() => void run('fu', async () => { await addFollowup(c.id, followup); setFollowup({ title: '', due_at: '' }); }, 'Follow-up added.')}
                >
                  Add
                </button>
              </div>
            )}
          </div>

          {/* ---------------------------------------------------------------- documents */}
          <div className="card">
            <div className="modal-sub">Documents</div>
            {data.documents.length === 0 && <p className="help">Nothing requested yet.</p>}
            {data.documents.map((d) => (
              <div key={d.id} className="toolbar-row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <div>
                  <div>{d.name}</div>
                  <div className="muted">
                    {d.uploaded_at
                      ? <span className="pill ok">Received {dateTime(d.uploaded_at)}</span>
                      : <span className="pill warn">Requested</span>}
                  </div>
                </div>
                {canEdit && !d.uploaded_at && (
                  <button
                    className="btn ghost sm"
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => void run(`doc-${d.id}`, () => receiveDocument(c.id, d.id, { file_name: d.name }), 'Marked as received.')}
                  >
                    Mark received
                  </button>
                )}
              </div>
            ))}
            {canEdit && (
              <div className="toolbar-row" style={{ gap: 8 }}>
                <input placeholder="Document to request" value={docName} onChange={(e) => setDocName(e.target.value)} />
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={busy !== '' || !docName.trim()}
                  onClick={() => void run('doc', async () => { await requestDocument(c.id, docName); setDocName(''); }, 'Document requested.')}
                >
                  Request
                </button>
              </div>
            )}
          </div>

          {/* ---------------------------------------------------------------- onboarding */}
          {(['approved', 'onboarding', 'active'].includes(c.status) || data.onboarding.length > 0) && (
            <div className="card">
              <div className="modal-sub">Onboarding checklist</div>
              {data.onboarding.length === 0 && <p className="help">No steps yet.</p>}
              {data.onboarding.map((o) => (
                <div key={o.id} className="toolbar-row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <div>
                    <div>{o.title}</div>
                    {o.done_at && <div className="muted">Done {dateTime(o.done_at)}{o.done_by ? ` by ${o.done_by}` : ''}</div>}
                  </div>
                  {canEdit && !o.done_at && (
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => void run(`ob-${o.id}`, () => completeOnboardingItem(c.id, o.id), 'Step completed.')}
                    >
                      Mark done
                    </button>
                  )}
                </div>
              ))}
              {/* Adding steps is an administrator's: the checklist is the brokerage's, not one recruiter's. */}
              {canDecide && (
                <div className="toolbar-row" style={{ gap: 8 }}>
                  <input placeholder="Add a step" value={stepTitle} onChange={(e) => setStepTitle(e.target.value)} />
                  <button
                    className="btn ghost sm"
                    type="button"
                    disabled={busy !== '' || !stepTitle.trim()}
                    onClick={() => void run('ob', async () => { await addOnboardingItem(c.id, stepTitle); setStepTitle(''); }, 'Step added.')}
                  >
                    Add
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------------- history */}
          <div className="card">
            <div className="modal-sub">Activity</div>
            {data.events.length === 0 ? (
              <p className="help">Nothing recorded yet.</p>
            ) : (
              <div className="lead-scroll">
                {data.events.map((e) => (
                  <div key={e.id} style={{ marginBottom: 6 }}>
                    <div>{e.detail || e.action}</div>
                    <div className="muted">{e.actor_name || 'System'} · {dateTime(e.created_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {texting && (
        <RecruitmentSendText
          candidateId={c.id}
          onClose={() => setTexting(false)}
          onSent={() => { void loadMessages(); void load(); }}
        />
      )}

      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}
