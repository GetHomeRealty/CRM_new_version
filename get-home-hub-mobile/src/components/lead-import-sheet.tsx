import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Alert, AppState, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { environment } from '@/config/environment';
import { fetchRecentLeadImports, validateImport } from '@/leads/lead-import-api';
import { acknowledgeImport, guardedImport, readImportAttempt } from '@/leads/lead-import-guard';
import { chooseImportCsv } from '@/leads/lead-import-file';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';

export function LeadImportSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth(); const theme = useTheme(); const client = useQueryClient();
  const allowed = Boolean(token && user?.id) && canAreaScreen(user, 'crm', 'lead');
  const editable = allowed && canAreaScreen(user, 'crm', 'lead', 'edit') && environment.leadImportEnabled;
  const permit = useRef(false); const mounted = useRef(true); const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [tag, setTag] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useLayoutEffect(() => { permit.current = editable; return () => { permit.current = false; }; }, [editable]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => { mounted.current = false; request.current?.abort(); subscription.remove(); };
  }, []);
  const history = useQuery({ queryKey: ['lead-imports', user?.id], enabled: allowed,
    queryFn: ({ signal }) => fetchRecentLeadImports(token!, signal),
    refetchInterval: query => foreground && query.state.data?.some(job => !job.done) ? 5000 : false });
  const safety = useQuery({ queryKey: ['lead-import-attempt', user?.id], enabled: allowed,
    queryFn: () => readImportAttempt(user!.id!), retry: false });
  const ready = editable && safety.isSuccess && !safety.data && !busy;
  const refresh = async () => { await Promise.all([history.refetch(), safety.refetch()]); };
  const close = () => {
    if (pending.current) return;
    if (file) Alert.alert('Discard selected CSV?', 'No import is started until you confirm submission.', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: onClose }]);
    else onClose();
  };
  const pick = async () => {
    if (!permit.current || pending.current || !ready) return;
    pending.current = true; setBusy(true); setMessage('');
    try { const selected = await chooseImportCsv(); if (permit.current && selected) setFile(selected); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Could not read CSV.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const submit = () => {
    if (!ready || !file || !token || !user || pending.current) return;
    try { validateImport(file.csv, tag); } catch (error) { setMessage(error instanceof Error ? error.message : 'Review the CSV.'); return; }
    const selected = file; const selectedTag = tag;
    Alert.alert('Import leads?', `Submit ${selected.name} to the CRM? Existing addresses may be tagged rather than added. This does not send emails.`, [
      { text: 'Cancel', style: 'cancel' }, { text: 'Import', onPress: () => { void (async () => {
        if (!permit.current || pending.current) return;
        pending.current = true; setBusy(true); setMessage('');
        const controller = new AbortController(); request.current = controller;
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          const job = await guardedImport(user.id!, token, selected.csv, selectedTag, controller.signal);
          if (mounted.current) { setFile(null); setTag(''); setMessage(`Import accepted. Job ${job.job_id}. Follow progress below.`); }
          void client.invalidateQueries({ queryKey: ['leads'] });
        } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Import could not be confirmed. Check history before submitting again.'); }
        finally {
          clearTimeout(timer); pending.current = false; request.current = null;
          if (mounted.current) { setBusy(false); void refresh(); }
        }
      })(); } },
    ]);
  };
  const acknowledge = async () => {
    if (!user || safety.data?.state !== 'confirmed' || pending.current || !permit.current) return;
    pending.current = true; setBusy(true);
    try { await acknowledgeImport(user.id!, safety.data.jobId!); if (mounted.current) { setFile(null); setTag(''); await safety.refetch(); } }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Could not acknowledge import.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const button = { minHeight: 44, padding: 12 };
  return <Modal visible animationType="slide" onRequestClose={close}><SafeAreaProvider><SafeAreaView style={{ flex: 1, padding: 16, gap: 12, backgroundColor: theme.background }}>
    <ThemedText type="subtitle">Lead imports</ThemedText>
    <Pressable accessibilityRole="button" disabled={busy} style={button} onPress={close}><ThemedText>Back to leads</ThemedText></Pressable>
    {!allowed ? <ThemedText accessibilityRole="alert">You do not have access to lead imports.</ThemedText> : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
      <ThemedText type="small">Recent imports for your account (up to 5). Active jobs refresh every 5 seconds while this screen is open. Importing does not send emails.</ThemedText>
      {!environment.leadImportEnabled ? <ThemedText>CSV submission is not enabled in this build. Import history remains available.</ThemedText> : null}
      {message ? <ThemedText accessibilityRole="alert">{message}</ThemedText> : null}
      {busy || history.isFetching || safety.isPending ? <ActivityIndicator accessibilityLabel="Loading import status" /> : null}
      {safety.isError ? <ThemedText accessibilityRole="alert">{safety.error.message}</ThemedText> : null}
      {safety.data?.state === 'pending' ? <ThemedText accessibilityRole="alert">A previous submission is unconfirmed. Do not upload it again. Check the history and ask your administrator to reconcile the attempt; absence from recent history does not prove failure.</ThemedText> : null}
      {safety.data?.state === 'confirmed' ? <View><ThemedText>Accepted job: {safety.data.jobId}. Acknowledging does not restart it.</ThemedText>{editable ? <Pressable accessibilityRole="button" disabled={busy} style={button} onPress={() => { void acknowledge(); }}><ThemedText>Acknowledge accepted import</ThemedText></Pressable> : null}</View> : null}
      {editable && !safety.data ? <View style={{ gap: 12 }}>
        <ThemedText type="small">Choose a UTF-8 .csv with a header and data rows (name and email recommended). Mobile limit: 1 MB and 250,000 characters. Larger files can be imported on the website.</ThemedText>
        <Pressable accessibilityRole="button" disabled={!ready} style={button} onPress={() => { void pick(); }}><ThemedText>{file ? 'Replace CSV' : 'Choose CSV file'}</ThemedText></Pressable>
        {file ? <ThemedText>{file.name} · {file.csv.length.toLocaleString()} characters</ThemedText> : null}
        <TextInput accessibilityLabel="Import tag (optional)" placeholder="Tag (optional)" placeholderTextColor={theme.textSecondary} editable={ready} value={tag} onChangeText={setTag} maxLength={100} style={{ color: theme.text, borderWidth: 1, borderColor: theme.border, padding: 12, borderRadius: 12 }} />
        <Pressable accessibilityRole="button" disabled={!ready || !file} style={button} onPress={submit}><ThemedText>Review and import</ThemedText></Pressable>
      </View> : null}
      <Pressable accessibilityRole="button" disabled={busy} style={button} onPress={() => { void refresh(); }}><ThemedText>Refresh import history</ThemedText></Pressable>
      {history.isError ? <ThemedText accessibilityRole="alert">{history.error.message}</ThemedText> : history.data?.length === 0 ? <ThemedText>No recent imports.</ThemedText> : history.data?.map(job => <View key={job.job_id} style={{ gap: 6, paddingVertical: 12, borderBottomWidth: 1, borderColor: theme.border }}>
        <ThemedText type="smallBold">{job.status} · {job.percent}%</ThemedText><ThemedText type="small">Job: {job.job_id}</ThemedText>
        <ThemedText>{job.message}</ThemedText><ThemedText type="small">Processed {job.processed_rows} of {job.total_rows} · Added {job.imported} · Tagged {job.tagged} · Duplicates {job.duplicate} · Invalid {job.invalid}</ThemedText>
        {job.failure_reason ? <ThemedText accessibilityRole="alert">{job.failure_reason}</ThemedText> : null}
      </View>)}
    </ScrollView>}
  </SafeAreaView></SafeAreaProvider></Modal>;
}
