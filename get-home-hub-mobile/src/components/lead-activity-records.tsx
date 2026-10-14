import { LeadTaskAssignment } from './lead-task-assignment';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, TextInput, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import type { MobileLead } from '@/leads/leads-api';
import { activityBody, saveActivityRecord, type ActivityFields, type EditableActivity, type RemovableActivity } from '@/leads/activity-records-api';
import { ThemedText } from './themed-text';
import { useTheme } from '@/hooks/use-theme';
const FIELDS: Record<EditableActivity, string[]> = { notes: ['content'], tasks: ['title', 'due_date', 'description', 'priority', 'status'], showings: ['property', 'showing_date', 'time', 'notes', 'status'] };
interface RecordRow { id: number; title: string; draft: ActivityFields }
function records(lead: MobileLead, kind: RemovableActivity): RecordRow[] {
  if (kind === 'notes') return (lead.notes_history || []).map(n => ({ id: n.id, title: n.content, draft: { content: n.content } }));
  if (kind === 'tasks') return (lead.tasks || []).map(t => ({ id: t.id, title: t.title, draft: { title: t.title, due_date: t.due_date.slice(0, 10), description: t.description || '', priority: t.priority, status: t.status } }));
  if (kind === 'showings') return (lead.showings || []).map(s => ({ id: s.id, title: s.property || 'Property showing', draft: { property: s.property || '', showing_date: s.showing_date.slice(0, 10), time: s.time, notes: s.notes || '', status: s.status } }));
  return (lead.calls || []).map(c => ({ id: c.id, title: c.outcome || 'Call log', draft: {} }));
}
export function LeadActivityRecords({ lead, kind }: { lead: MobileLead; kind: RemovableActivity }) {
  const { user, token } = useMobileAuth(), theme = useTheme(), client = useQueryClient();
  const canEdit = Boolean(token && user?.id && canAreaScreen(user, 'crm', 'lead', 'edit'));
  const [editing, setEditing] = useState<{ kind: EditableActivity; id: number; draft: ActivityFields } | null>(null);
  const [validation, setValidation] = useState('');
  const rows = records(lead, kind);
  const mutation = useMutation({ retry: false, mutationFn: (submitted: { leadId: number; userId: number; token: string; kind: RemovableActivity; id: number; draft: ActivityFields | null }) => {
    if (!canEdit || submitted.leadId !== lead.id || submitted.userId !== user?.id || submitted.token !== token) throw new Error('You no longer have permission to edit lead activity.');
    return saveActivityRecord(token!, lead.id, submitted.kind, submitted.id, submitted.draft);
  }, onSuccess: async (_, submitted) => {
    setEditing(current => current?.id === submitted.id && current.kind === submitted.kind && (!submitted.draft || JSON.stringify(current.draft) === JSON.stringify(submitted.draft)) ? null : current);
    await Promise.all([client.invalidateQueries({ queryKey: ['lead', submitted.leadId] }), client.invalidateQueries({ queryKey: ['leads'] }), client.invalidateQueries({ queryKey: ['calendar'] })]);
  } });
  const submit = (id: number, activity: RemovableActivity, draft: ActivityFields | null) => ({ leadId: lead.id, userId: user!.id!, token: token!, kind: activity, id, draft });
  const button = (label: string, action: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={mutation.isPending} accessibilityState={{ disabled: mutation.isPending }} onPress={action} style={{ minHeight: 44, padding: 12 }}><ThemedText themeColor="primary">{label}</ThemedText></Pressable>;
  if (!canEdit || !rows.length) return null;
  return <View style={{ gap: 12 }}><ThemedText type="smallBold">Manage existing {kind}</ThemedText>{kind === 'notes' ? <ThemedText type="small">The API checks note authorship before an edit or removal.</ThemedText> : null}
    {kind === 'tasks' ? (lead.tasks || []).map(task => <LeadTaskAssignment key={task.id} leadId={lead.id} task={task} />) : null}
    {rows.map(row => <View key={row.id} style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 12 }}><ThemedText>{row.title}</ThemedText>
      {kind !== 'calls' ? button(`Edit ${kind} ${row.id}`, () => {
        const open = () => { setEditing({ kind, id: row.id, draft: { ...row.draft } }); setValidation(''); mutation.reset(); };
        if (editing) Alert.alert('Discard activity draft?', 'Your current unsaved changes will be discarded.', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard draft', onPress: open }]); else open();
      }) : null}
      {button(`Delete ${kind} ${row.id}`, () => { const submitted = submit(row.id, kind, null); Alert.alert('Delete this activity?', 'This permanently removes the activity from the lead history. It cannot be undone here.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete activity', style: 'destructive', onPress: () => mutation.mutate(submitted) }]); })}
    </View>)}
    {editing ? <View style={{ gap: 10 }}><ThemedText type="smallBold">Editing {editing.kind} {editing.id}</ThemedText>{FIELDS[editing.kind].map(field => <View key={field}><ThemedText>{field.replaceAll('_', ' ')}</ThemedText><TextInput accessibilityLabel={`Activity ${field}`} editable={!mutation.isPending} value={editing.draft[field]} maxLength={field === 'title' || field === 'property' ? 255 : ['content', 'notes', 'description'].includes(field) ? 20000 : 32} multiline={['content', 'notes', 'description'].includes(field)} onChangeText={value => setEditing(current => current ? { ...current, draft: { ...current.draft, [field]: value } } : null)} style={{ minHeight: 44, padding: 12, color: theme.text, borderWidth: 1, borderColor: theme.border, borderRadius: 8 }} /></View>)}
      {button('Save activity changes', () => { try { activityBody(editing.kind, editing.draft); setValidation(''); mutation.mutate(submit(editing.id, editing.kind, { ...editing.draft })); } catch (e) { setValidation((e as Error).message); } })}
      {button('Discard activity changes', () => Alert.alert('Discard activity changes?', 'The saved activity will remain unchanged.', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard draft', onPress: () => { setEditing(null); setValidation(''); mutation.reset(); } }]))}
    </View> : null}
    {validation ? <ThemedText accessibilityRole="alert" themeColor="danger">{validation}</ThemedText> : null}{mutation.isPending ? <ActivityIndicator /> : null}{mutation.isError ? <ThemedText accessibilityRole="alert" themeColor="danger">{mutation.error.message}</ThemedText> : null}
  </View>;
}
