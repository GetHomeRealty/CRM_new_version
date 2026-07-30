import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';
import { DEFAULT_AREA, areaPath, screenInArea, type Area } from './area';

/**
 * The order screens are offered in when deciding where to land someone. Unchanged — it is a
 * preference list, not an area list, and it is filtered by area at the point of use.
 */
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

/**
 * Sends the user to the first screen they're allowed to see.
 *
 * Now area-aware, but it deliberately does not stop at the area boundary: if a user has no
 * permission for anything in the area they arrived at, they are sent to the other area rather
 * than told they have no access. Splitting the navigation must not lock out an agent who only
 * ever had CRM permissions and happens to open the root URL.
 */
export function LandingRedirect({ area = DEFAULT_AREA }: { area?: Area }) {
  const { can, modules } = useAuth();
  const firstIn = (a: Area) => ORDER.find((s) => screenInArea(s, a) && can(s, 'view'));

  // Only somewhere this login may actually be. Landing in an area the company has not bought, or that
  // nobody assigned, would be a redirect straight into a refusal.
  const here = modules.includes(area) ? firstIn(area) : undefined;
  if (here) return <Navigate to={areaPath(area, here)} replace />;

  const elsewhere = modules.filter((a) => a !== area).map((a) => ({ a, s: firstIn(a) })).find((x) => x.s);
  if (elsewhere?.s) return <Navigate to={areaPath(elsewhere.a, elsewhere.s)} replace />;

  return (
    <div className="centered">
      {modules.length === 0
        ? 'No modules are enabled for your account. Ask an administrator to assign one under Settings → Users.'
        : 'You have no screen access yet. Ask an administrator to grant permissions.'}
    </div>
  );
}
