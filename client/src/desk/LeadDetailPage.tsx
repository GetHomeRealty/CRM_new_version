import { crmPath } from './area';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  addCallRecording, addLeadCall, addLeadMessage, addLeadNote, addLeadShowing, addLeadTask,
  callRecordingUrl, deleteCallRecording, generateLeadEmail, getLead, leadOptions, placeLeadCall, sendLeadEmail, smsGatewayStatus, updateLeadMessage, voiceCallStatus,
  updateLeadNote, updateLeadShowing, updateLeadTask,
  deleteLeadShowing, deleteLeadNote, deleteLeadTask, deleteLeadCall, deleteLeadMessage, deleteLeadEmail,
} from '../lib/leadsApi';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { apiErrorMessage } from '../lib/apiError';
import TwilioDialer from './TwilioDialer';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import LeadEditorModal, { label, prefHeading } from './LeadEditorModal';
import { identityLocked } from '../lib/leadIdentity';
import { createEvent } from '../lib/calendarApi';
import type {
  CalendarEventInput, LeadCall, LeadDetail, LeadOptions, LeadShowing, MessageStatus, SmsGatewayStatus,
} from '../types';

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

/** 24-hour "14:30" → "2:30 PM". */
const clock = (t: string): string => {
  const m = /^(\d{2}):(\d{2})$/.exec(t ?? '');
  if (!m) return t ?? '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
};

/** Seconds → "3m 20s"; blank when the duration wasn't recorded. */
const mmss = (secs: number | null): string => {
  if (secs == null) return '';
  const m = Math.floor(secs / 60);
  return m ? `${m}m ${secs % 60}s` : `${secs}s`;
};

const today = (): string => new Date().toISOString().slice(0, 10);

const priorityPill = (p: string): string => (p === 'high' ? 'bad' : p === 'low' ? 'ok' : 'warn');
const statePill = (s: string): string => (s === 'completed' ? 'ok' : s === 'cancelled' ? 'bad' : 'info');

export default function LeadDetailPage() {
  const { id } = useParams();
  const leadId = Number(id);
  const toast = useToast();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const canEdit = can('lead', 'edit');

  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [options, setOptions] = useState<LeadOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);

  /**
   * `quiet` refetches without showing the loader, so adding a note or task refreshes the panels
   * in place instead of blanking the whole page for a moment. Only the first load — when there
   * is nothing on screen yet — shows a loading state.
   */
  const load = useCallback(async (quiet = false) => {
    if (!Number.isInteger(leadId) || leadId <= 0) { setNotFound(true); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      setLead(await getLead(leadId));
      setNotFound(false);
    } catch (ex) {
      setNotFound(true);
      toast(apiErrorMessage(ex, 'Could not load the lead'), 'bad');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [leadId, toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { leadOptions().then(setOptions).catch(() => setOptions(null)); }, []);

  /*
   * One confirmation dialog for the whole page, passed down as `ask`.
   *
   * Every destructive control on this screen goes through it. They previously did not exist at all
   * for notes, tasks, calls and messages — the API could delete them and nothing on screen could,
   * so a note typed against the wrong lead was permanent as far as the user was concerned — and the
   * one that did exist (showings) used `window.confirm` while the rest of the application uses this
   * component. Two dialog idioms on one screen, and a delete of a call recording with no
   * confirmation at all.
   */
  const { confirm, askDelete, closeConfirm } = useConfirm();
  const ask: Ask = (title, message, onConfirm) => askDelete({ title, message, onConfirm });

  /** Wrap a write so every panel refreshes from the server rather than guessing. */
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok, 'ok');
      await load(true);
    } catch (ex) {
      toast(apiErrorMessage(ex, 'That did not work'), 'bad');
    }
  };

  if (loading) return <div className="card"><p className="help">Loading lead…</p></div>;
  if (notFound || !lead) {
    return (
      <div className="card stub">
        <h2>Lead not found</h2>
        <p>It may have been deleted, or it belongs to another agent.</p>
        <button className="btn ghost" type="button" onClick={() => navigate(crmPath('lead'))}>Back to Leads</button>
      </div>
    );
  }

  const prefs = lead.property_preferences;

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <button className="btn ghost sm" type="button" onClick={() => navigate(crmPath('lead'))}>← Back to Leads</button>
            <h2 className="lead-title">{lead.name}</h2>
            <div className="lead-subtitle">
              {lead.lead_status && <span className="pill info">{label(lead.lead_status)}</span>}
              {lead.lead_type && <span className="pill">{label(lead.lead_type)}</span>}
              {/* Source indicator, added alongside the existing lead_source value rather than replacing it. */}
              {lead.source === 'facebook_meta' && <span className="pill type-res-buy" title="Imported from Facebook Lead Ads">Meta</span>}
              {lead.unsubscribed && <span className="pill bad">Unsubscribed</span>}
              <span className="muted">Added {stamp(lead.created_at)}{lead.created_by ? ` by ${lead.created_by}` : ''}</span>
            </div>
          </div>
          <div className="toolbar-row">
            {canEdit && (
              <button className="btn ghost" type="button" onClick={() => setFollowUpOpen(true)}>
                📅 Schedule Follow-up
              </button>
            )}
            {canEdit && <button className="btn primary" type="button" onClick={() => setEditorOpen(true)}>Edit Lead</button>}
          </div>
        </div>
      </div>

      <div className="g2">
        <div className="card">
          <div className="modal-sub">Contact &amp; Classification</div>
          <dl className="lead-dl">
            <Row k="Email" v={lead.email} />
            <Row k="Phone" v={lead.phone} />
            <Row k="Location" v={lead.location} />
            <Row k="Property" v={lead.property} />
            <Row k="Assigned To" v={lead.assigned_to_name ?? 'Unassigned'} />
            <Row k="Lead Source" v={lead.lead_source && label(lead.lead_source)} />
            <Row k="Lead Response" v={lead.lead_response && label(lead.lead_response)} />
            <Row k="Client Type" v={lead.client_type && label(lead.client_type)} />
            <Row k="Conversion" v={lead.lead_conversion && label(lead.lead_conversion)} />
            <Row k="Tags" v={lead.tags.length ? lead.tags.join(', ') : null} />
          </dl>

          <div className="modal-sub">Demographics</div>
          <dl className="lead-dl">
            <Row k="Age" v={lead.age != null ? String(lead.age) : null} />
            <Row k="Gender" v={lead.gender && label(lead.gender)} />
            <Row k="Language" v={lead.language} />
            <Row k="Religion" v={lead.religion} />
            <Row k="Date of Birth" v={lead.date_of_birth} />
            <Row k="Marriage Day" v={lead.marriage_day} />
          </dl>

          {/* A lead may keep several sets — "Property Preferences", then "2nd Preference", … */}
          {!prefs?.length ? (
            <>
              <div className="modal-sub">Property Preferences</div>
              <p className="help">None recorded.</p>
            </>
          ) : prefs.map((p, i) => (
            <div key={i}>
              <div className="modal-sub">{prefHeading(i)}</div>
              <dl className="lead-dl">
                <Row k="Budget" v={p.budget?.min != null || p.budget?.max != null
                  ? `${p.budget?.min ?? '—'} – ${p.budget?.max ?? '—'}` : null} />
                <Row k="Property Type" v={(p.propertyType ?? []).join(', ') || null} />
                <Row k="Bedrooms" v={p.bedrooms != null ? String(p.bedrooms) : null} />
                <Row k="Bathrooms" v={p.bathrooms != null ? String(p.bathrooms) : null} />
                <Row k="Square Footage" v={p.squareFootage != null ? String(p.squareFootage) : null} />
                <Row k="Year Built" v={p.yearBuilt != null ? String(p.yearBuilt) : null} />
                <Row k="Lot Size" v={p.lotSize || null} />
                <Row k="Parking" v={p.parking != null ? String(p.parking) : null} />
                <Row k="Features" v={(p.features ?? []).join(', ') || null} />
              </dl>
            </div>
          ))}

          {lead.meta && (
            <>
              <div className="modal-sub">Meta / Facebook Source</div>
              <dl className="lead-dl">
                <Row k="Page" v={lead.meta.page_name ?? lead.meta.page_id} />
                <Row k="Lead form" v={lead.meta.form_name ?? lead.meta.form_id} />
                <Row k="Campaign" v={lead.meta.campaign_name ?? lead.meta.campaign_id} />
                <Row k="Ad set" v={lead.meta.adset_name ?? lead.meta.adset_id} />
                <Row k="Ad" v={lead.meta.ad_name ?? lead.meta.ad_id} />
                <Row k="Budget" v={lead.meta.budget} />
                <Row k="Timeline" v={lead.meta.timeline} />
                <Row k="Property type" v={lead.meta.property_type} />
                <Row k="Submitted" v={lead.meta.submitted_at ? stamp(lead.meta.submitted_at) : null} />
                <Row k="Imported" v={lead.meta.imported_at ? stamp(lead.meta.imported_at) : null} />
                <Row k="Meta lead ID" v={lead.meta.lead_id} />
              </dl>
              {lead.meta.message && (
                <>
                  <div className="modal-sub">Enquiry</div>
                  <p className="lead-summary">{lead.meta.message}</p>
                </>
              )}
              {!lead.meta.campaign_id && (
                <span className="help">
                  Campaign, ad-set and ad names are blank when the connected Meta app lacks the
                  ads permissions — the lead itself is unaffected.
                </span>
              )}
            </>
          )}

          {lead.notes && (
            <>
              <div className="modal-sub">Summary Notes</div>
              <p className="lead-summary">{lead.notes}</p>
            </>
          )}
        </div>

        <div>
          <CommunicationPanel lead={lead} canEdit={canEdit} run={run} ask={ask} onSent={() => void load(true)} />
          <NotesPanel lead={lead} canEdit={canEdit} run={run} ask={ask} />
          <TasksPanel lead={lead} options={options} canEdit={canEdit} run={run} ask={ask} />
          <ShowingsPanel lead={lead} canEdit={canEdit} run={run} ask={ask} />
          <CallsPanel lead={lead} options={options} canEdit={canEdit} run={run} ask={ask} />
        </div>
      </div>

      {editorOpen && (
        <LeadEditorModal
          lead={lead}
          options={options}
          // One definition, shared with the Leads list and matching the server. See `leadIdentity`.
          lockIdentity={identityLocked(lead, user)}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); void load(true); }}
        />
      )}

      {/* Creates a real calendar event linked to this lead — the Calendar module owns it. */}
      {followUpOpen && (
        <FollowUpModal
          lead={lead}
          onClose={() => setFollowUpOpen(false)}
          onSaved={() => { setFollowUpOpen(false); toast('Follow-up added to the calendar.', 'ok'); }}
        />
      )}

      {/* One dialog for every destructive control on the page, driven by `ask`. */}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}

function Row({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v ? v : <span className="muted">—</span>}</dd>
    </>
  );
}

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<void>;
/** Confirm a destructive action before it happens. Wired to the page's single ConfirmDialog. */
type Ask = (title: string, message: string, onConfirm: () => void) => void;

/*
 * The activity panels below — Notes, Tasks, Showings, Call Log, the SMS conversation and Email
 * History — each offer deletion.
 *
 * THIS USED TO SAY THE OPPOSITE, and the note is kept rather than simply replaced because the
 * original reasoning still applies to how deletion behaves. Append-only was a deliberate request:
 * a lead's history is a record of what happened, and the delete endpoints existed for
 * administrative cleanup without being reachable here. They were then asked for one at a time —
 * Email History last, to clear repeated failed sends from a broken mailbox — until the comment
 * described none of the code beneath it.
 *
 * WHAT SURVIVES OF THE ORIGINAL RULE: every one of these deletions writes the removed CONTENT to
 * the audit trail, not merely the fact that something went. That is what keeps "the record of what
 * happened" true while letting the panel be tidied, and it is the part to preserve if another of
 * these grows a delete.
 */

// ------------------------------------------------------------------- notes
function NotesPanel({ lead, canEdit, run, ask }: { lead: LeadDetail; canEdit: boolean; run: Run; ask: Ask }) {
  const [text, setText] = useState('');
  return (
    <div className="card">
      <div className="modal-sub">Notes ({lead.notes_history.length})</div>
      {canEdit && (
        <div className="lead-add-row">
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a dated note…" />
          <button className="btn primary sm" type="button" disabled={!text.trim()}
            onClick={() => void run(() => addLeadNote(lead.id, text.trim()), 'Note added.').then(() => setText(''))}>
            Add
          </button>
        </div>
      )}
      {lead.notes_history.length === 0 ? <p className="help">No notes yet.</p> : (
        <ul className="lead-feed">
          {lead.notes_history.map((n) => (
            <li key={n.id} className={n.pinned ? 'pinned' : ''}>
              <div className="lead-feed-body">{n.content}</div>
              <div className="lead-feed-meta">
                <span className="muted">{stamp(n.created_at)}{n.created_by ? ` · ${n.created_by}` : ''}</span>
                {canEdit && (
                  <>
                    <button className="btn ghost sm" type="button"
                      onClick={() => void run(() => updateLeadNote(lead.id, n.id, { pinned: !n.pinned }), n.pinned ? 'Note unpinned.' : 'Note pinned.')}>
                      {n.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    {/* The server refuses this unless you wrote the note, or you are an
                        administrator. The button is shown regardless rather than hidden by a guess
                        at the rule: the refusal explains itself, and a hidden control cannot. */}
                    <button className="btn ghost sm" type="button" title="Delete this note"
                      onClick={() => ask(
                        'Delete this note?',
                        `"${n.content.slice(0, 120)}${n.content.length > 120 ? '…' : ''}" will be removed. Only its author or an administrator can delete a note, and the deletion is recorded in the audit trail with its content.`,
                        () => void run(() => deleteLeadNote(lead.id, n.id), 'Note deleted.'),
                      )}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- tasks
function TasksPanel({ lead, options, canEdit, run, ask }: { lead: LeadDetail; options: LeadOptions | null; canEdit: boolean; run: Run; ask: Ask }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(today());
  const [priority, setPriority] = useState('medium');
  const [assignee, setAssignee] = useState('');

  const pending = lead.tasks.filter((t) => t.status === 'pending').length;

  return (
    <div className="card">
      <div className="modal-sub">Tasks ({pending} pending of {lead.tasks.length})</div>
      {canEdit && (
        <div className="lead-add-grid">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {(options?.task_priority ?? ['low', 'medium', 'high']).map((p) => <option key={p} value={p}>{label(p)}</option>)}
          </select>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Assign to me</option>
            {(options?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button className="btn primary sm" type="button" disabled={!title.trim()}
            onClick={() => void run(
              () => addLeadTask(lead.id, {
                title: title.trim(), due_date: due, priority,
                ...(assignee ? { assigned_to: Number(assignee) } : {}),
              }),
              'Task added.',
            ).then(() => setTitle(''))}>
            Add
          </button>
        </div>
      )}
      {lead.tasks.length === 0 ? <p className="help">No tasks yet.</p> : (
        <ul className="lead-feed">
          {lead.tasks.map((t) => (
            <li key={t.id}>
              <div className="lead-feed-body">
                {/* A cancelled task reads as struck through too — it is finished with, just not done. */}
                <strong className={t.status === 'pending' ? '' : 'done'}>{t.title}</strong>
                {t.description && <div className="muted">{t.description}</div>}
              </div>
              <div className="lead-feed-meta">
                <span className="pill info">{t.due_date}</span>
                <span className={`pill ${priorityPill(t.priority)}`}>{label(t.priority)}</span>
                <span className={`pill ${statePill(t.status)}`}>{label(t.status)}</span>
                {t.assigned_to_name && <span className="muted">{t.assigned_to_name}</span>}
                {canEdit && (
                  <>
                    {/* Cancelled is a third resting state, not a kind of done: the task was
                        dropped rather than finished, and it stays on the lead as a record.
                        Deleting is still there for something logged by mistake. */}
                    {t.status === 'pending' ? (
                      <>
                        <button className="btn ghost sm" type="button"
                          onClick={() => void run(() => updateLeadTask(lead.id, t.id, { status: 'completed' }), 'Task completed.')}>
                          Complete
                        </button>
                        <button className="btn ghost sm" type="button"
                          onClick={() => void run(() => updateLeadTask(lead.id, t.id, { status: 'cancelled' }), 'Task cancelled.')}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn ghost sm" type="button"
                          onClick={() => void run(() => updateLeadTask(lead.id, t.id, { status: 'pending' }), 'Task reopened.')}>
                          Reopen
                        </button>
                        {t.status === 'completed' && (
                          <button className="btn ghost sm" type="button"
                            onClick={() => void run(() => updateLeadTask(lead.id, t.id, { status: 'cancelled' }), 'Task cancelled.')}>
                            Cancel
                          </button>
                        )}
                      </>
                    )}
                    {/* For something logged against the wrong lead. Cancelling keeps the record;
                        this removes it, which is why it asks first. */}
                    <button className="btn ghost sm" type="button" title="Delete this task"
                      onClick={() => ask(
                        'Delete this task?',
                        `"${t.title}" will be removed from this lead. If the work simply is not going ahead, Cancel keeps it on the record instead.`,
                        () => void run(() => deleteLeadTask(lead.id, t.id), 'Task deleted.'),
                      )}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/*
 * CRM-042: Reschedule asks where the showing is moving to.
 *
 * WHAT IT DID. The button sent `{ status: 'scheduled' }` and nothing else, so a completed showing
 * flipped back to Scheduled at the slot it already had. It did not reschedule anything — it
 * un-completed. And since it was the only control on a showing that mentioned moving one, an agent
 * needing to shift a viewing had nowhere to go: the date and time boxes at the top belong to the
 * ADD form, so using those makes a SECOND showing. The workaround people are left with is delete
 * and recreate, which throws away the original record.
 *
 * WHY NOT JUST RENAME IT "REOPEN". That was the cheap fix, and it was the wrong one twice over.
 * The comment on the old button records that Reopen was removed on request, so putting the word
 * back would undo a decision somebody already made deliberately; and renaming leaves the real gap
 * exactly where it was — there would still be no way to move a viewing to another day.
 *
 * PRE-FILLED WITH THE CURRENT SLOT, which is what keeps the old behaviour intact. Confirming
 * without touching anything does precisely what the button did before — returns the showing to
 * Scheduled, unmoved — so undoing a mis-clicked Complete still takes one extra keypress and no
 * thought. Changing the date or time reschedules it for real.
 */
function RescheduleModal({ showing, onClose, onConfirm }: {
  showing: LeadShowing;
  onClose: () => void;
  onConfirm: (next: { showing_date: string; time: string }) => void;
}) {
  const [date, setDate] = useState(showing.showing_date);
  const [time, setTime] = useState(showing.time);
  const moved = date !== showing.showing_date || time !== showing.time;

  return createPortal(
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000 }}>
      <div className="modal" style={{ maxWidth: 420, margin: 0 }}>
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h">Reschedule this showing</div>
        <p style={{ fontSize: 13, marginTop: 4 }}>
          <strong>{showing.property || 'Property showing'}</strong> is currently{' '}
          {showing.showing_date} at {clock(showing.time)}.
        </p>
        <div className="lead-add-grid" style={{ marginTop: 10 }}>
          <label style={{ fontSize: 12 }}>Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label style={{ fontSize: 12 }}>Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        {/*
          Says which of the two things the button is about to do. The dialog covers both a real move
          and the undo-a-mis-click case, and those deserve different sentences rather than one
          wording that half-fits each.
        */}
        <p className="help" style={{ marginTop: 8 }}>
          {moved
            ? `The showing moves to ${date} at ${clock(time)} and returns to Scheduled.`
            : 'Nothing has been changed, so the showing returns to Scheduled at the same slot.'}
        </p>
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!date || !time}
            onClick={() => { onConfirm({ showing_date: date, time }); onClose(); }}>
            {moved ? 'Reschedule' : 'Return to Scheduled'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}


// ---------------------------------------------------------------- showings
function ShowingsPanel({ lead, canEdit, run, ask }: { lead: LeadDetail; canEdit: boolean; run: Run; ask: Ask }) {
  const [date, setDate] = useState(today());
  const [time, setTime] = useState('12:00');
  const [property, setProperty] = useState('');
  const [rescheduling, setRescheduling] = useState<LeadShowing | null>(null);

  return (
    <div className="card">
      <div className="modal-sub">Showings ({lead.showings.length})</div>
      {canEdit && (
        <div className="lead-add-grid">
          <input value={property} onChange={(e) => setProperty(e.target.value)} placeholder="Property address" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          <button className="btn primary sm" type="button" disabled={!property.trim()}
            onClick={() => void run(
              () => addLeadShowing(lead.id, { showing_date: date, time, property: property.trim() }),
              'Showing scheduled.',
            ).then(() => setProperty(''))}>
            Add
          </button>
        </div>
      )}
      {lead.showings.length === 0 ? <p className="help">No showings scheduled.</p> : (
        <ul className="lead-feed">
          {lead.showings.map((s) => (
            <li key={s.id}>
              <div className="lead-feed-body">
                <strong>{s.property || 'Property showing'}</strong>
                {s.notes && <div className="muted">{s.notes}</div>}
              </div>
              <div className="lead-feed-meta">
                <span className="pill info">{s.showing_date} · {clock(s.time)}</span>
                <span className={`pill ${statePill(s.status)}`}>{label(s.status)}</span>
                {canEdit && (
                  <>
                    {/* Reopen was removed on request. The third state is Cancelled, for a showing
                        that was called off; Reschedule is the way back to scheduled, so a
                        mis-click on Complete or Cancel does not need a delete to undo. */}
                    {s.status !== 'completed' && (
                      <button className="btn ghost sm" type="button"
                        onClick={() => void run(() => updateLeadShowing(lead.id, s.id, { status: 'completed' }), 'Showing completed.')}>
                        Complete
                      </button>
                    )}
                    {s.status !== 'cancelled' && (
                      <button className="btn ghost sm" type="button"
                        onClick={() => void run(() => updateLeadShowing(lead.id, s.id, { status: 'cancelled' }), 'Showing cancelled.')}>
                        Cancel
                      </button>
                    )}
                    {/* Opens the dialog rather than firing. See RescheduleModal for why. */}
                    {s.status !== 'scheduled' && (
                      <button className="btn ghost sm" type="button"
                        onClick={() => setRescheduling(s)}>
                        Reschedule
                      </button>
                    )}
                    <button className="btn ghost sm" type="button" style={{ color: 'var(--bad)' }}
                      onClick={() => ask(
                        'Delete this showing?',
                        `${s.property || 'This showing'} on ${s.showing_date}${s.time ? ` at ${s.time}` : ''} will be removed from the lead. This cannot be undone.`,
                        () => void run(() => deleteLeadShowing(lead.id, s.id), 'Showing deleted.'),
                      )}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {/*
        One mount for the whole list: the dialog is about the showing held in `rescheduling`, so a
        per-row mount would put N copies of it in the tree to no purpose.
      */}
      {rescheduling && (
        <RescheduleModal
          showing={rescheduling}
          onClose={() => setRescheduling(null)}
          onConfirm={(next) => void run(
            () => updateLeadShowing(lead.id, rescheduling.id, { ...next, status: 'scheduled' }),
            next.showing_date === rescheduling.showing_date && next.time === rescheduling.time
              ? 'Showing returned to Scheduled.'
              : 'Showing rescheduled.',
          )}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------- communication
/**
 * How an outbound SMS is doing, in the agent's words. These are recorded by hand — see the note
 * under the thread — so the list stays to things a person can actually know.
 */
const STATUS_LABEL: Record<MessageStatus, string> = {
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed to send',
};

const STATUS_PILL: Record<MessageStatus, string> = {
  queued: '', sent: 'info', delivered: 'ok', read: 'ok', failed: 'bad',
};

/** The id the Communication panel scrolls to; the Call Log panel carries it. */
const CALL_LOG_ANCHOR = 'lead-call-log';

/** Everything but digits and a leading + — `tel:`/`sms:` links choke on spaces and brackets. */
const dialable = (phone: string | null): string => (phone ?? '').replace(/[^\d+]/g, '');

/**
 * Calling and texting a lead.
 *
 * Calls always hand off to the device: there is no telephony integration, so `tel:` opens
 * whatever dialler the machine has and the outcome is logged afterwards.
 *
 * SMS works one of two ways depending on the server. With an SMS gateway configured, the server
 * sends the message itself and the delivery status updates on its own from the provider's
 * callback. Without one, the message goes to the device's messaging app through an `sms:` link
 * and only the record is kept — with the status set by hand. The panel says which mode it is in
 * rather than leaving the agent to guess whether a message actually went.
 */
function CommunicationPanel({ lead, canEdit, run, ask, onSent }: {
  lead: LeadDetail; canEdit: boolean; run: Run; ask: Ask; onSent: () => void;
}) {
  const toast = useToast();
  const [composing, setComposing] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [text, setText] = useState('');
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const [gateway, setGateway] = useState<SmsGatewayStatus | null>(null);

  useEffect(() => { smsGatewayStatus().then(setGateway).catch(() => setGateway(null)); }, []);
  const liveSms = gateway?.configured === true;
  // Three calling modes, most capable first:
  //   • in-browser dialer (Voice SDK) — talk in the browser;
  //   • server click-to-call — Twilio rings the agent's phone, then bridges the lead;
  //   • device dialler (`tel:`) — nothing configured.
  const liveCall = gateway?.voice === true;
  const [browserCall, setBrowserCall] = useState(false);
  useEffect(() => { voiceCallStatus().then((s) => setBrowserCall(s.configured)).catch(() => setBrowserCall(false)); }, []);
  const [dialerOpen, setDialerOpen] = useState(false);
  const [calling, setCalling] = useState(false);

  const number = dialable(lead.phone);
  const hasPhone = number.length > 0;

  const call = async () => {
    if (!hasPhone || calling) return;
    if (browserCall) { setDialerOpen(true); return; }
    if (liveCall) {
      setCalling(true);
      try {
        await placeLeadCall(lead.id);
        toast('Calling you now — answer your phone to be connected to the lead.', 'ok');
        onSent(); // the new call row appears in the log
        document.getElementById(CALL_LOG_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (ex) {
        toast(apiErrorMessage(ex, 'Could not start the call'), 'bad');
      } finally {
        setCalling(false);
      }
      return;
    }
    window.location.href = `tel:${number}`;
    toast('Opening your dialler — log the outcome in the Call Log below.', 'info');
    document.getElementById(CALL_LOG_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    const outbound = direction === 'outbound';

    // With no gateway the message has to leave through the device, so open the messaging app
    // first and record only what was handed over. With one, the server does the sending and
    // nothing should open — opening a second draft would risk the lead getting it twice.
    if (outbound && hasPhone && !liveSms) {
      window.open(`sms:${number}?&body=${encodeURIComponent(body)}`, '_self');
    }

    await run(
      () => addLeadMessage(lead.id, {
        direction, body, phone: lead.phone ?? null,
        ...(outbound && liveSms ? { send: true } : {}),
      }),
      outbound ? (liveSms ? 'Message sent.' : 'Message logged.') : 'Reply logged.',
    );
    setText('');
    setComposing(false);
  };

  return (
    <div className="card">
      <div className="modal-sub">Communication</div>
      {!hasPhone && <p className="help">This lead has no phone number, so calling and texting are unavailable.</p>}

      <div className="lead-comm-actions">
        <button className="btn primary sm" type="button" disabled={!hasPhone || calling} onClick={call}
          title={liveCall ? 'Twilio rings your phone, then connects the lead' : 'Opens your device dialler'}>
          {calling ? '📞 Calling…' : '📞 Make Call'}
        </button>
        <button className="btn sm" type="button" disabled={!canEdit || (!hasPhone && direction === 'outbound')}
          onClick={() => setComposing((c) => !c)}>💬 Send SMS</button>
        <button className="btn sm" type="button"
          disabled={!canEdit || !lead.email || lead.unsubscribed}
          title={lead.unsubscribed ? `${lead.name} has unsubscribed` : lead.email || 'No email address'}
          onClick={() => setEmailing(true)}>
          ✉ Send Email
        </button>
        <button className="btn ghost sm" type="button"
          onClick={() => document.getElementById(CALL_LOG_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          View Call History ({lead.calls.length})
        </button>
      </div>
      {hasPhone && (
        <p className="help" style={{ marginTop: 4 }}>
          {browserCall
            ? '📞 Make Call opens an in-browser dialler — talk to the lead through your computer, recorded and logged automatically.'
            : liveCall
              ? '📞 Make Call rings your phone, then connects the lead — recorded and logged automatically.'
              : '📞 Make Call opens your device dialler (no Twilio gateway configured) — log the outcome below.'}
        </p>
      )}
      {dialerOpen && (
        <TwilioDialer
          lead={{ id: lead.id, name: lead.name, phone: lead.phone }}
          onClose={() => setDialerOpen(false)}
          onLogged={onSent}
        />
      )}

      {emailing && canEdit && (
        <EmailComposer lead={lead} onClose={() => setEmailing(false)} onSent={() => { setEmailing(false); onSent(); }} />
      )}

      {lead.emails.length > 0 && (
        <>
          <div className="modal-sub">Email History ({lead.emails.length})</div>
          <ul className="lead-feed">
            {lead.emails.map((e) => (
              <li key={e.id}>
                <div className="lead-feed-body">
                  <strong>{e.subject}</strong>
                  {e.error && <div className="lead-sms-error" style={{ textAlign: 'left' }}>{e.error}</div>}
                </div>
                <div className="lead-feed-meta">
                  <span className={`pill ${e.status === 'sent' ? 'ok' : 'bad'}`}>
                    {e.status === 'sent' ? 'Sent' : 'Failed'}
                  </span>
                  <span className="muted">{stamp(e.sent_at)} · to {e.recipient}{e.sent_by ? ` · ${e.sent_by}` : ''}</span>
                  {/*
                    * Mostly used to clear repeated FAILED sends — a broken mailbox can leave five
                    * identical `invalid_grant` rows sitting on top of the correspondence that
                    * matters. The confirm says the record is kept in the audit trail, because
                    * deleting proof that a client was contacted is a different act from tidying,
                    * and the person clicking should know which one this is.
                    */}
                  {canEdit && (
                    <button className="btn ghost sm" type="button" title="Delete this email record"
                      onClick={() => ask(
                        'Delete this email record?',
                        `"${e.subject}" (${e.status === 'sent' ? 'sent' : 'failed'}) to ${e.recipient} will be removed from this lead's history. `
                        + 'It does not unsend anything, and the full record is kept in the audit trail.',
                        () => void run(() => deleteLeadEmail(lead.id, e.id), 'Email record deleted.'),
                      )}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {composing && canEdit && (
        <div className="lead-comm-compose">
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'outbound' | 'inbound')}>
            <option value="outbound">Sent to {lead.name.split(' ')[0]}</option>
            <option value="inbound">Received from {lead.name.split(' ')[0]}</option>
          </select>
          <textarea rows={3} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)}
            placeholder={direction === 'outbound' ? 'Type the message…' : 'What did they reply?'} />
          <div className="lead-comm-compose-row">
            <span className="help">
              {direction !== 'outbound' ? 'Recorded on the lead only.'
                : liveSms ? `Sent by the server from ${gateway?.from}. Delivery status updates on its own.`
                : 'Opens your messaging app with this text ready to send, and records it here.'}
            </span>
            <button className="btn primary sm" type="button" disabled={!text.trim()} onClick={() => void send()}>
              {direction !== 'outbound' ? 'Log Reply' : liveSms ? 'Send' : 'Open & Log'}
            </button>
          </div>
        </div>
      )}

      <div className="modal-sub">SMS Conversation ({lead.messages.length})</div>
      {lead.messages.length === 0 ? <p className="help">No SMS messages yet.</p> : (
        <>
          <ul className="lead-sms">
            {lead.messages.map((m) => (
              <li key={m.id} className={m.direction === 'inbound' ? 'in' : 'out'}>
                <div className="lead-sms-bubble">{m.body}</div>
                <div className="lead-sms-meta">
                  <span className="muted">{stamp(m.sent_at)}{m.created_by ? ` · ${m.created_by}` : ''}</span>
                  {canEdit && (
                    <button className="btn ghost sm" type="button" title="Delete this message"
                      onClick={() => ask(
                        'Delete this message?',
                        'It will be removed from the conversation on this lead. The message itself was sent from a phone and cannot be unsent.',
                        () => void run(() => deleteLeadMessage(lead.id, m.id), 'Message deleted.'),
                      )}>
                      Delete
                    </button>
                  )}
                  {m.status && <span className={`pill ${STATUS_PILL[m.status]}`}>{STATUS_LABEL[m.status]}</span>}
                  {/* With a gateway connected the status is the provider's, so it is not editable
                      — except Read, which no SMS provider ever reports and only a person knows. */}
                  {m.status && canEdit && !liveSms && (
                    <select className="sms-status" value={m.status} aria-label="Delivery status"
                      onChange={(e) => void run(
                        () => updateLeadMessage(lead.id, m.id, { status: e.target.value as MessageStatus }),
                        'Status updated.',
                      )}>
                      {(Object.keys(STATUS_LABEL) as MessageStatus[]).map((s) => (
                        <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                      ))}
                    </select>
                  )}
                  {m.status && canEdit && liveSms && m.status !== 'read' && m.status !== 'failed' && (
                    <button className="btn ghost sm" type="button"
                      onClick={() => void run(() => updateLeadMessage(lead.id, m.id, { status: 'read' }), 'Marked read.')}>
                      Mark read
                    </button>
                  )}
                </div>
                {m.error_message && <div className="lead-sms-error">{m.error_message}</div>}
              </li>
            ))}
          </ul>
          <p className="help">
            {liveSms ? (
              <>
                Sent through the SMS gateway, so <strong>Queued</strong>, <strong>Sent</strong>,
                <strong> Delivered</strong> and <strong>Failed to send</strong> come from the
                carrier and update on their own. <strong>Read</strong> stays a manual mark: plain
                SMS has no read receipt — no provider can report it — so tick it when the lead
                replies or confirms they saw the message.
              </>
            ) : (
              <>
                Statuses are set by hand. No SMS gateway is connected, so nothing can report
                delivery: mark a message <strong>Read</strong> when the lead replies or confirms
                they saw it, and <strong>Failed to send</strong> if the number bounced.
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Write one email to one lead.
 *
 * Not a campaign: there is no tracking pixel, no unsubscribe footer and no audience — it is
 * correspondence with a single person, sent through the SMTP account Email Settings manages. A
 * lead who has unsubscribed cannot be reached from here at all; the button is disabled and the
 * server refuses it too, so neither alone is load-bearing.
 *
 * Rendered outside the panel's `.card`: a card animates a transform, which makes it the
 * containing block for a fixed-position descendant and lands the overlay inside the card.
 */
function EmailComposer({ lead, onClose, onSent }: { lead: LeadDetail; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  // Once AI drafts the body it is real HTML, so it is sent verbatim; a hand-typed body is plain
  // text and gets escaped + newline-converted so markup can't sneak in and lines survive.
  const [isHtml, setIsHtml] = useState(false);
  /**
   * The HTML the preview was last SEEDED with, and the reason it is separate from `body`.
   *
   * The preview is edited in place, so it must not be re-rendered from `body` on every keystroke —
   * replacing an iframe's srcDoc destroys its document and puts the caret back at the start. This
   * changes only when the AI produces a new draft, which is the one moment the preview should be
   * thrown away and rebuilt.
   */
  const [seed, setSeed] = useState('');
  const previewRef = useRef<HTMLIFrameElement | null>(null);

  const generate = async () => {
    const p = aiPrompt.trim();
    if (!p || generating) return;
    setGenerating(true);
    try {
      const res = await generateLeadEmail(lead.id, p);
      setSubject(res.subject);
      setBody(res.html);
      setSeed(res.html);        // a new draft is the one time the preview is rebuilt from scratch
      setIsHtml(true);
      // Says which it is. A starter the server produced because the model was unavailable must not
      // read as "drafted for this lead" — the agent is about to send it to a real client.
      if (res.fallback) toast(res.reason ?? 'The AI service was unavailable — here is a blank starter to write in.', 'bad');
      else toast('Draft generated — review and send.', 'ok');
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not generate the email'), 'bad');
    } finally {
      setGenerating(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      // AI output is HTML already; a typed message is plain text, so convert newlines to <br>.
      const html = isHtml ? body.trim() : escapeHtml(body.trim()).replace(/\n/g, '<br>');
      await sendLeadEmail(lead.id, { subject: subject.trim(), body: html });
      toast(`Email sent to ${lead.email}.`, 'ok');
      onSent();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'The email could not be sent'), 'bad');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <div className="modal-head">
          <h3>Email {lead.name}</h3>
          <button className="btn ghost sm" type="button" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          {/* AI Email Generator */}
          <div className="field" style={{ background: 'var(--surface-2, var(--surface-2))', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>✨ AI Email Generator</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <textarea rows={2} style={{ flex: 1 }} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void generate(); } }}
                placeholder="Describe the email you want to send (e.g., 'Send a follow-up about the property showing we had yesterday')" />
              <button className="btn primary sm" type="button" style={{ whiteSpace: 'nowrap' }} disabled={generating || !aiPrompt.trim()} onClick={() => void generate()}>
                {generating ? 'Generating…' : '✨ Generate'}
              </button>
            </div>
            <div className="help" style={{ marginTop: 6 }}>💡 AI drafts a short personal email — plain wording, no template or branding. Review and edit before sending.</div>
            <div className="help" style={{ marginTop: 4 }}>
              <span style={{ fontWeight: 600 }}>Examples:</span>
              {AI_EMAIL_EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => setAiPrompt(ex)}
                  style={{ display: 'block', textAlign: 'left', background: 'none', border: 'none', color: 'var(--brand)', cursor: 'pointer', padding: '1px 0', fontSize: 12 }}>
                  • {ex}
                </button>
              ))}
            </div>
          </div>

          <p className="help">
            Sent to <strong>{lead.email}</strong> through your configured mail account. This is a
            one-off message, not a campaign — no tracking and no unsubscribe footer.
          </p>
          <div className="field">
            <label>Subject</label>
            <input value={subject} maxLength={255} autoFocus required
              onChange={(e) => setSubject(e.target.value)} placeholder="What is this about?" />
          </div>
          {isHtml ? (
            /*
              THE PREVIEW IS THE EDITOR. It used to be a read-only iframe with a raw-HTML textarea
              underneath, so editing an AI draft meant editing markup — the formatted email was the
              one thing you could not type into.
              THE SANDBOX IS NOT DROPPED TO ACHIEVE THAT, because the content is model output built
              from a prompt and lead fields, and rendering it into the app's own DOM would let an
              `onerror=` attribute run with the user's session. `allow-same-origin` WITHOUT
              `allow-scripts` is the pair that makes this safe: scripts and inline handlers still do
              not run, and the parent can reach `contentDocument` to make the body editable and read
              the edits back.
            */
            <div className="field">
              <label>Message</label>
              <iframe
                title="Email — click to edit"
                ref={previewRef}
                sandbox="allow-same-origin"
                srcDoc={seed}
                onLoad={() => {
                  const doc = previewRef.current?.contentDocument;
                  if (!doc) return;
                  doc.body.contentEditable = 'true';
                  doc.body.style.margin = '10px';
                  doc.body.style.font = '14px system-ui, sans-serif';
                  doc.body.style.outline = 'none';
                  // Every edit flows straight back into the value that gets sent, so what was typed
                  // is what leaves — there is no separate "apply" step to forget.
                  doc.body.addEventListener('input', () => setBody(doc.body.innerHTML));
                }}
                style={{ width: '100%', height: 300, border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }}
              />
              <div className="help">Click into the message to edit it. It sends exactly as it looks here.</div>
            </div>
          ) : (
            <div className="field">
              <label>Message</label>
              <textarea rows={10} value={body} required
                onChange={(e) => setBody(e.target.value)} placeholder={`Hi ${lead.name.split(' ')[0]},`} />
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn primary" type="submit" disabled={sending || !subject.trim() || !body.trim()}>
            {sending ? 'Sending…' : 'Send Email'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The message is typed as plain text; anything that looks like markup must not become markup. */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Starter prompts shown under the AI email generator. */
/*
 * Prompts that ask for correspondence, not campaign copy.
 *
 * "Create a welcome email for a new client with a market update" invited exactly the newsletter the
 * drafting prompt no longer produces, and an example is a stronger instruction than help text —
 * it is the thing agents actually click. These read like a note one person sends another.
 */
const AI_EMAIL_EXAMPLES = [
  "Follow up on yesterday's showing and ask what they thought",
  'Introduce myself and ask what they are looking for',
  'Check in — we have not heard back in a couple of weeks',
  'Thank them for their time and confirm the next step',
];

const MAX_RECORDING_BYTES = 8 * 1024 * 1024;   // mirrors the server's limit, to fail before uploading
const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.wav,.ogg,.webm,.flac';

const fileSize = (bytes: number): string =>
  (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The audio recording on a logged call: a player when one is attached, an upload control when
 * not. Nothing captures these automatically — there is no telephony integration — so this is the
 * file the agent's phone or dialler produced.
 *
 * The <audio> element streams from the API behind the same session cookie; the bytes are never
 * part of a lead payload.
 */
function Recording({ lead, call, canEdit, run, ask }: { lead: LeadDetail; call: LeadCall; canEdit: boolean; run: Run; ask: Ask }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const inputId = `rec-${call.id}`;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_RECORDING_BYTES) {
      toast(`That file is ${fileSize(file.size)}, above the 8 MB limit.`, 'bad');
      return;
    }
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read that file'));
        reader.readAsDataURL(file);
      });
      // `file.type` is blank for some formats on Windows; fall back to the extension so a valid
      // mp3 is not refused for the browser's failure to label it.
      const type = file.type || TYPE_BY_EXTENSION[file.name.split('.').pop()?.toLowerCase() ?? ''] || '';
      await run(
        () => addCallRecording(lead.id, call.id, { filename: file.name, content_type: type, data }),
        'Recording attached.',
      );
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not attach that recording'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (call.recording) {
    return (
      <div className="call-rec">
        <audio controls preload="none" src={callRecordingUrl(lead.id, call.id)} />
        <div className="call-rec-meta">
          <span className="muted">{call.recording.filename} · {fileSize(call.recording.size)}</span>
          <a className="btn ghost sm" href={callRecordingUrl(lead.id, call.id)} download={call.recording.filename}>Download</a>
          {canEdit && (
            <button className="btn ghost sm" type="button"
              onClick={() => ask(
                'Delete this recording?',
                'The audio of this conversation will be permanently removed. The call itself stays on the lead.',
                () => void run(() => deleteCallRecording(lead.id, call.id), 'Recording removed.'),
              )}>
              Remove
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!canEdit) return null;
  return (
    <div className="call-rec">
      <input id={inputId} type="file" accept={AUDIO_ACCEPT} className="visually-hidden" disabled={busy}
        onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      <label className="btn ghost sm" htmlFor={inputId}>{busy ? 'Attaching…' : '🎙 Attach recording'}</label>
    </div>
  );
}

/** Windows often reports a blank MIME type from a file input; the extension is the fallback. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/x-m4a', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac',
};

// ------------------------------------------------------------------- calls
function CallsPanel({ lead, options, canEdit, run, ask }: { lead: LeadDetail; options: LeadOptions | null; canEdit: boolean; run: Run; ask: Ask }) {
  const [outcome, setOutcome] = useState('connected');
  const [duration, setDuration] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <div className="card" id={CALL_LOG_ANCHOR}>
      <div className="modal-sub">Call Log ({lead.calls.length})</div>
      <p className="help">
        There is no telephony integration here, so calls are logged manually after the fact, and
        a recording is whatever audio file you attach from your phone or dialler.
        The <strong>No Calls</strong> counter on the Leads list counts leads with nothing logged.
      </p>
      {canEdit && (
        <div className="lead-add-grid">
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {(options?.call_outcome ?? ['connected']).map((o) => <option key={o} value={o}>{label(o)}</option>)}
          </select>
          <input type="number" min={0} value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="Seconds" />
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was said" />
          <button className="btn primary sm" type="button"
            onClick={() => void run(
              () => addLeadCall(lead.id, {
                outcome,
                duration: duration.trim() === '' ? null : Number(duration),
                notes: notes.trim(),
              }),
              'Call logged.',
            ).then(() => { setDuration(''); setNotes(''); })}>
            Log
          </button>
        </div>
      )}
      {lead.calls.length === 0 ? <p className="help">No calls logged.</p> : (
        <ul className="lead-feed">
          {lead.calls.map((c) => (
            <li key={c.id}>
              <div className="lead-feed-body">
                <strong>{c.outcome ? label(c.outcome) : 'Call'}</strong>
                {c.notes && <div className="muted">{c.notes}</div>}
                <Recording lead={lead} call={c} canEdit={canEdit} run={run} ask={ask} />
              </div>
              <div className="lead-feed-meta">
                <span className="muted">{stamp(c.called_at)}{c.duration != null ? ` · ${mmss(c.duration)}` : ''}{c.created_by ? ` · ${c.created_by}` : ''}</span>
                {canEdit && (
                  <button className="btn ghost sm" type="button" title="Delete this call log"
                    onClick={() => ask(
                      'Delete this call log?',
                      `The record of this call${c.outcome ? ` (${label(c.outcome)})` : ''} on ${stamp(c.called_at)} will be removed, along with any recording attached to it.`,
                      () => void run(() => deleteLeadCall(lead.id, c.id), 'Call log deleted.'),
                    )}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Schedule a follow-up for a lead. This writes a normal calendar event through the existing
 * Calendar API with `lead_id` set, so it appears on the calendar like any other appointment and
 * the Calendar module keeps sole ownership of events.
 */
function FollowUpModal({ lead, onClose, onSaved }: { lead: LeadDetail; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    title: `Follow up — ${lead.name}`,
    date: today(),
    time: '10:00',
    type: 'follow-up',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  /**
   * The overlap the API refused, if it did.
   *
   * The refusal message ends "…or save again with 'Book anyway' to keep both", and this modal used
   * to swallow the whole thing into a generic error toast — so the user was told to press a button
   * that did not exist here. `EventEditorModal` has offered it all along; this is the same handling,
   * against the same `allow_overlap` flag.
   */
  const [clash, setClash] = useState<string | null>(null);

  const submit = async (e: React.FormEvent, allowOverlap = false) => {
    e.preventDefault();
    setSaving(true);
    if (!allowOverlap) setClash(null);
    try {
      const payload: CalendarEventInput & { lead_id: number } = {
        title: form.title.trim(),
        date: form.date,
        time: form.time,
        type: form.type as CalendarEventInput['type'],
        status: 'scheduled',
        contact_email: lead.email,
        contact_phone: lead.phone ?? '',
        notes: form.notes.trim(),
        lead_id: lead.id,
        ...(allowOverlap ? { allow_overlap: true } : {}),
      };
      await createEvent('crm', payload);
      onSaved();
    } catch (ex) {
      const res = (ex as { response?: { data?: { conflict?: boolean; message?: string } } }).response?.data;
      if (res?.conflict) {
        // Deliberately NOT a toast. The choice it asks for needs the button beside it, and a toast
        // disappears while the user is still reading which appointment they collided with.
        setClash(res.message ?? 'This overlaps another appointment.');
      } else {
        toast(apiErrorMessage(ex, 'Could not create the follow-up'), 'bad');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h">Schedule Follow-up</div>
        <form onSubmit={submit}>
          <div className="field">
            <label>Title *</label>
            <input value={form.title} required onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </div>
          <div className="g3">
            <div className="field">
              <label>Date *</label>
              <input type="date" value={form.date} required onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="field">
              <label>Time *</label>
              <input type="time" value={form.time} required onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                {['follow-up', 'call', 'meeting', 'viewing', 'showing', 'task'].map((t) => (
                  <option key={t} value={t}>{label(t)}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Notes</label>
            <textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
          <span className="help">Appears on the Calendar and stays linked to this lead.</span>

          {/*
            The overlap, and the way through it. Double-booking is sometimes deliberate — two
            viewings at one address, a call during a long meeting — so the API refuses once, says
            what was hit, and accepts `allow_overlap` on the second attempt. Showing the collision
            and the button together is what makes that an informed choice rather than a dead end.
          */}
          {clash && (
            <div className="field-err" style={{ marginTop: 8 }} role="alert">{clash}</div>
          )}

          <div className="actions">
            <button className="btn ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            {clash && (
              <button className="btn ghost" type="button" disabled={saving}
                onClick={(e) => void submit(e as unknown as React.FormEvent, true)}>
                Book anyway
              </button>
            )}
            <button className="btn primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add to Calendar'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
