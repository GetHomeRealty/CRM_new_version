import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';

const ORDER = ['dashboard', 'transactions', 'invoice', 'reports', 'analytics', 'calendar', 'inventory', 'mls', 'users', 'reviews', 'favorites', 'inbox', 'lead', 'campaigns', 'meta', 'triggers', 'settings'];

// Blocks a screen the user can't at least view. Pass `superAdmin` to restrict a
// screen to Super Admins regardless of the screen permission map, or `orSuperAdmin`
// to widen a screen permission so Super Admins are always let in as well.
export function RequireScreen({ screen, superAdmin = false, orSuperAdmin = false, children }: {
  screen?: string; superAdmin?: boolean; orSuperAdmin?: boolean; children: ReactNode;
}): ReactNode {
  const { can, isSuperAdmin } = useAuth();
  // `screen` is only consulted when superAdmin is false, and every non-superAdmin
  // route supplies it; `?? ''` keeps can()'s string contract without changing behaviour.
  //
  // `orSuperAdmin` exists for Settings: it now also hosts the sections that used to live
  // on the Super-Admin-only Email Settings route. Without it, a Super Admin whose
  // `settings` permission had been revoked would lose access they previously had. The
  // tabs inside apply their own per-section checks, so widening the door does not widen
  // what anyone can actually see.
  const allowed = superAdmin ? isSuperAdmin : (can(screen ?? '', 'view') || (orSuperAdmin && isSuperAdmin));
  if (!allowed) {
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
