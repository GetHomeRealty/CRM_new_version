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
import ReportsPage from './desk/ReportsPage';
import UsersPage from './desk/UsersPage';
import CompanySettingsPage from './desk/CompanySettingsPage';
import TransactionsPage from './desk/TransactionsPage';
import TransactionDetailPage from './desk/TransactionDetailPage';
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
                <Route path="calendar" element={<RequireScreen screen="calendar"><CalendarPage /></RequireScreen>} />
                <Route path="inventory" element={<RequireScreen screen="inventory"><InventoryPage /></RequireScreen>} />
                <Route path="invoice" element={<RequireScreen screen="invoice"><InvoicePage /></RequireScreen>} />
                <Route path="mls" element={<RequireScreen screen="mls"><MlsPage /></RequireScreen>} />
                <Route path="reports" element={<RequireScreen screen="reports"><ReportsPage /></RequireScreen>} />
                <Route path="users" element={<RequireScreen screen="users"><UsersPage /></RequireScreen>} />
                <Route path="settings" element={<RequireScreen screen="settings"><CompanySettingsPage /></RequireScreen>} />
                <Route path="transactions" element={<RequireScreen screen="transactions"><TransactionsPage /></RequireScreen>} />
                <Route path="transactions/:id" element={<RequireScreen screen="transactions"><TransactionDetailPage /></RequireScreen>} />
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
