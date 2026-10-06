import { useCallback, useEffect, useState } from 'react';
import { candidateMessages, sendCandidateSms, setSmsConsent, smsComposer } from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import type { RecruitmentMessage, SmsComposer } from '../types/recruitment';

/**
 * Texting a candidate.
 *
 * ONE COMPONENT FOR BOTH SCREENS — the Candidates list and the candidate's own page. Texting
 * somebody has rules (a number that can be dialled, a gateway that exists, a preview before it
 * goes), and a second copy of this on the list would be the copy that drifts out of step with them.
 *
 * THE NUMBER IS SHOWN BUT NEVER SENT. `smsComposer` returns the number the SERVER read off the
 * candidate, and `sendCandidateSms` posts only the message text. The screen therefore cannot
 * redirect a text, by accident or otherwise — see `RecruitmentSmsService` for what that rule is
 * protecting against.
 *
 * PREVIEW IS A STEP, NOT A PANEL. Writing and sending are separated by an explicit press, because
 * an SMS cannot be recalled: there is no outbox, no "sending…" window and no edit after the fact.
 * The preview shows exactly the characters that will be transmitted, including the trailing spaces
 * and line breaks that a textarea makes easy to leave behind.
 */

/** Twilio bills per segment; these are the thresholds a sender should see before they press Send. */
const GSM_SEGMENT = 160;
const MAX_BODY = 480;

export function messageStatusPill(status: string): string {
  if (status === 'delivered') return 'pill ok';
  if (status === 'failed') return 'pill bad';
  if (status === 'sent') return 'pill info';
  return 'pill warn';   // queued — accepted by the gateway, not yet gone
}

/** What each status actually means, because "sent" and "delivered" are not the same promise. */
export function messageStatusHint(status: string): string {
  if (status === 'delivered') return "The carrier confirmed it reached the candidate's handset.";
  if (status === 'failed') return 'It did not go. The reason is recorded beside it.';
  if (status === 'sent') return 'Handed to the carrier. Delivery has not been confirmed yet.';
  return 'Accepted by the gateway and waiting to go out.';
}

export default function RecruitmentSendText({
  candidateId, onClose, onSent,
}: {
  candidateId: number;
  onClose: () => void;
  /** So the page behind can refresh its history without this component knowing how. */
  onSent?: () => void;
}) {
  const toast = useToast();
  const [state, setState] = useState<SmsComposer | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<RecruitmentMessage[]>([]);

  const load = useCallback(async () => {
    try {
      const [c, history] = await Promise.all([smsComposer(candidateId), candidateMessages(candidateId)]);
      setState(c);
      setSent(history.data);
      // The template is a starting point. Loaded into the box so it can be edited, not pinned
      // above it where it would have to be retyped to change one word.
      setText(c.template);
      setError('');
    } catch (ex) {
      setError(apiErrorMessage(ex, 'Could not open the composer'));
    }
  }, [candidateId]);

  useEffect(() => { void load(); }, [load]);

  const trimmed = text.trim();
  const segments = Math.max(1, Math.ceil(trimmed.length / GSM_SEGMENT));
  const tooLong = trimmed.length > MAX_BODY;
  const canSend = !!state?.can_send && !!trimmed && !tooLong && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      await sendCandidateSms(candidateId, trimmed);
      toast('Text sent.', 'ok');
      onSent?.();
      onClose();
    } catch (ex) {
      /*
       * STAYS OPEN ON FAILURE, with the message still in the box. The commonest failure is a number
       * the carrier rejects, and closing would throw away what was written at the exact moment
       * somebody wants to fix the number and send it again.
       */
      toast(apiErrorMessage(ex, 'The text could not be sent'), 'bad');
      setPreviewing(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h">Send a text</div>

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
                {/* The number the SERVER will dial, in the form it will dial it. */}
                <div className="muted">{state.to ?? state.candidate.phone ?? 'No phone number'}</div>
              </dd>
            </dl>

            {state.blocked_reason && <p className="help bad">{state.blocked_reason}</p>}

            {/*
              * OFFERED WHERE THE REFUSAL IS, because that is where somebody finds out they need it —
              * and only when the answer is genuinely missing. A candidate who said NO is not offered
              * a one-click "actually yes": that is a decision to go and have a conversation about,
              * not a button to press while a composer is open.
              */}
            {state.consent.answer === null && (
              <div className="field">
                <p className="help">
                  If {state.candidate.name.split(' ')[0]} has agreed to be texted, record it here and
                  it will be kept with their file, with your name and today's date.
                </p>
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={busy}
                  onClick={() => void (async () => {
                    setBusy(true);
                    try {
                      await setSmsConsent(candidateId, true, 'Recorded from the Send Text composer');
                      toast('Agreement recorded.', 'ok');
                      await load();
                      onSent?.();
                    } catch (ex) {
                      toast(apiErrorMessage(ex, 'Could not record that'), 'bad');
                    } finally {
                      setBusy(false);
                    }
                  })()}
                >
                  They agreed to be texted
                </button>
              </div>
            )}

            {state.consent.answer === true && state.consent.by && (
              <p className="help">
                Agreed to be texted — recorded by {state.consent.by}
                {state.consent.at ? ` on ${new Date(state.consent.at).toLocaleDateString()}` : ''}.
              </p>
            )}

            {!previewing ? (
              <>
                <div className="field">
                  <label>Message</label>
                  <textarea
                    rows={5}
                    value={text}
                    disabled={!state.can_send}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <span className={tooLong ? 'help bad' : 'help'}>
                    {trimmed.length} characters
                    {trimmed.length > GSM_SEGMENT && ` · ${segments} segments`}
                    {tooLong && ` · over the ${MAX_BODY}-character limit`}
                  </span>
                </div>
                <p className="help">
                  An interview confirmation is filled in for you, with the date, time, time zone and
                  where to go. Edit it freely — it is a starting point, not a form.
                </p>
                <div className="toolbar-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={!canSend}
                    onClick={() => setPreviewing(true)}
                  >
                    Preview
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-sub">Preview</div>
                {/*
                  * `pre-wrap` on purpose: this is the message as the handset will render it, so the
                  * line breaks and the double space somebody left in must be visible here.
                  */}
                <p className="help">This is exactly what will be sent to {state.to}.</p>
                <div className="card" style={{ whiteSpace: 'pre-wrap' }}>{trimmed}</div>
                <p className="help bad" style={{ marginTop: 8 }}>
                  A text cannot be recalled once it is sent.
                </p>
                <div className="toolbar-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => setPreviewing(false)}>
                    Back to editing
                  </button>
                  <button className="btn primary" type="button" disabled={!canSend} onClick={() => void send()}>
                    {busy ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </>
            )}

            {sent.length > 0 && (
              <>
                <div className="modal-sub" style={{ marginTop: 14 }}>Already sent</div>
                <div className="lead-scroll" style={{ maxHeight: 180 }}>
                  <table className="list-table">
                    <thead><tr><th>When</th><th>Status</th><th>Message</th></tr></thead>
                    <tbody>
                      {sent.map((m) => (
                        <tr key={m.id}>
                          <td>{new Date(m.sent_at).toLocaleString()}</td>
                          <td>
                            <span className={messageStatusPill(m.status)} title={messageStatusHint(m.status)}>
                              {m.status}
                            </span>
                            {m.error_message && <div className="muted">{m.error_message}</div>}
                          </td>
                          <td>{m.body}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
