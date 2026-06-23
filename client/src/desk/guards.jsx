import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ORDER = ['dashboard', 'transactions', 'analytics', 'calendar', 'inventory', 'invoice', 'mls', 'reports', 'users', 'reviews', 'favorites', 'inbox', 'lead', 'triggers', 'settings'];

// Blocks a screen the user can't at least view.
export function RequireScreen({ screen, children }) {
  const { can } = useAuth();
  if (!can(screen, 'view')) {
    return (
      <div className="card stub">
        <h2>🔒 No access</h2>
        <p>You don't have permission to view this screen.</p>
        <p className="help">Ask an administrator to grant you access under <strong>Users</strong>.</p>
      </div>
    );
  }
  return children;
}

// Sends the user to the first screen they're allowed to see.
export function LandingRedirect() {
  const { can } = useAuth();
  const first = ORDER.find((s) => can(s, 'view'));
  if (!first) {
    return <div className="centered">You have no screen access yet. Ask an administrator to grant permissions.</div>;
  }
  return <Navigate to={`/app/${first}`} replace />;
}
