import type { Dispatch, SetStateAction } from 'react';

/**
 * Core authentication & authorization types. These mirror the exact payload the
 * Laravel API returns from `/api/user`, `/api/login`, and `/api/register`
 * (see AuthController::payload) and the role/permission model in
 * PermissionService — do not diverge without a matching backend change.
 */

/** Stored role values. 'admin' = Super Admin, 'manager' = Admin (relabelled in UI). */
export type Role = 'admin' | 'manager' | 'agent' | 'accounting' | 'documentation' | 'crm';

/** Screen-level access ranking used by PermissionService and the `can()` helper. */
export type ScreenLevel = 'none' | 'view' | 'edit';

/** Effective per-screen permission map, keyed by screen name. */
export type Permissions = Record<string, ScreenLevel>;

/** The authenticated user object returned by AuthController::payload. */
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  role_label: string;
  is_admin: boolean;
  is_super_admin: boolean;
  is_admin_or_above: boolean;
  permissions: Permissions;
}

/** Body sent to POST /api/register (bootstrap first-admin registration). */
export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
  password_confirmation: string;
}

/** Value exposed by AuthContext / useAuth(). */
export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string, remember?: boolean) => Promise<AuthUser>;
  register: (payload: RegisterPayload) => Promise<AuthUser>;
  logout: () => Promise<void>;
  setUser: Dispatch<SetStateAction<AuthUser | null>>;
  can: (screen: string, level?: ScreenLevel) => boolean;
  isSuperAdmin: boolean;
  isAdminOrAbove: boolean;
}
