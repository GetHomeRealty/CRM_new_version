import { lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './desk/toast';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';
import DeskLayout from './desk/DeskLayout';
import { RequireScreen, LandingRedirect } from './desk/guards';

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
 * regression, and the third is the shell every /app route renders inside.
 */
const DashboardPage = lazy(() => import('./desk/DashboardPage'));
const AnalyticsPage = lazy(() => import('./desk/AnalyticsPage'));
const CalendarPage = lazy(() => import('./desk/CalendarPage'));
const InventoryPage = lazy(() => import('./desk/InventoryPage'));
const InvoicePage = lazy(() => import('./desk/InvoicePage'));
const MlsPage = lazy(() => import('./desk/MlsPage'));
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
const InboxPage = lazy(() => import('./desk/InboxPage'));
const AuditLogPage = lazy(() => import('./desk/AuditLogPage'));
const RecycleBinPage = lazy(() => import('./desk/RecycleBinPage'));
const StubPage = lazy(() => import('./desk/StubPage'));


/**
 * /app/email-settings → /app/settings, preserving the requested tab.
 *
 * The screen was removed, but its URL is still reachable from bookmarks and — more
 * importantly — from OAuth return URLs that may already be recorded outside this build.
 * A redirect keeps every one of those working instead of dropping the user on a stub.
 */
function EmailSettingsRedirect() {
  const [params] = useSearchParams();
  const tab = params.get('tab') ?? 'integrations';
  const rest = new URLSearchParams(params);
  rest.delete('tab');
  const extra = rest.toString();
  return <Navigate to={`/app/settings?tab=${encodeURIComponent(tab)}${extra ? `&${extra}` : ''}`} replace />;
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
              <Route path="/app" element={<DeskLayout />}>
                <Route index element={<LandingRedirect />} />
                <Route path="dashboard" element={<RequireScreen screen="dashboard"><DashboardPage /></RequireScreen>} />
                <Route path="analytics" element={<RequireScreen screen="analytics"><AnalyticsPage /></RequireScreen>} />
                <Route path="campaigns" element={<RequireScreen screen="campaigns"><CampaignsPage /></RequireScreen>} />
                <Route path="calendar" element={<RequireScreen screen="calendar"><CalendarPage /></RequireScreen>} />
                <Route path="inventory" element={<RequireScreen screen="inventory"><InventoryPage /></RequireScreen>} />
                <Route path="lead" element={<RequireScreen screen="lead"><LeadsPage /></RequireScreen>} />
                <Route path="lead/:id" element={<RequireScreen screen="lead"><LeadDetailPage /></RequireScreen>} />
                <Route path="meta" element={<RequireScreen screen="meta"><MetaPage /></RequireScreen>} />
                <Route path="invoice" element={<RequireScreen screen="invoice"><InvoicePage /></RequireScreen>} />
                <Route path="mls" element={<RequireScreen screen="mls"><MlsPage /></RequireScreen>} />
                <Route path="mls/:id" element={<RequireScreen screen="mls"><MlsDetailPage /></RequireScreen>} />
                <Route path="favorites" element={<RequireScreen screen="favorites"><FavoritesPage /></RequireScreen>} />
                <Route path="reports" element={<RequireScreen screen="reports"><ReportsPage /></RequireScreen>} />
                <Route path="reports/:reportType" element={<RequireScreen screen="reports"><ReportDetailPage /></RequireScreen>} />
                <Route path="users" element={<RequireScreen screen="users"><UsersPage /></RequireScreen>} />
                {/* `orSuperAdmin`: Settings now also hosts what used to be the Super-Admin-only
                    Email Settings screen, so a Super Admin must still get in even if their
                    `settings` screen permission was revoked. Each tab re-checks for itself. */}
                <Route path="settings" element={<RequireScreen screen="settings" orSuperAdmin><SettingsPage /></RequireScreen>} />
                <Route path="transactions" element={<RequireScreen screen="transactions"><TransactionsPage /></RequireScreen>} />
                {/* must precede :id so "import" isn't read as a transaction id */}
                <Route path="transactions/import" element={<RequireScreen screen="transactions"><BulkImportPage /></RequireScreen>} />
                <Route path="transactions/downloads" element={<RequireScreen screen="transactions"><DownloadCentrePage /></RequireScreen>} />
                <Route path="transactions/:id" element={<RequireScreen screen="transactions"><TransactionDetailPage /></RequireScreen>} />
                <Route path="audit" element={<RequireScreen screen="audit"><AuditLogPage /></RequireScreen>} />
                {/* Personal settings + inbox — available to every authenticated user, no screen gate.
                Inbox is a personal mailbox (own IMAP accounts), so it is not the admin-permissioned
                `inbox` screen; a plain authenticated route. */}
            <Route path="account" element={<AccountSettingsPage />} />
            <Route path="inbox" element={<InboxPage />} />
            {/* Email Settings has been folded into Settings. This redirect is kept so old
                bookmarks — and the Google/Gmail OAuth round-trips, whose return URL may
                already be stored server-side — still land somewhere real. It carries the
                requested tab across: ?tab=crm keeps working, ?tab=accounts maps to
                Integrations (see SettingsPage's ALIASES). */}
            <Route path="email-settings" element={<EmailSettingsRedirect />} />
                <Route path="recycle-bin" element={<RequireScreen superAdmin><RecycleBinPage /></RequireScreen>} />
                <Route path=":page" element={<StubPage />} />
              </Route>
            </Route>

            <Route path="/" element={<Navigate to="/app/transactions" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
