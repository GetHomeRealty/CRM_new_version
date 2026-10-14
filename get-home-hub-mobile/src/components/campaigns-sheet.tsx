import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { cancelScheduledCampaign } from '@/campaigns/campaign-write-api';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { fetchCampaign, fetchCampaigns, type CampaignSummary } from '@/campaigns/campaigns-api';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';
import { CampaignToolsSheet } from './campaign-tools-sheet';
import { deliverySummary } from '@/campaigns/delivery-summary';
import { CampaignSuppressionsSheet } from './campaign-suppressions-sheet';

function Stats({ campaign }: { campaign: CampaignSummary }) {
  return <View style={styles.card}><ThemedText type="smallBold">{campaign.name}</ThemedText>
    <ThemedText>Status: {campaign.status}</ThemedText>
    <ThemedText type="small">Recipients: {campaign.stats.total} · Sent: {campaign.stats.sent} · Failed: {campaign.stats.failed}</ThemedText>
    <ThemedText type="small">Opened: {campaign.stats.opened} · Bounced: {campaign.stats.bounced} · Unsubscribed: {campaign.stats.unsubscribed}</ThemedText>
  </View>;
}
export function CampaignsSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const canEdit = canAreaScreen(user, 'crm', 'campaigns', 'edit');
  const editAllowed = useRef(canEdit);
  useLayoutEffect(() => { editAllowed.current = canEdit; return () => { editAllowed.current = false; }; }, [canEdit]);
  const theme = useTheme();
  const [selected, setSelected] = useState<number | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [suppressionsOpen, setSuppressionsOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelMessage, setCancelMessage] = useState('');
  const [attemptedIds, setAttemptedIds] = useState<number[]>([]);
  const pendingCancel = useRef<AbortController | null>(null);
  const attempted = useRef(new Set<number>());
  useEffect(() => () => pendingCancel.current?.abort(), []);
  const list = useQuery({ queryKey: ['campaigns'], queryFn: ({ signal }) => fetchCampaigns(token!, signal), enabled: Boolean(token) });
  const detail = useQuery({ queryKey: ['campaign', selected], queryFn: ({ signal }) => fetchCampaign(token!, selected!, signal), enabled: Boolean(token && selected) });
  const current = selected ? detail : list;
  const back = () => { if (pendingCancel.current) return; setCancelMessage(''); return selected ? setSelected(null) : onClose(); };
  const confirmCancellation = () => {
    if (!editAllowed.current || !token || !selected || detail.data?.status !== 'scheduled' || pendingCancel.current || attempted.current.has(selected)) return;
    const id = selected;
    Alert.alert('Cancel scheduled campaign?', 'This requests cancellation only before delivery begins. Emails already sent cannot be recalled.', [{ text: 'Keep scheduled', style: 'cancel' }, { text: 'Cancel scheduled campaign', style: 'destructive', onPress: () => { void (async () => {
      if (!editAllowed.current || pendingCancel.current || attempted.current.has(id)) return;
      const controller = new AbortController(); pendingCancel.current = controller; attempted.current.add(id); setAttemptedIds(previous => [...previous, id]); setCancelling(true); setCancelMessage('');
      try {
        await cancelScheduledCampaign(token, id, controller.signal);
        if (!controller.signal.aborted) setCancelMessage('Cancellation confirmed. Refreshing campaign status.');
      } catch (error) { if (!controller.signal.aborted) setCancelMessage(error instanceof Error ? error.message : 'Cancellation could not be confirmed. Refresh campaign status.'); }
      finally {
        if (!controller.signal.aborted) { await Promise.all([detail.refetch(), list.refetch()]); setCancelling(false); }
        pendingCancel.current = null;
      }
    })(); } }]);
  };
  if (toolsOpen) return <CampaignToolsSheet onClose={() => { setToolsOpen(false); void list.refetch(); }} />;
  if (suppressionsOpen) return <CampaignSuppressionsSheet onClose={() => setSuppressionsOpen(false)} />;
  return <Modal visible animationType="slide" onRequestClose={back}>
    <SafeAreaProvider>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}><ThemedText type="subtitle">{selected ? 'Campaign results' : 'Campaigns'}</ThemedText>
        <Pressable accessibilityRole="button" onPress={back} style={styles.button}><ThemedText>{selected ? 'Back to campaigns' : 'Close'}</ThemedText></Pressable></View>
      <ThemedText type="small">No emails are sent from this screen. Scheduled campaigns can be cancelled before delivery starts.</ThemedText>
      {cancelMessage ? <ThemedText accessibilityRole="alert">{cancelMessage}</ThemedText> : null}
      {canEdit && selected && detail.data?.status === 'scheduled' && !detail.isError ? <Pressable accessibilityRole="button" disabled={cancelling || attemptedIds.includes(selected)} accessibilityState={{ disabled: cancelling || attemptedIds.includes(selected) }} style={styles.button} onPress={confirmCancellation}><ThemedText>Cancel scheduled campaign</ThemedText></Pressable> : null}
      {cancelling ? <ActivityIndicator accessibilityLabel="Cancelling campaign" /> : null}
      {!selected ? <Pressable accessibilityRole="button" onPress={() => setToolsOpen(true)} style={styles.button}><ThemedText>Templates and audience preview</ThemedText></Pressable> : null}
      {!selected ? <Pressable accessibilityRole="button" onPress={() => setSuppressionsOpen(true)} style={styles.button}><ThemedText>Do-not-email list</ThemedText></Pressable> : null}
      <Pressable accessibilityRole="button" onPress={() => { void current.refetch(); }} style={styles.button}><ThemedText>Refresh campaigns</ThemedText></Pressable>
      {current.isFetching ? <ActivityIndicator accessibilityLabel="Loading campaigns" /> : null}
      {current.isError ? <ThemedText accessibilityRole="alert" themeColor="danger">{current.error.message}</ThemedText> : null}
      {selected ? detail.data && !detail.isError ? <FlatList data={detail.data.recipients} keyExtractor={item => String(item.id)}
        ListHeaderComponent={<><Stats campaign={detail.data} /><ThemedText>Subject: {detail.data.subject}</ThemedText><ThemedText type="small">Open counts are tracking signals, not proof that a person read the email.</ThemedText></>}
        ListEmptyComponent={<ThemedText>No recipient results.</ThemedText>}
        renderItem={({ item }) => <View style={styles.card}><ThemedText type="smallBold">{item.name || item.email}</ThemedText><ThemedText type="small">{item.email}</ThemedText><ThemedText type="small">{item.status}{item.opened ? ' · Open tracked' : ''}{item.bounced ? ' · Bounced' : ''}{item.unsubscribed ? ' · Unsubscribed' : ''}</ThemedText><ThemedText type="small">{deliverySummary(item)}</ThemedText></View>} /> : null
        : list.data && !list.isError ? <FlatList data={list.data} keyExtractor={item => String(item.id)}
          ListHeaderComponent={<ThemedText type="small">Latest {list.data.length} campaigns (up to 100). Older campaigns remain available on the website.</ThemedText>}
          ListEmptyComponent={<ThemedText>No campaigns found.</ThemedText>}
          renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`View campaign ${item.name}`} onPress={() => setSelected(item.id)}><Stats campaign={item} /></Pressable>} /> : null}
    </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;
}
const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 }, header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
  button: { minHeight: 44, padding: 12 }, card: { paddingVertical: 16, gap: 8 },
});
