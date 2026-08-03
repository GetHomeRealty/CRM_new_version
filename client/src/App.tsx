import { lazy, type ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './desk/toast';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';
import DeskLayout from './desk/DeskLayout';
import { RequireScreen, LandingRedirect } from './desk/guards';
import { AREAS, DEFAULT_AREA, areaFor, areaPath, screenInArea, type Area } from './desk/area';

/**
 * Route-level code splitting.
 *
 * Every screen used to be bundled into the one file the browser downloads before it can render
 * anything, so opening the transactions list also paid for the campaign builder, the MLS pages
 * and the recycle bin. Each of these now becomes its own chunk, fetched when its route is first
 * visited and cached thereafter.
 *
 * Login, Register and DeskLayout are deliberately NOT lazy. The first two are the cold-start
 * path for a signed-out visitor, where an extra round trip before the form appears is a
 * regression, and the third is the shell every in-area route renders inside.
 */
// One dashboard per area: two endpoints, two sets of queries, two screens — section 10.
const CrmDashboardPage = lazy(() => import('./desk/CrmDashboardPage'));
const DeskDashboardPage = lazy(() => import('./desk/DeskDashboardPage'));
const AnalyticsPage = lazy(() => import('./desk/AnalyticsPage'));
const CalendarPage = lazy(() => import('./desk/CalendarPage'));
const InventoryPage = lazy(() => import('./desk/InventoryPage'));
const InvoicePage = lazy(() => import('./desk/InvoicePage'));
const MlsModulePage = lazy(() => import('./desk/MlsModulePage'));
const MlsDetailPage = lazy(() => import('./desk/MlsDetailPage'));
const FavoritesPage = lazy(() => import('./desk/FavoritesPage'));
const ReportsPage = lazy(() => import('./desk/ReportsPage'));
const ReportDetailPage = lazy(() => import('./desk/ReportDetailPage'));
const UsersPage = lazy(() => import('./desk/UsersPage'));
const SettingsPage = lazy(() => import('./desk/SettingsPage'));
const TransactionsPage = lazy(() => import('./desk/TransactionsPage'));
const TransactionDetailPage = lazy(() => import('./desk/TransactionDetailPage'));
const BulkImportPage = lazy(() => import('./desk/BulkImportPage'));
const DownloadCentrePage = lazy(() => import('./desk/DownloadCentrePage'));
const CampaignsPage = lazy(() => import('./desk/CampaignsPage'));
const LeadsPage = lazy(() => import('./desk/LeadsPage'));
const LeadDetailPage = lazy(() => import('./desk/LeadDetailPage'));
const MetaPage = lazy(() => import('./desk/MetaPage'));
const AccountSettingsPage = lazy(() => import('./desk/AccountSettingsPage'));
const NotificationPreferencesPage = lazy(() => import('./desk/NotificationPreferencesPage'));
const InboxPage = lazy(() => import('./desk/InboxPage'));
const AuditLogPage = lazy(() => import('./desk/AuditLogPage'));
const RecycleBinPage = lazy(() => import('./desk/RecycleBinPage'));
const StubPage = lazy(() => import('./desk/StubPage'));
const TriggersPage = lazy(() => import('./desk/TriggersPage'));

/**
 * One screen's routes, as they appear inside an area.
 *
 * `screen` is the permission key and the first path segment; `paths` lists the sub-routes it
 * owns. The table is declared once and mounted under every area the screen belongs to, so the
 * two areas cannot drift apart — adding a route to one and forgetting the other is not possible.
 */
interface ScreenRoutes {
  screen: string;
  /** Sub-paths relative to the screen segment. `''` is the screen itself. */
  paths: string[];
  /** `area` is passed so a screen can differ per area — the Dashboard is two different pages. */
  element: (path: string, area: Area) => ReactElement;
  /** Restricts the whole screen to Super Admins, regardless of the permission map. */
  superAdmin?: boolean;
  /** Lets a Super Admin in even if the screen permission was revoked. */
  orSuperAdmin?: boolean;
  /** No permission gate at all — personal screens every authenticated user has. */
  open?: boolean;
}

const SCREENS: ScreenRoutes[] = [
  { screen: 'dashboard', paths: [''], element: (_p, area) => (area === 'crm' ? <CrmDashboardPage /> : <DeskDashboardPage />) },
  { screen: 'analytics', paths: [''], element: () => <AnalyticsPage /> },
  { screen: 'campaigns', paths: [''], element: () => <CampaignsPage /> },
  { screen: 'calendar', paths: [''], element: () => <CalendarPage /> },
  { screen: 'inventory', paths: [''], element: () => <InventoryPage /> },
  { screen: 'lead', paths: ['', ':id'], element: (p) => (p === '' ? <LeadsPage /> : <LeadDetailPage />) },
  { screen: 'meta', paths: [''], element: () => <MetaPage /> },
  { screen: 'invoice', paths: [''], element: () => <InvoicePage /> },
  // MLS hosts Favorites as a section — see MlsModulePage.
  { screen: 'mls', paths: ['', ':id'], element: (p) => (p === '' ? <MlsModulePage /> : <MlsDetailPage />) },
  // Favorites moved inside MLS. The screen stays so existing links keep working, and anyone
  // whose `mls` permission was revoked can still reach their own favourites — merging the
  // navigation must not quietly take that away.
  { screen: 'favorites', paths: [''], element: () => <FavoritesPage /> },
  { screen: 'reports', paths: ['', ':reportType'], element: (p) => (p === '' ? <ReportsPage /> : <ReportDetailPage />) },
  // `superAdmin`, matching what the API enforces. `/api/users` is guarded by AdminGuard and never
  // consults the `users` screen permission, so gating this route on that permission let somebody
  // with "Users: view" open a page that answered 403 to every request — an enabled "+ Add User"
  // button over an empty table and two "Could not load users" toasts. The permission still governs
  // Settings → Roles & Permissions, which does honour it.
  { screen: 'users', paths: [''], element: () => <UsersPage />, superAdmin: true },
  // `orSuperAdmin`: Settings also hosts what used to be the Super-Admin-only Email Settings
  // screen, so a Super Admin must still get in even if their `settings` permission was revoked.
  // Each tab re-checks for itself.
  { screen: 'settings', paths: [''], element: () => <SettingsPage />, orSuperAdmin: true },
  {
    screen: 'transactions',
    // 'import' and 'downloads' precede ':id' so they are not read as transaction ids. Ids are
    // numeric, so no real transaction can be shadowed by a named sub-route.
    paths: ['', 'import', 'downloads', ':id'],
    element: (p) => (p === '' ? <TransactionsPage /> : p === 'import' ? <BulkImportPage /> : p === 'downloads' ? <DownloadCentrePage /> : <TransactionDetailPage />),
  },
  { screen: 'triggers', paths: [''], element: () => <TriggersPage /> },
  { screen: 'audit', paths: [''], element: () => <AuditLogPage /> },
  // Personal screens — every authenticated user has them, with no admin permission gate. The
  // Inbox is a personal mailbox (the user's own IMAP accounts), not the admin-permissioned
  // `inbox` screen.
  { screen: 'account', paths: [''], element: () => <AccountSettingsPage />, open: true },
  // Open like the other personal screens: these are the signed-in user's own notification
  // choices, so everyone from agent to super-admin reaches their own and nobody reaches
  // anyone else's. There is no admin permission that would make sense to gate it on.
  { screen: 'notifications', paths: [''], element: () => <NotificationPreferencesPage />, open: true },
  { screen: 'inbox', paths: [''], element: () => <InboxPage />, open: true },
  { screen: 'recycle-bin', paths: [''], element: () => <RecycleBinPage />, superAdmin: true },
];

/** Every screen the router knows, for deciding whether an unmatched segment is a real screen. */
const KNOWN_SCREENS = new Set(SCREENS.map((s) => s.screen));

function screenRoutes(area: Area): ReactElement[] {
  return SCREENS.filter((s) => screenInArea(s.screen, area)).flatMap((s) =>
    s.paths.map((p) => {
      const path = p ? `${s.screen}/${p}` : s.screen;
      const body = s.element(p, area);
      return (
        <Route
          key={`${area}:${path}`}
          path={path}
          element={s.open ? body : (
            <RequireScreen
              screen={s.superAdmin ? undefined : s.screen}
              superAdmin={s.superAdmin}
              orSuperAdmin={s.orSuperAdmin}
            >
              {body}
            </RequireScreen>
          )}
        />
      );
    }),
  );
}

/**
 * A segment this area does not serve.
 *
 * If it is a real screen that lives in the other area, go there rather than showing a stub —
 * following a link to Leads from the Transaction Desk should open Leads, not a dead end. Anything
 * genuinely unknown falls through to the "not built yet" page, as before.
 */
function AreaFallback({ area }: { area: Area }) {
  const { page } = useParams();
  const location = useLocation();
  const name = page ?? '';
  if (name && KNOWN_SCREENS.has(name) && !screenInArea(name, area)) {
    const rest = location.pathname.split('/').slice(3).join('/');
    const target = areaPath(areaFor(name), rest ? `${name}/${rest}` : name);
    return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
  }
  return <StubPage />;
}

/**
 * `/app/*` → the same screen inside its area.
 *
 * Every URL the application has ever produced starts with `/app/`: bookmarks, links in
 * notification emails, and the OAuth return URLs registered with Google and Meta, some of which
 * are recorded outside this build and cannot be edited. All of them keep working.
 *
 * The query string and fragment are carried across untouched, because they are load-bearing —
 * `?tab=`, `?open=docs` and the OAuth `?code=`/`?state=` pairs all arrive this way.
 */
function LegacyAppRedirect() {
  const location = useLocation();
  const [params] = useSearchParams();
  const parts = location.pathname.split('/').filter(Boolean); // ['app', screen, ...rest]
  const screen = parts[1] ?? '';
  const rest = parts.slice(2).join('/');

  // No screen: /app on its own. Let the area landing decide, as /app used to.
  if (!screen) return <Navigate to={areaPath(DEFAULT_AREA)} replace />;

  // Email Settings was folded into Settings. Kept because the Google/Gmail OAuth round-trip may
  // still return to it from a redirect URI recorded server-side. ?tab=accounts maps to
  // Integrations inside SettingsPage's own aliases.
  if (screen === 'email-settings') {
    const tab = params.get('tab') ?? 'integrations';
    const extra = new URLSearchParams(params);
    extra.delete('tab');
    const q = extra.toString();
    return <Navigate to={`${areaPath(areaForSettingsTab(tab), 'settings')}?tab=${encodeURIComponent(tab)}${q ? `&${q}` : ''}`} replace />;
  }

  // A bookmarked `/app/settings?tab=crm` belongs in the CRM's own Settings, not the Desk's.
  const area = screen === 'settings' ? areaForSettingsTab(params.get('tab')) : areaFor(screen);
  const target = areaPath(area, rest ? `${screen}/${rest}` : screen);
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
}

/** Which area a Settings tab belongs to. Unknown or absent keeps the historical default. */
function areaForSettingsTab(tab: string | null): Area {
  return tab === 'crm' ? 'crm' : DEFAULT_AREA;
}

/** `/` → wherever this user's default area can actually take them. */
function RootRedirect() {
  return <Navigate to={areaPath(DEFAULT_AREA)} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />

            <Route element={<ProtectedRoute />}>
              {/*
                One shell per area, both built from the same SCREENS table. The area is a prop
                rather than something the layout reads off the URL, so the sidebar cannot end up
                describing a different area than the one being rendered.
              */}
              {AREAS.map((area) => (
                <Route key={area} path={area} element={<DeskLayout area={area} />}>
                  <Route index element={<LandingRedirect area={area} />} />
                  {screenRoutes(area)}
                  <Route path=":page" element={<AreaFallback area={area} />} />
                  <Route path=":page/*" element={<AreaFallback area={area} />} />
                </Route>
              ))}

              {/* Every historical URL, redirected into its area. */}
              <Route path="/app" element={<LegacyAppRedirect />} />
              <Route path="/app/*" element={<LegacyAppRedirect />} />
            </Route>

            <Route path="/" element={<RootRedirect />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

