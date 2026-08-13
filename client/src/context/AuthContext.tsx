import { AREAS, type Area } from '../desk/area';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import api, { getCsrfCookie } from '../lib/axios';
import type { AuthContextValue, AuthUser, RegisterPayload, ScreenLevel } from '../types';
import { answerChallenge, isChallenge, type LoginOutcome, type MfaType } from '../lib/mfaApi';

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On first load, try to restore the session by asking the API who we are.
  useEffect(() => {
    let active = true;
    api
      .get<AuthUser>('/api/user')
      .then((res) => { if (active) setUser(res.data); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
    };
  }, []);

  /**
   * Sign in — which may not finish here.
   *
   * The server answers one of two shapes. When the account holds a second factor and this browser is
   * not already trusted, it answers `{ mfa_required: true, challenge }` and NO user payload: at that
   * point a password has been proved and nothing else, and the payload is the thing being protected.
   * The caller shows the challenge and calls `completeMfa` with the code.
   *
   * `setUser` is deliberately NOT called on a challenge. Setting a user here would make the whole
   * application behave as though sign-in had succeeded while the server still refuses every request
   * — which is the failure mode a partial-login bug takes.
   */
  const login = async (username: string, password: string, remember = false): Promise<LoginOutcome> => {
    await getCsrfCookie();
    const { data } = await api.post<LoginOutcome>('/api/login', { username, password, remember });
    if (!isChallenge(data)) setUser(data.user);
    return data;
  };

  /** Answer the outstanding challenge and finish signing in. */
  const completeMfa = async (
    method: MfaType | 'recovery',
    code: string,
    trustDevice = false,
  ): Promise<AuthUser> => {
    const { user: signedIn } = await answerChallenge(method, code, trustDevice);
    setUser(signedIn);
    return signedIn;
  };

  const register = async (payload: RegisterPayload): Promise<AuthUser> => {
    await getCsrfCookie();
    const { data } = await api.post<{ user: AuthUser }>('/api/register', payload);
    setUser(data.user);
    return data.user;
  };

  const logout = async (): Promise<void> => {
    await api.post('/api/logout');
    setUser(null);
  };

  // Screen-level permission check (mirrors backend PermissionService).
  const RANK: Record<ScreenLevel, number> = { none: 0, view: 1, edit: 2 };
  const can = (screen: string, level: ScreenLevel = 'view'): boolean => {
    if (!user) return false;
    if (user.is_admin) return true;
    const have = user.permissions?.[screen] ?? 'none';
    return (RANK[have] ?? 0) >= (RANK[level] ?? 0);
  };

  // Role tiers (relabel-in-place): Super Admin (stored 'admin') > Admin ('manager') > Agent.
  const isSuperAdmin = !!user?.is_super_admin;
  /**
   * The areas this login may open. Falls back to both when the server said nothing — an older API, or
   * a deployment that has not been told about licensing, must not leave someone with no navigation.
   */
  const modules: Area[] = AREAS.filter((a) => (user?.modules ? user.modules.includes(a) : true));
  const isAdminOrAbove = !!user?.is_admin_or_above;

  const value: AuthContextValue = { user, loading, login, completeMfa, register, logout, setUser, can, isSuperAdmin, isAdminOrAbove, modules };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
