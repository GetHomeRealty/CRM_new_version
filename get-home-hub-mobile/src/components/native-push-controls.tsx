import { Pressable, View } from 'react-native';
import { useNativePush } from '@/notifications/native-push-context';
import { ThemedText } from './themed-text';
export function NativePushControls() {
  const push = useNativePush();
  if (!push) return null;
  const labels = { unavailable: 'Device notifications are not configured for this build.', disabled: 'Device notifications are off.', enabled: 'Device notifications are enabled for this signed-in session.', denied: 'Device notifications are blocked in system settings.', error: 'Device notification status could not be confirmed. Refresh before retrying.' };
  return <View style={{ gap: 8 }}><ThemedText accessibilityLiveRegion="polite">{labels[push.state]}</ThemedText>
    <ThemedText type="small">Alerts show a generic update. Open the app to view details. Category preferences also apply.</ThemedText>
    {push.state !== 'unavailable' ? <>
      <Pressable accessibilityRole="button" disabled={push.busy} style={{ minHeight: 44, padding: 12 }} onPress={() => { void push.enable(); }}><ThemedText>Enable device notifications</ThemedText></Pressable>
      <Pressable accessibilityRole="button" disabled={push.busy} style={{ minHeight: 44, padding: 12 }} onPress={() => { void push.disable(); }}><ThemedText>Disable device notifications</ThemedText></Pressable>
      <Pressable accessibilityRole="button" disabled={push.busy} style={{ minHeight: 44, padding: 12 }} onPress={() => { void push.refresh(); }}><ThemedText>Refresh device notification status</ThemedText></Pressable>
    </> : null}
  </View>;
}
