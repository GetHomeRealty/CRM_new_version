import { createPortal } from 'react-dom';

// §3.2 — centered "Saved" confirmation shown over a modal for the hold duration
// before it auto-closes. Rendered via a portal to <body> so its fixed position is
// always relative to the viewport (a transformed modal ancestor would otherwise
// pin it to the middle of a long, scrolled-off modal). Render with `show={savedOk}`.
export default function SavedBadge({ show, label = 'Saved' }) {
  if (!show) return null;
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', zIndex: 9999, pointerEvents: 'none' }}>
      <div style={{
        background: '#fff', borderRadius: 18, padding: '30px 44px', border: '1px solid #bbf7d0',
        boxShadow: '0 16px 48px rgba(0,0,0,.28)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
        animation: 'savedPop .18s ease-out',
      }}>
        <div style={{ width: 68, height: 68, borderRadius: '50%', background: '#16a34a', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 38, fontWeight: 800, lineHeight: 1 }}>✓</div>
        <div style={{ fontSize: 19, fontWeight: 700, color: '#166534' }}>{label}</div>
      </div>
    </div>,
    document.body,
  );
}
