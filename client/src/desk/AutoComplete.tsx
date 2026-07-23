import { useEffect, useRef, useState, type CSSProperties } from 'react';

interface AutoCompleteProps<T> {
  value: string;
  onChange: (v: string) => void;
  onPick: (option: T) => void;
  options?: T[];
  getLabel: (o: T) => string;
  getSub?: (o: T) => string | null | undefined;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  inputStyle?: CSSProperties;
}

/**
 * Text input with a type-ahead dropdown sourced from previously saved records.
 * Typing filters `options` by `getLabel`; picking one calls `onPick(option)` so
 * the caller can auto-fill related fields. Falls back to a plain input when there
 * are no matches, so it never gets in the way of free-text entry.
 */
export default function AutoComplete<T>({
  value, onChange, onPick, options = [], getLabel, getSub,
  placeholder, disabled, type = 'text', inputStyle,
}: AutoCompleteProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const q = (value || '').toLowerCase().trim();
  const matches = (options || [])
    .filter((o) => {
      const label = (getLabel(o) || '').toLowerCase();
      return label && label !== q && (!q || label.includes(q));
    })
    .slice(0, 8);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        type={type} value={value} disabled={disabled} placeholder={placeholder} autoComplete="off"
        style={{ width: '100%', ...inputStyle }}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && !disabled && matches.length > 0 && (
        <div style={{
          position: 'absolute', zIndex: 60, top: '100%', left: 0, right: 0, marginTop: 2,
          background: '#fff', border: '1px solid var(--line)', borderRadius: 6,
          boxShadow: '0 8px 22px rgba(0,0,0,.14)', maxHeight: 240, overflowY: 'auto',
        }}>
          {matches.map((o, i) => (
            <button
              key={i} type="button"
              onMouseDown={(e) => { e.preventDefault(); onPick(o); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px',
                border: 'none', borderBottom: '1px solid var(--line)', background: 'transparent',
                cursor: 'pointer', fontSize: 13,
              }}
            >
              <span style={{ fontWeight: 600 }}>{getLabel(o)}</span>
              {getSub && getSub(o) && <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>{getSub(o)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
