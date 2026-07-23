import { useState, type ChangeEventHandler } from 'react';

interface PasswordInputProps {
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  placeholder?: string;
  name?: string;
  autoFocus?: boolean;
  autoComplete?: string;
}

// Password field with a show/hide (eye) toggle. Drop-in replacement for a plain
// <input type="password">; forwards value/onChange/placeholder/etc.
export default function PasswordInput({ value, onChange, placeholder, name, autoFocus = false, autoComplete = 'off' }: PasswordInputProps) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={show ? 'text' : 'password'}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        style={{ width: '100%', paddingRight: 40 }}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        title={show ? 'Hide password' : 'Show password'}
        aria-label={show ? 'Hide password' : 'Show password'}
        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, lineHeight: 1, color: 'var(--muted)', padding: 2 }}
      >
        {show ? '🙈' : '👁'}
      </button>
    </div>
  );
}
