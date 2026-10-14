import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useEffect, useState } from 'react';
import { createSessionCache, disposeSessionCache } from '@/auth/session-cache';

import { NativePushProvider } from '@/components/native-push-provider';
import AppTabs from '@/components/app-tabs';
import { AuthProvider, useMobileAuth } from '@/auth/auth-context';
import { SignInScreen } from '@/components/sign-in-screen';
import { useColorScheme } from '@/hooks/use-color-scheme';

function AuthenticatedApp() {
  const { loading, user, token } = useMobileAuth();
  if (loading) return null;
  return user && token ? <SessionApp key={token} /> : <SignInScreen />;
}

function SessionApp() {
  const [queryClient] = useState(createSessionCache);
  useEffect(() => () => disposeSessionCache(queryClient), [queryClient]);
  return <QueryClientProvider client={queryClient}><NativePushProvider><AppTabs /></NativePushProvider></QueryClientProvider>;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AuthProvider>
          <AuthenticatedApp />
        </AuthProvider>
      </ThemeProvider>
  );
}
