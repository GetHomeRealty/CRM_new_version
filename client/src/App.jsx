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
import TransactionsPage from './desk/TransactionsPage';
import TransactionDetailPage from './desk/TransactionDetailPage';
import StubPage from './desk/StubPage';

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
                <Route index element={<Navigate to="/app/transactions" replace />} />
                <Route path="dashboard" element={<DashboardPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="calendar" element={<CalendarPage />} />
                <Route path="inventory" element={<InventoryPage />} />
                <Route path="invoice" element={<InvoicePage />} />
                <Route path="mls" element={<MlsPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="users" element={<UsersPage />} />
                <Route path="transactions" element={<TransactionsPage />} />
                <Route path="transactions/:id" element={<TransactionDetailPage />} />
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
