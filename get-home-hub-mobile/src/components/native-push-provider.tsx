import { type PropsWithChildren, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useMobileAuth } from '@/auth/auth-context';
import { environment } from '@/config/environment';
import { NativePushContext } from '@/notifications/native-push-context';
import { createNativePushSession, type PushState } from '@/notifications/native-push-session';
import { isCurrentPush, nativePushRequest } from '@/notifications/native-push-api';
import { NotificationsSheet } from './notifications-sheet';

export function NativePushProvider({ children }: PropsWithChildren) {
  const { token, user } = useMobileAuth();
  const [state, setState] = useState<PushState>('unavailable');
  const [busy, setBusy] = useState(false);
  const [openedFor, setOpenedFor] = useState<{ token: string; userId: number } | null>(null);
  const available = environment.nativePushEnabled && Platform.OS !== 'web' && /^[0-9a-f-]{36}$/i.test(environment.pushProjectId);
  const managerRef = useRef<ReturnType<typeof createNativePushSession> | null>(null);
  const userId = user?.id;
  useEffect(() => {
    const manager = createNativePushSession({
    available: Boolean(available && token),
    capability: signal => nativePushRequest(token!, 'GET', signal),
    permission: async ask => {
      const Notifications = await import('expo-notifications');
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('hub-updates', { name: 'Hub updates', importance: Notifications.AndroidImportance.DEFAULT });
      let permission = await Notifications.getPermissionsAsync();
      if (ask && !permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
      return permission.granted;
    },
    token: async () => (await (await import('expo-notifications')).getExpoPushTokenAsync({ projectId: environment.pushProjectId })).data,
    register: async (pushToken, signal) => { await nativePushRequest(token!, 'POST', signal, { token: pushToken, platform: Platform.OS === 'ios' ? 'ios' : 'android' }); },
    remove: async signal => { await nativePushRequest(token!, 'DELETE', signal); },
    changed: setState,
  });
    managerRef.current = manager;
    let active = true;
    let removeResponse: (() => void) | undefined;
    const refresh = () => { void manager.refresh(); };
    const subscription = AppState.addEventListener('change', status => { if (status === 'active') refresh(); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') refresh(); }, 6 * 60 * 60 * 1000);
    refresh();
    if (available) void import('expo-notifications').then(Notifications => {
      if (!active) return;
      Notifications.setNotificationHandler({ handleNotification: async notification => {
        const allowed = Boolean(active && userId && isCurrentPush(notification.request.content.data, userId));
        return { shouldShowBanner: allowed, shouldShowList: allowed, shouldPlaySound: false, shouldSetBadge: false };
      } });
      // Alerts never contain record data. Authentication + account ID gates notification interactions.
      const handle = (response: import('expo-notifications').NotificationResponse | null) => {
        if (active && response && userId && isCurrentPush(response.notification.request.content.data, userId)) {
          setOpenedFor({ token: token!, userId }); void Notifications.clearLastNotificationResponseAsync();
        }
      };
      handle(Notifications.getLastNotificationResponse());
      const listener = Notifications.addNotificationResponseReceivedListener(handle);
      removeResponse = () => { listener.remove(); Notifications.setNotificationHandler(null); };
    }).catch(() => { if (active) setState('error'); });
    return () => {
      active = false; manager.stop(); if (managerRef.current === manager) managerRef.current = null; subscription.remove(); clearInterval(timer); removeResponse?.();
      if (available) void import('expo-notifications').then(async Notifications => {
        await Notifications.dismissAllNotificationsAsync(); await Notifications.clearLastNotificationResponseAsync();
      }).catch(() => {});
    };
  }, [available, token, userId]);
  const controls = useMemo(() => {
    const run = async (action: 'enable' | 'disable' | 'refresh') => { setBusy(true); try { await managerRef.current?.[action](); } finally { setBusy(false); } };
    return { state, busy, enable: () => run('enable'), disable: () => run('disable'), refresh: () => run('refresh') };
  }, [busy, state]);
  return <NativePushContext.Provider value={controls}>{children}{openedFor && openedFor.token === token && openedFor.userId === userId ? <NotificationsSheet onClose={() => setOpenedFor(null)} /> : null}</NativePushContext.Provider>;
}
