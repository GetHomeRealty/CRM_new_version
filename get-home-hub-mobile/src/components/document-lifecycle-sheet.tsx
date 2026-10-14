import { useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { canManageDocuments, canDocumentAction, fetchDocumentLifecycle, changeDocumentLifecycle, UnconfirmedDocumentLifecycleError, type LifecycleDocument } from '@/transactions/document-lifecycle-api';
import { ThemedText } from './themed-text';
export function DocumentLifecycleSheet({ transactionId, onClose }: { transactionId: number; onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const allowed = Boolean(token && canManageDocuments(user));
  const auth = useRef({ token, user, allowed }), active = useRef<AbortController | null>(null), locked = useRef(false), blocked = useRef(false), mounted = useRef(true);
  const theme = useTheme(), queryClient = useQueryClient();
  const [busy, setBusy] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false), [error, setError] = useState('');
  const query = useQuery({ queryKey: ['document-lifecycle', transactionId, user?.id, user?.role], queryFn: ({ signal }) => fetchDocumentLifecycle(token!, transactionId, signal), enabled: allowed, refetchOnMount: 'always' });
  useLayoutEffect(() => {
    if (auth.current.token !== token || !allowed || auth.current.user?.role !== user?.role || auth.current.user?.permissions?.transactions !== user?.permissions?.transactions) active.current?.abort();
    auth.current = { token, user, allowed };
  }, [token, user, allowed]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);
  const submit = async (document: LifecycleDocument, action: 'remove' | 'restore', startToken: string, startRole: string) => {
    if (!mounted.current || locked.current || blocked.current || !auth.current.allowed || auth.current.token !== startToken || auth.current.user?.role !== startRole || !canDocumentAction(auth.current.user, document, action)) return;
    locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); active.current = controller;
    try {
      await changeDocumentLifecycle(startToken, auth.current.user, transactionId, document, action, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      blocked.current = true;
      await queryClient.invalidateQueries({ queryKey: ['document-lifecycle', transactionId] });
      await queryClient.invalidateQueries({ queryKey: ['transaction-documents', transactionId] });
      await queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] });
      if (!controller.signal.aborted && mounted.current) onClose();
    } catch (caught) { if (!controller.signal.aborted && mounted.current) { blocked.current = blocked.current || caught instanceof UnconfirmedDocumentLifecycleError; setNeedsRefresh(blocked.current); setError(caught instanceof Error ? caught.message : 'Could not change document.'); } }
    finally { active.current = null; locked.current = false; if (mounted.current) setBusy(false); }
  };
  const confirm = (document: LifecycleDocument, action: 'remove' | 'restore') => {
    if (!token || !user || !allowed || busy || needsRefresh || query.isFetching || query.isError || !canDocumentAction(user, document, action)) return;
    const startToken = token, startRole = user.role;
    Alert.alert(action === 'remove' ? 'Remove document?' : 'Restore document?', action === 'remove' ? `${document.title} will leave the checklist. Its files will be retained. A Super Admin can recover it from removed documents.` : `${document.title} will return to the active checklist with its retained files.`, [{ text: 'Cancel', style: 'cancel' }, { text: action === 'remove' ? 'Remove document' : 'Restore document', style: action === 'remove' ? 'destructive' : 'default', onPress: () => { void submit(document, action, startToken, startRole); } }]);
  };
  if (!allowed) return null;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaView style={{ flex: 1, padding: 16, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ gap: 16 }}>
    <ThemedText type="subtitle">Document removal and restore</ThemedText>
    <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 12 }}><ThemedText>Close</ThemedText></Pressable>
    <ThemedText>Managers review pending removals. Only a Super Admin restores removed documents or removes Valid and condition documents.</ThemedText>
    {query.isFetching ? <ActivityIndicator accessibilityLabel="Loading document removal status" /> : null}
    {query.isError ? <><ThemedText accessibilityRole="alert" themeColor="danger">{query.error.message}</ThemedText><Pressable accessibilityRole="button" onPress={() => { void query.refetch(); }} style={{ padding: 12 }}><ThemedText>Reload documents</ThemedText></Pressable></> : null}
    {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
    {!query.isFetching && !query.isError && query.data ? <>{query.data.has_more ? <ThemedText>Showing the first 200 documents. Additional documents require the website.</ThemedText> : null}
      {!query.data.documents.length ? <ThemedText>No documents available.</ThemedText> : null}
      {query.data.documents.map(document => <SafeAreaView key={document.id} edges={[]} style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: theme.border }}><ThemedText type="smallBold">{document.title}</ThemedText><ThemedText>{document.state === 'pending' ? 'Pending removal review' : document.state === 'removed' ? 'Removed — files retained' : 'Active'} · {document.validation}{document.deleted_by ? ` · ${document.deleted_by}` : ''}</ThemedText>
        {canDocumentAction(user, document, 'remove') ? <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${document.title}`} disabled={busy || needsRefresh} onPress={() => confirm(document, 'remove')} style={{ padding: 12 }}><ThemedText themeColor="danger">Remove document</ThemedText></Pressable> : null}
        {canDocumentAction(user, document, 'restore') ? <Pressable accessibilityRole="button" accessibilityLabel={`Restore ${document.title}`} disabled={busy || needsRefresh} onPress={() => confirm(document, 'restore')} style={{ padding: 12 }}><ThemedText themeColor="primary">Restore document</ThemedText></Pressable> : null}
      </SafeAreaView>)}
    </> : null}
  </ScrollView></SafeAreaView></Modal>;
}
