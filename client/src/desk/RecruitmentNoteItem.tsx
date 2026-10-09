import { useState } from 'react';
import { deleteCandidateNote, setCandidateNotePinned, updateCandidateNote } from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import type { CandidateNote } from '../types/recruitment';

const dateTime = (v: string | null): string => (v ? new Date(v).toLocaleString() : '—');

/**
 * ONE SAVED NOTE, with Edit and Delete for people who may change it — the same row on the candidate
 * page and in the notes modal, so the two can never behave differently.
 *
 * Editing changes the text only: the author and the time it was written stay as they were, and the
 * server records the edit in the candidate's history. A failed save keeps what was typed, with the
 * reason, rather than closing and losing it. Delete asks first. Neither is offered without
 * Recruitment: edit — and the server refuses them anyway.
 *
 * PINNING IS SHARED, NOT A PER-VIEWER PREFERENCE. It is saved on the note, so it survives a refresh
 * and everyone who may see the candidate sees the same notes at the top. It therefore needs the
 * same permission as editing, and is offered on the same terms.
 */
export default function RecruitmentNoteItem({
  candidateId, note, canEdit, onChanged,
}: {
  candidateId: number;
  note: CandidateNote;
  canEdit: boolean;
  /** Called after a successful edit or delete, so the owner can re-read its notes. */
  onChanged: () => void | Promise<void>;
}) {
  const toast = useToast();
  const { confirm, askDelete, closeConfirm } = useConfirm();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const startEdit = () => { setText(note.body); setError(''); setEditing(true); };
  const cancel = () => { setEditing(false); setText(note.body); setError(''); };

  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await updateCandidateNote(candidateId, note.id, text.trim());
      setEditing(false);
      toast('Note updated.', 'ok');
      await onChanged();
    } catch (ex) {
      setError(apiErrorMessage(ex, 'The note could not be saved'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * `busy` is the SAME flag Edit and Delete use, so a pin in flight disables all three rather than
   * only itself. Two writes to one note cannot race, and a second click on Pin while the first is
   * still going cannot reach the server at all.
   */
  const togglePin = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await setCandidateNotePinned(candidateId, note.id, !note.pinned);
      toast(note.pinned ? 'Note unpinned.' : 'Note pinned.', 'ok');
      await onChanged();
    } catch (ex) {
      // Visible on the note itself, not only as a toast: the row did not move, and this says why.
      setError(apiErrorMessage(ex, note.pinned ? 'The note could not be unpinned' : 'The note could not be pinned'));
    } finally {
      setBusy(false);
    }
  };

  const remove = () => askDelete({
    title: 'Delete this note?',
    message: (
      <>
        <div style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{note.body}</div>
        <div className="muted" style={{ marginTop: 6 }}>{note.author || 'Someone'} · {dateTime(note.created_at)}</div>
      </>
    ),
    note: 'This cannot be undone. The deletion is recorded in the candidate\'s history.',
    confirmLabel: 'Delete note',
    onConfirm: () => {
      void (async () => {
        setBusy(true);
        setError('');
        try {
          await deleteCandidateNote(candidateId, note.id);
          toast('Note deleted.', 'ok');
          await onChanged();
        } catch (ex) {
          setError(apiErrorMessage(ex, 'The note could not be deleted'));
        } finally {
          setBusy(false);
        }
      })();
    },
  });

  return (
    <div data-note-id={note.id} data-pinned={note.pinned ? 'true' : 'false'} style={{ marginBottom: 10 }}>
      {editing ? (
        <>
          <textarea rows={4} value={text} disabled={busy} autoFocus aria-label="Edit note"
            onChange={(e) => setText(e.target.value)} />
          <div className="toolbar-row" style={{ gap: 6, marginTop: 4 }}>
            <button className="btn primary sm" type="button" disabled={busy || !text.trim()}
              title={!text.trim() ? 'A note needs something in it' : undefined} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn ghost sm" type="button" disabled={busy} onClick={cancel}>Cancel</button>
          </div>
        </>
      ) : (
        <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>
      )}
      <div className="toolbar-row" style={{ gap: 6, alignItems: 'center' }}>
        {/*
          The indicator is shown to EVERYONE who can read the note, including view-only people who
          have no Pin button — otherwise a note would sit at the top of their list for no visible
          reason. `aria-label` carries the word, because the pin glyph alone reads as nothing.
        */}
        {note.pinned && (
          <span className="pill ok" data-testid="note-pinned-badge" aria-label="Pinned note"
            style={{ fontSize: 11 }}>📌 Pinned</span>
        )}
        <span className="muted">{note.author || 'Someone'} · {dateTime(note.created_at)}</span>
        {canEdit && !editing && (
          <>
            <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void togglePin()}
              data-testid="note-pin-toggle" aria-pressed={note.pinned}
              aria-label={note.pinned ? 'Unpin this note' : 'Pin this note to the top'}
              title={note.pinned ? 'Unpin this note' : 'Pin this note to the top'}>
              {note.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button className="btn ghost sm" type="button" disabled={busy} onClick={startEdit}>Edit</button>
            <button className="btn ghost sm" type="button" disabled={busy} onClick={remove}>Delete</button>
          </>
        )}
      </div>
      {error && <p className="help bad" role="alert" style={{ margin: '4px 0 0' }}>{error}</p>}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </div>
  );
}
