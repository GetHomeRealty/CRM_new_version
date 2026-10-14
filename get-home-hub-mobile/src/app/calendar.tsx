import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen, requireAreaEdit } from '@/auth/access-policy';
import { createTodo, deleteTodo, fetchCalendar, type CalendarArea, type CalendarEvent, type CalendarTodo, type TodoInput, updateTodo } from '@/calendar/calendar-api';
import { CalendarEventEditor } from '@/components/calendar-event-editor';
import { MobileScreen } from '@/components/mobile-screen';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const emptyForm: TodoInput = { title: '', description: '', status: 'pending', priority: 'medium', due_date: null };

export default function CalendarScreen() {
  const { token, user } = useMobileAuth();
  const theme = useTheme();
  const client = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CalendarTodo | null>(null);
  const [form, setForm] = useState<TodoInput>(emptyForm);
  const [eventEditorOpen, setEventEditorOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const areas = (['crm', 'desk'] as const).filter((value) => canAreaScreen(user, value, 'calendar'));
  const [selectedArea, setArea] = useState<CalendarArea>('crm');
  const area = areas.includes(selectedArea) ? selectedArea : areas[0] ?? 'crm';
  const canEdit = canAreaScreen(user, area, 'calendar', 'edit');
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const query = useQuery({ queryKey: ['calendar', area, month.getFullYear(), month.getMonth()], queryFn: ({ signal }) => fetchCalendar(token!, area, month, signal), enabled: Boolean(token) && areas.length > 0 });
  const refresh = () => client.invalidateQueries({ queryKey: ['calendar'] });
  const toggle = useMutation({ mutationFn: (todo: CalendarTodo) => { requireAreaEdit(user, area, 'calendar'); return updateTodo(token!, todo, { status: todo.status === 'completed' ? 'pending' : 'completed' }, area); }, onSuccess: refresh, onError: (error: Error) => Alert.alert('Could not update task', error.message) });
  const save = useMutation({ mutationFn: () => { requireAreaEdit(user, area, 'calendar'); return editing ? updateTodo(token!, editing, form, area) : createTodo(token!, form, area); }, onSuccess: () => { refresh(); setEditorOpen(false); }, onError: (error: Error) => Alert.alert('Could not save task', error.message) });
  const remove = useMutation({ mutationFn: () => { requireAreaEdit(user, area, 'calendar'); return deleteTodo(token!, editing!, area); }, onSuccess: () => { refresh(); setEditorOpen(false); }, onError: (error: Error) => Alert.alert('Could not delete task', error.message) });
  const openNew = () => { setEditing(null); setForm(emptyForm); setEditorOpen(true); };
  const openEdit = (todo: CalendarTodo) => { setEditing(todo); setForm({ title: todo.title, description: todo.description ?? '', status: todo.status, priority: todo.priority, due_date: todo.due_date }); setEditorOpen(true); };

  const openEvent = (event: CalendarEvent | null) => { setEditingEvent(event); setEventEditorOpen(true); };
  const eventSaved = () => { refresh(); setEventEditorOpen(false); };

  if (!canEdit) return <MobileScreen eyebrow={area === 'crm' ? 'CRM' : 'Transaction Desk'} title="Calendar" subtitle="View-only access">
    <View style={styles.choices}>{areas.map(value => <Choice key={value} label={value === 'crm' ? 'CRM' : 'Transactions'} selected={area === value} onPress={() => setArea(value)} />)}</View>
    <View style={styles.headerActions}>
      <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ThemedText>Previous month</ThemedText></Pressable>
      <ThemedText>{month.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}</ThemedText>
      <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ThemedText>Next month</ThemedText></Pressable>
    </View>
    {areas.length === 0 ? <ThemedText>Calendar access is unavailable.</ThemedText> : query.isPending ? <ActivityIndicator /> : null}
    {query.isError ? <Pressable onPress={() => query.refetch()}><ThemedText>Could not load calendar. Tap to retry.</ThemedText></Pressable> : null}
    {areas.length > 0 && query.data ? <>
      <Section title="Appointments">{query.data.events.map(event => <View key={event.id}><ThemedText>{event.title}</ThemedText><ThemedText>{event.date} · {event.time} · {event.location}</ThemedText></View>)}{!query.data.events.length ? <ThemedText>No appointments this month.</ThemedText> : null}</Section>
      <Section title="To-do list">{query.data.todos.data.map(todo => <View key={todo.id}><ThemedText>{todo.title} · {todo.status}</ThemedText><ThemedText>{todo.priority} · {todo.due_date}</ThemedText></View>)}{!query.data.todos.data.length ? <ThemedText>No personal tasks.</ThemedText> : null}</Section>
    </> : null}
  </MobileScreen>;

  return <><MobileScreen eyebrow={area === 'crm' ? 'CRM' : 'Transaction Desk'} title="Calendar" subtitle="Appointments and personal tasks" action={<View style={styles.headerActions}><Pressable accessibilityLabel="Add appointment" onPress={() => openEvent(null)} style={[styles.secondaryAdd, { borderColor: theme.primary }]}><ThemedText type="smallBold" themeColor="primary">+ Event</ThemedText></Pressable><Pressable accessibilityLabel="Add task" onPress={openNew} style={[styles.add, { backgroundColor: theme.primary }]}><ThemedText type="smallBold" style={styles.white}>+ Task</ThemedText></Pressable></View>}>
    <View style={styles.choices}>{areas.map((value) => <Choice key={value} label={value === 'crm' ? 'CRM' : 'Transactions'} selected={area === value} onPress={() => setArea(value)} />)}</View>
    <View style={styles.headerActions}>
      <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} style={styles.add}><ThemedText>‹</ThemedText></Pressable>
      <ThemedText type="smallBold">{month.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}</ThemedText>
      <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} style={styles.add}><ThemedText>›</ThemedText></Pressable>
      <Pressable accessibilityRole="button" onPress={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}><ThemedText themeColor="primary">Today</ThemedText></Pressable>
    </View>
    {query.isPending ? <ActivityIndicator color={theme.primary} /> : null}
    {query.isError ? <ThemedText themeColor="danger">{query.error.message}</ThemedText> : null}
    {query.data ? <><View style={styles.summary}><Summary label="This month" value={query.data.events.length} /><Summary label="Pending" value={query.data.todos.counts.pending} /><Summary label="Overdue" value={query.data.todos.counts.overdue} /></View>
      <Section title="Appointments">{query.data.events.length ? query.data.events.map((event) => <Pressable accessibilityLabel={`Edit appointment ${event.title}`} key={event.id} onPress={() => openEvent(event)} style={[styles.row, { borderColor: theme.border }]}><ThemedText type="smallBold">{event.title}</ThemedText><ThemedText type="small" themeColor="textSecondary">{event.date} · {event.time}{event.location ? ` · ${event.location}` : ''}</ThemedText></Pressable>) : <ThemedText type="small" themeColor="textSecondary">No appointments this month.</ThemedText>}</Section>
      <Section title="To-do list">{query.data.todos.data.length ? query.data.todos.data.map((todo) => <View key={todo.id} style={[styles.todo, { borderColor: theme.border }]}><Pressable accessibilityLabel={`${todo.status === 'completed' ? 'Reopen' : 'Complete'} ${todo.title}`} accessibilityRole="checkbox" accessibilityState={{ checked: todo.status === 'completed' }} disabled={toggle.isPending} onPress={() => toggle.mutate(todo)} style={[styles.check, { borderColor: todo.status === 'completed' ? theme.primary : theme.border, backgroundColor: todo.status === 'completed' ? theme.primary : 'transparent' }]}>{todo.status === 'completed' ? <ThemedText style={styles.checkText}>✓</ThemedText> : null}</Pressable><Pressable accessibilityLabel={`Edit ${todo.title}`} onPress={() => openEdit(todo)} style={styles.todoCopy}><ThemedText type="smallBold" style={todo.status === 'completed' ? styles.done : undefined}>{todo.title}</ThemedText><ThemedText type="small" themeColor={todo.overdue ? 'danger' : 'textSecondary'}>{todo.priority} priority{todo.due_date ? ` · Due ${todo.due_date}` : ''}</ThemedText></Pressable></View>) : <ThemedText type="small" themeColor="textSecondary">No personal tasks.</ThemedText>}</Section></> : null}
  </MobileScreen><TaskEditor editing={editing} form={form} open={editorOpen} saving={save.isPending} deleting={remove.isPending} onChange={setForm} onClose={() => setEditorOpen(false)} onSave={() => save.mutate()} onDelete={() => remove.mutate()} />{eventEditorOpen ? <CalendarEventEditor key={editingEvent?.id ?? 'new'} event={editingEvent} area={area} open onClose={() => setEventEditorOpen(false)} onSaved={eventSaved} /> : null}</>;
}

function TaskEditor({ editing, form, open, saving, deleting, onChange, onClose, onSave, onDelete }: { editing: CalendarTodo | null; form: TodoInput; open: boolean; saving: boolean; deleting: boolean; onChange: (value: TodoInput) => void; onClose: () => void; onSave: () => void; onDelete: () => void }) {
  const theme = useTheme();
  return <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={open}><ThemedView style={styles.screen}><SafeAreaView style={styles.screen}><View style={[styles.header, { borderBottomColor: theme.border }]}><Pressable onPress={onClose}><ThemedText type="smallBold">Cancel</ThemedText></Pressable><ThemedText type="smallBold">{editing ? 'Edit task' : 'New task'}</ThemedText><Pressable accessibilityLabel="Save task" disabled={!form.title.trim() || saving} onPress={onSave}>{saving ? <ActivityIndicator color={theme.primary} /> : <ThemedText type="smallBold" themeColor="primary">Save</ThemedText>}</Pressable></View><ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled"><Field label="Title"><TextInput accessibilityLabel="Task title" onChangeText={(title) => onChange({ ...form, title })} placeholder="Follow up with client" placeholderTextColor={theme.textSecondary} style={[styles.input, { borderColor: theme.border, color: theme.text }]} value={form.title} /></Field><Field label="Description"><TextInput accessibilityLabel="Task description" multiline onChangeText={(description) => onChange({ ...form, description })} placeholder="Optional details" placeholderTextColor={theme.textSecondary} style={[styles.input, styles.multiline, { borderColor: theme.border, color: theme.text }]} value={form.description} /></Field><Field label="Due date (YYYY-MM-DD)"><TextInput accessibilityLabel="Task due date" keyboardType="numbers-and-punctuation" onChangeText={(due_date) => onChange({ ...form, due_date: due_date || null })} placeholder="2026-09-30" placeholderTextColor={theme.textSecondary} style={[styles.input, { borderColor: theme.border, color: theme.text }]} value={form.due_date ?? ''} /></Field><Field label="Priority"><View style={styles.choices}>{(['low', 'medium', 'high'] as const).map((priority) => <Choice key={priority} label={priority} selected={form.priority === priority} onPress={() => onChange({ ...form, priority })} />)}</View></Field>{editing ? <Pressable accessibilityLabel="Delete task" disabled={deleting} onPress={() => Alert.alert('Delete task?', 'This removes the task from your calendar.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: onDelete }])} style={styles.delete}><ThemedText type="smallBold" themeColor="danger">Delete task</ThemedText></Pressable> : null}</ScrollView></SafeAreaView></ThemedView></Modal>;
}

function Summary({ label, value }: { label: string; value: number }) { return <View style={styles.summaryItem}><ThemedText style={styles.summaryValue}>{value}</ThemedText><ThemedText type="small" themeColor="textSecondary">{label}</ThemedText></View>; }
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <View style={styles.section}><ThemedText type="subtitle">{title}</ThemedText>{children}</View>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <View style={styles.field}><ThemedText type="smallBold">{label}</ThemedText>{children}</View>; }
function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) { const theme = useTheme(); return <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress} style={[styles.choice, { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.primarySoft : theme.backgroundElement }]}><ThemedText type="smallBold" themeColor={selected ? 'primary' : 'text'}>{label}</ThemedText></Pressable>; }

const styles = StyleSheet.create({ screen: { flex: 1 }, header: { height: 52, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: Spacing.three, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, headerActions: { flexDirection: 'row', gap: Spacing.two }, add: { borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10 }, secondaryAdd: { borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10 }, white: { color: '#FFFFFF' }, summary: { flexDirection: 'row', gap: Spacing.two }, summaryItem: { flex: 1, alignItems: 'center', padding: Spacing.three, borderRadius: 18, backgroundColor: 'rgba(81,70,229,0.09)' }, summaryValue: { fontSize: 25, lineHeight: 31, fontWeight: '800' }, section: { gap: Spacing.two }, row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, padding: Spacing.three, gap: 3 }, todo: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, padding: Spacing.three }, check: { width: 28, height: 28, borderWidth: 1.5, borderRadius: 9, alignItems: 'center', justifyContent: 'center' }, checkText: { color: '#FFFFFF', fontWeight: '800' }, todoCopy: { flex: 1, gap: 2 }, done: { textDecorationLine: 'line-through', opacity: 0.6 }, form: { padding: Spacing.three, paddingBottom: Spacing.six, gap: Spacing.four }, field: { gap: Spacing.two }, input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 13, paddingHorizontal: 14, fontSize: 16 }, multiline: { minHeight: 100, paddingTop: 13, textAlignVertical: 'top' }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two }, choice: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, textTransform: 'capitalize' }, delete: { minHeight: 48, alignItems: 'center', justifyContent: 'center' } });
