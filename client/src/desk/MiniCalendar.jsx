import { useState } from 'react';

// Lightweight multi-select month calendar. Clicking a day toggles it in/out of
// `selected` (array of 'YYYY-MM-DD'); used for custom reminder dates.
const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

export default function MiniCalendar({ selected = [], onToggle }) {
  const now = new Date();
  const [view, setView] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const sel = new Set(selected);

  const first = new Date(view.y, view.m, 1);
  const startDow = first.getDay();
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  const monthName = first.toLocaleString('en-CA', { month: 'long', year: 'numeric' });
  const prev = () => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }));
  const next = () => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }));

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <button type="button" onClick={prev} style={navBtn}>‹</button>
        <strong style={{ fontSize: 12 }}>{monthName}</strong>
        <button type="button" onClick={next} style={navBtn}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, textAlign: 'center', fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>
        {WD.map((w) => <div key={w}>{w}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />;
          const ds = iso(view.y, view.m, d);
          const on = sel.has(ds);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onToggle(ds)}
              style={{
                fontSize: 11, padding: '4px 0', borderRadius: 5, cursor: 'pointer',
                border: on ? '1px solid #16a34a' : '1px solid transparent',
                background: on ? '#16a34a' : 'transparent',
                color: on ? '#fff' : 'var(--text)', fontWeight: on ? 700 : 400,
              }}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const navBtn = { border: '1px solid var(--line)', background: '#fff', borderRadius: 6, width: 24, height: 24, cursor: 'pointer', lineHeight: 1 };
