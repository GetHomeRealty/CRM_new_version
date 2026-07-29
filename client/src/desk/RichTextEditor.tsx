import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

/**
 * A small rich-text editor for email bodies — type what the recipient will see, rather than
 * writing HTML by hand.
 *
 * Built on contentEditable with no library behind it. That is deliberate: every editor worth
 * naming costs 100-200 kB gzipped, and this screen is a handful of templates edited occasionally.
 * The whole bundle was just reduced from 648 kB to 113 kB, and spending a third of that back on
 * one modal would be a poor trade.
 *
 * `document.execCommand` is formally deprecated and still the only thing every browser implements
 * for this. The replacement API is not shipped anywhere; it stays until it doesn't.
 *
 * The HTML view is kept, not replaced. Email HTML is fussy — inline styles, tables, things a
 * visual editor happily rewrites — and the existing templates are written that way. Being able to
 * drop into the source means a template that matters can always be fixed by hand.
 */

export interface RichTextHandle {
  /** Insert text at the caret, in whichever view is showing. */
  insert: (text: string) => void;
}

interface Props {
  value: string;
  onChange: (html: string) => void;
  rows?: number;
}

type Mode = 'visual' | 'html';

/** Toolbar buttons. `cmd` goes straight to execCommand; `block` wraps the line in a tag. */
const TOOLS: { label: string; title: string; cmd?: string; block?: string; arg?: string }[] = [
  { label: 'B', title: 'Bold', cmd: 'bold' },
  { label: 'I', title: 'Italic', cmd: 'italic' },
  { label: 'U', title: 'Underline', cmd: 'underline' },
  { label: 'H1', title: 'Heading', block: 'h2' },
  { label: 'H2', title: 'Subheading', block: 'h3' },
  { label: '¶', title: 'Normal text', block: 'p' },
  { label: '• List', title: 'Bulleted list', cmd: 'insertUnorderedList' },
  { label: '1. List', title: 'Numbered list', cmd: 'insertOrderedList' },
];

const RichTextEditor = forwardRef<RichTextHandle, Props>(function RichTextEditor(
  { value, onChange, rows = 12 }, ref,
) {
  const [mode, setMode] = useState<Mode>('visual');
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // What this component last emitted. Comparing against it stops the effect below from
  // rewriting innerHTML while someone is typing, which would drop the caret to the start
  // on every keystroke.
  //
  // Starts as null rather than `value`: seeded with the initial value, the first run would
  // compare equal and skip, so an existing template opened into an empty editor.
  const emitted = useRef<string | null>(null);

  useEffect(() => {
    if (mode !== 'visual' || !box.current) return;
    if (value === emitted.current) return;
    box.current.innerHTML = value;
    emitted.current = value;
  }, [value, mode]);

  const emit = (html: string) => { emitted.current = html; onChange(html); };
  const sync = () => { if (box.current) emit(box.current.innerHTML); };

  const exec = (cmd: string, arg?: string) => {
    box.current?.focus();
    document.execCommand(cmd, false, arg);
    sync();
  };

  const link = () => {
    const url = window.prompt('Link address (https://…)');
    if (!url) return;
    // Only http(s) and mailto. A javascript: URL here would be stored in the template and run
    // in whatever renders the preview.
    if (!/^(https?:\/\/|mailto:)/i.test(url)) { window.alert('Enter a link starting with https:// or mailto:'); return; }
    exec('createLink', url);
  };

  useImperativeHandle(ref, () => ({
    insert: (text: string) => {
      if (mode === 'html') {
        const el = area.current;
        if (!el) { emit(value + text); return; }
        const start = el.selectionStart ?? value.length;
        const end = el.selectionEnd ?? value.length;
        emit(value.slice(0, start) + text + value.slice(end));
        requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; });
        return;
      }
      box.current?.focus();
      // insertText keeps it as text, so a variable like {{ agent_name }} is never interpreted
      // as markup and survives a round trip through the editor unchanged.
      document.execCommand('insertText', false, text);
      sync();
    },
  }), [mode, value]);

  return (
    <div className="rte">
      <div className="rte-bar">
        {mode === 'visual' && (
          <>
            {TOOLS.map((t) => (
              <button key={t.label} type="button" className="rte-btn" title={t.title}
                // onMouseDown, not onClick: clicking a button blurs the editable area first and
                // the selection is lost, so the command would apply to nothing.
                onMouseDown={(e) => { e.preventDefault(); if (t.cmd) exec(t.cmd, t.arg); else if (t.block) exec('formatBlock', t.block); }}>
                {t.label}
              </button>
            ))}
            <button type="button" className="rte-btn" title="Insert link" onMouseDown={(e) => { e.preventDefault(); link(); }}>🔗</button>
            <button type="button" className="rte-btn" title="Remove formatting" onMouseDown={(e) => { e.preventDefault(); exec('removeFormat'); }}>✕</button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className={`rte-btn ${mode === 'html' ? 'on' : ''}`} title="Edit the underlying HTML"
          onClick={() => {
            // The editable div is unmounted while the HTML view is showing, so it comes back
            // empty. Clearing the marker makes the effect repopulate it — without this, going
            // HTML -> Visual showed a blank editor and saving from there would have wiped the
            // template.
            emitted.current = null;
            setMode((m) => (m === 'visual' ? 'html' : 'visual'));
          }}>
          {mode === 'visual' ? '</> HTML' : '✎ Visual'}
        </button>
      </div>

      {mode === 'visual' ? (
        <div
          ref={box}
          className="rte-body"
          contentEditable
          suppressContentEditableWarning
          style={{ minHeight: rows * 22 }}
          onInput={sync}
          // Paste as plain text. Pasting from Word or a browser drags in font tags, class names
          // and styles that no mail client renders the same way.
          onPaste={(e) => {
            e.preventDefault();
            document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
            sync();
          }}
        />
      ) : (
        <textarea
          ref={area}
          className="rte-html"
          rows={rows}
          value={value}
          onChange={(e) => emit(e.target.value)}
        />
      )}
    </div>
  );
});

export default RichTextEditor;
