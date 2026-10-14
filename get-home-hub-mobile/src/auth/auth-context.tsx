import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { createAccessRefresh } from './access-refresh';

import { refreshAccess, restoreSession, revokeSession, signInWithCrm, type MobileUser } from '@/auth/auth-api';

interface AuthContextValue {
  loading: boolean;
  signingIn: boolean;
  token: string | null;
  user: MobileUser | null;
  error: string;
  canRetrySession: boolean;
  retrySession: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<MobileUser | null>(null);
  const [error, setError] = useState('');
  const [canRetrySession, setCanRetrySession] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!token) return;
    const refresh = createAccessRefresh(
      (signal) => refreshAccess(token, signal),
      (next) => {
        setUser(next);
        if (!next) setToken(null);
      },
      () => { /* Network failures retain session; server guards still enforce access. */ },
    );
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh.refresh();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh.refresh();
    }, 60_000);
    return () => { refresh.stop(); subscription.remove(); clearInterval(timer); };
  }, [token]);

  const retrySession = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSigningIn(true);
    setError('');
    try {
      const session = await restoreSession();
      setToken(session?.token ?? null);
      setUser(session?.user ?? null);
      setCanRetrySession(false);
    } catch {
      setCanRetrySession(true);
      setError('Could not reconnect to your saved session. Your saved login has been kept. Retry the connection or sign in again.');
    } finally {
      busy.current = false;
      setSigningIn(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    restoreSession().then((session) => {
      if (!active) return;
      setToken(session?.token ?? null);
      setUser(session?.user ?? null);
    }).catch(() => {
      if (!active) return;
      setCanRetrySession(true);
      setError('Could not reconnect to your saved session. Your saved login has been kept. Retry the connection or sign in again.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    loading,
    signingIn,
    token,
    user,
    error,
    canRetrySession,
    retrySession,
    signIn: async () => {
      if (busy.current) return;
      busy.current = true;
      setSigningIn(true);
      setError('');
      try {
        const session = await signInWithCrm();
        setToken(session.token);
        setUser(session.user);
        setCanRetrySession(false);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Sign-in failed. Please try again.');
      } finally {
        busy.current = false;
        setSigningIn(false);
      }
    },
    signOut: async () => {
      await revokeSession(token);
      setToken(null);
      setUser(null);
    },
  }), [canRetrySession, error, loading, retrySession, signingIn, token, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useMobileAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useMobileAuth must be used inside AuthProvider.');
  return context;
}
