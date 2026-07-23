import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Guards nested routes: redirects to /login when there is no authenticated
 * user, and waits for the initial session check before deciding.
 */
export default function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="centered">Loading…</div>;
  }

  return user ? <Outlet /> : <Navigate to="/login" replace />;
}
