import { useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { fetchTransactionDocuments } from '@/transactions/transactions-api';
import { canChecklistTools, canChecklistAction, checklistRequest, saveChecklistAction, UnconfirmedChecklistActionError, type ChecklistAction } from '@/transactions/checklist-actions-api';
import { ThemedText } from './themed-text';
export function ChecklistToolsSheet({ transactionId, onClose }: { transactionId: number; onClose: () => void }) {
  const { token, user } = useMobileAuth(); const allowed = Boolean(token && canChecklistTools(user));
  const auth = useRef({ token, user, allowed }), active = useRef<AbortController | null>(null), locked = useRef(false), blocked = useRef(false), mounted = useRef(true);
  const theme = useTheme(), queryClient = useQueryClient();
  const [title, setTitle] = useState(''), [readiness, setReadiness] = useState<{ ready: string | null; remarks: string | null } | null>(null), [busy, setBusy] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false), [error, setError] = useState('');
  const draft = useRef({ title, readiness }); useLayoutEffect(() => { draft.current = { title, readiness }; }, [title, readiness]);
  const query = useQuery({ queryKey: ['checklist-tools', transactionId, user?.id, user?.role], queryFn: ({ signal }) => fetchTransactionDocuments(token!, transactionId, signal), enabled: allowed, refetchOnMount: 'always' });
  useLayoutEffect(() => { if (auth.current.token !== token || auth.current.user?.role !== user?.role || auth.current.user?.permissions?.transactions !== user?.permissions?.transactions || !allowed) { active.current?.abort(); setTitle(''); setReadiness(null); } auth.current = { token, user, allowed }; }, [token, user, allowed]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);
  const submit = async (action: ChecklistAction, startToken: string, startRole: string, sourceReadiness: typeof readiness) => {
    if (!mounted.current || locked.current || blocked.current || !auth.current.allowed || auth.current.token !== startToken || auth.current.user?.role !== startRole || !canChecklistAction(auth.current.user, action) || (action.type === 'create' && draft.current.title !== action.title) || (action.type === 'readiness' && draft.current.readiness !== sourceReadiness)) return;
    locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); active.current = controller;
    try {
      await saveChecklistAction(startToken, auth.current.user, transactionId, action, controller.signal);
      if (controller.signal.aborted || !mounted.current) return; blocked.current = true;
      await queryClient.invalidateQueries({ queryKey: ['transaction-documents', transactionId] }); await queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] }); await queryClient.invalidateQueries({ queryKey: ['checklist-tools', transactionId] });
      if (!controller.signal.aborted && mounted.current) onClose();
    } catch (caught) { if (!controller.signal.aborted && mounted.current) { blocked.current = blocked.current || caught instanceof UnconfirmedChecklistActionError; setNeedsRefresh(blocked.current); setError(caught instanceof Error ? caught.message : 'Could not change checklist.'); } }
    finally { active.current = null; locked.current = false; if (mounted.current) setBusy(false); }
  };
  const confirm = (action: ChecklistAction) => {
    if (!token || !user || busy || needsRefresh || query.isFetching || query.isError) return;
    try { checklistRequest(user, transactionId, action); } catch (caught) { setError((caught as Error).message); return; }
    const startToken = token, startRole = user.role, sourceReadiness = readiness;
    const message = action.type === 'create' ? `Add “${action.title.trim()}”? An existing active manual document with this title will be reused.` : action.type === 'readiness' ? `Ready for RECO audit: ${action.ready ?? 'Not selected'}${action.ready === 'No' ? `. Reason: ${action.remarks || 'None'}` : ''}.` : `Permanently remove ${action.label} from ${action.document.title}? The document and other files stay. Copies previously saved outside this app remain.`;
    Alert.alert(action.type === 'remove' ? 'Remove selected file?' : 'Save checklist change?', message, [{ text: 'Cancel', style: 'cancel' }, { text: action.type === 'remove' ? 'Remove file' : 'Save change', style: action.type === 'remove' ? 'destructive' : 'default', onPress: () => { void submit(action, startToken, startRole, sourceReadiness); } }]);
  };
  if (!allowed) return null;
  const effective = readiness ?? { ready: query.data?.reco_audit_ready ?? null, remarks: query.data?.reco_audit_remarks ?? null };
  const readyAction: ChecklistAction = { type: 'readiness', ready: effective.ready, remarks: effective.remarks, version: query.data?.reco_audit_version ?? '' };
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaView style={{ flex: 1, padding: 16, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ gap: 16 }}>
    <ThemedText type="subtitle">Checklist tools</ThemedText><Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 12 }}><ThemedText>Close</ThemedText></Pressable>
    {query.isFetching ? <ActivityIndicator accessibilityLabel="Loading checklist tools" /> : null}
    {query.isError ? <><ThemedText accessibilityRole="alert" themeColor="danger">{query.error.message}</ThemedText><Pressable accessibilityRole="button" onPress={() => { void query.refetch(); }} style={{ padding: 12 }}><ThemedText>Reload checklist</ThemedText></Pressable></> : null}
    {!query.isFetching && !query.isError && query.data ? <>
      {canChecklistAction(user, { type: 'create', title }) ? <><ThemedText type="smallBold">Add manual document</ThemedText><TextInput accessibilityLabel="New document title" maxLength={255} editable={!busy && !needsRefresh} value={title} onChangeText={setTitle} style={{ borderWidth: 1, padding: 12, borderColor: theme.border, color: theme.text }} /><Pressable accessibilityRole="button" accessibilityLabel="Confirm document creation" disabled={busy || needsRefresh || !title.trim()} onPress={() => confirm({ type: 'create', title })} style={{ padding: 12 }}><ThemedText>Add document</ThemedText></Pressable></> : null}
      <ThemedText type="smallBold">Ready for RECO audit</ThemedText><ThemedText>{effective.ready ?? 'Not selected'}{effective.ready === 'No' ? ` · ${effective.remarks || 'No reason entered'}` : ''}</ThemedText>
      {canChecklistAction(user, readyAction) ? <>{([null, 'Yes', 'No'] as const).map(value => <Pressable key={String(value)} accessibilityRole="button" accessibilityLabel={`RECO readiness: ${value ?? 'Not selected'}`} accessibilityState={{ selected: effective.ready === value }} disabled={busy || needsRefresh} onPress={() => setReadiness({ ...effective, ready: value })} style={{ padding: 12 }}><ThemedText>{effective.ready === value ? '✓ ' : ''}{value ?? 'Not selected'}</ThemedText></Pressable>)}
        {effective.ready === 'No' ? <TextInput accessibilityLabel="RECO readiness reason" multiline maxLength={5000} editable={!busy && !needsRefresh} value={effective.remarks ?? ''} onChangeText={text => setReadiness({ ...effective, remarks: text || null })} style={{ minHeight: 90, borderWidth: 1, padding: 12, borderColor: theme.border, color: theme.text }} /> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Confirm RECO readiness" disabled={busy || needsRefresh || readiness === null} onPress={() => confirm(readyAction)} style={{ padding: 12 }}><ThemedText>Save readiness</ThemedText></Pressable>
      </> : null}
      <ThemedText type="smallBold">Individual file removal</ThemedText>
      {query.data.documents.map(document => <View key={document.id} style={{ gap: 8 }}><ThemedText>{document.title}</ThemedText>
        {[...(document.has_file ? [{ kind: 'primary' as const, label: document.file_name || 'Primary file' }] : []), ...(document.files ?? []).map(file => ({ kind: 'indexed' as const, index: file.index, label: [file.client_name, file.file_name || `File ${file.index + 1}`].filter(Boolean).join(' · ') }))].map(file => {
          const action: ChecklistAction = { type: 'remove', document, ...file }; return canChecklistAction(user, action) ? <Pressable key={`${file.kind}-${'index' in file ? file.index : ''}`} accessibilityRole="button" accessibilityLabel={`Remove file ${file.label}`} disabled={busy || needsRefresh} onPress={() => confirm(action)} style={{ padding: 12 }}><ThemedText themeColor="danger">Remove {file.label}</ThemedText></Pressable> : null;
        })}
      </View>)}
    </> : null}
    {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
  </ScrollView></SafeAreaView></Modal>;
}
