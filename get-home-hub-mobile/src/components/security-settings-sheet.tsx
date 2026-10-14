import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Modal, Pressable, ScrollView } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { hasModule } from '@/auth/access-policy';
import { fetchSecurityStatus, securityPageUrl, type SecurityStatus } from '@/account/security-api';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';

const methodLabels = { totp: 'Authenticator app', email: 'Email code', sms: 'SMS code' };
export function SecuritySettingsSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth(), theme = useTheme();
  const area = hasModule(user, 'crm') ? 'crm' : hasModule(user, 'desk') ? 'desk' : null;
  const [status, setStatus] = useState<SecurityStatus>();
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false), [opening, setOpening] = useState(false);
  const alive = useRef(false), request = useRef<AbortController | null>(null), browserBusy = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, [token]);
  const refresh = async () => {
    if (!token || !alive.current || request.current) return;
    const controller = new AbortController(); request.current = controller; setLoading(true); setStatus(undefined); setError('');
    const timer = setTimeout(() => controller.abort(), 15000);
    try { const result = await fetchSecurityStatus(token, controller.signal); if (alive.current && !controller.signal.aborted) setStatus(result); }
    catch { if (alive.current) setError('Security status could not be loaded. No security changes were made. Retry or manage it on the CRM website.'); }
    finally { clearTimeout(timer); request.current = null; if (alive.current) setLoading(false); }
  };
  useEffect(() => {
    const initial = setTimeout(() => { void refresh(); }, 0);
    const subscription = AppState.addEventListener('change', next => { if (next === 'active') void refresh(); });
    return () => { clearTimeout(initial); subscription.remove(); };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = async (destination: 'password' | 'two-step') => {
    if (!token || !area || !alive.current || browserBusy.current) return;
    browserBusy.current = true; setOpening(true); setNotice('');
    try {
      await Linking.openURL(securityPageUrl(area, destination));
      if (alive.current) setNotice('Browser opened. Complete any changes there, then return and refresh status. Opening the page does not change your security settings.');
    } catch { if (alive.current) setNotice('The secure CRM page could not be opened. Please try again.'); }
    finally { browserBusy.current = false; if (alive.current) setOpening(false); }
  };
  const buttonStyle = { minHeight: 44, padding: 12 };
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ThemedText type="smallBold">Account security</ThemedText>
    <Pressable accessibilityRole="button" onPress={onClose} style={buttonStyle}><ThemedText>Close security settings</ThemedText></Pressable>
    <ThemedText>Mobile account: {user?.email || user?.name}</ThemedText>
    <ThemedText>Passwords, authenticator setup and recovery codes are managed on the trusted CRM website. Verify the browser is signed into this same account; it may ask you to sign in again.</ThemedText>
    {loading ? <ActivityIndicator /> : null}{error ? <ThemedText accessibilityLiveRegion="polite">{error}</ThemedText> : null}
    {status ? <><ThemedText type="smallBold">Two-step verification: {status.enabled ? 'Enabled' : 'Not enabled'}</ThemedText>
      {status.methods.map(method => <ThemedText key={method}>{methodLabels[method]}</ThemedText>)}
      <ThemedText>Unused recovery codes: {status.recoveryCodesRemaining}</ThemedText>
      <ThemedText>Trusted browser devices: {status.trustedDeviceCount}</ThemedText>
      <ThemedText>Trusted browser devices are not a list of mobile sessions.</ThemedText>
      {status.obligation !== 'none' ? <ThemedText>{status.obligation === 'overdue' ? 'Your organization requires two-step verification now.' : 'Your organization requires two-step verification; an enrollment grace period is active.'}</ThemedText> : null}</> : null}
    <Pressable accessibilityRole="button" disabled={loading} accessibilityState={{ disabled: loading }} onPress={() => { void refresh(); }} style={buttonStyle}><ThemedText>Refresh security status</ThemedText></Pressable>
    <ThemedText type="smallBold">Password</ThemedText>
    <ThemedText>Open CRM, then tap the padlock / Password button in the top bar (“Change your password”). The website requires your current password. The same button is available if sign-in takes you to the dashboard.</ThemedText>
    <Pressable accessibilityRole="button" disabled={!area || opening} accessibilityState={{ disabled: !area || opening }} onPress={() => { void open('password'); }} style={buttonStyle}><ThemedText>Open CRM password controls</ThemedText></Pressable>
    <ThemedText type="smallBold">Two-step verification and recovery</ThemedText>
    <ThemedText>Enroll an authenticator, manage available email/SMS methods, recovery codes and trusted browser devices. If sign-in opens the dashboard, choose Two-Step Verification from its menu, or reopen this link after signing in.</ThemedText>
    <Pressable accessibilityRole="button" disabled={!area || opening} accessibilityState={{ disabled: !area || opening }} onPress={() => { void open('two-step'); }} style={buttonStyle}><ThemedText>Manage two-step verification securely</ThemedText></Pressable>
    {!area ? <ThemedText>No CRM or Transactions module is available. Ask your administrator for access to the website security screen.</ThemedText> : null}
    {notice ? <ThemedText accessibilityLiveRegion="polite">{notice}</ThemedText> : null}
  </ScrollView></SafeAreaView></SafeAreaProvider></Modal>;
}
