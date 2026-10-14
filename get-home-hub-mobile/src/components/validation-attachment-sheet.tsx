import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';
import { useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { useTheme } from '@/hooks/use-theme';
import { canEditValidationAttachment, changeValidationAttachment, UnconfirmedValidationAttachmentError } from '@/transactions/validation-attachment-api';
import { validateDocumentFile, type SelectedDocumentFile } from '@/transactions/document-upload';
import { documentAttachments } from '@/transactions/document-files';
import { downloadDocument } from '@/transactions/document-download';
import type { MobileDocument } from '@/transactions/transactions-api';
import { ThemedText } from './themed-text';
export function ValidationAttachmentSheet({ transactionId, document, onClose }: { transactionId: number; document: MobileDocument; onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const view = Boolean(token && canAreaScreen(user, 'desk', 'transactions'));
  const edit = view && canEditValidationAttachment(user, document);
  const auth = useRef({ token, user, view, edit });
  const active = useRef<AbortController | null>(null), mounted = useRef(true), locked = useRef(false), blocked = useRef(false);
  const selected = useRef<SelectedDocumentFile | null>(null), downloads = useRef<(() => void)[]>([]);
  const [file, setFile] = useState<SelectedDocumentFile | null>(null), [busy, setBusy] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false), [error, setError] = useState('');
  const theme = useTheme(), queryClient = useQueryClient();
  const dispose = () => { const current = selected.current; selected.current = null; if (current) { try { new File(current.uri).delete(); } catch { /* cache cleanup */ } } };
  const disposeDownloads = () => { for (const cleanup of downloads.current) cleanup(); downloads.current = []; };
  useLayoutEffect(() => {
    if (auth.current.token !== token || auth.current.user?.role !== user?.role || !view || (auth.current.edit && !edit)) { active.current?.abort(); dispose(); disposeDownloads(); setFile(null); }
    auth.current = { token, user, view, edit };
  }, [token, user, view, edit]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); dispose(); disposeDownloads(); }; }, []);
  const pick = async () => {
    if (!auth.current.edit || locked.current || blocked.current || Platform.OS === 'web') return;
    locked.current = true; setBusy(true); setError(''); const start = auth.current;
    let candidate: SelectedDocumentFile | null = null;
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
      if (result.canceled) return;
      const asset = result.assets[0]; candidate = { uri: asset.uri, name: asset.name, size: new File(asset.uri).size, mimeType: asset.mimeType };
      validateDocumentFile(candidate);
      if (!mounted.current || !auth.current.edit || auth.current.token !== start.token || auth.current.user?.role !== start.user?.role) return;
      dispose(); selected.current = candidate; setFile(candidate); candidate = null;
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not choose file.'); }
    finally { if (candidate) { try { new File(candidate.uri).delete(); } catch { /* cache cleanup */ } } locked.current = false; if (mounted.current) setBusy(false); }
  };
  const submit = async (chosen: SelectedDocumentFile | null, startToken: string, startRole: string) => {
    if (!mounted.current || !auth.current.edit || auth.current.token !== startToken || auth.current.user?.role !== startRole || locked.current || blocked.current || (chosen && selected.current !== chosen)) return;
    locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); active.current = controller;
    try {
      await changeValidationAttachment(startToken, auth.current.user, transactionId, document, chosen, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      blocked.current = true;
      await queryClient.invalidateQueries({ queryKey: ['transaction-documents', transactionId] });
      if (!controller.signal.aborted && mounted.current) { dispose(); onClose(); }
    } catch (caught) { if (!controller.signal.aborted && mounted.current) { blocked.current = blocked.current || caught instanceof UnconfirmedValidationAttachmentError; setNeedsRefresh(blocked.current); setError(caught instanceof Error ? caught.message : 'Could not change attachment.'); } }
    finally { active.current = null; locked.current = false; if (mounted.current) setBusy(false); }
  };
  const confirm = (remove: boolean) => {
    if (!edit || !auth.current.token || busy || needsRefresh || (!remove && !file)) return;
    const chosen = remove ? null : file, startToken = auth.current.token, startRole = user!.role;
    Alert.alert(remove ? 'Remove validation attachment?' : 'Upload validation attachment?', remove ? `${document.validation_file_name || 'Supporting file'} will be permanently removed from ${document.title}.` : `${chosen!.name} will be uploaded for ${document.title}${document.has_validation_file ? ' and replace its current supporting attachment' : ''}.`, [{ text: 'Cancel', style: 'cancel' }, { text: remove ? 'Remove attachment' : 'Upload attachment', style: remove ? 'destructive' : 'default', onPress: () => { void submit(chosen, startToken, startRole); } }]);
  };
  const open = async () => {
    if (!auth.current.view || !auth.current.token || locked.current || blocked.current) return;
    locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); active.current = controller; const startToken = auth.current.token;
    try {
      if (Platform.OS === 'web' || !await Sharing.isAvailableAsync()) throw new Error('Open files using the iOS or Android app.');
      if (controller.signal.aborted) return;
      const attachment = documentAttachments(document).find(item => item.path.endsWith('/validation-file'));
      if (!attachment) throw new Error('No validation attachment available.');
      const downloaded = await downloadDocument(startToken, attachment, controller.signal);
      if (controller.signal.aborted || !mounted.current) { downloaded.dispose(); return; }
      downloads.current.push(downloaded.dispose); await Sharing.shareAsync(downloaded.uri, { dialogTitle: 'Open or save validation attachment' });
    } catch (caught) { if (mounted.current && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Could not open attachment.'); }
    finally { active.current = null; locked.current = false; if (mounted.current) setBusy(false); }
  };
  if (!view) return null;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaView style={{ flex: 1, padding: 16, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ gap: 16 }}>
    <ThemedText type="subtitle">Validation attachment</ThemedText><ThemedText>{document.title}</ThemedText><ThemedText>{document.remarks || 'No reviewer remarks.'}</ThemedText>
    <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 12 }}><ThemedText>Close</ThemedText></Pressable>
    <ThemedText>Open or save uses your device’s share sheet. Copies saved outside this app are not removed automatically.</ThemedText>
    {document.has_validation_file ? <Pressable accessibilityRole="button" accessibilityLabel="Open validation attachment" disabled={busy || needsRefresh} onPress={() => { void open(); }} style={{ padding: 12 }}><ThemedText>{document.validation_file_name || 'Supporting attachment'} · Open or save</ThemedText></Pressable> : <ThemedText>No supporting attachment.</ThemedText>}
    {edit ? <><ThemedText>Choose one non-empty file, up to 20 MB.</ThemedText>{file ? <ThemedText>{file.name} · {Math.ceil(file.size / 1024)} KB</ThemedText> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Choose validation attachment" disabled={busy || needsRefresh || Platform.OS === 'web'} onPress={() => { void pick(); }} style={{ padding: 12 }}><ThemedText>Choose file</ThemedText></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Confirm validation upload" disabled={!file || busy || needsRefresh} onPress={() => confirm(false)} style={{ padding: 12 }}><ThemedText>Review upload</ThemedText></Pressable>
      {document.has_validation_file ? <Pressable accessibilityRole="button" accessibilityLabel="Confirm validation removal" disabled={busy || needsRefresh} onPress={() => confirm(true)} style={{ padding: 12 }}><ThemedText themeColor="danger">Remove supporting attachment</ThemedText></Pressable> : null}
    </> : null}
    {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
  </ScrollView></SafeAreaView></Modal>;
}
