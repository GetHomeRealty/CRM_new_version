import { useEffect, useRef, useState } from 'react';
import { fetchOnboardingAttachment, fetchOnboardingDocument, getOnboardingPreview, sendOnboardingEmail, type OnboardingAttachment, type OnboardingKind, type OnboardingPreview } from '../lib/api';
import RichTextEditor, { type RichTextHandle } from './RichTextEditor';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';

/**
 * Review before sending — for each of the letters a new agent receives from the Users screen.
 *
 * The buttons open the message as it will actually arrive for this agent, with the variables
 * already filled in and the template's attachments listed, and it can be edited before it goes.
 *
 * The edit applies to this send only. Adjusting a sentence for one agent must not quietly rewrite
 * what every future agent receives — Settings → Templates is where the template itself changes,
 * and that is said on screen so the distinction is not a surprise.
 */

/**
 * The heading over the review.
 *
 * `onboard` is deliberately not named "Fresher" or "Experienced" here: which of the two it is comes
 * back with the preview, and a heading guessed on this side could contradict the message under it.
 */
const KIND_LABEL: Record<OnboardingKind, string> = {
  onboard: 'Onboarding Email',
  contract: 'Contract Agreement',
  accounting: 'Accounting Onboarding Email',
  training: 'Training Onboarding Email',
  media: 'Listing Media & Marketing Fee Agreement',
};

/* ------------------------------------------------------------------ blanks
 *
 * THE RULED LINES ARE FILLED IN HERE, on the preview, rather than only through the rich-text
 * editor. A contract arrives with blanks for the things the profile does not hold — the agent's
 * address, the signature and date lines, Other Remarks — and the person sending it is the person
 * who knows what goes in them. Making them type into raw HTML to fill a line is the sort of thing
 * that produces a contract with a broken tag in it.
 *
 * Every blank looks the same wherever it came from: the template writes one and
 * `UserOnboardingService.BLANK` writes an identical one for a variable the profile leaves empty, so
 * a single pattern finds both.
 */
const RULE_SPAN = /<span style="color:#9ca3af">(_+)<\/span>/g;

/**
 * A blank is a BORDER, not a row of underscore characters.
 *
 * The first attempt kept the underscores and let people type among them, which produced exactly
 * what it sounds like: `______hfkjhgfjgk________`. Underscores are text, so a caret sits between
 * them and the typed words end up threaded through the rule. Drawing the line with a bottom border
 * instead leaves the span's text content genuinely empty, so whatever is typed lands ON the line
 * with nothing else in it — and an untouched blank still prints as a ruled line, in the email and
 * in the PDF, because the border is an inline style rather than a stylesheet rule.
 *
 * The original underscore COUNT is kept as the width, so each line stays the length the form drew
 * it — a signature line and the Other Remarks line are not the same size.
 */
const blankStyle = (chars: number): string =>
  // `min-width` sets the length the form drew, `max-width` stops it growing past the page: without
  // the second, a long remark ran off the right edge on one endless line instead of wrapping, because
  // an inline-block with only a minimum has no reason to break. `overflow-wrap:anywhere` handles the
  // case a soft-wrap cannot — an address or reference typed with no spaces in it.
  `display:inline-block;min-width:${Math.round(chars * 6.2)}px;max-width:100%;`
  + 'white-space:normal;overflow-wrap:anywhere;word-break:break-word;'
  + 'border-bottom:1px solid #9ca3af;line-height:1.5;text-align:left';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Give every blank a stable id, and remember how long its line was.
 *
 * Done ONCE, when the preview arrives. The id is what lets an edit find the same blank again after
 * the body has changed — counting them afresh each time would renumber them the moment one was
 * filled, and the second edit would land in the wrong line.
 */
/**
 * What a particular blank is for, decided by the words in front of it.
 *
 * NOT EVERY BLANK IS TYPED INTO. A signature line is signed by hand on the printed copy — a name
 * keyed into it is not a signature and should not be able to look like one. The agent's address is
 * held on their profile, so typing over it here would put a different address on the contract than
 * the record has, silently. A date is typed into, but by picking one, because a contract with
 * "19/8" or "next Friday" on it is a document nobody can rely on.
 *
 * Read from the label rather than from the blank's position: the positions shift whenever the
 * template is edited, and the label is what a reader uses to know what the line is for too.
 */
type BlankKind = 'text' | 'date' | 'locked';

const blankKindFor = (preceding: string): BlankKind => {
  const label = preceding.slice(-70).replace(/<[^>]*>/g, ' ').toLowerCase();
  if (/signature/.test(label)) return 'locked';
  if (/residing at/.test(label)) return 'locked';
  if (/date/.test(label)) return 'date';
  return 'text';
};

const tagBlanks = (html: string): string => {
  let i = 0;
  return html.replace(RULE_SPAN, (_m, rule: string, offset: number, whole: string) => {
    const kind = blankKindFor(whole.slice(0, offset));
    return `<span data-blank="${i++}" data-kind="${kind}" data-rule="${rule.length}" style="${blankStyle(rule.length)}"></span>`;
  });
};

/** The same body with its blanks made typeable and its tick boxes clickable. Display only. */
const asEditable = (html: string): string => html
  // Typed into directly.
  .replace(/<span data-blank="(\d+)" data-kind="text"/g,
    '<span class="onb-blank" contenteditable="true" data-blank="$1" data-kind="text"')
  // Clicked to open a date picker — never typed into, so no `contenteditable`.
  .replace(/<span data-blank="(\d+)" data-kind="date"/g,
    '<span class="onb-blank onb-date" role="button" tabindex="0" title="Pick a date" data-blank="$1" data-kind="date"')
  // Signature and address lines: shown, never filled in here.
  .replace(/<span data-blank="(\d+)" data-kind="locked"/g,
    '<span class="onb-locked" title="Signed by hand on the printed copy" data-blank="$1" data-kind="locked"')
  .replace(/<span data-check="(\d+)"/g, '<span class="onb-check" role="checkbox" tabindex="0" data-check="$1"');

/*
 * TICKING A BOX.
 *
 * Not `<input type="checkbox">`, deliberately: mail clients strip or ignore form controls and a
 * checkbox does not survive into a PDF, so the box is a bordered span and the tick is the letter X
 * inside it. What is sent and what is printed are then the same thing that was on screen.
 *
 * The state lives in the body itself rather than beside it. A separate `checked` map would have to
 * be merged back in at send time and at PDF time, and any path that forgot would mail an unticked
 * form — whereas an X written into the body is carried by every one of those paths for free.
 */
const toggleCheck = (html: string, id: string): string =>
  html.replace(
    new RegExp(`(<span data-check="${id}"[^>]*>)([\\s\\S]*?)(</span>)`),
    (_m, open: string, body: string, close: string) => `${open}${body.trim() === 'X' ? '' : 'X'}${close}`,
  );

/** Put `text` on blank `id`; empty leaves the line ruled and bare. */
const fillBlank = (html: string, id: string, text: string): string => {
  const value = text.replace(/\s+/g, ' ').trim();
  return html.replace(
    new RegExp(`<span data-blank="${id}" data-kind="([a-z]+)" data-rule="(\\d+)"[^>]*>[\\s\\S]*?</span>`),
    (_m, kind: string, chars: string) =>
      `<span data-blank="${id}" data-kind="${kind}" data-rule="${chars}" style="${blankStyle(Number(chars))}">${escapeHtml(value)}</span>`,
  );
};

/** Said under the heading, so which of the two onboarding guides this is can be read at a glance. */
const EVENT_LABEL: Record<string, string> = {
  'user.onboard_email': 'experienced agent',
  'user.onboard_email_fresher': 'fresher',
};

/**
 * Why a file could not be opened.
 *
 * These requests ask for a Blob, so axios hands the error body back as a Blob as well — the usual
 * reader finds no `message` on it and every failure reads the same. Reading the blob back as text
 * is what turns "Could not open that file" into the reason it could not be opened.
 */
async function fileErrorMessage(e: unknown): Promise<string> {
  const body = (e as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (body instanceof Blob) {
    try {
      const parsed = JSON.parse(await body.text()) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
    } catch { /* not JSON — fall through to the generic message */ }
  }
  return apiErrorMessage(e, 'Could not open that file');
}

export default function OnboardingEmailModal({ userId, kind, onClose }: {
  userId: number;
  kind: OnboardingKind;
  onClose: () => void;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState<OnboardingPreview | null>(null);
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const bodyRef = useRef<RichTextHandle>(null);
  /**
   * Files picked here go with this email only and are never stored on the template.
   *
   * That is the point for a contract agreement: it is filled in for one agent, so keeping it on
   * the template would attach that agent's copy to every future send.
   */
  const [files, setFiles] = useState<(OnboardingAttachment & { size: number })[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The attachment being read right now, shown in place below the list. */
  const [viewing, setViewing] = useState<{ name: string; url: string; type: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  /**
   * The date blank waiting on the picker, and the native input that provides it.
   *
   * A real `<input type="date">` rather than a calendar drawn here: it is the control people
   * already know, it is keyboard- and screen-reader-accessible for free, and it cannot produce a
   * date that does not exist. It lives outside the message and never appears in what is sent —
   * only the formatted result is written into the body.
   */
  const [dateFor, setDateFor] = useState<string | null>(null);
  /*
   * The same id again, in a ref. `dateFor` drives whether the field is VISIBLE; this drives
   * where the chosen date is WRITTEN. They are separate because dismissing the field and
   * receiving its value race: picking a day from the native calendar can fire blur before
   * change, and a handler reading state would find the target already cleared and write
   * nothing. A ref is set synchronously and cannot be overtaken.
   */
  const dateForRef = useRef<string | null>(null);
  const dateInput = useRef<HTMLInputElement>(null);

  // The object URL outlives React's rendering, so it is released on the way out.
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  useEffect(() => {
    getOnboardingPreview(userId, kind)
      // Tagged on arrival, so every later edit addresses a blank by id rather than by position.
      .then((p) => { setPreview(p); setSubject(p.subject); setHtml(tagBlanks(p.html)); })
      .catch((e) => { toast(apiErrorMessage(e, 'Could not build the preview'), 'bad'); onClose(); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, kind]);

  /**
   * Put a real date field on the line that was clicked, and open its picker.
   *
   * SYNCHRONOUSLY, INSIDE THE CLICK. `showPicker()` requires user activation, and a `setTimeout` —
   * however short — ends it: the call then throws NotAllowedError and nothing opens. The first
   * version did exactly that, and because the fallback focused a 1px transparent input, a real click
   * appeared to do nothing at all. (An automated test missed it by dispatching events directly,
   * which never needed activation in the first place.)
   *
   * The input is also MOVED OVER THE BLANK and made visible, rather than hidden off-screen. That is
   * what makes this work on a browser with no `showPicker` and on one that refuses it: the person
   * sees an ordinary date field sitting on the line, and can type into it or open its own calendar.
   */
  const openPicker = (id: string, anchor: HTMLElement) => {
    dateForRef.current = id;
    setDateFor(id);
    const el = dateInput.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    el.style.left = `${Math.round(r.left)}px`;
    el.style.top = `${Math.round(r.top)}px`;
    el.style.width = `${Math.max(150, Math.round(r.width))}px`;
    try { (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); }
    catch { /* not permitted here — the visible field below is the way in */ }
    el.focus();
  };

  /**
   * Write the chosen day onto the blank, spelled out.
   *
   * "19 August 2026", not 19/08/2026: this is a contract read in two countries whose conventions
   * disagree about which number is the month, and a date nobody can misread is worth six characters.
   */
  const chooseDate = (iso: string) => {
    const target = dateForRef.current;
    if (!target || !iso) return;
    const [y, m, d] = iso.split('-').map(Number);
    const text = new Date(y, m - 1, d).toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' });
    setHtml((h) => fillBlank(h, target, text));
    dateForRef.current = null;
    setDateFor(null);
  };

  const pick = async (file: File | null) => {
    if (!file) return;
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? '').split(',')[1] ?? '');
        r.onerror = () => reject(new Error('Could not read that file'));
        r.readAsDataURL(file);
      });
      setFiles((f) => [...f, { filename: file.name, content_type: file.type || 'application/octet-stream', data, size: file.size }]);
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not read that file'), 'bad');
    } finally {
      // Cleared so picking the same file again still fires change.
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const send = async () => {
    setSending(true);
    try {
      const r = await sendOnboardingEmail(userId, kind, {
        subject,
        html,
        attachments: files.map(({ filename, content_type, data }) => ({ filename, content_type, data })),
      });
      toast(r.message, 'ok');
      onClose();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not send'), 'bad');
    } finally { setSending(false); }
  };

  const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

  /**
   * Show an attachment in place, under the list it was clicked in — not in another browser tab, so
   * the email being reviewed stays on screen next to the document it refers to.
   *
   * One object URL is alive at a time, revoked when it is replaced, closed, or the dialog goes away.
   * Held in a ref rather than state because it has to be released on the way out, when there is no
   * longer a render to read it from.
   */
  const show = (name: string, blob: Blob) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = URL.createObjectURL(blob);
    setViewing({ name, url: urlRef.current, type: blob.type || '' });
  };

  const closeViewer = () => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setViewing(null);
  };

  /** A file on the template is fetched back from the API — only its name and size were listed. */
  const viewStored = async (a: { id: number; filename: string }) => {
    setOpening(`t${a.id}`);
    try {
      show(a.filename, await fetchOnboardingAttachment(kind, a.id));
    } catch (e) {
      toast(await fileErrorMessage(e), 'bad');
    } finally {
      setOpening(null);
    }
  };

  /**
   * The generated agreement, rendered from the message as it stands right now — including an edit
   * made in this dialog, since that is the copy that will be attached.
   */
  const viewDocument = async (name: string) => {
    setOpening('doc');
    try {
      show(name, await fetchOnboardingDocument(userId, kind, html));
    } catch (e) {
      toast(await fileErrorMessage(e), 'bad');
    } finally {
      setOpening(null);
    }
  };

  /** One picked here is already in the browser, so it is shown from the bytes in hand. */
  const viewPicked = (file: OnboardingAttachment & { size: number }) => {
    try {
      const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
      show(file.filename, new Blob([bytes], { type: file.content_type || 'application/octet-stream' }));
    } catch {
      toast('Could not open that file', 'bad');
    }
  };

  return (
    <div className="overlay open stacked" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h" style={{ marginBottom: 2 }}>{KIND_LABEL[kind]}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
          {loading ? 'Building the preview…' : (
            <>
              To <strong>{preview?.to || '—'}</strong>
              {preview?.sender ? <> · from {preview.sender}</> : null}
              {/* Which of the two guides was chosen from the agent's record, so a letter meant for a
                  transferring agent is not sent to a fresher without it being visible first. */}
              {preview && EVENT_LABEL[preview.event_key] ? <> · {EVENT_LABEL[preview.event_key]} version</> : null}
              {/* For the contract, which of the brokerage's five agreements these terms are — read
                  from the same splits the wording below is built from. */}
              {kind === 'contract' ? (
                preview?.contract_variant
                  ? <> · <strong>{preview.contract_variant}</strong> agreement</>
                  : <> · non-standard split</>
              ) : null}
            </>
          )}
        </div>

        {loading ? <div className="centered">Loading…</div> : preview && (
          <>
            {/* Said before the button is pressed, not after. */}
            {preview.warning && (
              <div className="import-error" style={{ marginBottom: 12 }}>{preview.warning}</div>
            )}

            <div className="field"><label>Subject</label>
              {editing
                ? <input value={subject} onChange={(e) => setSubject(e.target.value)} />
                : <div className="onb-static">{subject}</div>}
            </div>

            <div className="field" style={{ marginBottom: 10 }}>
              <label>Message</label>
              {editing ? (
                <RichTextEditor ref={bodyRef} value={html} onChange={setHtml} rows={12} />
              ) : (
                /*
                 * The rendering of exactly what will be sent — with the ruled blanks typeable.
                 *
                 * COMMITTED ON BLUR, not on every keystroke. Writing state as the person types would
                 * re-render this container from `html` mid-word, replacing the very node holding the
                 * caret; the caret would jump to the start and the text would come out backwards.
                 * Letting the browser own the text until focus leaves avoids that entirely.
                 */
                <div
                  className="onb-preview"
                  onClick={(e) => {
                    const el = e.target as HTMLElement;
                    const box = el.closest?.('[data-check]') as HTMLElement | null;
                    if (box?.dataset.check !== undefined) { setHtml((h) => toggleCheck(h, box.dataset.check!)); return; }
                    const date = el.closest?.('[data-kind="date"]') as HTMLElement | null;
                    if (date?.dataset.blank !== undefined) openPicker(date.dataset.blank, date);
                  }}
                  onBlur={(e) => {
                    const el = e.target as HTMLElement;
                    const id = el.dataset?.blank;
                    if (id !== undefined) setHtml((h) => fillBlank(h, id, el.textContent ?? ''));
                  }}
                  onKeyDown={(e) => {
                    const el = e.target as HTMLElement;
                    // A blank is one line on a form. Enter finishes it rather than adding a line
                    // break inside a contract.
                    if (e.key === 'Enter' && el.dataset?.blank !== undefined) {
                      e.preventDefault();
                      el.blur();
                    }
                    // A tick box is reachable by keyboard, so it has to be operable by one.
                    if ((e.key === ' ' || e.key === 'Enter') && el.dataset?.check !== undefined) {
                      e.preventDefault();
                      setHtml((h) => toggleCheck(h, el.dataset.check!));
                    }
                  }}
                  dangerouslySetInnerHTML={{ __html: asEditable(html) }}
                />
              )}
              {/*
                * The date field. Parked out of the way until a date line is clicked, then moved onto
                * that line and shown — see `openPicker`. Never `display:none`: a hidden input cannot
                * be focused or opened, which is the whole job here.
                *
                * Dismissed on blur and on Escape so it cannot be left sitting over the contract.
                */}
              {!editing && (
                <input
                  ref={dateInput}
                  type="date"
                  className="onb-datefield"
                  style={{
                    position: 'fixed',
                    zIndex: 60,
                    left: -9999,
                    top: -9999,
                    width: 150,
                    opacity: dateFor === null ? 0 : 1,
                    pointerEvents: dateFor === null ? 'none' : 'auto',
                  }}
                  onChange={(e) => chooseDate(e.target.value)}
                  onBlur={() => setDateFor(null)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setDateFor(null); } }}
                  aria-label="Pick a date for this line"
                />
              )}
              {!editing && (html.includes('data-blank=') || html.includes('data-check=')) && (
                <p className="help" style={{ margin: '6px 0 0' }}>
                  Click a ruled line to type into it, or a date line to pick a date
                  {html.includes('data-check=') ? ', and any box to tick it' : ''}.
                  Signature and address lines are not filled in here — they are signed by hand on the
                  printed copy. What you fill in is sent and appears in the PDF.
                </p>
              )}
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <label>Attachments</label>
              {(preview.generated_document || preview.attachments.length > 0 || files.length > 0) && (
                <ul className="tmpl-files">
                  {/* Built from the message for this agent, not stored anywhere. Listed first
                      because it is the document the email is about. */}
                  {preview.generated_document && (
                    <li key="doc">
                      <span className="tmpl-file-ico">📄</span>
                      <span>{preview.generated_document}</span>
                      <span className="tmpl-file-size">generated from this message</span>
                      <button type="button" className="btn ghost sm" disabled={opening === 'doc'}
                        onClick={() => void viewDocument(preview.generated_document!)}>
                        {opening === 'doc' ? 'Building…' : '👁 Preview'}
                      </button>
                    </li>
                  )}
                  {/* From the template — the same files go to every agent. */}
                  {preview.attachments.map((a) => (
                    <li key={`t${a.id}`}>
                      <span className="tmpl-file-ico">📎</span>
                      <span>{a.filename}</span>
                      <span className="tmpl-file-size">{size(a.size)} · from template</span>
                      <button type="button" className="btn ghost sm" disabled={opening === `t${a.id}`}
                        onClick={() => void viewStored(a)}>
                        {opening === `t${a.id}` ? 'Opening…' : '👁 Preview'}
                      </button>
                    </li>
                  ))}
                  {/* Picked here — this email only. */}
                  {files.map((f, i) => (
                    <li key={`a${i}`}>
                      <span className="tmpl-file-ico">📎</span>
                      <span>{f.filename}</span>
                      <span className="tmpl-file-size">{size(f.size)}</span>
                      <button type="button" className="btn ghost sm" onClick={() => viewPicked(f)}>👁 Preview</button>
                      {/* Closed with it: a preview of a file that is no longer attached is a
                          document the agent will not receive. */}
                      <button type="button" className="btn ghost sm" disabled={sending}
                        onClick={() => {
                          if (viewing?.name === f.filename) closeViewer();
                          setFiles((list) => list.filter((_, n) => n !== i));
                        }}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              {/* Shown here rather than in another tab, so the message and the document it refers
                  to can be read together. */}
              {viewing && (
                <div className="onb-viewer">
                  <div className="onb-viewer-h">
                    <span className="onb-viewer-name">{viewing.name}</span>
                    <button type="button" className="btn ghost sm" onClick={closeViewer}>Close preview</button>
                  </div>
                  {viewing.type.startsWith('image/')
                    ? <img src={viewing.url} alt={viewing.name} />
                    : <iframe src={viewing.url} title={viewing.name} />}
                </div>
              )}

              <input ref={fileInput} type="file" style={{ display: 'none' }}
                onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
              <button type="button" className="btn ghost sm" disabled={sending || files.length >= 5}
                onClick={() => fileInput.current?.click()}>
                {files.length >= 5 ? 'Attachment limit reached' : '📎 Attach a file'}
              </button>
              <span className="help" style={{ display: 'block', marginTop: 4 }}>
                Files added here are sent with this email only. Files that should go to every agent
                belong on the template, in Settings → Templates.
              </span>
            </div>

            <div className="actions" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button className="btn ghost" onClick={onClose}>Close</button>
              <button className="btn ghost" onClick={() => setEditing((v) => !v)}>
                {editing ? '👁 Preview' : '✎ Edit'}
              </button>
              <button className="btn primary" disabled={sending || !preview.to} onClick={() => void send()}>
                {sending ? 'Sending…' : `Send to ${preview.to || '—'}`}
              </button>
            </div>
            {editing && (
              <p className="help" style={{ marginTop: 6 }}>
                Edits apply to this email only. To change it for every agent, edit the template in
                Settings → Templates.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
