import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { useTheme } from '@/hooks/use-theme';
import { documentUploadPath, uploadTransactionDocument, validateDocumentFile, UnconfirmedDocumentUploadError, type SelectedDocumentFile } from '@/transactions/document-upload';
import type { MobileDocument } from '@/transactions/transactions-api';
import { ThemedText } from './themed-text';
export function DocumentUploadSheet({ transactionId, document, clients, onClose }: { transactionId: number; document: MobileDocument; clients: string[]; onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const allowed = Boolean(token && canAreaScreen(user, 'desk', 'transactions', 'edit'));
  const auth = useRef({ token, allowed });
  const active = useRef<AbortController | null>(null), locked = useRef(false), mounted = useRef(true), uncertainRef = useRef(false);
  const selected = useRef<SelectedDocumentFile | null>(null);
  const theme = useTheme(), queryClient = useQueryClient();
  const [file, setFile] = useState<SelectedDocumentFile | null>(null), [client, setClient] = useState('');
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
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
  const submit = async (chosen: SelectedDocumentFile, chosenClient: string, startToken: string) => {
    if (!mounted.current || locked.current || uncertainRef.current || !auth.current.allowed || auth.current.token !== startToken || selected.current !== chosen) return;
    locked.current = true; setBusy(true); setError('');
    const controller = new AbortController(); active.current = controller;
    try {
      await uploadTransactionDocument(startToken, transactionId, document, chosen, chosenClient, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      await queryClient.invalidateQueries({ queryKey: ['transaction-documents', transactionId] });
      await queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] });
      if (!mounted.current || controller.signal.aborted) return;
      dispose(); onClose();
    } catch (caught) {
      if (mounted.current && !controller.signal.aborted) { uncertainRef.current = caught instanceof UnconfirmedDocumentUploadError; setUncertain(uncertainRef.current); setError(caught instanceof Error ? caught.message : 'Could not upload file.'); }
    } finally { active.current = null; locked.current = false; if (mounted.current) setBusy(false); }
  };
  const confirm = () => {
    if (!file || !auth.current.token || !allowed || busy || uncertain) return;
    try { documentUploadPath(transactionId, document, client); } catch (caught) { setError((caught as Error).message); return; }
    const chosen = file, chosenClient = client, startToken = auth.current.token;
    Alert.alert('Upload transaction document?', `${chosen.name} → ${document.title}${chosenClient ? ` (${chosenClient})` : ''}. An existing file for this slot may be replaced. Transaction document notifications may be generated.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Upload', onPress: () => { void submit(chosen, chosenClient, startToken); } }]);
  };
  if (!allowed) return null;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaView style={{ flex: 1, padding: 16, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ gap: 16 }}>
    <View><ThemedText type="subtitle">Upload document</ThemedText><ThemedText>{document.title}</ThemedText></View>
    <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 12 }}><ThemedText>Close</ThemedText></Pressable>
    <ThemedText>Choose one file, up to 20 MB. Review it before uploading.</ThemedText>
    {document.kind === 'per_client' ? [...new Set(clients)].map(name => <Pressable key={name} accessibilityRole="button" accessibilityState={{ selected: name === client, disabled: busy || uncertain }} disabled={busy || uncertain} onPress={() => setClient(name)} style={{ padding: 12 }}><ThemedText>{name === client ? '✓ ' : ''}{name}</ThemedText></Pressable>) : null}
    {file ? <ThemedText>{file.name} · {Math.ceil(file.size / 1024)} KB</ThemedText> : null}
    {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Choose transaction document" disabled={busy || uncertain || Platform.OS === 'web'} onPress={() => { void pick(); }} style={{ padding: 12 }}><ThemedText>Choose file</ThemedText></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Review document upload" disabled={!file || busy || uncertain} onPress={confirm} style={{ padding: 12 }}><ThemedText>{busy ? 'Please wait…' : 'Review upload'}</ThemedText></Pressable>
  </ScrollView></SafeAreaView></Modal>;
}
