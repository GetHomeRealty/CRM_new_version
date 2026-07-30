import { Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { companyLogoUrl, getAgentChangeNotifications, getDocNotifications, markDocNotificationsSeen } from '../lib/api';
import type { AgentChangeItem, AgentChangeNotif, DocNotif, DocNotifItem } from '../types';
import ChangePasswordModal from './ChangePasswordModal';
import UserAvatar from './UserAvatar';
import ErrorBoundary from '../components/ErrorBoundary';
import { AREA_LABEL, AREA_SHORT, AREA_TAB, DEFAULT_AREA, areaPath, screenInArea, type Area } from './area';
import { AreaProvider } from './AreaContext';

interface NavItem {
  key: string;
  label: string;
  ico: string;
  superAdmin?: boolean;
  /** Shown only to agents — their own personal settings, self-scoped. */
  agentOnly?: boolean;
  /**
   * Sections of this module, shown as an indented list under the entry.
   *
   * Each child carries its own `key`, which is both its screen permission and, by default,
   * where it goes. A child the user has no permission for is dropped, and an entry left with
   * one child collapses back to a plain link — so a module never advertises a section that
   * cannot be opened.
   */
  children?: NavChild[];
}

interface NavChild {
  key: string;
  label: string;
  ico?: string;
  /**
   * Where it navigates, relative to the current area — `campaigns?tab=templates` becomes
   * `/crm/campaigns?tab=templates`. Defaults to `key`. Relative rather than absolute so one
   * declaration serves both areas and neither can point into the other by accident.
   */
  path?: string;
  /** Whether this child is the one currently open. */
  match?: (pathname: string, search: string) => boolean;
  /**
   * What the child is gated on. Left unset it is `key` treated as a screen permission, which
   * suits sections that are screens in their own right (Favorites). Sections of one screen —
   * the Settings tabs — name the permission that already guarded them instead, so the sidebar
   * shows exactly what the page would let you open and never advertises a locked tab.
   */
  screen?: string;
  superAdmin?: boolean;
  /** Restricts the section to one area. The Settings tabs are per-area by nature. */
  area?: Area;
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
  {
    key: 'campaigns', label: 'Campaigns', ico: '\u{1F4E3}',
    children: [
      { key: 'campaigns', label: 'Campaigns', ico: '\u{1F4E3}', screen: 'campaigns', path: 'campaigns',
        match: (_p, q) => new URLSearchParams(q).get('tab') !== 'templates' },
      { key: 'campaign-templates', label: 'Templates', ico: '\u{1F4DD}', screen: 'campaigns', path: 'campaigns?tab=templates',
        match: (_p, q) => new URLSearchParams(q).get('tab') === 'templates' },
    ],
  },
  { key: 'meta', label: 'Meta', ico: '\u{1F310}' },
  {
    key: 'mls', label: 'MLS', ico: '\u{1F3F7}',
    children: [
      { key: 'mls', label: 'MLS', ico: '\u{1F3F7}', path: 'mls',
        match: (_p, q) => new URLSearchParams(q).get('tab') !== 'favorites' },
      { key: 'favorites', label: 'Favorites', ico: '\u{2665}', path: 'mls?tab=favorites',
        match: (_p, q) => new URLSearchParams(q).get('tab') === 'favorites' },
    ],
  },
  // Deal group: Transactions → Invoice → Reports
  { key: 'transactions', label: 'Transactions', ico: '\u{1F4DA}' },
  { key: 'invoice', label: 'Invoice', ico: '\u{1F9FE}' },
  { key: 'reports', label: 'Reports', ico: '\u{1F4D1}' },
  { key: 'audit', label: 'Audit Trail', ico: '\u{1F4DD}' },
  { key: 'users', label: 'Users', ico: '\u{1F465}' },
  {
    key: 'settings', label: 'Settings', ico: '\u{2699}',
    // Mirrors SettingsPage's own tabs, with the permissions those tabs already carried: the two
    // that came from the Super-Admin-only Email Settings screen stay Super Admin.
    //
    // The area-specific tab is shown only in its own area. Offering "CRM Settings" from inside
    // the Transaction Desk is exactly the cross-wiring this separation exists to remove — and it
    // was the cause of the bug where linking a CRM email account opened the Desk's integrations.
    // Company Settings appears in both, because it belongs to neither.
    children: [
      { key: 'settings-desk', label: 'Transaction Desk', ico: '\u{1F4DA}', superAdmin: true, area: 'desk', path: 'settings?tab=desk',
        match: (_p, q) => (new URLSearchParams(q).get('tab') ?? 'desk') === 'desk' },
      { key: 'settings-crm', label: 'CRM Settings', ico: '\u{2699}', superAdmin: true, area: 'crm', path: 'settings?tab=crm',
        match: (_p, q) => (new URLSearchParams(q).get('tab') ?? 'crm') === 'crm' },
      { key: 'settings-company', label: 'Company Settings', ico: '\u{1F3E2}', screen: 'settings', path: 'settings?tab=company',
        match: (_p, q) => new URLSearchParams(q).get('tab') === 'company' },
    ],
  },
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

export default function DeskLayout({ area = DEFAULT_AREA }: { area?: Area }) {
  const { logout, user, can, isAdminOrAbove, isSuperAdmin, modules } = useAuth();
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

  // Both notifications are about transactions, so they always open in the Transaction Desk
  // regardless of which area the bell was rung in.
  const openNotif = (item: AgentChangeItem) => { setBellOpen(false); navigate(areaPath('desk', `transactions/${item.id}`)); };
  const openDocNotif = (item: DocNotifItem) => {
    setDocBellOpen(false);
    // Redirect to the transaction and open Legal & Documentation (where the review is).
    navigate(`${areaPath('desk', `transactions/${item.id}`)}?open=docs`);
    markDocNotificationsSeen(item.id).then(loadDocNotif).catch(() => {});
  };

  const visibleNav = NAV
    // Only this area's modules. Permission is unchanged by the split — a screen the user could
    // open before is still openable, it is simply listed under the area it belongs to.
    .filter((n) => screenInArea(n.key, area))
    .filter((n) => (n.agentOnly ? isAgent : n.superAdmin ? isSuperAdmin : can(n.key, 'view')))
    // Drop sections the user has no permission for or that belong to the other area, and flatten
    // an entry back to a plain link when only one is left — an expander that reveals a single
    // item is just a slower click.
    .map((n) => {
      if (!n.children) return n;
      const kids = n.children
        .filter((c) => !c.area || c.area === area)
        .filter((c) => (c.superAdmin ? isSuperAdmin : can(c.screen ?? c.key, 'view')));
      return kids.length > 1 ? { ...n, children: kids } : { ...n, children: undefined };
    });

  /**
   * Which module entries are expanded. Seeded so the one containing the current page is already
   * open on arrival — landing on Favorites with its parent collapsed would leave no indication
   * of where you are.
   */
  const [openNav, setOpenNav] = useState<Record<string, boolean>>({});
  const toggleNav = (key: string) => setOpenNav((o) => ({ ...o, [key]: !(o[key] ?? false) }));

  // ['', area, screen, …] — the area occupies the first segment, so the screen is still index 2.
  const seg = location.pathname.split('/')[2] || '';
  const title = location.pathname.includes('/transactions/') ? 'Transaction Detail' : (TITLES[seg] || AREA_SHORT[area]);

  const go = (key: string) => navigate(areaPath(area, key));

  /**
   * The trail after the area: the module, then the record when there is one.
   *
   * Derived from the path rather than kept in state, so it cannot fall out of step with the URL —
   * and so a deep link that skips the list still shows the whole trail. The module label comes from
   * the same TITLES map the heading uses, so the two always agree.
   */
  const rest = location.pathname.split('/').filter(Boolean).slice(2);
  const crumbs: { label: string; to?: string }[] = [];
  if (seg) {
    crumbs.push({ label: TITLES[seg] ?? seg.replace(/-/g, ' ').replace(/\w/g, (c) => c.toUpperCase()), to: areaPath(area, seg) });
    if (rest.length) {
      // A numeric segment is a record id; anything else is a named sub-screen (import, downloads).
      const last = rest[rest.length - 1];
      crumbs.push({ label: /^\d+$/.test(last) ? `#${last}` : last.replace(/-/g, ' ').replace(/\w/g, (c) => c.toUpperCase()) });
    }
  }

  /**
   * Switching areas keeps you on the same screen when that screen exists on the other side —
   * moving from the CRM's Calendar to the Desk's Calendar is the useful behaviour. When it does
   * not exist there, the area's own landing decides, rather than dropping the user on a stub.
   */
  const switchArea = (next: Area) => {
    if (next === area || !modules.includes(next)) return;
    navigate(seg && screenInArea(seg, next) ? `${areaPath(next, seg)}${location.search}` : areaPath(next));
  };

  /**
   * The area switcher, rendered in two places with only one visible at a time — beside the
   * navigation it governs on a wide screen, and in the topbar once the sidebar collapses to its
   * icon rail. One definition, so the two placements cannot drift apart in behaviour.
   */
  const areaSwitch = (place: 'in-sidebar' | 'in-topbar') => (
    // Only the modules this login has. With one module there is nothing to switch between, so the
    // control is not rendered at all — a switcher with a single option is a button that cannot do
    // anything, and it advertises a module the company may not have bought.
    modules.length < 2 ? null : (
    <div className={`area-switch ${place}`} role="group" aria-label="Application area">
      {modules.map((a) => (
        <button
          key={a}
          className={`area-btn ${a === area ? 'active' : ''}`}
          aria-current={a === area ? 'page' : undefined}
          title={AREA_LABEL[a]}
          onClick={() => switchArea(a)}
        >
          {AREA_TAB[a]}
        </button>
      ))}
    </div>
    )
  );

  const onLogout = async () => {
    try { await logout(); } catch { /* ignore */ }
    navigate('/login');
  };


  return (
    <>
      <div className="titlebar"><span className="dot">G</span> Get Home Realty — {AREA_SHORT[area]}</div>
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
          {/*
            Which half of the application you are in, and the way to the other one.

            Above the navigation rather than tucked in the topbar because it changes the meaning of
            every entry below it: the same "Calendar" is a different calendar in each area, and a
            switcher placed away from the list it governs invites the reading that the list is all
            there is.
          */}
          {areaSwitch('in-sidebar')}
          <nav className="nav">
            {visibleNav.map((n) => {
              if (!n.children) {
                return (
                  <button key={n.key} className={seg === n.key ? 'active' : ''} onClick={() => go(n.key)}>
                    <span className="ico">{n.ico}</span><span>{n.label}</span>
                  </button>
                );
              }
              const onModule = seg === n.key;
              // Open if explicitly toggled, otherwise whenever the current page is inside it.
              const open = openNav[n.key] ?? onModule;
              return (
                <div key={n.key} className="nav-group">
                  <button
                    className={`nav-parent ${onModule ? 'active' : ''}`}
                    onClick={() => { toggleNav(n.key); if (!onModule) go(n.key); }}
                    aria-expanded={open}
                  >
                    <span className="ico">{n.ico}</span>
                    <span>{n.label}</span>
                    <span className={`nav-caret ${open ? 'open' : ''}`}>{'▾'}</span>
                  </button>
                  {open && n.children!.map((c) => {
                    const active = onModule && (c.match ? c.match(location.pathname, location.search) : false);
                    return (
                      <button
                        key={c.key}
                        className={`nav-child ${active ? 'active' : ''}`}
                        onClick={() => navigate(areaPath(area, c.path ?? c.key))}
                      >
                        <span className="ico">{c.ico ?? ''}</span><span>{c.label}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            <button onClick={onLogout}>
              <span className="ico">{'\u{23FB}'}</span><span>Logout</span>
            </button>
          </nav>
        </aside>
        <main className="main">
          <div className="topbar">
            {/* Below 1100px the sidebar becomes a 64px icon rail — and with its own scrollbar there
                are barely 20px of usable width, too little for two legible labels. The switcher
                moves up here instead, where the labels fit in full. Exactly one of the two is
                displayed; the stylesheet decides which. */}
            {areaSwitch('in-topbar')}
            {/*
              Area → module → (record). Section 15 asks for breadcrumbs, and with two areas the
              first crumb is doing real work: it names which half of the application you are in,
              which the screen title alone no longer tells you — "Calendar" is a different calendar
              on each side.

              The area crumb is a link back to that area's landing; the module crumb is a link when
              you are deeper than the module itself. The last crumb is never a link, because a link
              to where you already are is a dead control.
            */}
            <nav className="crumbs" aria-label="Breadcrumb">
              <button type="button" onClick={() => navigate(areaPath(area))}>{AREA_SHORT[area]}</button>
              {crumbs.map((c, i) => (
                <span key={c.label} className="crumb">
                  <span className="crumb-sep" aria-hidden="true">›</span>
                  {i < crumbs.length - 1 && c.to
                    ? <button type="button" onClick={() => navigate(c.to!)}>{c.label}</button>
                    : <span aria-current="page">{c.label}</span>}
                </span>
              ))}
            </nav>
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
            {/* The area is published to the screens themselves, so a shared page (Settings,
                Calendar, the Audit Trail) knows which half it is being shown in without
                re-deriving it from the URL and risking a different answer than the sidebar. */}
            <AreaProvider area={area}>
              <ErrorBoundary key={location.pathname} what="This page">
                <Suspense fallback={<div className="empty-cell">Loading…</div>}>
                  <Outlet />
                </Suspense>
              </ErrorBoundary>
            </AreaProvider>
          </div>
        </main>
      </div>
      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </>
  );
}
