import { useCallback, useEffect, useState } from 'react';
import { emailComposer, previewCandidateEmail, sendCandidateEmail } from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import type { EmailComposer, RecruitmentEmail } from '../types/recruitment';

const SUBJECT_MAX = 255;
const MESSAGE_MAX = 20_000;

/** How an email's status reads in the history. */
export function emailStatusPill(s: RecruitmentEmail['status']): string {
  if (s === 'sent') return 'pill ok';
  if (s === 'failed') return 'pill bad';
  if (s === 'skipped') return 'pill warn';
  return 'pill info';
}

/**
 * SEND MAIL — an email to the candidate's saved address, from the brokerage's CRM mail account.
 *
 * Write, preview, send: the preview is the HTML the server built from what was typed, so what is
 * shown is what goes. Nothing here decides who may send — the server checks Recruitment: edit and
 * the candidate scope on every request. SMS consent plays no part: agreeing to texts is about texts.
 */
export default function RecruitmentSendMail({
  candidateId, onClose, onSent,
}: {
  candidateId: number;
  onClose: () => void;
  /** So the page behind can refresh its email history. */
  onSent?: () => void;
}) {
  const toast = useToast();
  const [state, setState] = useState<EmailComposer | null>(null);
  const [error, setError] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<{ to: string; subject: string; html: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await emailComposer(candidateId);
      setState(c);
      setError('');
      // A starting point, loaded into the boxes so it can be changed rather than retyped.
      setSubject((s) => s || (c.from ? `Your application with ${c.from.name}` : 'Your application'));
      setMessage((m) => m || `Hi ${c.candidate.name.trim().split(/\s+/)[0] || c.candidate.name},\n\n`);
    } catch (ex) {
      setError(apiErrorMessage(ex, 'Could not open the composer'));
    }
  }, [candidateId]);

  useEffect(() => { void load(); }, [load]);

  const s = subject.trim();
  const m = message.trim();
  const problem = !s ? 'The email needs a subject.'
    : s.length > SUBJECT_MAX ? `The subject can be at most ${SUBJECT_MAX} characters.`
      : !m ? 'The email needs a message.'
        : m.length > MESSAGE_MAX ? `The message can be at most ${MESSAGE_MAX} characters.` : null;
  const ready = !!state?.can_send && !problem && !busy;

  const showPreview = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      setPreview(await previewCandidateEmail(candidateId, { subject: s, message: m }));
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not build the preview'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!ready || !preview) return;
    setBusy(true);
    try {
      const r = await sendCandidateEmail(candidateId, { subject: s, message: m });
      toast(r.contacted ? 'Email sent. Moved to Contacted.' : 'Email sent.', 'ok');
      onSent?.();
      onClose();
    } catch (ex) {
      // Stays open with the message intact: the failure is recorded in the history, and the fix
      // (a corrected address, a reconnected mailbox) is usually followed by sending it again.
      toast(apiErrorMessage(ex, 'The email could not be sent'), 'bad');
      setPreview(null);
      onSent?.();
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal">
        <button className="close" type="button" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        <div className="modal-h">Send mail</div>

        {error ? (
          <p className="help bad">{error}</p>
        ) : !state ? (
          <p className="help">Opening…</p>
        ) : (
          <>
            <dl className="lead-dl">
              <dt>To</dt>
              <dd>
                {state.candidate.name}
                <div className="muted">{state.candidate.email ?? 'No email address on file'}</div>
              </dd>
              <dt>From</dt>
              <dd>{state.from ? `${state.from.name} <${state.from.email}>` : <span className="muted">No CRM mail account connected</span>}</dd>
            </dl>

            {state.blocked_reason && <p className="help bad">{state.blocked_reason}</p>}

            {!preview ? (
              <>
                <div className="field">
                  <label>Subject</label>
                  <input value={subject} maxLength={SUBJECT_MAX} disabled={!state.can_send} onChange={(e) => setSubject(e.target.value)} />
                </div>
                <div className="field">
                  <label>Message</label>
                  <textarea rows={8} value={message} disabled={!state.can_send} onChange={(e) => setMessage(e.target.value)} />
                  <span className={problem && (s || m) ? 'help bad' : 'help'}>
                    {problem && (s || m) ? problem : `${m.length} characters`}
                  </span>
                </div>
                <div className="toolbar-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
                  <button className="btn primary" type="button" disabled={!ready} onClick={() => void showPreview()}
                    title={!state.can_send ? (state.blocked_reason ?? undefined) : (problem ?? undefined)}>
                    {busy ? 'Preparing…' : 'Preview'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-sub">Preview</div>
                <p className="help">This is exactly what will be sent to {preview.to}.</p>
                <div className="card" style={{ padding: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>{preview.subject}</div>
                  {/* Built by the server from what was typed, with every character escaped. */}
                  <div dangerouslySetInnerHTML={{ __html: preview.html }} />
                </div>
                <div className="toolbar-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => setPreview(null)}>Back to editing</button>
                  <button className="btn primary" type="button" disabled={!ready} onClick={() => void send()}>
                    {busy ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
