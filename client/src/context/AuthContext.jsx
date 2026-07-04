import { createContext, useContext, useEffect, useState } from 'react';
import api, { getCsrfCookie } from '../lib/axios';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On first load, try to restore the session by asking the API who we are.
  useEffect(() => {
    let active = true;
    api
      .get('/api/user')
      .then((res) => active && setUser(res.data))
      .catch(() => active && setUser(null))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const login = async (username, password, remember = false) => {
    await getCsrfCookie();
    const { data } = await api.post('/api/login', { username, password, remember });
    setUser(data.user);
    return data.user;
  };

  const register = async (payload) => {
    await getCsrfCookie();
    const { data } = await api.post('/api/register', payload);
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    await api.post('/api/logout');
    setUser(null);
  };

  // Screen-level permission check (mirrors backend PermissionService).
  const RANK = { none: 0, view: 1, edit: 2 };
  const can = (screen, level = 'view') => {
    if (!user) return false;
    if (user.is_admin) return true;
    const have = user.permissions?.[screen] ?? 'none';
    return (RANK[have] ?? 0) >= (RANK[level] ?? 0);
  };

  // Role tiers (relabel-in-place): Super Admin (stored 'admin') > Admin ('manager') > Agent.
  const isSuperAdmin = !!user?.is_super_admin;
  const isAdminOrAbove = !!user?.is_admin_or_above;

  const value = { user, loading, login, register, logout, setUser, can, isSuperAdmin, isAdminOrAbove };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
