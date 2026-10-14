import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';
import * as Sharing from 'expo-sharing';
import { downloadTemplateAttachment } from '@/transactions/document-download';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { CampaignTemplate } from '@/campaigns/campaign-preview-api';
import { createTemplate, uploadTemplateAttachment, removeTemplateAttachment, templateCategories, updateTemplateBody, UnconfirmedTemplateSaveError, updateTemplateMetadata, type TemplateMetadataPatch } from '@/campaigns/template-edit-api';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';

export function TemplateMetadataEditor({ template, mode = 'metadata', onClose, onSaved }: { template: CampaignTemplate; mode?: 'metadata' | 'body' | 'create'; onClose: () => void; onSaved: () => void }) {
  const { token, user } = useMobileAuth(); const theme = useTheme();
  const canEdit = canAreaScreen(user, 'crm', 'campaigns', 'edit');
  const editAllowed = useRef(canEdit);
  useLayoutEffect(() => { editAllowed.current = canEdit; return () => { editAllowed.current = false; }; }, [canEdit]);
  const [name, setName] = useState(template.name); const [subject, setSubject] = useState(template.subject);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [content, setContent] = useState(template.content ?? '');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [category, setCategory] = useState(template.category);
  const [active, setActive] = useState(template.is_active);
  const [removedAttachments, setRemovedAttachments] = useState<number[]>([]);
  const [picked, setPicked] = useState<{ filename: string; content_type: string; data: string } | null>(null);
  const [uploaded, setUploaded] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const temporaryFiles = useRef<(() => void)[]>([]);
  useEffect(() => () => { pending.current?.abort(); temporaryFiles.current.forEach(dispose => dispose()); }, []);
  const chooseAttachment = async () => {
    if (!editAllowed.current) return;
    if (pending.current || unconfirmed || uploaded) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try {
      if (Platform.OS === 'web') throw new Error('Choose files using the iOS or Android app.');
      const existing = template.attachments?.filter(file => !removedAttachments.includes(file.id));
      if (!existing || existing.length >= 5) throw new Error('Refresh the template. A maximum of five attachments is allowed.');
      const Picker = await import('expo-document-picker');
      const result = await Picker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
      if (result.canceled) return;
      const asset = result.assets[0];
      const { File, Paths } = await import('expo-file-system');
      // Delete only the picker-created cache copy, never the user's original document.
      const file = new File(asset.uri);
      if (!file.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, '')}/`)) throw new Error('The selected file was not copied to private cache.');
      try {
        if (controller.signal.aborted) return;
        if (!file.size || existing.reduce((total, item) => total + item.size, 0) + file.size > 5 * 1024 * 1024) throw new Error('Choose a nonempty file. Attachments must total no more than 5 MB.');
        const data = await file.base64();
        if (!controller.signal.aborted) setPicked({ filename: asset.name, content_type: asset.mimeType || 'application/octet-stream', data });
      } finally { if (file.exists) file.delete(); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not read attachment.'); }
    finally { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  const upload = async () => {
    if (!editAllowed.current) return;
    if (!token || !picked || pending.current || unconfirmed || uploaded) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try {
      await uploadTemplateAttachment(token, template.id, picked, controller.signal);
      if (!controller.signal.aborted) { setPicked(null); setUploaded(true); }
    } catch (e) { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Could not upload attachment.'); if (e instanceof UnconfirmedTemplateSaveError) setUnconfirmed(true); } }
    finally { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  const openAttachment = async (id: number, filename: string) => {
    if (!token || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try {
      if (Platform.OS === 'web' || !await Sharing.isAvailableAsync()) throw new Error('Open files using the iOS or Android app.');
      if (controller.signal.aborted) return;
      const file = await downloadTemplateAttachment(token, template.id, id, filename, controller.signal);
      if (controller.signal.aborted) { file.dispose(); return; }
      temporaryFiles.current.push(file.dispose);
      await Sharing.shareAsync(file.uri, { dialogTitle: 'Open or save attachment' });
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not open attachment.'); }
    finally { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  const dirty = mode === 'body' ? content !== template.content : name !== template.name || subject !== template.subject || (mode === 'create' && content !== (template.content ?? '')) || (mode === 'metadata' && (category !== template.category || active !== template.is_active));
  const close = () => {
    if (pending.current) return;
    if (!dirty && !picked) { onClose(); return; }
    Alert.alert('Discard template changes?', 'Your unsaved changes will be lost.', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: onClose }]);
  };
  const removeAttachment = (id: number, filename: string) => {
    if (!editAllowed.current) return;
    if (pending.current || unconfirmed) return;
    Alert.alert('Remove attachment?', `${filename} will be removed immediately from this template and will not be included in future sends. This cannot be undone here.`, [
      { text: 'Keep attachment', style: 'cancel' },
      { text: 'Remove attachment', style: 'destructive', onPress: () => { void (async () => {
        if (!editAllowed.current || !token || pending.current || unconfirmed) return;
        const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
        try {
          await removeTemplateAttachment(token, template.id, id, controller.signal);
          if (!controller.signal.aborted) setRemovedAttachments(previous => [...previous, id]);
        } catch (e) {
          if (!controller.signal.aborted) {
            setError(e instanceof Error ? e.message : 'Could not remove attachment.');
            if (e instanceof UnconfirmedTemplateSaveError) setUnconfirmed(true);
          }
        } finally { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
      })(); } },
    ]);
  };
  const save = async () => {
    if (!editAllowed.current) return;
    if (!token || pending.current || !dirty || unconfirmed) return;
    const patch: TemplateMetadataPatch = {};
    if (name !== template.name) patch.name = name;
    if (subject !== template.subject) patch.subject = subject;
    if (mode === 'metadata' && category !== template.category) patch.category = category;
    if (mode === 'metadata' && active !== template.is_active) patch.is_active = active;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try {
      if (mode === 'create') await createTemplate(token, { name, subject, content }, controller.signal);
      else if (mode === 'body') await updateTemplateBody(token, template.id, content, controller.signal);
      else await updateTemplateMetadata(token, template.id, patch, controller.signal);
      if (!controller.signal.aborted) onSaved();
    } catch (e) { if (!controller.signal.aborted) {
      setError(e instanceof Error ? e.message : 'Could not save template.');
      if (mode !== 'metadata' && e instanceof UnconfirmedTemplateSaveError) setUnconfirmed(true);
    } }
    finally { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  return <Modal visible animationType="slide" onRequestClose={close}><SafeAreaProvider><SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <ThemedText type="subtitle">{mode === 'create' ? 'Create template' : mode === 'body' ? 'Edit email body' : 'Edit template details'}</ThemedText>
      <ThemedText>{mode === 'metadata' ? 'Email body and attachments stay unchanged. Active templates are available for campaign selection.' : mode === 'create' ? 'New templates are saved as inactive custom templates.' : 'Edit the original HTML source carefully. Formatting and placeholders are preserved unless you change them. Other template fields and attachments stay unchanged.'} Saving does not send email. Editing requires permission from the server.</ThemedText>
      {mode !== 'body' ? <>
      <ThemedText>Name</ThemedText><TextInput accessibilityLabel="Template name" value={name} onChangeText={setName} maxLength={255} editable={!busy} style={[styles.input, { color: theme.text, borderColor: theme.textSecondary }]} />
      <ThemedText>Subject</ThemedText><TextInput accessibilityLabel="Template subject" value={subject} onChangeText={setSubject} maxLength={500} editable={!busy} multiline style={[styles.input, { color: theme.text, borderColor: theme.textSecondary }]} />
      </> : null}
      {mode === 'metadata' && template.attachments?.length ? <>
        <ThemedText>Attachments — removal takes effect immediately</ThemedText>
        <ThemedText>Open or save uses your device’s share sheet. Choose a trusted app. Saved copies outside this app are not removed automatically.</ThemedText>
        {template.attachments.filter(file => !removedAttachments.includes(file.id)).map(file => <Pressable key={`open-${file.id}`} accessibilityRole="button" accessibilityLabel={`Open or save ${file.filename}`} disabled={busy} accessibilityState={{ disabled: busy }} style={styles.button} onPress={() => { void openAttachment(file.id, file.filename); }}><ThemedText>Open or save {file.filename}</ThemedText></Pressable>)}
        {template.attachments.filter(file => !removedAttachments.includes(file.id)).map(file => <Pressable key={file.id} accessibilityRole="button" accessibilityLabel={`Remove attachment ${file.filename}`} disabled={busy || unconfirmed} accessibilityState={{ disabled: busy || unconfirmed }} style={styles.button} onPress={() => removeAttachment(file.id, file.filename)}><ThemedText>Remove {file.filename}</ThemedText></Pressable>)}
        {removedAttachments.length ? <ThemedText accessibilityRole="alert">Attachment removed. Cancelling this editor will not restore it.</ThemedText> : null}
      </> : null}
      {mode === 'metadata' ? <>
        <Pressable accessibilityRole="button" disabled={busy || unconfirmed || uploaded} style={styles.button} onPress={() => { void chooseAttachment(); }}><ThemedText>Choose attachment</ThemedText></Pressable>
        {picked ? <><ThemedText>Selected: {picked.filename}. Uploading attaches this file to future sends of this template immediately.</ThemedText><Pressable accessibilityRole="button" disabled={busy || unconfirmed} style={styles.button} onPress={() => { void upload(); }}><ThemedText>Confirm attachment upload</ThemedText></Pressable><Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={() => setPicked(null)}><ThemedText>Discard selected file</ThemedText></Pressable></> : null}
        {uploaded ? <ThemedText accessibilityRole="alert">Attachment uploaded. Close and reopen this template to refresh its files. Cancelling does not remove the upload.</ThemedText> : null}
      </> : null}
      {mode === 'metadata' ? <>
        <ThemedText>Category: {category}</ThemedText>
        {templateCategories.map(value => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`Category ${value}`} accessibilityState={{ checked: category === value, disabled: busy }} disabled={busy} style={styles.button} onPress={() => setCategory(value)}><ThemedText>{category === value ? '● ' : '○ '}{value}</ThemedText></Pressable>)}
        <Pressable accessibilityRole="switch" accessibilityLabel="Template active" accessibilityState={{ checked: Boolean(active), disabled: busy }} disabled={busy} style={styles.button} onPress={() => setActive(!active)}><ThemedText>{active ? 'Active' : 'Inactive'} — tap to change</ThemedText></Pressable>
      </> : null}
      {mode !== 'metadata' ? <><ThemedText>Email body (HTML source)</ThemedText><TextInput accessibilityLabel="Template body source" value={content} onChangeText={setContent} maxLength={200000} editable={!busy && !unconfirmed} multiline autoCapitalize="none" autoCorrect={false} style={[styles.input, { minHeight: 240, textAlignVertical: 'top', color: theme.text, borderColor: theme.textSecondary }]} /></> : null}
      {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
      {busy ? <ActivityIndicator accessibilityLabel="Saving template" /> : null}
      <Pressable accessibilityRole="button" disabled={busy || !dirty || unconfirmed} accessibilityState={{ disabled: busy || !dirty || unconfirmed }} style={styles.button} onPress={() => { void save(); }}><ThemedText>{mode === 'metadata' ? 'Save template details' : mode === 'create' ? 'Create inactive template' : 'Save email body'}</ThemedText></Pressable>
      <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} style={styles.button} onPress={close}><ThemedText>Cancel</ThemedText></Pressable>
    </ScrollView>
  </SafeAreaView></SafeAreaProvider></Modal>;
}
const styles = StyleSheet.create({ container: { flex: 1, padding: 16 }, content: { gap: 16, paddingBottom: 32 }, input: { minHeight: 48, borderWidth: 1, borderRadius: 12, padding: 12 }, button: { minHeight: 48, padding: 12 } });
