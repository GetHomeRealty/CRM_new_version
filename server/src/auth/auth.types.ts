import type { user_modules, user_permissions, users } from '@prisma/client';

/**
 * A user row loaded together with its per-user permission overrides and module assignments.
 *
 * The module rows ride along because `ScreenGuard` needs them on every request, and the guard
 * reading them off a user the auth guard has already loaded costs nothing, where a second query
 * would cost one per request.
 */
export type AuthUserRecord = users & {
  user_permissions: user_permissions[];
  user_modules?: user_modules[];
};

/**
 * The authenticated-user payload returned by /api/login, /api/register and
 * /api/user — a faithful copy of Laravel AuthController::payload().
 */
export interface AuthPayload {
  id: number;
  name: string;
  email: string;
  role: string;
  role_label: string;
  is_admin: boolean;
  is_super_admin: boolean;
  is_admin_or_above: boolean;
  permissions: Record<string, string>;
  /**
   * The modules this person may open — licensed to the company AND assigned to them. The frontend
   * builds its navigation from this, so a module nobody bought and a module nobody was given look the
   * same from the outside: absent.
   */
  modules: ('crm' | 'desk')[];
  /** What the company bought, for the screens that explain why a module is missing. */
  licence: { crm: boolean; desk: boolean; plan: string | null; status: string; expires: string | null; valid: boolean };
}
