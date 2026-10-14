import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { exportSelectedLeads, moveLeadsToDeleted } from '@/leads/lead-bulk-api';
import { shareLeadExport } from '@/leads/lead-export-share';
import type { MobileLead } from '@/leads/leads-api';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';

export function LeadBulkSheet({ leads, onClose }: { leads: readonly MobileLead[]; onClose: () => void }) {
  const { token, user } = useMobileAuth(); const theme = useTheme(); const client = useQueryClient();
  const allowed = Boolean(token) && canAreaScreen(user, 'crm', 'lead', 'edit');
  const permit = useRef(false); const mounted = useRef(true); const active = useRef(false); const controller = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<number[]>([]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const [deleteAttempted, setDeleteAttempted] = useState(false); const attempted = useRef(false);
  useLayoutEffect(() => { permit.current = allowed; return () => { permit.current = false; }; }, [allowed]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const close = () => { if (!active.current) onClose(); };
  const run = async (action: 'export' | 'delete', ids: number[]) => {
    if (!permit.current || active.current || !token || !ids.length || (action === 'delete' && attempted.current)) return;
    active.current = true; setBusy(true); setMessage('');
    if (action === 'delete') { attempted.current = true; setDeleteAttempted(true); }
    const request = new AbortController(); controller.current = request;
    const timer = setTimeout(() => request.abort(), 30000);
    try {
      if (action === 'delete') {
        const count = await moveLeadsToDeleted(token, ids, request.signal);
        if (mounted.current) setMessage(`${count} of ${ids.length} selected leads moved to Recently deleted. Others may be ineligible or no longer available. Close this screen to refresh the list.`);
      } else {
        const result = await exportSelectedLeads(token, ids, request.signal);
        if (!permit.current || request.signal.aborted) return;
        await shareLeadExport(result.data);
        if (mounted.current) setMessage(`Share sheet closed. Prepared ${result.data.length} of ${ids.length} selected leads; saving or sharing depends on your chosen action.`);
      }
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Action could not be confirmed. Refresh your leads.'); }
    finally {
      clearTimeout(timer); active.current = false; controller.current = null;
      if (mounted.current) setBusy(false);
      if (action === 'delete') { void client.invalidateQueries({ queryKey: ['leads'] }); void client.invalidateQueries({ queryKey: ['deleted-leads'] }); }
    }
  };
  const confirm = (action: 'export' | 'delete') => {
    if (!allowed || busy || !selected.length) return;
    const ids = [...selected];
    Alert.alert(action === 'delete' ? 'Move selected leads to Recently deleted?' : 'Export selected leads?',
      action === 'delete' ? `Move ${ids.length} selected leads? Eligible leads can be restored later. No permanent deletion is performed.` : `Prepare contact information for ${ids.length} selected leads as a CSV. Choose where to save or share it in the system share sheet.`,
      [{ text: 'Cancel', style: 'cancel' }, { text: action === 'delete' ? 'Move to deleted' : 'Export CSV', style: action === 'delete' ? 'destructive' : 'default', onPress: () => { void run(action, ids); } }]);
  };
  const button = { minHeight: 44, padding: 12 };
  return <Modal visible animationType="slide" onRequestClose={close}><SafeAreaProvider><SafeAreaView style={{ flex: 1, padding: 16, gap: 12, backgroundColor: theme.background }}>
    <ThemedText type="subtitle">Selected lead actions</ThemedText><Pressable accessibilityRole="button" disabled={busy} style={button} onPress={close}><ThemedText>Back to leads</ThemedText></Pressable>
    {!allowed ? <ThemedText accessibilityRole="alert">You do not have permission for bulk lead actions.</ThemedText> : <>
      <ThemedText type="small">Select from this page only (up to 50). No leads from other pages are included.</ThemedText>
      <ThemedText>{selected.length} selected</ThemedText>
      {message ? <ThemedText accessibilityRole="alert">{message}</ThemedText> : null}{busy ? <ActivityIndicator accessibilityLabel="Processing selected leads" /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        <Pressable accessibilityRole="button" disabled={busy || !selected.length} style={button} onPress={() => confirm('export')}><ThemedText>Export selected</ThemedText></Pressable>
        <Pressable accessibilityRole="button" disabled={busy || !selected.length || deleteAttempted} style={button} onPress={() => confirm('delete')}><ThemedText>Move selected to deleted</ThemedText></Pressable>
      </View>
      <FlatList data={leads.slice(0, 50)} keyExtractor={lead => String(lead.id)} renderItem={({ item }) => <Pressable accessibilityRole="checkbox" accessibilityLabel={`Select ${item.name}`} accessibilityState={{ checked: selected.includes(item.id), disabled: busy }} disabled={busy} style={button} onPress={() => setSelected(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id])}>
        <ThemedText>{selected.includes(item.id) ? '☑' : '☐'} {item.name}</ThemedText><ThemedText type="small">{item.email || item.phone || 'No contact details'}</ThemedText>
      </Pressable>} />
    </>}
  </SafeAreaView></SafeAreaProvider></Modal>;
}
