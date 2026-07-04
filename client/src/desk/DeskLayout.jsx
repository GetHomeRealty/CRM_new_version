import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getAgentChangeNotifications } from '../lib/api';
import ChangePasswordModal from './ChangePasswordModal';

const NAV = [
  { key: 'dashboard', label: 'Dashboard', ico: '\u{1F4CA}' },
  { key: 'analytics', label: 'Analytics', ico: '\u{1F4C8}' },
  { key: 'calendar', label: 'Calendar', ico: '\u{1F4C5}' },
  { key: 'reviews', label: 'Client Reviews', ico: '\u{2B50}' },
  { key: 'favorites', label: 'Favorites', ico: '\u{2665}' },
  { key: 'inbox', label: 'Inbox', ico: '\u{2709}' },
  { key: 'inventory', label: 'Inventory', ico: '\u{1F4E6}' },
  { key: 'invoice', label: 'Invoice', ico: '\u{1F9FE}' },
  { key: 'lead', label: 'Lead', ico: '\u{1F9D1}' },
  { key: 'mls', label: 'MLS', ico: '\u{1F3F7}' },
  { key: 'reports', label: 'Reports', ico: '\u{1F4D1}' },
  { key: 'triggers', label: 'Triggers', ico: '\u{26A1}' },
  { key: 'transactions', label: 'Transactions', ico: '\u{1F4DA}' },
  { key: 'audit', label: 'Audit Trail', ico: '\u{1F4DD}' },
  { key: 'users', label: 'Users', ico: '\u{1F465}' },
  { key: 'settings', label: 'Settings', ico: '\u{2699}' },
];

const TITLES = Object.fromEntries(NAV.map((n) => [n.key, n.label]));

export default function DeskLayout() {
  const { logout, user, can, isAdminOrAbove } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [pwOpen, setPwOpen] = useState(false);
  const [notif, setNotif] = useState({ count: 0, items: [] });
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef(null);

  // Poll agent-change notifications (admins/managers only); refresh on navigation.
  useEffect(() => {
    if (!isAdminOrAbove) return undefined;
    const load = () => getAgentChangeNotifications().then(setNotif).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [isAdminOrAbove, location.pathname]);

  useEffect(() => {
    if (!bellOpen) return undefined;
    const onDoc = (e) => { if (bellRef.current && !bellRef.current.contains(e.target)) setBellOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [bellOpen]);

  const openNotif = (item) => { setBellOpen(false); navigate(`/app/transactions/${item.id}`); };

  const visibleNav = NAV.filter((n) => can(n.key, 'view'));

  const seg = location.pathname.split('/')[2] || 'transactions';
  const title = location.pathname.includes('/transactions/') ? 'Transaction Detail' : (TITLES[seg] || 'Transactions');

  const go = (key) => navigate(`/app/${key}`);

  const onLogout = async () => {
    try { await logout(); } catch { /* ignore */ }
    navigate('/login');
  };

  const avatarInitial = (user?.name || 'G').charAt(0).toUpperCase();

  return (
    <>
      <div className="titlebar"><span className="dot">G</span> Get Home Realty — Transaction Desk</div>
      <div className="app">
        <aside className="sidebar">
          <div className="logo">
            <div className="logo-circle">G</div>
            <div className="brand-name">Get Home<br />Realty</div>
          </div>
          <nav className="nav">
            {visibleNav.map((n) => (
              <button key={n.key} className={seg === n.key ? 'active' : ''} onClick={() => go(n.key)}>
                <span className="ico">{n.ico}</span><span>{n.label}</span>
              </button>
            ))}
            <button onClick={onLogout}>
              <span className="ico">{'\u{23FB}'}</span><span>Logout</span>
            </button>
          </nav>
        </aside>
        <main className="main">
          <div className="topbar">
            <div className="title">{title}</div>
            <div className="right">
              {isAdminOrAbove && (
                <div ref={bellRef} style={{ position: 'relative' }}>
                  <button className="icon-btn" onClick={() => setBellOpen((o) => !o)} title="Agent changes to review">
                    {'\u{1F514}'}{notif.count > 0 && <span className="badge">{notif.count}</span>}
                  </button>
                  {bellOpen && (
                    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 340, maxHeight: 380, overflowY: 'auto', background: '#fff', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.16)', zIndex: 50, padding: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '4px 8px 8px' }}>Agent changes to review</div>
                      {notif.items.length === 0
                        ? <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>Nothing to review 🎉</div>
                        : notif.items.map((it) => (
                          <button key={it.id} onClick={() => openNotif(it)} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.background = '#f8fafc')} onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.property || 'Untitled'} <span style={{ color: 'var(--brand)', fontWeight: 700 }}>·{it.count}</span></div>
                            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Trade #{it.trade_no} · {it.agent || 'agent'}{it.at ? ` · ${it.at}` : ''}</div>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}
              <div style={{ fontSize: 13, color: '#374151' }}>{'\u{1F1E8}\u{1F1E6}'} English</div>
              <div className="avatar">{avatarInitial}</div>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{user?.name || 'Gethomerealty'}</span>
              <button className="btn ghost sm" onClick={() => setPwOpen(true)} title="Change your password">🔑 Password</button>
            </div>
          </div>
          <div className="content"><Outlet /></div>
        </main>
      </div>
      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </>
  );
}
