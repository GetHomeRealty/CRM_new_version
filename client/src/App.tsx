import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './desk/toast';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';
import DeskLayout from './desk/DeskLayout';
import DashboardPage from './desk/DashboardPage';
import AnalyticsPage from './desk/AnalyticsPage';
import CalendarPage from './desk/CalendarPage';
import InventoryPage from './desk/InventoryPage';
import InvoicePage from './desk/InvoicePage';
import MlsPage from './desk/MlsPage';
import MlsDetailPage from './desk/MlsDetailPage';
import FavoritesPage from './desk/FavoritesPage';
import ReportsPage from './desk/ReportsPage';
import ReportDetailPage from './desk/ReportDetailPage';
import UsersPage from './desk/UsersPage';
import CompanySettingsPage from './desk/CompanySettingsPage';
import TransactionsPage from './desk/TransactionsPage';
import TransactionDetailPage from './desk/TransactionDetailPage';
import BulkImportPage from './desk/BulkImportPage';
import DownloadCentrePage from './desk/DownloadCentrePage';
import CampaignsPage from './desk/CampaignsPage';
import LeadsPage from './desk/LeadsPage';
import LeadDetailPage from './desk/LeadDetailPage';
import MetaPage from './desk/MetaPage';
import EmailSettingsPage from './desk/EmailSettingsPage';
import AccountSettingsPage from './desk/AccountSettingsPage';
import InboxPage from './desk/InboxPage';
import AuditLogPage from './desk/AuditLogPage';
import RecycleBinPage from './desk/RecycleBinPage';
import StubPage from './desk/StubPage';
import { RequireScreen, LandingRedirect } from './desk/guards';

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
                <Route path="settings" element={<RequireScreen screen="settings"><CompanySettingsPage /></RequireScreen>} />
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
            <Route path="email-settings" element={<RequireScreen superAdmin><EmailSettingsPage /></RequireScreen>} />
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
