import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { fetchNotificationPreferences, saveNotificationPreferences, type PreferenceChanges } from '@/notifications/preferences-api';
import { ThemedText } from './themed-text';

const labels = { in_app: 'In-app', email: 'Email', push: 'Push' };

export function NotificationPreferencesSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const theme = useTheme();
  const client = useQueryClient();
  const [draft, setDraft] = useState<PreferenceChanges>({});
  const [saved, setSaved] = useState(false);
  const prefs = useQuery({ queryKey: ['notification-preferences'],
    queryFn: ({ signal }) => fetchNotificationPreferences(token!, signal), enabled: Boolean(token) });
  const save = useMutation({
    mutationFn: () => saveNotificationPreferences(token!, prefs.data!, draft),
    onSuccess: (result) => { client.setQueryData(['notification-preferences'], result); setDraft({}); setSaved(true); },
  });
  const dirty = Object.keys(draft).length > 0;
  const close = () => {
    if (save.isPending) return;
    if (!dirty) return onClose();
    Alert.alert('Discard changes?', 'Your notification changes have not been saved.', [
      { text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  };
  return <Modal visible animationType="slide" onRequestClose={close}>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <ThemedText type="subtitle">Notification preferences</ThemedText>
      <ThemedText type="small">These settings apply to your Hub account. Push preferences do not enable native phone notifications; device registration is not implemented yet.</ThemedText>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" disabled={save.isPending} accessibilityState={{ disabled: save.isPending }} onPress={close} style={styles.button}><ThemedText>Back</ThemedText></Pressable>
        <Pressable accessibilityRole="button" disabled={!dirty || save.isPending || !prefs.data} accessibilityState={{ disabled: !dirty || save.isPending || !prefs.data }} onPress={() => save.mutate()} style={styles.button}><ThemedText>Save preferences</ThemedText></Pressable>
      </View>
      {prefs.isPending || save.isPending ? <ActivityIndicator color={theme.primary} /> : null}
      {prefs.error || save.error ? <ThemedText accessibilityRole="alert" themeColor="danger">{prefs.error?.message || save.error?.message}</ThemedText> : null}
      {prefs.isError ? <Pressable accessibilityRole="button" onPress={() => { void prefs.refetch(); }} style={styles.button}><ThemedText>Retry loading</ThemedText></Pressable> : null}
      {saved ? <ThemedText accessibilityLiveRegion="polite">Preferences saved.</ThemedText> : null}
      <ScrollView contentContainerStyle={styles.content}>
        {prefs.data?.categories.filter((category) => !category.areas || category.areas.some((area) => Array.isArray(user?.modules) && user.modules.includes(area))).map((category) => <View key={category.key} style={[styles.card, { borderColor: theme.primary }]}>
          <ThemedText type="smallBold">{category.label}</ThemedText>
          <ThemedText type="small">{category.description}</ThemedText>
          {prefs.data!.channels.map((channel) => <View key={channel} style={styles.row}>
            <ThemedText>{labels[channel]}{category.channels[channel] !== 'live' ? ` (${category.channels[channel]})` : ''}</ThemedText>
            <Switch accessibilityLabel={`${category.label}: ${labels[channel]}`} disabled={save.isPending || category.channels[channel] !== 'live'}
              value={draft[category.key]?.[channel] ?? category.enabled[channel]}
              onValueChange={(enabled) => { setSaved(false); setDraft((previous) => ({ ...previous, [category.key]: { ...previous[category.key], [channel]: enabled } })); }} />
          </View>)}
        </View>)}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, padding: 12, justifyContent: 'center' },
  content: { paddingVertical: 12, gap: 16 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16, gap: 12 },
});
