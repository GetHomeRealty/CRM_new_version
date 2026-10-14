import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { addLeadActivity, changeLeadActivity, sendLeadEmail, type MobileLead } from '@/leads/leads-api';
import { LeadTaskAssignment } from './lead-task-assignment';
import { LeadMessages, LeadRecordings } from './lead-communications';
import { LeadActivityRecords } from './lead-activity-records';
import { clearSubmittedField } from '@/leads/submitted-field';
import { validActivityDate, shortActivityDate } from '@/leads/activity-date';

type ActivityKind = 'notes' | 'tasks' | 'showings' | 'calls' | 'emails' | 'sms';
const KINDS: { key: ActivityKind; label: string }[] = [
  { key: 'notes', label: 'Notes' }, { key: 'tasks', label: 'Tasks' }, { key: 'showings', label: 'Showings' },
  { key: 'calls', label: 'Calls' }, { key: 'emails', label: 'Emails' }, { key: 'sms', label: 'SMS' },
];
const CALL_OUTCOMES = ['connected', 'no answer', 'voicemail', 'wrong number', 'callback requested'] as const;

export function LeadActivity({ lead }: { lead: MobileLead }) {
  const { token, user } = useMobileAuth();
  const canEdit = canAreaScreen(user, 'crm', 'lead', 'edit');
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ActivityKind>('notes');
  const [content, setContent] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskPriority, setTaskPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  const [property, setProperty] = useState('');
  const [showingDate, setShowingDate] = useState('');
  const [showingTime, setShowingTime] = useState('12:00');
  const [callOutcome, setCallOutcome] = useState('connected');
  const [callDuration, setCallDuration] = useState('');
  const [callNotes, setCallNotes] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const activityDraft = { kind, content, taskTitle, taskDescription, taskPriority, dueDate, property, showingDate, showingTime, callOutcome, callDuration, callNotes };
  const create = useMutation({
    mutationFn: ({ kind, content, taskTitle, taskDescription, taskPriority, dueDate, property, showingDate, showingTime, callOutcome, callDuration, callNotes }: typeof activityDraft) => {
      if (!canEdit) throw new Error('You do not have permission to edit lead activity.');
      if (kind === 'sms') throw new Error('Use the SMS history form to record past exchanges.');
      if (kind === 'tasks' && !validActivityDate(dueDate)) throw new Error('Enter a valid due date in YYYY-MM-DD format.');
      if (kind === 'showings' && !validActivityDate(showingDate)) throw new Error('Enter a valid showing date in YYYY-MM-DD format.');
      if (kind === 'notes') return addLeadActivity(token!, lead.id, 'notes', { content });
      if (kind === 'tasks') return addLeadActivity(token!, lead.id, 'tasks', { title: taskTitle.trim(), description: taskDescription.trim() || null, due_date: dueDate, status: 'pending', priority: taskPriority });
      if (kind === 'showings') return addLeadActivity(token!, lead.id, 'showings', { property, showing_date: showingDate, time: showingTime, status: 'scheduled' });
      return addLeadActivity(token!, lead.id, 'calls', { outcome: callOutcome, duration: callDuration, notes: callNotes });
    },
    onSuccess: (_, submitted) => {
      if (submitted.kind === 'notes') setContent((current) => clearSubmittedField(current, submitted.content));
      if (submitted.kind === 'tasks') {
        setTaskTitle((current) => clearSubmittedField(current, submitted.taskTitle));
        setTaskDescription((current) => clearSubmittedField(current, submitted.taskDescription));
        setTaskPriority((current) => clearSubmittedField(current, submitted.taskPriority, 'medium'));
        setDueDate((current) => clearSubmittedField(current, submitted.dueDate));
      }
      if (submitted.kind === 'showings') {
        setProperty((current) => clearSubmittedField(current, submitted.property));
        setShowingDate((current) => clearSubmittedField(current, submitted.showingDate));
        setShowingTime((current) => clearSubmittedField(current, submitted.showingTime, '12:00'));
      }
      if (submitted.kind === 'calls') {
        setCallDuration((current) => clearSubmittedField(current, submitted.callDuration));
        setCallNotes((current) => clearSubmittedField(current, submitted.callNotes));
      }
      queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
  const email = useMutation({
    mutationFn: (submitted: { subject: string; body: string }) => {
      if (!canEdit) throw new Error('You do not have permission to send lead email.');
      if (lead.unsubscribed) throw new Error('This lead has unsubscribed from email.');
      return sendLeadEmail(token!, lead.id, submitted.subject, submitted.body);
    },
    onSuccess: (_, submitted) => {
      setEmailSubject((current) => clearSubmittedField(current, submitted.subject));
      setEmailBody((current) => clearSubmittedField(current, submitted.body));
      queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
    },
  });
  const entries = kind === 'sms' ? [] : activityEntries(lead, kind);
  const displayedEntries = kind === 'tasks' || kind === 'notes' || kind === 'showings' ? [] : entries;
  const change = useMutation({
    mutationFn: (update: Parameters<typeof changeLeadActivity>[2]) => {
      if (!canEdit) throw new Error('You do not have permission to edit lead activity.');
      return changeLeadActivity(token!, lead.id, update);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['lead', lead.id] }),
        queryClient.invalidateQueries({ queryKey: ['leads'] }),
        queryClient.invalidateQueries({ queryKey: ['calendar'] }),
      ]);
    },
  });
  const validDate = validActivityDate;
  const canCreate = kind === 'notes' ? Boolean(content.trim())
    : kind === 'tasks' ? Boolean(taskTitle.trim() && validDate(dueDate))
      : kind === 'showings' ? Boolean(validDate(showingDate) && /^([01]\d|2[0-3]):[0-5]\d$/.test(showingTime))
        : kind === 'calls' && (!callDuration || /^\d+$/.test(callDuration));

  if (!canEdit) return (
    <View style={styles.wrapper}>
      <ThemedText type="smallBold">Activity · view only</ThemedText>
      <View style={styles.tabs}>{KINDS.map((item) => <Pressable key={item.key} accessibilityRole="tab" accessibilityState={{ selected: kind === item.key }} onPress={() => setKind(item.key)} style={[styles.tab, { borderColor: theme.border }]}><ThemedText>{item.label}</ThemedText></Pressable>)}</View>
      {kind === 'tasks' ? (lead.tasks || []).map(task => <LeadTaskAssignment key={task.id} leadId={lead.id} task={task} />) : null}
      {kind === 'calls' ? <LeadRecordings lead={lead} /> : null}
      {kind === 'sms' ? <LeadMessages lead={lead} /> : entries.length ? entries.map((entry) => <View key={entry.id} style={styles.entryCopy}><ThemedText type="smallBold">{entry.title}</ThemedText><ThemedText>{entry.detail}</ThemedText><ThemedText type="small">{entry.meta}</ThemedText></View>) : <ThemedText>No {kind} yet.</ThemedText>}
    </View>
  );

  return (
    <View style={styles.wrapper}>
      <ThemedText type="smallBold">Activity</ThemedText>
      <View style={styles.tabs}>
        {KINDS.map((item) => <Pressable key={item.key} accessibilityRole="tab" accessibilityState={{ selected: kind === item.key, disabled: create.isPending || email.isPending }} disabled={create.isPending || email.isPending} onPress={() => { setKind(item.key); create.reset(); email.reset(); }} style={[styles.tab, { borderColor: kind === item.key ? theme.primary : theme.border, backgroundColor: kind === item.key ? theme.primarySoft : theme.backgroundElement }]}><ThemedText type="smallBold" themeColor={kind === item.key ? 'primary' : 'textSecondary'}>{item.label}</ThemedText></Pressable>)}
      </View>
      {kind === 'notes' ? (
        <ComposerInput label="New note" multiline placeholder="Write a note…" value={content} onChangeText={setContent} />
      ) : kind === 'tasks' ? (
        <View style={styles.composerFields}>
          <ComposerInput label="Task" placeholder="Follow up with lead" value={taskTitle} onChangeText={setTaskTitle} />
          <ComposerInput label="Description (optional)" accessibilityLabel="Task description" multiline value={taskDescription} onChangeText={setTaskDescription} />
          <ThemedText type="small" themeColor="textSecondary">Priority</ThemedText>
          <View style={styles.tabs}>{['low', 'medium', 'high'].map((priority) => <Pressable key={priority} accessibilityRole="radio" accessibilityLabel={`Task priority ${priority}`} accessibilityState={{ selected: taskPriority === priority }} onPress={() => setTaskPriority(priority)} style={[styles.tab, { minHeight: 44, borderColor: taskPriority === priority ? theme.primary : theme.border, backgroundColor: taskPriority === priority ? theme.primarySoft : theme.backgroundElement }]}><ThemedText>{priority}</ThemedText></Pressable>)}</View>
          <ComposerInput label="Due date" placeholder="YYYY-MM-DD" value={dueDate} onChangeText={setDueDate} />
          {dueDate && !validDate(dueDate) ? <ThemedText type="small" themeColor="danger">Enter an existing date in YYYY-MM-DD format.</ThemedText> : null}
        </View>
      ) : kind === 'showings' ? (
        <View style={styles.composerFields}>
          <ComposerInput label="Property" placeholder="123 Main Street" value={property} onChangeText={setProperty} />
          <ComposerInput label="Showing date" placeholder="YYYY-MM-DD" value={showingDate} onChangeText={setShowingDate} />
          {showingDate && !validDate(showingDate) ? <ThemedText type="small" themeColor="danger">Enter an existing date in YYYY-MM-DD format.</ThemedText> : null}
          <ComposerInput label="Time" placeholder="HH:MM" value={showingTime} onChangeText={setShowingTime} />
        </View>
      ) : kind === 'calls' ? (
        <View style={styles.composerFields}>
          <ThemedText type="small" themeColor="textSecondary">Outcome</ThemedText>
          <View style={styles.tabs}>{CALL_OUTCOMES.map((outcome) => <Pressable key={outcome} onPress={() => setCallOutcome(outcome)} style={[styles.tab, { borderColor: callOutcome === outcome ? theme.primary : theme.border, backgroundColor: callOutcome === outcome ? theme.primarySoft : theme.backgroundElement }]}><ThemedText type="smallBold" themeColor={callOutcome === outcome ? 'primary' : 'textSecondary'}>{outcome.replace(/\b\w/g, (letter) => letter.toUpperCase())}</ThemedText></Pressable>)}</View>
          <ComposerInput keyboardType="number-pad" label="Duration in seconds (optional)" placeholder="120" value={callDuration} onChangeText={setCallDuration} />
          <ComposerInput label="Call notes (optional)" multiline placeholder="Add call notes…" value={callNotes} onChangeText={setCallNotes} />
        </View>
      ) : kind === 'sms' ? <LeadMessages lead={lead} /> : (
        <View style={styles.composerFields}>
          <ThemedText type="small" themeColor="textSecondary">{lead.unsubscribed ? 'This lead has unsubscribed from email.' : lead.email ? `This sends directly to ${lead.email} through your connected CRM mail account.` : 'Add an email address to this lead before sending email.'}</ThemedText>
          <ComposerInput label="Subject" placeholder="Email subject" value={emailSubject} onChangeText={setEmailSubject} />
          <ComposerInput label="Message" multiline placeholder="Write your message…" value={emailBody} onChangeText={setEmailBody} />
          {email.isError ? <ThemedText type="small" themeColor="danger" accessibilityLiveRegion="polite">{email.error.message}</ThemedText> : null}
          {email.isSuccess ? <ThemedText type="smallBold" themeColor="success" accessibilityLiveRegion="polite">Email sent.</ThemedText> : null}
          <Pressable
            accessibilityRole="button"
            disabled={lead.unsubscribed || !lead.email || !emailSubject.trim() || !emailBody.trim() || email.isPending}
            onPress={() => Alert.alert('Send this email?', `This will send to ${lead.email}.`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Send email', onPress: () => email.mutate({ subject: emailSubject, body: emailBody }) },
            ])}
            style={[styles.addButton, (lead.unsubscribed || !lead.email || !emailSubject.trim() || !emailBody.trim() || email.isPending) && styles.disabled]}>
            {email.isPending ? <ActivityIndicator color="#FFFFFF" /> : <ThemedText type="smallBold" style={styles.white}>Review and send</ThemedText>}
          </Pressable>
        </View>
      )}
      {kind !== 'emails' && kind !== 'sms' ? (
        <>
          {create.isError ? <ThemedText type="small" themeColor="danger">{create.error.message}</ThemedText> : null}
          <Pressable accessibilityRole="button" disabled={!canCreate || create.isPending} onPress={() => create.mutate(activityDraft)} style={[styles.addButton, (!canCreate || create.isPending) && styles.disabled]}>
            {create.isPending ? <ActivityIndicator color="#FFFFFF" /> : <ThemedText type="smallBold" style={styles.white}>{kind === 'calls' ? 'Log call' : kind === 'showings' ? 'Schedule showing' : `Add ${kind === 'notes' ? 'note' : 'task'}`}</ThemedText>}
          </Pressable>
        </>
      ) : null}
      {kind !== 'emails' && kind !== 'sms' ? <LeadActivityRecords key={lead.id} lead={lead} kind={kind} /> : null}
      {kind === 'calls' ? <LeadRecordings lead={lead} /> : null}
      <View style={styles.entries}>
        {kind === 'showings' ? (lead.showings ?? []).map((showing) => <View key={showing.id} style={styles.composerFields}>
          <ThemedText type="smallBold">{showing.property || 'Property showing'} · {showing.status}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">{shortActivityDate(showing.showing_date)} · {showing.time}</ThemedText>
          {showing.notes ? <ThemedText type="small">{showing.notes}</ThemedText> : null}
          <View style={styles.tabs}>{(['scheduled', 'completed', 'cancelled'] as const).map((status) => <Pressable key={status} accessibilityRole="button" accessibilityLabel={`Mark showing ${showing.property || showing.id} ${status}`} disabled={change.isPending || showing.status === status} accessibilityState={{ disabled: change.isPending || showing.status === status }} onPress={() => change.mutate({ kind: 'showings', id: showing.id, status })} style={[styles.tab, { borderColor: theme.border, minHeight: 44 }, (change.isPending || showing.status === status) && styles.disabled]}><ThemedText>{status === 'scheduled' ? 'Mark scheduled' : status === 'completed' ? 'Complete' : 'Cancel showing'}</ThemedText></Pressable>)}</View>
          {change.isPending && change.variables?.kind === 'showings' && change.variables.id === showing.id ? <ActivityIndicator accessibilityLabel="Updating showing" /> : null}
        </View>) : null}
        {change.isError ? <ThemedText themeColor="danger" accessibilityLiveRegion="polite">{change.error.message}</ThemedText> : null}
        {kind === 'tasks' ? (lead.tasks ?? []).map((task) => <View key={`actions-${task.id}`} style={styles.composerFields}>
          <ThemedText type="smallBold">{task.title} · {task.status}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">{task.priority} priority · {shortActivityDate(task.due_date)}</ThemedText>
          {task.description ? <ThemedText type="small">{task.description}</ThemedText> : null}
          <View style={styles.tabs}>{(['pending', 'completed', 'cancelled'] as const).map((status) => <Pressable key={status} accessibilityRole="button" accessibilityLabel={`Mark ${task.title} ${status}`} accessibilityState={{ disabled: change.isPending || task.status === status, selected: task.status === status }} disabled={change.isPending || task.status === status} onPress={() => change.mutate({ kind: 'tasks', id: task.id, status })} style={[styles.tab, { borderColor: theme.border, minHeight: 44 }, (change.isPending || task.status === status) && styles.disabled]}><ThemedText>{status === 'pending' ? 'Reopen' : status === 'completed' ? 'Complete' : 'Cancel task'}</ThemedText></Pressable>)}</View>
          {change.isPending && change.variables?.kind === 'tasks' && change.variables.id === task.id ? <ActivityIndicator accessibilityLabel="Updating task" /> : null}
        </View>) : null}
        {kind === 'notes' ? (lead.notes_history ?? []).map((note) => <View key={`pin-${note.id}`} style={styles.composerFields}>
          <ThemedText>{note.content}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">{note.created_by} · {shortActivityDate(note.created_at)}</ThemedText>
          <Pressable accessibilityRole="button" accessibilityLabel={`${note.pinned ? 'Unpin' : 'Pin'} note: ${note.content}`} disabled={change.isPending} onPress={() => change.mutate({ kind: 'notes', id: note.id, pinned: !note.pinned })} style={{ minHeight: 44, justifyContent: 'center' }}><ThemedText themeColor="primary">{note.pinned ? 'Unpin note' : 'Pin note'}</ThemedText></Pressable>
          {change.isPending && change.variables?.kind === 'notes' && change.variables.id === note.id ? <ActivityIndicator accessibilityLabel="Updating note" /> : null}
        </View>) : null}
        {entries.length ? displayedEntries.map((entry) => <View key={entry.id} style={[styles.entry, { borderTopColor: theme.border }]}><View style={styles.entryCopy}><ThemedText type="smallBold">{entry.title}</ThemedText>{entry.detail ? <ThemedText type="small" themeColor="textSecondary">{entry.detail}</ThemedText> : null}</View><ThemedText type="small" themeColor="textSecondary">{entry.meta}</ThemedText></View>) : kind === 'sms' && Boolean(lead.messages?.length) ? null : <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>No {kind} yet.</ThemedText>}
      </View>
    </View>
  );
}

function ComposerInput(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, style, ...inputProps } = props;
  const theme = useTheme();
  return <View style={styles.field}><ThemedText type="small" themeColor="textSecondary">{label}</ThemedText><TextInput {...inputProps} placeholderTextColor={theme.textSecondary} style={[styles.input, inputProps.multiline && styles.multiline, { color: theme.text, borderColor: theme.border, backgroundColor: theme.background }, style]} /></View>;
}


function activityEntries(lead: MobileLead, kind: ActivityKind): { id: string; title: string; detail: string; meta: string }[] {
  if (kind === 'notes') return (lead.notes_history ?? []).map((item) => ({ id: `n${item.id}`, title: item.content, detail: item.created_by ?? '', meta: shortActivityDate(item.created_at) }));
  if (kind === 'tasks') return (lead.tasks ?? []).map((item) => ({ id: `t${item.id}`, title: item.title, detail: `${item.priority} priority`, meta: `${shortActivityDate(item.due_date)} · ${item.status}` }));
  if (kind === 'showings') return (lead.showings ?? []).map((item) => ({ id: `s${item.id}`, title: item.property || 'Property showing', detail: item.time, meta: `${shortActivityDate(item.showing_date)} · ${item.status}` }));
  if (kind === 'calls') return (lead.calls ?? []).map((item) => ({ id: `c${item.id}`, title: item.outcome || item.status || 'Call', detail: item.notes || '', meta: shortActivityDate(item.called_at) }));
  return (lead.emails ?? []).map((item) => ({ id: `e${item.id}`, title: item.subject, detail: item.recipient, meta: `${shortActivityDate(item.sent_at)} · ${item.status}` }));
}

const styles = StyleSheet.create({
  wrapper: { gap: Spacing.three }, tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two }, tab: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 }, composerFields: { gap: Spacing.two }, field: { gap: Spacing.one }, input: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10, fontSize: 16, textAlignVertical: 'top' }, multiline: { minHeight: 88 }, addButton: { height: 46, borderRadius: 13, backgroundColor: '#5146E5', alignItems: 'center', justifyContent: 'center' }, disabled: { opacity: 0.45 }, white: { color: '#FFFFFF' }, entries: { gap: 0 }, entry: { minHeight: 62, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: Spacing.two }, entryCopy: { flex: 1, gap: 2 }, empty: { textAlign: 'center', paddingVertical: Spacing.three },
});
