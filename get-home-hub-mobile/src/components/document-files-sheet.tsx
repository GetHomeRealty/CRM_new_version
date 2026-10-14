import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Sharing from 'expo-sharing';
import { useMobileAuth } from '@/auth/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { documentAttachments, type DocumentAttachment } from '@/transactions/document-files';
import { downloadDocument } from '@/transactions/document-download';
import type { MobileDocument } from '@/transactions/transactions-api';
import { ThemedText } from './themed-text';

export function DocumentFilesSheet({ document, onClose }: { document: MobileDocument; onClose: () => void }) {
  const { token } = useMobileAuth();
  const theme = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const files = useRef<(() => void)[]>([]);
  useEffect(() => () => {
    active.current?.abort();
    for (const dispose of files.current) dispose();
    files.current = [];
  }, []);
  const open = async (attachment: DocumentAttachment) => {
    if (active.current || !token) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(attachment.key); setError('');
    try {
      if (Platform.OS === 'web' || !await Sharing.isAvailableAsync()) throw new Error('Open files using the iOS or Android app.');
      if (controller.signal.aborted) return;
      const downloaded = await downloadDocument(token, attachment, controller.signal);
      if (controller.signal.aborted) { downloaded.dispose(); return; }
      files.current.push(downloaded.dispose);
      await Sharing.shareAsync(downloaded.uri, { dialogTitle: 'Open or save document' });
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Could not open document.');
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  };
  let attachments: DocumentAttachment[] = [];
  let invalid = false;
  try { attachments = documentAttachments(document); } catch { invalid = true; }
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.row}><ThemedText type="subtitle">Document files</ThemedText><Pressable accessibilityRole="button" onPress={onClose} style={styles.button}><ThemedText>Back</ThemedText></Pressable></View>
      <ThemedText type="smallBold">{document.title}</ThemedText>
      <ThemedText type="small">Open or save uses your device’s share sheet. Only choose a trusted app. Copies you save outside this app are not removed automatically.</ThemedText>
      {busy ? <ActivityIndicator accessibilityLabel="Preparing document" color={theme.primary} /> : null}
      {error || invalid ? <ThemedText accessibilityRole="alert" themeColor="danger">{error || 'The attachment list is invalid. Refresh the transaction.'}</ThemedText> : null}
      <ScrollView contentContainerStyle={styles.content}>
        {document.remarks ? <ThemedText>{document.remarks}</ThemedText> : null}
        {!invalid && attachments.length === 0 ? <ThemedText>No uploaded files.</ThemedText> : null}
        {attachments.map((attachment) => <Pressable key={attachment.key} accessibilityRole="button" accessibilityLabel={`Open or save ${attachment.label}`}
          accessibilityState={{ disabled: busy !== null }} disabled={busy !== null} onPress={() => { void open(attachment); }} style={[styles.file, { borderColor: theme.primary }]}>
          <ThemedText type="smallBold">{attachment.label}</ThemedText><ThemedText type="small">Open or save</ThemedText>
        </Pressable>)}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 }, row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' },
  button: { padding: 12, minHeight: 44 }, content: { gap: 12, paddingVertical: 12 },
  file: { padding: 16, minHeight: 60, borderWidth: 1, borderRadius: 16, gap: 6 },
});
