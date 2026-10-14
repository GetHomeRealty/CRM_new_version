import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { environment } from '@/config/environment';
import { fetchMetaForms, fetchMetaHistory, fetchMetaLeads, fetchMetaPages, fetchMetaStatus, startMetaConnection, updateMeta } from '@/crm/meta-api';
import { ThemedText } from './themed-text';
import { LeadDetailSheet } from './lead-detail-sheet';
import { useTheme } from '@/hooks/use-theme';
export function MetaSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { token, user } = useMobileAuth(), theme = useTheme(), client = useQueryClient();
  const currentAuth = useRef({ token, user });
  useLayoutEffect(() => { currentAuth.current = { token, user }; }, [token, user]);
  const allowed = Boolean(token && user?.id && canAreaScreen(user, 'crm', 'meta'));
  const editable = allowed && canAreaScreen(user, 'crm', 'meta', 'edit') && environment.metaManagementEnabled;
  const [page, setPage] = useState<string | null>(null), [selectedLead, setSelectedLead] = useState<number | null>(null), [controller] = useState(() => new AbortController());
  useEffect(() => () => controller.abort(), [controller]);
  const status = useQuery({ queryKey: ['meta-status', user?.id], queryFn: ({ signal }) => fetchMetaStatus(token!, signal), enabled: allowed, retry: false });
  const leads = useQuery({ queryKey: ['meta-leads', user?.id], queryFn: ({ signal }) => fetchMetaLeads(token!, signal), enabled: allowed, retry: false });
  const history = useQuery({ queryKey: ['meta-history', user?.id], queryFn: ({ signal }) => fetchMetaHistory(token!, signal), enabled: allowed, retry: false });
  const state = allowed && !status.isError && !status.isFetching ? status.data : undefined;
  const pages = useQuery({ queryKey: ['meta-pages', user?.id], queryFn: ({ signal }) => fetchMetaPages(token!, signal), enabled: allowed && state?.is_connected === true, retry: false });
  const forms = useQuery({ queryKey: ['meta-forms', user?.id, page], queryFn: ({ signal }) => fetchMetaForms(token!, page!, signal), enabled: editable && state?.is_connected === true && Boolean(page && pages.data?.some(p => p.id === page)) && !pages.isError && !pages.isFetching, retry: false });
  const refresh = async () => { await Promise.all(['meta-status', 'meta-leads', 'meta-history', 'meta-pages', 'meta-forms', 'leads'].map(key => client.invalidateQueries({ queryKey: [key] }))); };
  const mutation = useMutation({ retry: false, mutationFn: async (v: { action: 'connect' | 'sync' | 'refresh' | 'disconnect' | 'form'; token: string; userId: number; formId?: string }) => {
    if (!editable || v.token !== token || v.userId !== user?.id || !state || controller.signal.aborted) throw new Error('Meta connection changes are unavailable.');
    if (v.action === 'connect') { if (!state.configured || !state.token_storage_secure) throw new Error('Meta connection is not ready.'); const url = await startMetaConnection(token!, controller.signal);
      const current = currentAuth.current;
      if (current.token !== v.token || current.user?.id !== v.userId || !canAreaScreen(current.user, 'crm', 'meta', 'edit') || controller.signal.aborted) throw new Error('Meta access changed before browser sign-in.');
      await WebBrowser.openBrowserAsync(url); return; }
    if (!state.is_connected) throw new Error('Connect your Meta account first.');
    if (v.action === 'form') { const form = !forms.isError && !forms.isFetching ? forms.data?.find(f => f.id === v.formId) : undefined; if (!form || !page || !pages.data?.some(p => p.id === page)) throw new Error('Refresh your available forms.'); await updateMeta(token!, 'form', controller.signal, { page, id: form.id, name: form.name, connected: !form.is_connected }); }
    else await updateMeta(token!, v.action, controller.signal);
  }, onSuccess: refresh });
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled }} onPress={action} style={{ minHeight: 44, padding: 12 }}><ThemedText>{label}</ThemedText></Pressable>;
  const change = (action: 'connect' | 'sync' | 'refresh' | 'disconnect' | 'form', formId?: string) => { const submitted = { action, formId, token: token!, userId: user!.id! }; Alert.alert('Confirm Meta connection change', action === 'connect' ? 'Open Facebook sign-in in your browser, then return here and refresh.' : action === 'disconnect' ? 'Disconnect your Meta account from Hub? Existing imported leads remain in your CRM.' : action === 'form' ? 'Change whether this form imports leads into your own CRM?' : 'Contact Meta to refresh your own connection and imported leads?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Continue', onPress: () => mutation.mutate(submitted) }]); };
  const data = allowed && !leads.isError && !leads.isFetching ? leads.data : undefined;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}><FlatList data={data?.data || []} keyExtractor={l => String(l.id)} contentContainerStyle={{ padding: 20, gap: 12 }} ListHeaderComponent={<View style={{ gap: 12 }}><ThemedText type="subtitle">Meta lead ads</ThemedText>{button('Close Meta lead ads', onClose)}
    {!allowed ? <ThemedText>Meta access is unavailable.</ThemedText> : <>{button('Refresh Meta overview', () => { mutation.reset(); void refresh(); }, mutation.isPending || status.isFetching || leads.isFetching)}{status.isFetching || leads.isFetching ? <ActivityIndicator /> : null}{status.isError ? <ThemedText accessibilityRole="alert">{status.error.message}</ThemedText> : null}{leads.isError ? <ThemedText accessibilityRole="alert">{leads.error.message}</ThemedText> : null}{mutation.isError ? <ThemedText accessibilityRole="alert">{mutation.error.message}</ThemedText> : null}{mutation.isPending ? <ActivityIndicator /> : null}
      {state ? <><ThemedText>{state.is_connected ? 'Connected to ' + (state.facebook_user_name || 'your Meta account') : 'Meta account not connected'}</ThemedText>{!state.configured ? <ThemedText>Meta sign-in is not available yet.</ThemedText> : null}{state.token_expired || state.needs_reconnect ? <ThemedText>Reconnect your account to resume importing.</ThemedText> : null}{state.last_error ? <ThemedText accessibilityRole="alert">{state.last_error}</ThemedText> : null}<ThemedText>{state.pages_count} pages · {state.connected_forms} connected forms · Last sync {state.last_sync || 'None'}</ThemedText>{!environment.metaManagementEnabled ? <ThemedText>Connection changes and provider sync are unavailable in this build.</ThemedText> : null}{editable ? <>{button(state.is_connected ? 'Reconnect Meta account' : 'Connect Meta account', () => change('connect'), mutation.isPending || !state.configured || !state.token_storage_secure)}{state.is_connected ? <>{button('Sync own Meta leads', () => change('sync'), mutation.isPending)}{button('Refresh own Meta pages', () => change('refresh'), mutation.isPending)}{button('Disconnect Meta account', () => change('disconnect'), mutation.isPending)}</> : null}</> : null}</> : null}
      {pages.isError && state?.is_connected ? <ThemedText accessibilityRole="alert">{pages.error.message}</ThemedText> : null}{state?.is_connected && !pages.isError && !pages.isFetching ? pages.data?.map(p => <View key={p.id}>{button('Forms on ' + p.name, () => setPage(p.id), !editable || mutation.isPending)}</View>) : null}{page && editable ? <>{forms.isFetching ? <ActivityIndicator /> : null}{forms.isError ? <ThemedText accessibilityRole="alert">{forms.error.message}</ThemedText> : null}{!forms.isFetching && !forms.isError ? forms.data?.map(f => <View key={f.id}><ThemedText>{f.name} · {f.leads_count} leads · {f.is_connected ? 'Connected' : 'Not connected'}</ThemedText>{button(`${f.is_connected ? 'Disconnect' : 'Connect'} form ${f.name}`, () => change('form', f.id), mutation.isPending)}</View>) : null}</> : null}
      <ThemedText type="smallBold">Recent sync history</ThemedText>{history.isError ? <ThemedText accessibilityRole="alert">{history.error.message}</ThemedText> : null}{!history.isError && !history.isFetching ? history.data?.map(h => <View key={h.id}><ThemedText>{h.started_at} · {h.imported} imported · {h.updated} updated</ThemedText>{h.errors.map((e, i) => <ThemedText key={i}>{e}</ThemedText>)}</View>) : null}
      {canAreaScreen(user, 'crm', 'lead') ? button('Open CRM lead list', () => { onClose(); router.navigate('/leads'); }) : null}
      <ThemedText type="smallBold">Your recent imported leads</ThemedText>{data ? <ThemedText>{data.stats.total} total · {data.stats.today} today · {data.stats.week} this week · Showing up to 50 recent leads</ThemedText> : null}
    </>}
  </View>} ListEmptyComponent={data ? <ThemedText>No recent imported leads.</ThemedText> : null} renderItem={({ item }) => <View style={{ padding: 12, borderWidth: 1, borderColor: theme.border, borderRadius: 12 }}><ThemedText type="smallBold">{item.name}</ThemedText><ThemedText>{item.email || item.phone || 'No contact details'} · {item.lead_status || 'Not set'}</ThemedText>{canAreaScreen(user, 'crm', 'lead') ? button('Open imported lead ' + item.name, () => setSelectedLead(item.id)) : null}</View>} />{allowed && canAreaScreen(user, 'crm', 'lead') && selectedLead !== null ? <LeadDetailSheet leadId={selectedLead} onClose={() => setSelectedLead(null)} /> : null}</SafeAreaView></SafeAreaProvider></Modal>;
}
