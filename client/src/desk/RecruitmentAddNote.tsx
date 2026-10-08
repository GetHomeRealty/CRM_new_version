import { useEffect, useState } from 'react';
import { addCandidateNote, getCandidate } from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import type { CandidateNote } from '../types/recruitment';

const dateTime = (v: string | null): string => (v ? new Date(v).toLocaleString() : '—');

/**
 * ADD NOTE, from a row on the Interviews tab — the candidate's own notes, without leaving the list.
 *
 * The same notes the candidate page shows and the same endpoint it saves through
 * (`POST /api/recruitment/candidates/:id/notes`), so a note written here is in that history, with its
 * author and time, and nowhere else. Saving a note changes nothing about the candidate's or the
 * interview's status: a note records interest, availability or how a follow-up went, and moving the
 * candidate on stays a separate, deliberate step on the candidate page.
 *
 * Who may write is the server's decision (Recruitment: edit, within the candidates they may see);
 * the button is only offered to people who hold that permission.
 */
export default function RecruitmentAddNote({
  candidateId, candidateName, onClose,
}: {
  candidateId: number;
  candidateName: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [notes, setNotes] = useState<CandidateNote[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getCandidate(candidateId)
      .then((d) => { if (live) { setNotes(d.notes); setLoadError(''); } })
      .catch((ex) => { if (live) setLoadError(apiErrorMessage(ex, 'Could not load this candidate\'s notes')); });
    return () => { live = false; };
  }, [candidateId]);

  const body = text.trim();
  const save = async () => {
    if (!body || busy) return;
    setBusy(true);
    try {
      await addCandidateNote(candidateId, body);
      toast('Note added.', 'ok');
      onClose();
    } catch (ex) {
      // Stays open with the text intact, so nothing typed is lost to a failed save.
      toast(apiErrorMessage(ex, 'The note could not be saved'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="recruitment-add-note-title">
        <button className="close" type="button" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        <div className="modal-h" id="recruitment-add-note-title">Add note</div>
        <p className="help" style={{ marginTop: 0 }}>
          Candidate: <strong data-testid="add-note-candidate">{candidateName}</strong>
        </p>

        <div className="field">
          <label htmlFor="recruitment-add-note-text">Note <span className="muted">(required)</span></label>
          <textarea id="recruitment-add-note-text" rows={5} value={text} required autoFocus
            placeholder="Interest, availability, how the follow-up went…"
            onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="toolbar-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" type="button" disabled={!body || busy || !!loadError}
            title={!body ? 'Write a note first' : undefined} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>

        <div className="modal-sub" style={{ marginTop: 12 }}>Notes</div>
        <div data-testid="add-note-history" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {loadError ? (
            <p className="help bad">{loadError}</p>
          ) : !notes ? (
            <p className="help">Loading notes…</p>
          ) : notes.length === 0 ? (
            <p className="help">No notes yet.</p>
          ) : notes.map((n) => (
            <div key={n.id} data-note-id={n.id} style={{ marginBottom: 8 }}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
              <div className="muted">{n.author || 'Someone'} · {dateTime(n.created_at)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
