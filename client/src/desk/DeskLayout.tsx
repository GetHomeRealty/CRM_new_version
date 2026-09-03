import { Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { companyLogoUrl, getAgentChangeNotifications, getDocNotifications, getReviewNotifications, markDocNotificationsSeen } from '../lib/api';
import type { AgentChangeItem, AgentChangeNotif, DocNotif, DocNotifItem } from '../types';
import ChangePasswordModal from './ChangePasswordModal';
import UserAvatar from './UserAvatar';
import ErrorBoundary from '../components/ErrorBoundary';
import Icon from '../ui/Icon';
import { AREA_SHORT, AREA_TAB, DEFAULT_AREA, areaPath, screenInArea, type Area } from './area';
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
  /**
   * Shown to every signed-in user, with no permission check.
   *
   * For sections that are a person's own settings rather than a part of the module they sit
   * under — there is no admin right that should decide whether somebody may mute their own
   * phone. Only for genuinely self-scoped screens: the server scopes these to the caller, so
   * the sidebar entry grants nothing the API would not already allow.
   */
  personal?: boolean;
  /** Restricts the section to one area. The Settings tabs are per-area by nature. */
  area?: Area;
}

const NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', ico: 'dashboard' },
  { key: 'analytics', label: 'Analytics', ico: 'analytics' },
  { key: 'calendar', label: 'Calendar', ico: 'calendar' },
  { key: 'reviews', label: 'Client Reviews', ico: 'star' },
  { key: 'inventory', label: 'Inventory', ico: 'package' },
  // CRM group: Inbox → Lead → Campaigns
  { key: 'inbox', label: 'Inbox', ico: 'inbox' },
  { key: 'lead', label: 'Lead', ico: 'lead' },
  {
    key: 'campaigns', label: 'Campaigns', ico: 'megaphone',
    children: [
      // Each section owns its own `?tab=` value, so the match is an equality test rather than
      // "anything but templates" — with a third section that predicate lit Campaigns up while
      // the Suppression List was open.
      { key: 'campaigns', label: 'Campaigns', ico: 'megaphone', screen: 'campaigns', path: 'campaigns',
        match: (_p, q) => !['templates', 'suppressions'].includes(new URLSearchParams(q).get('tab') ?? '') },
      { key: 'campaign-templates', label: 'Templates', ico: 'file', screen: 'campaigns', path: 'campaigns?tab=templates',
        match: (_p, q) => new URLSearchParams(q).get('tab') === 'templates' },
      // Brokerage-wide and read-only for an agent without campaign edit rights, so it is gated on
      // the same `campaigns` view permission as the rest of the module.
      { key: 'campaign-suppressions', label: 'Suppression List', ico: 'lock', screen: 'campaigns', path: 'campaigns?tab=suppressions',
        match: (_p, q) => new URLSearchParams(q).get('tab') === 'suppressions' },
    ],
  },
  { key: 'meta', label: 'Meta', ico: 'globe' },
  {
    key: 'mls', label: 'MLS', ico: 'tag',
    children: [
      { key: 'mls', label: 'MLS', ico: 'tag', path: 'mls',
        match: (_p, q) => new URLSearchParams(q).get('tab') !== 'favorites' },
      { key: 'favorites', label: 'Favorites', ico: 'heart', path: 'mls?tab=favorites',
        match: (_p, q) => new URLSearchParams(q).get('tab') === 'favorites' },
    ],
  },
  // Deal group: Transactions → Invoice → Reports
  { key: 'transactions', label: 'Transactions', ico: 'briefcase' },
  { key: 'invoice', label: 'Invoice', ico: 'receipt' },
  { key: 'reports', label: 'Reports', ico: 'report' },
  { key: 'audit', label: 'Audit Trail', ico: 'clipboard' },
  // `superAdmin` rather than the `users` screen permission, because that is what the API enforces:
  // `/api/users` is guarded by AdminGuard and never consults the grid. Driving the nav from the
  // permission produced a visible Users item that opened a page answering 403 to every request.
  { key: 'users', label: 'Users', ico: 'users', superAdmin: true },
  {
    key: 'settings', label: 'Settings', ico: 'settings',
    // Mirrors SettingsPage's own tabs, with the permissions those tabs already carried: the two
    // that came from the Super-Admin-only Email Settings screen stay Super Admin.
    //
    // The area-specific tab is shown only in its own area. Offering "CRM Settings" from inside
    // the Transaction Desk is exactly the cross-wiring this separation exists to remove — and it
    // was the cause of the bug where linking a CRM email account opened the Desk's integrations.
    // Company Settings appears in both, because it belongs to neither.
    children: [
      { key: 'settings-desk', label: 'Transaction Desk', ico: 'briefcase', superAdmin: true, area: 'desk', path: 'settings?tab=desk',
        match: (_p, q) => (new URLSearchParams(q).get('tab') ?? 'desk') === 'desk' },
      // `screen: 'settings'` to match the tab in SettingsPage and the API behind it. It was
      // `superAdmin`, while every endpoint it opens gates on the `settings` permission — so a role
      // granted `settings: edit` could write CRM settings and broadcast to all staff through the
      // API with no navigation entry and no screen. See the comment on the tab itself.
      { key: 'settings-crm', label: 'CRM Settings', ico: 'settings', screen: 'settings', area: 'crm', path: 'settings?tab=crm',
        match: (_p, q) => (new URLSearchParams(q).get('tab') ?? 'crm') === 'crm' },
      { key: 'settings-company', label: 'Company Settings', ico: 'building', screen: 'settings', path: 'settings?tab=company',
        match: (_p, q) => new URLSearchParams(q).get('tab') === 'company' },
      // Same permission as the tab it opens: changing what a role grants is the same authority as
      // changing who holds it, which is the Users screen's edit right.
      { key: 'settings-roles', label: 'Roles & Permissions', ico: 'lock', screen: 'users', path: 'settings?tab=roles',
        match: (_p, q) => new URLSearchParams(q).get('tab') === 'roles' },
      // The one entry here that is not an administrator's setting: it is the viewer's own push
      // choices, which is why it carries `personal` instead of a screen permission. Agents do not
      // see this group at all, so their route in is the card on their own Settings page.
      { key: 'notification-center', label: 'Notifications', ico: 'bell', personal: true, path: 'notification-center',
        match: (p) => p.endsWith('/notification-center') },
      { key: 'notifications', label: 'Notification Preferences', ico: 'bell', personal: true, path: 'notifications',
        match: (p) => p.endsWith('/notifications') },
      /*
       * CRM Communications. `personal` like the two above, and for the same reason: most of what
       * it does is the viewer's own choices. The administrator-only parts are decided by the API
       * per request rather than by who can see the link, so one entry serves both.
       */
      // `mail`, not `megaphone`: Campaigns already carries the megaphone two groups above, and two
      // identical glyphs in one sidebar read as one entry duplicated.
      { key: 'communications', label: 'Communications', ico: 'mail', personal: true, area: 'crm', path: 'communications',
        match: (p) => p.endsWith('/communications') },
      /*
       * Two-step verification, moved here from the personal Settings page. `personal` for the same
       * reason as the two above and more strongly: it configures the viewer's own second factor and
       * nobody else's, and a role can be REQUIRED to hold one — so this must not be a link only
       * administrators see.
       */
      { key: 'two-step', label: 'Two-Step Verification', ico: 'lock', personal: true, area: 'crm', path: 'two-step',
        match: (p) => p.endsWith('/two-step') },
    ],
  },
  // Agent's own settings — profile, their email accounts, signature. Admins have the admin
  // Settings above instead, so this is shown to agents only.
  { key: 'account', label: 'Settings', ico: 'settings', agentOnly: true },
  { key: 'triggers', label: 'Triggers', ico: 'zap' },
  { key: 'recycle-bin', label: 'Recycle Bin', ico: 'trash', superAdmin: true },
];

const TITLES: Record<string, string> = Object.fromEntries(NAV.map((n): [string, string] => [n.key, n.label]));
// Favorites is a section of MLS now, so it has no sidebar entry — but the route still exists and
// needs a heading when someone arrives on it directly.
TITLES.favorites = 'Favorites';
// Reached from the Settings group for admins and from the agent's own Settings page, so it has no
// top-level entry of its own to take a heading from.
TITLES.notifications = 'Notification Preferences';
TITLES['notification-center'] = 'Notifications';

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

  /**
   * The agent's bell: document reviews and change reviews, in one list.
   *
   * Two feeds rather than one endpoint, merged here — they are about different things and neither
   * should be able to break the other, but an agent has one bell and does not care which of our
   * tables an answer came from. Newest first, and a failure of either leaves the other showing.
   */
  const loadDocNotif = () => Promise.allSettled([getDocNotifications(), getReviewNotifications()])
    .then(([docs, reviews]) => {
      const a = docs.status === 'fulfilled' ? docs.value : { count: 0, items: [] };
      const b = reviews.status === 'fulfilled' ? reviews.value : { count: 0, items: [] };
      const items = [...a.items, ...b.items].sort((x, y) => String(y.at ?? '').localeCompare(String(x.at ?? '')));
      setDocNotif({ count: a.count + b.count, items });
    })
    .catch(() => {});
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
  /**
   * Opening the deal is what marks its document notifications seen.
   *
   * An agent's upload is announced here but is not a reviewable change, so there is no "Mark
   * reviewed" button behind it to clear the mark — the server clears the document rows for this
   * transaction instead, and leaves any real field change still waiting to be reviewed.
   */
  const openNotif = (item: AgentChangeItem) => {
    setBellOpen(false);
    navigate(areaPath('desk', `transactions/${item.id}`));
    markDocNotificationsSeen(item.id)
      .then(() => getAgentChangeNotifications().then(setNotif))
      .catch(() => {});
  };
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
        .filter((c) => (c.personal ? true : c.superAdmin ? isSuperAdmin : can(c.screen ?? c.key, 'view')));
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
    <div className={`area-switch ${place}`} role="group" aria-label="Applications">
      {modules.map((a) => (
        <button
          type="button"
          key={a}
          className={`area-option ${a === area ? 'active' : ''}`}
          aria-current={a === area ? 'page' : undefined}
          onClick={() => switchArea(a)}
        >
          {AREA_TAB[a]}
        </button>
      ))}
      <button
        type="button"
        className="area-option precon"
        aria-label="Open Precon/Canada in a new tab"
        onClick={() => window.open(
          'https://precon.gethomerealty.ca/api/auth/crm/start?next=%2Fcommunities',
          '_blank',
          'noopener,noreferrer',
        )}
      >
        <span>Precon/Canada</span><span className="area-external" aria-hidden="true">↗</span>
      </button>
    </div>
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
                    <span className="ico"><Icon name={n.ico} size={17} /></span><span>{n.label}</span>
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
                    <span className="ico"><Icon name={n.ico} size={17} /></span>
                    <span>{n.label}</span>
                    <span className={`nav-caret ${open ? 'open' : ''}`}><Icon name="chevronDown" size={12} /></span>
                  </button>
                  {open && n.children!.map((c) => {
                    const active = onModule && (c.match ? c.match(location.pathname, location.search) : false);
                    return (
                      <button
                        key={c.key}
                        className={`nav-child ${active ? 'active' : ''}`}
                        onClick={() => navigate(areaPath(area, c.path ?? c.key))}
                      >
                        <span className="ico"><Icon name={c.ico ?? ''} size={16} /></span><span>{c.label}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            <button onClick={onLogout}>
              <span className="ico"><Icon name="logout" size={17} /></span><span>Logout</span>
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
                    <Icon name="bell" size={17} />{notif.count > 0 && <span className="badge">{notif.count}</span>}
                  </button>
                  {bellOpen && (
                    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 340, maxHeight: 380, overflowY: 'auto', background: '#fff', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.16)', zIndex: 50, padding: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '4px 8px 8px' }}>Agent changes to review</div>
                      {notif.items.length === 0
                        ? <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>Nothing to review</div>
                        : notif.items.map((it) => (
                          <button key={it.id} onClick={() => openNotif(it)} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', textAlign: 'left', background: it.unread ? 'var(--surface-2)' : 'none', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', opacity: it.unread ? 1 : 0.6 }} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-3)')} onMouseLeave={(e) => (e.currentTarget.style.background = it.unread ? 'var(--surface-2)' : 'none')}>
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
                    <Icon name="bell" size={17} />{docNotif.count > 0 && <span className="badge">{docNotif.count}</span>}
                  </button>
                  {docBellOpen && (
                    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 340, maxHeight: 380, overflowY: 'auto', background: '#fff', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.16)', zIndex: 50, padding: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '4px 8px 8px' }}>Document review updates</div>
                      {docNotif.items.length === 0
                        ? <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>No updates</div>
                        : docNotif.items.map((it) => (
                          <button key={it.id} onClick={() => openDocNotif(it)} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', textAlign: 'left', background: it.unread ? 'var(--surface-2)' : 'none', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', opacity: it.unread ? 1 : 0.6 }} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-3)')} onMouseLeave={(e) => (e.currentTarget.style.background = it.unread ? 'var(--surface-2)' : 'none')}>
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
              {/* The three classes below carry no styling of their own — they exist so the phone
                  breakpoint can drop what is decorative and keep what is not. The topbar is a
                  non-wrapping flex row, and at 390px its right-hand cluster alone is 301px wide, so
                  the whole shell scrolled sideways on every screen in both areas. Each of these
                  says something the row still says without it: the locale is fixed, the name is on
                  the avatar's tooltip, and the padlock is the same control as the word. */}
              <div className="topbar-locale" style={{ fontSize: 13, color: '#374151' }}>{'\u{1F1E8}\u{1F1E6}'} English</div>
              <UserAvatar userId={user?.id ?? null} name={user?.name} size={34} title={user?.name ?? undefined} />
              <span className="topbar-who" style={{ fontSize: 12, color: 'var(--muted)' }}>{user?.name || 'Gethomerealty'}</span>
              <button className="btn ghost sm" onClick={() => setPwOpen(true)} title="Change your password">
                <Icon name="lock" size={13} /> <span className="topbar-pw-label">Password</span>
              </button>
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
