import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { fetchSuppressions } from '@/campaigns/campaigns-api';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';

export function CampaignSuppressionsSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const allowed = Boolean(token) && canAreaScreen(user, 'crm', 'campaigns');
  const theme = useTheme();
  const [page, setPage] = useState(1);
  const result = useQuery({ queryKey: ['campaign-suppressions', user?.id, page],
    queryFn: ({ signal }) => fetchSuppressions(token!, page, signal), enabled: allowed });
  const data = allowed && !result.isError ? result.data : undefined;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaProvider>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <ThemedText type="subtitle">Do-not-email list</ThemedText>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}><ThemedText>Back to campaigns</ThemedText></Pressable>
      <ThemedText type="small">Addresses excluded from campaign delivery. Only records your account can access are shown. This read-only screen does not change consent or send emails.</ThemedText>
      {!allowed ? <ThemedText accessibilityRole="alert">You do not have access to campaigns.</ThemedText> : <>
        <Pressable accessibilityRole="button" onPress={() => { void result.refetch(); }} style={styles.button}><ThemedText>Refresh do-not-email list</ThemedText></Pressable>
        {result.isFetching ? <ActivityIndicator accessibilityLabel="Loading do-not-email list" /> : null}
        {result.isError ? <ThemedText accessibilityRole="alert">{result.error.message}</ThemedText> : null}
        {data ? <FlatList data={data.data} keyExtractor={item => String(item.id)}
          ListHeaderComponent={<ThemedText type="small">{data.meta.total} addresses · Page {page} of {data.meta.last_page}</ThemedText>}
          ListEmptyComponent={<ThemedText>No addresses on this page.</ThemedText>}
          renderItem={({ item }) => <View style={styles.card}><ThemedText type="smallBold">{item.email}</ThemedText><ThemedText>Reason: {item.reason || 'Not specified'}</ThemedText><ThemedText type="small">Updated: {item.updated_at ? new Date(item.updated_at).toLocaleString() : 'Not available'}</ThemedText></View>} /> : null}
        <View style={styles.navigation}>
          <Pressable accessibilityRole="button" disabled={page === 1 || result.isFetching} onPress={() => setPage(value => Math.max(1, value - 1))} style={styles.button}><ThemedText>Previous page</ThemedText></Pressable>
          <Pressable accessibilityRole="button" disabled={!data || page >= data.meta.last_page || result.isFetching} onPress={() => setPage(value => value + 1)} style={styles.button}><ThemedText>Next page</ThemedText></Pressable>
        </View>
      </>}
    </SafeAreaView></SafeAreaProvider></Modal>;
}
const styles = StyleSheet.create({ container: { flex: 1, padding: 16, gap: 12 }, button: { minHeight: 44, padding: 12 }, card: { paddingVertical: 16, gap: 8 }, navigation: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' } });
