import { AREAS, type Area } from '../desk/area';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import api, { getCsrfCookie } from '../lib/axios';
import type { AuthContextValue, AuthUser, RegisterPayload, ScreenLevel } from '../types';

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

  const login = async (username: string, password: string, remember = false): Promise<AuthUser> => {
    await getCsrfCookie();
    const { data } = await api.post<{ user: AuthUser }>('/api/login', { username, password, remember });
    setUser(data.user);
    return data.user;
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

  const value: AuthContextValue = { user, loading, login, register, logout, setUser, can, isSuperAdmin, isAdminOrAbove, modules };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
