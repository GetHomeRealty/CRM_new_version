import { Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { companyLogoUrl, getAgentChangeNotifications, getDocNotifications, markDocNotificationsSeen } from '../lib/api';
import type { AgentChangeItem, AgentChangeNotif, DocNotif, DocNotifItem } from '../types';
import ChangePasswordModal from './ChangePasswordModal';
import UserAvatar from './UserAvatar';
import ErrorBoundary from '../components/ErrorBoundary';

interface NavItem {
  key: string;
  label: string;
  ico: string;
  superAdmin?: boolean;
  /** Shown only to agents — their own personal settings, self-scoped. */
  agentOnly?: boolean;
}

const NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', ico: '\u{1F4CA}' },
  { key: 'analytics', label: 'Analytics', ico: '\u{1F4C8}' },
  { key: 'calendar', label: 'Calendar', ico: '\u{1F4C5}' },
  { key: 'reviews', label: 'Client Reviews', ico: '\u{2B50}' },
  { key: 'inventory', label: 'Inventory', ico: '\u{1F4E6}' },
  // CRM group: Inbox → Lead → Campaigns
  { key: 'inbox', label: 'Inbox', ico: '\u{2709}' },
  { key: 'lead', label: 'Lead', ico: '\u{1F9D1}' },
  { key: 'campaigns', label: 'Campaigns', ico: '\u{1F4E3}' },
  { key: 'meta', label: 'Meta', ico: '\u{1F310}' },
  { key: 'mls', label: 'MLS', ico: '\u{1F3F7}' },
  // Deal group: Transactions → Invoice → Reports
  { key: 'transactions', label: 'Transactions', ico: '\u{1F4DA}' },
  { key: 'invoice', label: 'Invoice', ico: '\u{1F9FE}' },
  { key: 'reports', label: 'Reports', ico: '\u{1F4D1}' },
  { key: 'audit', label: 'Audit Trail', ico: '\u{1F4DD}' },
  { key: 'users', label: 'Users', ico: '\u{1F465}' },
  { key: 'settings', label: 'Settings', ico: '\u{2699}' },
  // Agent's own settings — profile, their email accounts, signature. Admins have the admin
  // Settings above instead, so this is shown to agents only.
  { key: 'account', label: 'Settings', ico: '\u{2699}', agentOnly: true },
  { key: 'triggers', label: 'Triggers', ico: '\u{26A1}' },
  { key: 'recycle-bin', label: 'Recycle Bin', ico: '\u{1F5D1}', superAdmin: true },
];

const TITLES: Record<string, string> = Object.fromEntries(NAV.map((n): [string, string] => [n.key, n.label]));
// Favorites is a section of MLS now, so it has no sidebar entry — but the route still exists and
// needs a heading when someone arrives on it directly.
TITLES.favorites = 'Favorites';

export default function DeskLayout() {
  const { logout, user, can, isAdminOrAbove, isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [pwOpen, setPwOpen] = useState(false);
  const [notif, setNotif] = useState<AgentChangeNotif>({ count: 0, items: [] });
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const isAgent = user?.role === 'agent';
  const [docNotif, setDocNotif] = useState<DocNotif>({ count: 0, items: [] });
  const [docBellOpen, setDocBellOpen] = useState(false);
  const docBellRef = useRef<HTMLDivElement>(null);

  // Poll agent-change notifications (admins/managers only); refresh on navigation.
  useEffect(() => {
    if (!isAdminOrAbove) return undefined;
    const load = () => getAgentChangeNotifications().then(setNotif).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [isAdminOrAbove, location.pathname]);

  // Poll document-review notifications (agents only); refresh on navigation.
  const loadDocNotif = () => getDocNotifications().then(setDocNotif).catch(() => {});
  useEffect(() => {
    if (!isAgent) return undefined;
    loadDocNotif();
    const t = setInterval(loadDocNotif, 60000);
    return () => clearInterval(t);
  }, [isAgent, location.pathname]);

  useEffect(() => {
    if (!bellOpen && !docBellOpen) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
      if (docBellRef.current && !docBellRef.current.contains(e.target as Node)) setDocBellOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [bellOpen, docBellOpen]);

  const openNotif = (item: AgentChangeItem) => { setBellOpen(false); navigate(`/app/transactions/${item.id}`); };
  const openDocNotif = (item: DocNotifItem) => {
    setDocBellOpen(false);
    // Redirect to the transaction and open Legal & Documentation (where the review is).
    navigate(`/app/transactions/${item.id}?open=docs`);
    markDocNotificationsSeen(item.id).then(loadDocNotif).catch(() => {});
  };

  const visibleNav = NAV.filter((n) => (n.agentOnly ? isAgent : n.superAdmin ? isSuperAdmin : can(n.key, 'view')));

  const seg = location.pathname.split('/')[2] || 'transactions';
  const title = location.pathname.includes('/transactions/') ? 'Transaction Detail' : (TITLES[seg] || 'Transactions');

  const go = (key: string) => navigate(`/app/${key}`);

  const onLogout = async () => {
    try { await logout(); } catch { /* ignore */ }
    navigate('/login');
  };


  return (
    <>
      <div className="titlebar"><span className="dot">G</span> Get Home Realty — Transaction Desk</div>
      <div className="app">
        <aside className="sidebar">
          <div className="logo">
            {/* The uploaded brand logo (Settings → Company), falling back to the bundled mark. */}
            <img
              src={companyLogoUrl()}
              alt="Get Home Realty"
              className="logo-img"
              onError={(e) => { const i = e.currentTarget; if (i.src !== `${window.location.origin}/logo.svg`) i.src = '/logo.svg'; }}
            />
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
                          <button key={it.id} onClick={() => openNotif(it)} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', textAlign: 'left', background: it.unread ? '#f8fafc' : 'none', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', opacity: it.unread ? 1 : 0.6 }} onMouseEnter={(e) => (e.currentTarget.style.background = '#eef2f7')} onMouseLeave={(e) => (e.currentTarget.style.background = it.unread ? '#f8fafc' : 'none')}>
                            <span style={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', marginTop: 5, background: it.unread ? 'var(--brand)' : 'transparent' }} />
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 13, fontWeight: it.unread ? 700 : 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.property || 'Untitled'} <span style={{ color: 'var(--brand)', fontWeight: 700 }}>·{it.count}</span></div>
                              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Trade #{it.trade_no} · {it.agent || 'agent'}{it.at ? ` · ${it.at}` : ''}</div>
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}
              {isAgent && (
                <div ref={docBellRef} style={{ position: 'relative' }}>
                  <button className="icon-btn" onClick={() => setDocBellOpen((o) => !o)} title="Document review updates">
                    {'\u{1F514}'}{docNotif.count > 0 && <span className="badge">{docNotif.count}</span>}
                  </button>
                  {docBellOpen && (
                    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 340, maxHeight: 380, overflowY: 'auto', background: '#fff', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.16)', zIndex: 50, padding: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '4px 8px 8px' }}>Document review updates</div>
                      {docNotif.items.length === 0
                        ? <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>No updates 🎉</div>
                        : docNotif.items.map((it) => (
                          <button key={it.id} onClick={() => openDocNotif(it)} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', textAlign: 'left', background: it.unread ? '#f8fafc' : 'none', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', opacity: it.unread ? 1 : 0.6 }} onMouseEnter={(e) => (e.currentTarget.style.background = '#eef2f7')} onMouseLeave={(e) => (e.currentTarget.style.background = it.unread ? '#f8fafc' : 'none')}>
                            <span style={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', marginTop: 5, background: it.unread ? 'var(--brand)' : 'transparent' }} />
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 13, fontWeight: it.unread ? 700 : 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.property || 'Untitled'}</div>
                              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Trade #{it.trade_no}{it.summary ? ` · ${it.summary}` : ''}{it.at ? ` · ${it.at}` : ''}</div>
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}
              <div style={{ fontSize: 13, color: '#374151' }}>{'\u{1F1E8}\u{1F1E6}'} English</div>
              <UserAvatar userId={user?.id ?? null} name={user?.name} size={34} title={user?.name ?? undefined} />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{user?.name || 'Gethomerealty'}</span>
              <button className="btn ghost sm" onClick={() => setPwOpen(true)} title="Change your password">🔑 Password</button>
            </div>
          </div>
          {/*
            Inside the shell, so a page that fails to render leaves the sidebar and topbar
            working and the user can simply navigate elsewhere — rather than facing a blank
            document with no way out but the browser's back button.

            Keyed by pathname because a boundary that has caught an error stays in that state
            until it remounts: without the key, one broken page would keep showing its error
            over every screen visited afterwards.
          */}
          {/*
            Suspense sits INSIDE the shell so a route's chunk downloads with the sidebar and
            topbar still on screen — a full-page spinner would blank and redraw the whole
            application on every first visit to a screen, which reads as a flash.

            It is inside the boundary as well: a chunk that fails to load (a stale build after a
            deploy, a dropped connection) throws where the error panel can catch it and offer a
            reload, rather than leaving an empty frame.
          */}
          <div className="content">
            <ErrorBoundary key={location.pathname} what="This page">
              <Suspense fallback={<div className="empty-cell">Loading…</div>}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </>
  );
}
