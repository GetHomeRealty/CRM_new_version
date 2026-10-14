import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { fetchAudienceOptions, fetchCampaignTemplates, previewCampaignAudience, type AudiencePreview, type AudienceField, type AudienceFilters, type CampaignTemplate } from '@/campaigns/campaign-preview-api';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';
import { templateText } from '@/campaigns/template-text';
import { TemplateMetadataEditor } from './template-metadata-editor';
import { CampaignReviewSheet } from './campaign-review-sheet';
const filterLabels: Record<AudienceField, string> = { leadStatus: 'Status', leadType: 'Type', leadSource: 'Source', clientType: 'Client type' };

export function CampaignToolsSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth(); const theme = useTheme();
  const canEdit = canAreaScreen(user, 'crm', 'campaigns', 'edit');
  const templates = useQuery({ queryKey: ['campaign-templates'], queryFn: ({ signal }) => fetchCampaignTemplates(token!, signal), enabled: Boolean(token) });
  const options = useQuery({ queryKey: ['campaign-audience-options'], queryFn: ({ signal }) => fetchAudienceOptions(token!, signal), enabled: Boolean(token) });
  const [filters, setFilters] = useState<AudienceFilters>({});
  const [expanded, setExpanded] = useState<AudienceField | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [editing, setEditing] = useState<CampaignTemplate | null>(null);
  const [composing, setComposing] = useState<CampaignTemplate | null>(null);
  const [editMode, setEditMode] = useState<'metadata' | 'body' | 'create'>('metadata');
  const [saved, setSaved] = useState(false);
  const [tag, setTag] = useState('');
  const [result, setResult] = useState<AudiencePreview | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  const preview = async () => {
    if (!token || active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setResult(null);
    try { const value = await previewCampaignAudience(token, tag, controller.signal, filters); if (!controller.signal.aborted) setResult(value); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Audience preview failed.'); }
    finally { if (active.current === controller) active.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  if (composing && canEdit) return <CampaignReviewSheet template={composing} filters={filters} tag={tag} onClose={() => setComposing(null)} />;
  if (editing && canEdit) return <TemplateMetadataEditor template={editing} mode={editMode} onClose={() => { setEditing(null); void templates.refetch(); }} onSaved={() => { setEditing(null); setSaved(true); void templates.refetch(); }} />;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaProvider>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.row}><ThemedText type="subtitle">Campaign tools</ThemedText><Pressable accessibilityRole="button" style={styles.button} onPress={onClose}><ThemedText>Back</ThemedText></Pressable></View>
      <FlatList data={templates.isError ? [] : templates.data ?? []} keyExtractor={t => String(t.id)} keyboardShouldPersistTaps="handled"
        ListHeaderComponent={<View style={styles.section}>
          <ThemedText>Audience preview</ThemedText><ThemedText type="small">Filters combine together. Any means no restriction for that field. The optional tag must match exactly. Nothing is sent or saved.</ThemedText>
          {options.isPending ? <ActivityIndicator accessibilityLabel="Loading audience options" /> : null}
          {options.isError ? <><ThemedText accessibilityRole="alert" themeColor="danger">{options.error.message}</ThemedText><Pressable accessibilityRole="button" style={styles.button} onPress={() => { void options.refetch(); }}><ThemedText>Retry audience options</ThemedText></Pressable></> : null}
          {options.data && !options.isError ? (Object.keys(filterLabels) as AudienceField[]).map(field => <View key={field}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: expanded === field, disabled: busy }} disabled={busy} style={styles.button} onPress={() => setExpanded(expanded === field ? null : field)}><ThemedText>{filterLabels[field]}: {filters[field] || 'Any'}</ThemedText></Pressable>
            {expanded === field ? ['', ...options.data[field]].map(value => <Pressable key={value || '__any'} accessibilityRole="radio" accessibilityLabel={`${filterLabels[field]} option ${value || 'Any'}`} accessibilityState={{ checked: (filters[field] || '') === value, disabled: busy }} disabled={busy} style={styles.button}
              onPress={() => { setFilters(previous => ({ ...previous, [field]: value })); setExpanded(null); setResult(null); setError(''); }}><ThemedText>{value || 'Any'}</ThemedText></Pressable>) : null}
          </View>) : null}
          <TextInput accessibilityLabel="Audience tag" placeholder="Optional tag" placeholderTextColor={theme.textSecondary} value={tag} editable={!busy} maxLength={255}
            onChangeText={value => { setTag(value); setResult(null); setError(''); }} style={[styles.input, { color: theme.text, borderColor: theme.textSecondary }]} />
          <Pressable accessibilityRole="button" disabled={busy || !options.data || options.isError} accessibilityState={{ disabled: busy || !options.data || options.isError }} onPress={() => { void preview(); }} style={styles.button}><ThemedText>Preview audience count</ThemedText></Pressable>
          {busy ? <ActivityIndicator accessibilityLabel="Counting audience" /> : null}
          {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
          {result ? <ThemedText>{result.count} eligible recipients. This is a preview, not a send confirmation.</ThemedText> : null}
          <ThemedText type="subtitle">Templates</ThemedText><ThemedText type="small">Text-only previews. Formatting, images and links are not loaded. Placeholders are not personalized.</ThemedText>
          {canEdit ? <Pressable accessibilityRole="button" style={styles.button} onPress={() => { setSaved(false); setEditMode('create'); setEditing({ id: 0, name: '', subject: '', content: '', category: 'custom', is_active: false, attachment_count: 0 }); }}><ThemedText>Create template</ThemedText></Pressable> : null}
          {saved ? <ThemedText accessibilityRole="alert">Template saved.</ThemedText> : null}
          <Pressable accessibilityRole="button" onPress={() => { void templates.refetch(); }} style={styles.button}><ThemedText>Refresh templates</ThemedText></Pressable>
          {templates.isFetching ? <ActivityIndicator accessibilityLabel="Loading templates" /> : null}
          {templates.isError ? <ThemedText accessibilityRole="alert" themeColor="danger">{templates.error.message}</ThemedText> : null}
        </View>}
        ListEmptyComponent={!templates.isPending && !templates.isError ? <ThemedText>No templates found.</ThemedText> : null}
        renderItem={({ item }) => <View style={styles.section}><ThemedText type="smallBold">{item.name}</ThemedText><ThemedText type="small">{item.category} · {item.is_active ? 'Active' : 'Inactive'} · {item.attachment_count} attachments</ThemedText><ThemedText type="small">Subject: {item.subject}</ThemedText>
          <Pressable accessibilityRole="button" accessibilityLabel={`Preview template ${item.name}`} accessibilityState={{ expanded: previewId === item.id }} style={styles.button} onPress={() => setPreviewId(previewId === item.id ? null : item.id)}><ThemedText>{previewId === item.id ? 'Hide text preview' : 'View text preview'}</ThemedText></Pressable>
          {canEdit ? <Pressable accessibilityRole="button" accessibilityLabel={`Edit template ${item.name}`} style={styles.button} onPress={() => { setSaved(false); setEditMode('metadata'); setEditing(item); }}><ThemedText>Edit name and subject</ThemedText></Pressable> : null}
          {canEdit && item.content !== undefined ? <Pressable accessibilityRole="button" accessibilityLabel={`Edit body of ${item.name}`} style={styles.button} onPress={() => { setSaved(false); setEditMode('body'); setEditing(item); }}><ThemedText>Edit email body</ThemedText></Pressable> : null}
          {canEdit && item.is_active ? <Pressable accessibilityRole="button" style={styles.button} onPress={() => setComposing(item)}><ThemedText>Review campaign with this template</ThemedText></Pressable> : null}
          {previewId === item.id ? <View style={styles.section}>
            <ThemedText selectable>{item.content === undefined ? 'Template body is unavailable.' : templateText(item.content) || 'No readable text in this template. Images and attachments are not displayed.'}</ThemedText>
            <ThemedText type="smallBold">Attachments</ThemedText>
            <ThemedText type="small">File details only. Files are not downloaded or opened.</ThemedText>
            {item.attachment_count === 0 ? <ThemedText>No attachments.</ThemedText> : item.attachments === undefined ? <ThemedText>Attachment details are unavailable.</ThemedText> : item.attachments.map(file => <View key={file.id}>
              <ThemedText selectable>{file.filename}</ThemedText><ThemedText type="small">{file.size} bytes · {file.content_type || 'Unknown file type'}</ThemedText>
            </View>)}
          </View> : null}
        </View>} />
    </SafeAreaView></SafeAreaProvider></Modal>;
}
const styles = StyleSheet.create({ container: { flex: 1, padding: 16, gap: 12 }, row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }, section: { gap: 12, paddingVertical: 16 }, button: { minHeight: 48, padding: 12 }, input: { borderWidth: 1, borderRadius: 12, minHeight: 48, padding: 12 } });
