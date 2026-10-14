import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen, requireAreaEdit } from '@/auth/access-policy';
import { CalendarApiError, createEvent, deleteEvent, localDate, type CalendarArea, type CalendarEvent, type EventInput, updateEvent } from '@/calendar/calendar-api';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const types = ['viewing', 'meeting', 'open-house', 'follow-up', 'call', 'showing', 'inspection', 'closing', 'task'];
const statuses = ['scheduled', 'completed', 'cancelled', 'no-show', 'rescheduled'];
const blank = (): EventInput => ({ title: '', date: localDate(new Date()), time: '09:00', end_time: '10:00', type: 'meeting', status: 'scheduled', location: '', description: '', enable_reminder: false, recur_freq: 'none', recur_count: 4 });

export function CalendarEventEditor({ event, area, open, onClose, onSaved }: { event: CalendarEvent | null; area: CalendarArea; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { token, user } = useMobileAuth();
  const theme = useTheme();
  const [form, setForm] = useState<EventInput>(() => event ? { title: event.title, date: event.date, time: event.time, end_time: event.end_time, type: event.type, status: event.status, location: event.location ?? '', description: event.description ?? '', enable_reminder: event.enable_reminder ?? false } : blank());
  const [scope, setScope] = useState<'this' | 'series'>('this');
  const save = useMutation({
    mutationFn: (allowOverlap: boolean = false) => {
      requireAreaEdit(user, area, 'calendar');
      const payload = { ...form, allow_overlap: allowOverlap };
      return event ? updateEvent(token!, event, payload, area, scope) : createEvent(token!, payload, area);
    },
    onSuccess: onSaved,
    onError: (error: Error) => {
      if (error instanceof CalendarApiError && error.overlap) {
        Alert.alert('Appointment overlap', error.message, [
          { text: 'Change time', style: 'cancel' },
          { text: 'Book anyway', onPress: () => save.mutate(true) },
        ]);
      } else {
        Alert.alert('Could not save appointment', error.message);
      }
    },
  });
  const remove = useMutation({ mutationFn: () => { requireAreaEdit(user, area, 'calendar'); return deleteEvent(token!, event!, area, scope); }, onSuccess: onSaved, onError: (error: Error) => Alert.alert('Could not delete appointment', error.message) });
  if (!canAreaScreen(user, area, 'calendar', 'edit')) return null;
  const field = (label: string, keyName: keyof EventInput, placeholder: string) => <View style={styles.field}><ThemedText type="smallBold">{label}</ThemedText><TextInput accessibilityLabel={`Appointment ${label.toLowerCase()}`} onChangeText={(value) => setForm((current) => ({ ...current, [keyName]: value || (keyName === 'end_time' ? null : '') }))} placeholder={placeholder} placeholderTextColor={theme.textSecondary} style={[styles.input, { borderColor: theme.border, color: theme.text }]} value={String(form[keyName] ?? '')} /></View>;
  return <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={open}><ThemedView style={styles.screen}><SafeAreaView style={styles.screen}><View style={[styles.header, { borderBottomColor: theme.border }]}><Pressable onPress={onClose}><ThemedText type="smallBold">Cancel</ThemedText></Pressable><ThemedText type="smallBold">{event ? 'Edit appointment' : 'New appointment'}</ThemedText><Pressable accessibilityLabel="Save appointment" disabled={!form.title.trim() || save.isPending} onPress={() => save.mutate(false)}>{save.isPending ? <ActivityIndicator color={theme.primary} /> : <ThemedText type="smallBold" themeColor="primary">Save</ThemedText>}</Pressable></View><ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">{field('Title', 'title', 'Client meeting')}{field('Date', 'date', '2026-09-30')}<View style={styles.times}>{field('Start time', 'time', '09:00')}{field('End time', 'end_time', '10:00')}</View>{field('Location', 'location', 'Office or property address')}{field('Description', 'description', 'Optional details')}<ChoiceGroup label="Type" values={types} value={form.type} onChange={(type) => setForm((current) => ({ ...current, type }))} /><ChoiceGroup label="Status" values={statuses} value={form.status} onChange={(status) => setForm((current) => ({ ...current, status }))} /><View style={styles.times}><ThemedText type="smallBold">Appointment reminder</ThemedText><Switch accessibilityLabel="Appointment reminder" value={form.enable_reminder ?? false} onValueChange={(enable_reminder) => setForm((current) => ({ ...current, enable_reminder }))} /></View><ThemedText type="small" themeColor="textSecondary">Uses your existing Calendar reminder preferences.</ThemedText>
      {!event ? <><ChoiceGroup label="Repeat" values={['none', 'daily', 'weekly', 'monthly']} value={form.recur_freq ?? 'none'} onChange={(recur_freq) => setForm((current) => ({ ...current, recur_freq }))} />{form.recur_freq !== 'none' ? <View style={styles.field}><ThemedText type="smallBold">Number of appointments</ThemedText><TextInput accessibilityLabel="Number of appointments" keyboardType="number-pad" value={String(form.recur_count ?? '')} onChangeText={(value) => setForm((current) => ({ ...current, recur_count: value ? Number(value) : undefined }))} style={[styles.input, { borderColor: theme.border, color: theme.text }]} /></View> : null}</> : event.recurrence_id ? <ChoiceGroup label="Apply changes or deletion to" values={['this', 'series']} value={scope} onChange={(value) => setScope(value as 'this' | 'series')} /> : null}
      {event?.recurrence_id ? <ThemedText type="small" themeColor="textSecondary">“Series” includes this appointment and later occurrences.</ThemedText> : null}
      {event ? <Pressable accessibilityLabel="Delete appointment" disabled={remove.isPending} onPress={() => Alert.alert('Delete appointment?', scope === 'series' ? 'This removes this appointment and later occurrences.' : 'This removes this appointment from your calendar.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() }])} style={styles.delete}><ThemedText type="smallBold" themeColor="danger">Delete appointment</ThemedText></Pressable> : null}</ScrollView></SafeAreaView></ThemedView></Modal>;
}

function ChoiceGroup({ label, values, value, onChange }: { label: string; values: string[]; value: string; onChange: (value: string) => void }) { const theme = useTheme(); return <View style={styles.field}><ThemedText type="smallBold">{label}</ThemedText><View style={styles.choices}>{values.map((item) => <Pressable accessibilityRole="radio" accessibilityState={{ selected: item === value }} key={item} onPress={() => onChange(item)} style={[styles.choice, { borderColor: item === value ? theme.primary : theme.border, backgroundColor: item === value ? theme.primarySoft : theme.backgroundElement }]}><ThemedText type="smallBold" themeColor={item === value ? 'primary' : 'text'}>{item}</ThemedText></Pressable>)}</View></View>; }
const styles = StyleSheet.create({ screen: { flex: 1 }, header: { height: 52, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: Spacing.three, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, form: { padding: Spacing.three, paddingBottom: Spacing.six, gap: Spacing.three }, field: { flex: 1, gap: Spacing.two }, input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 13, paddingHorizontal: 14, fontSize: 16 }, times: { flexDirection: 'row', gap: Spacing.two }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two }, choice: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 }, delete: { minHeight: 48, alignItems: 'center', justifyContent: 'center' } });
