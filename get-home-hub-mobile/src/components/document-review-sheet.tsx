import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { canReviewDocument, reviewBody, saveDocumentReview, RefreshDocumentReviewError, type DocumentReviewPatch } from '@/transactions/document-review-api';
import type { MobileDocument } from '@/transactions/transactions-api';
import { ThemedText } from './themed-text';
export function DocumentReviewSheet({ transactionId, document, onClose }: { transactionId: number; document: MobileDocument; onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const allowed = Boolean(token && canReviewDocument(user, document));
  const auth = useRef({ token, user, allowed }), active = useRef<AbortController | null>(null), locked = useRef(false), mounted = useRef(true), blocked = useRef(false);
  const theme = useTheme(), queryClient = useQueryClient();
  const [patch, setPatch] = useState<DocumentReviewPatch>({}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [needsRefresh, setNeedsRefresh] = useState(false);
  const draft = useRef(patch);
  useLayoutEffect(() => { draft.current = patch; }, [patch]);
  useLayoutEffect(() => {
    if (auth.current.token !== token || !allowed || auth.current.user?.role !== user?.role) { active.current?.abort(); setPatch({}); }
    auth.current = { token, user, allowed };
  }, [token, user, allowed]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);
  const set = (key: keyof DocumentReviewPatch, value: string | boolean | null) => {
    if (!allowed || busy || needsRefresh) return;
    setPatch(current => { const next = { ...current, [key]: value }; if (key === 'validation' && value === 'Valid') next.drive_uploaded = 'No'; if (value === (document[key] ?? null)) delete next[key]; return next; });
  };
  const submit = async (changes: DocumentReviewPatch, startToken: string, startRole: string) => {
    if (!mounted.current || locked.current || blocked.current || !auth.current.allowed || auth.current.token !== startToken || auth.current.user?.role !== startRole || draft.current !== changes) return;
    locked.current = true; setBusy(true); setError('');
    const controller = new AbortController(); active.current = controller;
    try {
      await saveDocumentReview(startToken, auth.current.user, transactionId, document, changes, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      await queryClient.invalidateQueries({ queryKey: ['transaction-documents', transactionId] });
      await queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] });
      if (!controller.signal.aborted && mounted.current) { blocked.current = true; onClose(); }
    } catch (caught) {
      if (!controller.signal.aborted && mounted.current) { blocked.current = caught instanceof RefreshDocumentReviewError; setNeedsRefresh(blocked.current); setError(caught instanceof Error ? caught.message : 'Could not save review.'); }
    } finally { active.current = null; locked.current = false; if (mounted.current) setBusy(false); }
  };
  const confirm = () => {
    if (!auth.current.token || !allowed || busy || needsRefresh) return;
    try { reviewBody(user, document, patch); } catch (caught) { setError((caught as Error).message); return; }
    const changes = patch, startToken = auth.current.token, startRole = user!.role;
    Alert.alert('Save document review?', `${document.title}: ${Object.entries(changes).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value ?? 'Pending'}`).join('; ')}. Review notifications may be generated.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Save review', onPress: () => { void submit(changes, startToken, startRole); } }]);
  };
  const value = (key: keyof DocumentReviewPatch) => Object.hasOwn(patch, key) ? patch[key] : document[key];
  const choices = (key: keyof DocumentReviewPatch, label: string, values: (string | boolean | null)[]) => <><ThemedText type="smallBold">{label}</ThemedText>{values.map(option => <Pressable key={String(option)} accessibilityRole="button" accessibilityLabel={`${label}: ${option === null ? 'Pending' : String(option)}`} accessibilityState={{ selected: value(key) === option, disabled: busy || needsRefresh }} disabled={busy || needsRefresh} onPress={() => set(key, option)} style={{ padding: 12 }}><ThemedText>{value(key) === option ? '✓ ' : ''}{option === null ? 'Pending' : String(option)}</ThemedText></Pressable>)}</>;
  if (!allowed) return null;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaView style={{ flex: 1, padding: 16, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ gap: 12 }}>
    <ThemedText type="subtitle">Document review</ThemedText><ThemedText>{document.title}</ThemedText>
    <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 12 }}><ThemedText>Close</ThemedText></Pressable>
    {user?.role === 'agent' ? choices('agent_accepted', 'Document acceptance', [null, 'Accepted', 'Not Accepted']) : <>
      {choices('status', 'Receipt status', ['Pending', 'Received'])}
      {value('status') === 'Received' ? choices('validation', 'Validation', ['Pending', 'Valid', 'Invalid']) : null}
      {value('validation') === 'Valid' ? choices('drive_uploaded', 'Uploaded to Drive', ['No', 'Yes']) : null}
      {value('validation') !== 'Valid' && (value('status') !== 'Received' || value('validation') === 'Invalid') && document.agent_accepted !== 'Not Accepted' ? choices('reminder', 'Document reminder', [false, true]) : null}
      <ThemedText type="smallBold">Remarks</ThemedText><TextInput accessibilityLabel="Document review remarks" multiline maxLength={5000} editable={!busy && !needsRefresh} value={String(value('remarks') ?? '')} onChangeText={text => set('remarks', text || null)} style={{ minHeight: 100, color: theme.text, borderWidth: 1, padding: 12, borderColor: theme.border }} />
    </>}
    {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Confirm document review" disabled={busy || needsRefresh || !Object.keys(patch).length} onPress={confirm} style={{ padding: 12 }}><ThemedText>{busy ? 'Saving…' : 'Review and save'}</ThemedText></Pressable>
  </ScrollView></SafeAreaView></Modal>;
}
