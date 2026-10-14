import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { canReplaceValidFile, validateReplacementTarget, replaceValidFile, UnconfirmedValidReplacementError, type ValidFileTarget } from '@/transactions/valid-file-replacement-api';
import { useTheme } from '@/hooks/use-theme';
import { validateDocumentFile, type SelectedDocumentFile } from '@/transactions/document-upload';
import type { MobileDocument } from '@/transactions/transactions-api';
import { ThemedText } from './themed-text';
export function ValidFileReplacementSheet({ transactionId, document, onClose }: { transactionId: number; document: MobileDocument; onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const allowed = Boolean(token && canReplaceValidFile(user, document));
  const auth = useRef({ token, allowed });
  const active = useRef<AbortController | null>(null), locked = useRef(false), mounted = useRef(true), uncertainRef = useRef(false);
  const selected = useRef<SelectedDocumentFile | null>(null);
  const theme = useTheme(), queryClient = useQueryClient();
  const [file, setFile] = useState<SelectedDocumentFile | null>(null), [target, setTarget] = useState<ValidFileTarget | null>(null);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  const targetRef = useRef(target); useLayoutEffect(() => { targetRef.current = target; }, [target]);
  const dispose = () => { const current = selected.current; selected.current = null; if (current) { try { new File(current.uri).delete(); } catch { /* private cache cleanup */ } } };
  useLayoutEffect(() => {
    if (auth.current.token !== token || !allowed) { active.current?.abort(); dispose(); setFile(null); }
    auth.current = { token, allowed };
  }, [token, allowed]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); dispose(); }; }, []);
  const pick = async () => {
    if (locked.current || uncertainRef.current || !auth.current.allowed || Platform.OS === 'web') return;
    locked.current = true; setBusy(true); setError('');
    const startToken = auth.current.token;
    let candidate: SelectedDocumentFile | null = null;
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      candidate = { uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: new File(asset.uri).size };
      validateDocumentFile(candidate);
      if (!mounted.current || !auth.current.allowed || auth.current.token !== startToken) return;
      dispose(); selected.current = candidate; setFile(candidate); candidate = null;
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not choose file.'); }
    finally { if (candidate) { try { new File(candidate.uri).delete(); } catch { /* cache cleanup */ } } locked.current = false; if (mounted.current) setBusy(false); }
  };
  const submit = async (chosen: SelectedDocumentFile, chosenTarget: ValidFileTarget, startToken: string) => {
    if (!mounted.current || locked.current || uncertainRef.current || !auth.current.allowed || auth.current.token !== startToken || selected.current !== chosen || targetRef.current !== chosenTarget) return;
    locked.current = true; setBusy(true); setError('');
    const controller = new AbortController(); active.current = controller;
    try {
      await replaceValidFile(startToken, user, transactionId, document, chosenTarget, chosen, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      await queryClient.invalidateQueries({ queryKey: ['transaction-documents', transactionId] });
      await queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] });
      if (!mounted.current || controller.signal.aborted) return;
      dispose(); onClose();
    } catch (caught) {
      if (mounted.current && !controller.signal.aborted) { uncertainRef.current = caught instanceof UnconfirmedValidReplacementError; setUncertain(uncertainRef.current); setError(caught instanceof Error ? caught.message : 'Could not upload file.'); }
    } finally { active.current = null; locked.current = false; if (mounted.current) setBusy(false); }
  };
  const confirm = () => {
    if (!target || !file || !auth.current.token || !allowed || busy || uncertain) return;
    try { validateReplacementTarget(document, target); } catch (caught) { setError((caught as Error).message); return; }
    const chosen = file, chosenTarget = target, startToken = auth.current.token;
    Alert.alert('Replace Valid document file?', `${chosen.name} will replace ${chosenTarget.label} in ${document.title}. The old selected file will be removed; other files stay. Validation will reset to Pending and Uploaded to Drive to No for fresh review.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Replace file', style: 'destructive', onPress: () => { void submit(chosen, chosenTarget, startToken); } }]);
  };
  if (!allowed) return null;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaView style={{ flex: 1, padding: 16, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ gap: 16 }}>
    <View><ThemedText type="subtitle">Replace Valid file</ThemedText><ThemedText>{document.title}</ThemedText></View>
    <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 12 }}><ThemedText>Close</ThemedText></Pressable>
    <ThemedText>Super Admin override: choose the existing file and its replacement, up to 20 MB. Fresh review is required.</ThemedText>
    {[...(document.has_file ? [{ kind: 'primary' as const, label: document.file_name || 'Primary file' }] : []), ...(document.files ?? []).map(file => ({ kind: 'indexed' as const, index: file.index, label: [file.client_name, file.file_name || `File ${file.index + 1}`].filter(Boolean).join(' · ') }))].map(option => <Pressable key={`${option.kind}-${'index' in option ? option.index : ''}`} accessibilityRole="button" accessibilityLabel={`Replace target ${option.label}`} accessibilityState={{ selected: target?.kind === option.kind && target?.index === ('index' in option ? option.index : undefined), disabled: busy || uncertain }} disabled={busy || uncertain} onPress={() => setTarget(option)} style={{ padding: 12 }}><ThemedText>{option.label}</ThemedText></Pressable>)}
    {file ? <ThemedText>{file.name} · {Math.ceil(file.size / 1024)} KB</ThemedText> : null}
    {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Choose replacement file" disabled={busy || uncertain || Platform.OS === 'web'} onPress={() => { void pick(); }} style={{ padding: 12 }}><ThemedText>Choose file</ThemedText></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Confirm Valid file replacement" disabled={!target || !file || busy || uncertain} onPress={confirm} style={{ padding: 12 }}><ThemedText>{busy ? 'Please wait…' : 'Review replacement'}</ThemedText></Pressable>
  </ScrollView></SafeAreaView></Modal>;
}
