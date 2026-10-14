import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, TextInput, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import type { MobileLead } from '@/leads/leads-api';
import { changeLeadMessage, logLeadMessage, MESSAGE_STATUSES, pickCallRecording, removeCallRecording, shareCallRecording, uploadCallRecording, type CallRecording } from '@/leads/communications-api';
import { ThemedText } from './themed-text';
import { useTheme } from '@/hooks/use-theme';
function useCommunicationAccess() {
  const auth = useMobileAuth(), current = useRef(auth), [controller] = useState(() => new AbortController());
  useLayoutEffect(() => { current.current = auth; }, [auth]);
  useEffect(() => () => controller.abort(), [controller]);
  const allowed = (edit = false) => Boolean(current.current.token && current.current.user?.id && canAreaScreen(current.current.user, 'crm', 'lead', edit ? 'edit' : 'view'));
  return { ...auth, controller, current, allowed, canView: canAreaScreen(auth.user, 'crm', 'lead'), canEdit: canAreaScreen(auth.user, 'crm', 'lead', 'edit') };
}
function Action({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress: () => void }) { return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled }} onPress={onPress} style={{ minHeight: 44, padding: 12 }}><ThemedText themeColor="primary">{label}</ThemedText></Pressable>; }
export function LeadMessages({ lead }: { lead: MobileLead }) {
  const access = useCommunicationAccess(), client = useQueryClient(), theme = useTheme();
  const [body, setBody] = useState(''), [direction, setDirection] = useState<'inbound' | 'outbound'>('inbound'), [status, setStatus] = useState('sent'), [stamp, setStamp] = useState(() => new Date().toISOString()), [uncertain, setUncertain] = useState(false);
  const mutation = useMutation({ retry: false, mutationFn: async (v: { operation: 'log' | 'change'; token: string; userId: number; id?: number; next?: string | null; draft?: { body: string; direction: 'inbound' | 'outbound'; status: string; sent_at: string } }) => {
    if (!access.allowed(true) || v.token !== access.token || v.userId !== access.user?.id || uncertain) throw new Error('Refresh the lead before changing SMS history.');
    if (v.operation === 'log') await logLeadMessage(access.token!, lead.id, v.draft!, access.controller.signal);
    else await changeLeadMessage(access.token!, lead.id, v.id!, v.next ?? null, access.controller.signal);
  }, onSuccess: async (_, v) => { if (v.draft) setBody(current => current === v.draft!.body ? '' : current); await client.invalidateQueries({ queryKey: ['lead', lead.id] }); }, onError: () => setUncertain(true) });
  const confirm = (v: Parameters<typeof mutation.mutate>[0], title: string, copy: string) => Alert.alert(title, copy, [{ text: 'Cancel', style: 'cancel' }, { text: v.next === null ? 'Delete SMS record' : 'Save record', style: v.next === null ? 'destructive' : 'default', onPress: () => mutation.mutate(v) }]);
  const identity = { token: access.token!, userId: access.user?.id ?? -1 };
  if (!access.canView) return null;
  return <View style={{ gap: 12 }}><ThemedText type="smallBold">SMS history</ThemedText><ThemedText>Record past SMS exchanges here. This does not send a text message.</ThemedText>
    {(lead.messages || []).map(m => <View key={m.id} style={{ padding: 12, borderWidth: 1, borderColor: theme.border, borderRadius: 12 }}><ThemedText>{m.direction} · {m.status || 'Received'} · {m.sent_at}</ThemedText><ThemedText>{m.body}</ThemedText>{m.error_message ? <ThemedText>{m.error_message}</ThemedText> : null}{access.canEdit ? <>{m.direction === 'outbound' ? MESSAGE_STATUSES.map(next => <Action key={next} label={`Mark SMS ${m.id} ${next}`} disabled={mutation.isPending || uncertain || m.status === next} onPress={() => confirm({ operation: 'change', ...identity, id: m.id, next }, 'Update recorded SMS status?', 'Only change the history to match what you confirmed in your messaging provider.')} />) : null}<Action label={`Delete SMS record ${m.id}`} disabled={mutation.isPending || uncertain} onPress={() => confirm({ operation: 'change', ...identity, id: m.id, next: null }, 'Delete SMS record?', 'This permanently removes the SMS from lead history. It cannot be undone here.')} /></> : null}</View>)}
    {access.canEdit ? <><TextInput accessibilityLabel="SMS record text" multiline maxLength={2000} value={body} editable={!mutation.isPending} onChangeText={setBody} style={{ minHeight: 88, color: theme.text, padding: 12, borderWidth: 1, borderColor: theme.border, borderRadius: 8 }} /><TextInput accessibilityLabel="SMS recorded time with timezone" value={stamp} editable={!mutation.isPending} onChangeText={setStamp} maxLength={64} style={{ minHeight: 44, color: theme.text, padding: 12, borderWidth: 1, borderColor: theme.border }} />{(['inbound', 'outbound'] as const).map(v => <Action key={v} label={`Record ${v} SMS`} disabled={mutation.isPending} onPress={() => setDirection(v)} />)}<ThemedText>Direction: {direction} · Status: {direction === 'inbound' ? 'Received' : status}</ThemedText>{direction === 'outbound' ? MESSAGE_STATUSES.map(v => <Action key={v} label={`Recorded SMS status ${v}`} disabled={mutation.isPending} onPress={() => setStatus(v)} />) : null}<Action label="Review SMS history entry" disabled={!body.trim() || mutation.isPending || uncertain} onPress={() => confirm({ operation: 'log', ...identity, draft: { body, direction, status, sent_at: stamp } }, 'Record this past SMS?', 'This adds a history entry only; no text message will be delivered.')} /></> : null}
    {mutation.isPending ? <ActivityIndicator /> : null}{mutation.isError ? <ThemedText accessibilityRole="alert">{mutation.error.message}</ThemedText> : null}{uncertain ? <Action label="Refresh SMS history" disabled={mutation.isPending} onPress={() => { void client.refetchQueries({ queryKey: ['lead', lead.id] }, { throwOnError: true }).then(() => { if (access.allowed()) { setUncertain(false); mutation.reset(); } }).catch(() => {}); }} /> : null}
  </View>;
}
export function LeadRecordings({ lead }: { lead: MobileLead }) {
  const access = useCommunicationAccess(), client = useQueryClient();
  const mutation = useMutation({ retry: false, mutationFn: async (v: { action: 'upload' | 'remove' | 'share'; id: number; token: string; userId: number; metadata?: CallRecording }) => {
    const allowed = () => access.allowed(v.action !== 'share') && access.current.current.token === v.token && access.current.current.user?.id === v.userId;
    if (!allowed()) throw new Error('Recording access changed.');
    if (v.action === 'share') return shareCallRecording(v.token, lead.id, v.id, v.metadata!, access.controller.signal, allowed);
    if (v.action === 'remove') await removeCallRecording(v.token, lead.id, v.id, access.controller.signal);
    else { const file = await pickCallRecording(access.controller.signal); if (!file) return; if (!allowed()) throw new Error('Recording access changed while selecting a file.');
      const approved = await new Promise<boolean>(resolve => Alert.alert('Attach this recording?', `${file.filename} · ${file.size} bytes. This replaces any recording attached to this call.`, [{ text: 'Cancel', style: 'cancel', onPress: () => resolve(false) }, { text: 'Upload recording', onPress: () => resolve(true) }], { onDismiss: () => resolve(false) }));
      if (!approved) return; if (!allowed()) throw new Error('Recording access changed before upload.'); await uploadCallRecording(v.token, lead.id, v.id, file, access.controller.signal);
    }
    await client.invalidateQueries({ queryKey: ['lead', lead.id] });
  } });
  const identity = { token: access.token!, userId: access.user?.id ?? -1 };
  if (!access.canView || !lead.calls?.length) return null;
  return <View style={{ gap: 12 }}><ThemedText type="smallBold">Call recordings</ThemedText><ThemedText>Attach an existing audio file up to 5 MB. Stored audio up to 8 MB can be opened with your device’s share sheet.</ThemedText>{lead.calls.map(c => <View key={c.id}><ThemedText>{c.outcome || 'Call'} · {c.called_at}</ThemedText>{c.recording ? <><ThemedText>{c.recording.filename} · {c.recording.size} bytes</ThemedText><Action label={`Open recording ${c.id}`} disabled={mutation.isPending} onPress={() => mutation.mutate({ ...identity, action: 'share', id: c.id, metadata: c.recording! })} />{access.canEdit ? <Action label={`Remove recording ${c.id}`} disabled={mutation.isPending} onPress={() => { const submitted = { ...identity, action: 'remove' as const, id: c.id }; Alert.alert('Remove call recording?', 'This permanently removes the audio. It cannot be restored here.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove recording', style: 'destructive', onPress: () => mutation.mutate(submitted) }]); }} /> : null}</> : null}{access.canEdit ? <Action label={`Attach recording ${c.id}`} disabled={mutation.isPending} onPress={() => mutation.mutate({ ...identity, action: 'upload', id: c.id })} /> : null}</View>)}{mutation.isPending ? <ActivityIndicator /> : null}{mutation.isError ? <ThemedText accessibilityRole="alert">{mutation.error.message}</ThemedText> : null}</View>;
}
