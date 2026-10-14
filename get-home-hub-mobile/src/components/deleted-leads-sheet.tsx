import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { fetchDeletedLeads, restoreDeletedLead } from '@/leads/deleted-leads-api';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';

export function DeletedLeadsSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const theme = useTheme();
  const allowed = Boolean(token) && canAreaScreen(user, 'crm', 'lead');
  const canRestore = allowed && canAreaScreen(user, 'crm', 'lead', 'edit');
  const editAllowed = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const attempted = useRef(new Set<number>());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const client = useQueryClient();
  useLayoutEffect(() => { editAllowed.current = canRestore; return () => { editAllowed.current = false; }; }, [canRestore]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);
  const result = useQuery({ queryKey: ['deleted-leads', user?.id, page, submitted],
    queryFn: ({ signal }) => fetchDeletedLeads(token!, page, submitted, signal), enabled: allowed });
  const data = allowed && !result.isError ? result.data : undefined;
  const button = { minHeight: 44, padding: 12 };
  const searchNow = () => { setPage(1); setSubmitted(search.trim()); };
  const close = () => { if (!pending.current) onClose(); };
  const confirmRestore = (id: number, name: string) => {
    if (!editAllowed.current || !token || pending.current || attempted.current.has(id)) return;
    Alert.alert('Restore lead?', `Return ${name} to your active leads?`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Restore', onPress: () => { void (async () => {
      if (!editAllowed.current || pending.current || attempted.current.has(id)) return;
      const controller = new AbortController(); pending.current = controller; attempted.current.add(id); setBusy(true); setMessage('');
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        await restoreDeletedLead(token, id, controller.signal);
        if (editAllowed.current) setMessage('Lead restored.');
      } catch (error) {
        if (editAllowed.current) setMessage(controller.signal.aborted ? 'Restore timed out. Check active leads before trying again.' : error instanceof Error ? error.message : 'Restore could not be confirmed. Check active leads.');
      } finally {
        clearTimeout(timer); pending.current = null;
        if (mounted.current) setBusy(false);
        if (editAllowed.current) {
          void client.invalidateQueries({ queryKey: ['leads'] });
          void client.invalidateQueries({ queryKey: ['deleted-leads'] });
        }
      }
    })(); } }]);
  };
  return <Modal visible animationType="slide" onRequestClose={close}><SafeAreaProvider><SafeAreaView style={{ flex: 1, padding: 16, gap: 12, backgroundColor: theme.background }}>
    <ThemedText type="subtitle">Recently deleted leads</ThemedText>
    <Pressable accessibilityRole="button" disabled={busy} onPress={close} style={button}><ThemedText>Back to leads</ThemedText></Pressable>
    {!allowed ? <ThemedText accessibilityRole="alert">You do not have access to leads.</ThemedText> : <>
      <ThemedText type="small">View deleted leads your account can access. Restoring returns a lead to the active list. Permanent deletion is not available here.</ThemedText>
      {message ? <ThemedText accessibilityRole="alert">{message}</ThemedText> : null}
      {busy ? <ActivityIndicator accessibilityLabel="Restoring lead" /> : null}
      <TextInput accessibilityLabel="Search deleted leads" placeholder="Search name or email" placeholderTextColor={theme.textSecondary} value={search} onChangeText={setSearch} onSubmitEditing={searchNow} autoCapitalize="none" returnKeyType="search" style={{ color: theme.text, borderColor: theme.border, borderWidth: 1, borderRadius: 12, padding: 12 }} />
      <View style={{ flexDirection: 'row' }}><Pressable accessibilityRole="button" style={button} onPress={searchNow}><ThemedText>Search</ThemedText></Pressable><Pressable accessibilityRole="button" style={button} onPress={() => { void result.refetch(); }}><ThemedText>Refresh</ThemedText></Pressable></View>
      {result.isFetching ? <ActivityIndicator accessibilityLabel="Loading deleted leads" /> : null}
      {result.isError ? <ThemedText accessibilityRole="alert">{result.error.message}</ThemedText> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Pressable accessibilityRole="button" style={button} disabled={page === 1 || result.isFetching} onPress={() => setPage(value => value - 1)}><ThemedText>Previous page</ThemedText></Pressable>
        <Pressable accessibilityRole="button" style={button} disabled={!data || page >= data.meta.last_page || result.isFetching} onPress={() => setPage(value => value + 1)}><ThemedText>Next page</ThemedText></Pressable>
      </View>
      {data ? <FlatList data={data.data} keyExtractor={item => String(item.id)}
        ListHeaderComponent={<ThemedText>{data.meta.total} leads · Page {page} of {data.meta.last_page}</ThemedText>}
        ListEmptyComponent={<ThemedText>No deleted leads on this page.</ThemedText>}
        renderItem={({ item }) => <View style={{ paddingVertical: 16, gap: 8 }}><ThemedText type="smallBold">{item.name}</ThemedText><ThemedText>{item.email || 'No email'}</ThemedText><ThemedText type="small">Deleted: {item.deleted_at ? new Date(item.deleted_at).toLocaleString() : 'Not available'}</ThemedText>{canRestore ? <Pressable accessibilityRole="button" accessibilityLabel={`Restore ${item.name}`} disabled={busy || attempted.current.has(item.id)} style={button} onPress={() => confirmRestore(item.id, item.name)}><ThemedText>Restore lead</ThemedText></Pressable> : null}</View>} /> : null}
    </>}
  </SafeAreaView></SafeAreaProvider></Modal>;
}
