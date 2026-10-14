import { NativePushControls } from './native-push-controls';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { fetchNotifications, markAllNotificationsRead, markNotificationRead, type NotificationFilter, type NotificationItem, type NotificationSource } from '@/notifications/notifications-api';
import { ThemedText } from './themed-text';
import { notificationTarget, type NotificationTarget } from '@/notifications/notification-target';
import { LeadDetailSheet } from './lead-detail-sheet';
import { TransactionDetailSheet } from './transaction-detail-sheet';
import { NotificationPreferencesSheet } from './notification-preferences-sheet';

const categories: { label: string; value: NotificationSource | undefined }[] = [
  { label: 'All categories', value: undefined }, { label: 'Alerts', value: 'direct' },
  { label: 'Reminders', value: 'reminder' }, { label: 'Document reviews', value: 'doc-review' },
  { label: 'Review decisions', value: 'review-decision' }, { label: 'Agent changes', value: 'agent-change' },
];

export function NotificationsSheet({ onClose }: { onClose: () => void }) {
  const { token } = useMobileAuth();
  const theme = useTheme();
  const client = useQueryClient();
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [source, setSource] = useState<NotificationSource | undefined>();
  const [offset, setOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [target, setTarget] = useState<NotificationTarget | null>(null);
  const feed = useQuery({ queryKey: ['notifications', filter, source, offset, search],
    queryFn: ({ signal }) => fetchNotifications(token!, { filter, source, offset, search, signal }), enabled: Boolean(token) });
  const refresh = () => client.invalidateQueries({ queryKey: ['notifications'] });
  const mark = useMutation({ mutationFn: (item: NotificationItem) => markNotificationRead(token!, item),
    onSuccess: () => { setNotice('Notification marked read.'); void refresh(); } });
  const markAll = useMutation({ mutationFn: () => markAllNotificationsRead(token!),
    onSuccess: (result) => { setNotice(`${result.marked} marked read.${result.failed ? ` ${result.failed} could not be updated. Refresh and retry.` : ''}`); void refresh(); } });
  const busy = mark.isPending || markAll.isPending;
  const button = (label: string, action: () => void, disabled = false, selected?: boolean) => <Pressable
    accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled} onPress={action}
    style={[styles.button, { borderColor: theme.primary, opacity: disabled ? 0.45 : 1, borderWidth: selected ? 2 : 1 }]}>
    <ThemedText type="smallBold">{label}</ThemedText>
  </Pressable>;
  if (preferencesOpen) return <NotificationPreferencesSheet onClose={() => setPreferencesOpen(false)} />;
  if (target?.kind === 'lead') return <LeadDetailSheet leadId={target.id} onClose={() => setTarget(null)} />;
  if (target?.kind === 'transaction') return <TransactionDetailSheet transactionId={target.id} onClose={() => setTarget(null)} />;
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.row}><ThemedText type="subtitle">Notifications</ThemedText>{button('Close', onClose)}</View>
      {button('Preferences', () => setPreferencesOpen(true), busy)}
      <NativePushControls />
      <View style={styles.row}>{(['all', 'unread', 'read'] as const).map((value) => <View key={value}>
        {button(value[0].toUpperCase() + value.slice(1), () => { setFilter(value); setOffset(0); }, busy, filter === value)}
      </View>)}</View>
      <View><ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.row}>
        {categories.map((category) => <View key={category.label}>
          {button(category.label, () => { setSource(category.value); setOffset(0); }, busy, source === category.value)}
        </View>)}
      </ScrollView></View>
      <TextInput accessibilityLabel="Search notifications" placeholder="Search notifications" value={searchDraft}
        onChangeText={setSearchDraft} onSubmitEditing={() => { setSearch(searchDraft.trim()); setOffset(0); }}
        style={[styles.input, { color: theme.text, borderColor: theme.primary }]} />
      <View style={styles.row}>
        {button('Search', () => { setSearch(searchDraft.trim()); setOffset(0); }, busy)}
        {button('Refresh', () => { void feed.refetch(); }, feed.isFetching || busy)}
        {button('Mark all read', () => Alert.alert('Mark all notifications read?', 'This affects every unread notification, including those outside this page and filter.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Mark all read', onPress: () => { setNotice(''); markAll.mutate(); } },
        ]), busy || !feed.data?.unread)}
      </View>
      {feed.isPending || busy ? <ActivityIndicator color={theme.primary} /> : null}
      {feed.error || mark.error || markAll.error ? <ThemedText accessibilityRole="alert" themeColor="danger">{feed.error?.message || mark.error?.message || markAll.error?.message}</ThemedText> : null}
      {notice ? <ThemedText accessibilityLiveRegion="polite">{notice}</ThemedText> : null}
      <ScrollView contentContainerStyle={styles.content}>
        {feed.data?.items.length === 0 ? <ThemedText>No matching notifications.</ThemedText> : null}
        {feed.data?.items.map((item) => <View key={item.key} style={[styles.card, { borderColor: theme.primary }]}>
          <ThemedText type="smallBold">{item.unread ? '● ' : ''}{item.title}</ThemedText>
          {item.summary ? <ThemedText>{item.summary}</ThemedText> : null}
          {item.property ? <ThemedText type="small">{item.property}</ThemedText> : null}
          {item.at ? <ThemedText type="small">{new Date(item.at).toLocaleString()}</ThemedText> : null}
          {notificationTarget(item.link) ? button('Open related record', () => setTarget(notificationTarget(item.link)), busy) : null}
          {item.unread ? button('Mark read', () => { setNotice(''); mark.mutate(item); }, busy) : <ThemedText type="small">Read</ThemedText>}
        </View>)}
      </ScrollView>
      <View style={styles.row}>
        {button('Previous', () => setOffset((value) => Math.max(0, value - 30)), offset === 0 || feed.isFetching || busy)}
        <ThemedText type="small">Page {Math.floor(offset / 30) + 1}</ThemedText>
        {button('Next', () => setOffset((value) => value + 30), !feed.data || offset + feed.data.limit >= feed.data.total || feed.isFetching || busy)}
      </View>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  button: { minHeight: 44, padding: 12, borderRadius: 12, justifyContent: 'center' },
  input: { minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 12 },
  content: { gap: 12, paddingVertical: 12 },
  card: { padding: 16, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 8 },
});
