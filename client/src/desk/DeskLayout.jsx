import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

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
  { key: 'users', label: 'Users', ico: '\u{1F465}' },
  { key: 'settings', label: 'Settings', ico: '\u{2699}' },
];

const TITLES = Object.fromEntries(NAV.map((n) => [n.key, n.label]));

export default function DeskLayout() {
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

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
            {NAV.map((n) => (
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
              <button className="icon-btn">{'\u{1F514}'}<span className="badge">1</span></button>
              <div style={{ fontSize: 13, color: '#374151' }}>{'\u{1F1E8}\u{1F1E6}'} English</div>
              <div className="avatar">{avatarInitial}</div>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{user?.name || 'Gethomerealty'}</span>
            </div>
          </div>
          <div className="content"><Outlet /></div>
        </main>
      </div>
    </>
  );
}
