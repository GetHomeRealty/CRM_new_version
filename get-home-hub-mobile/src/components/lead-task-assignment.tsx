import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { fetchLeadOptions, type LeadTask } from '@/leads/leads-api';
import { assignLeadTask } from '@/leads/task-assignment-api';
import { ThemedText } from './themed-text';
export function LeadTaskAssignment({ leadId, task }: { leadId: number; task: LeadTask }) {
  const auth = useMobileAuth(), current = useRef(auth), client = useQueryClient();
  useLayoutEffect(() => { current.current = auth; }, [auth]);
  const [controller] = useState(() => new AbortController());
  useEffect(() => () => controller.abort(), [controller]);
  const edit = canAreaScreen(auth.user, 'crm', 'lead', 'edit');
  const options = useQuery({ queryKey: ['lead-options'], queryFn: ({ signal }) => fetchLeadOptions(auth.token!, signal), enabled: Boolean(edit && auth.token) });
  const [search, setSearch] = useState(''), [uncertain, setUncertain] = useState(false);
  const choices = options.isError || options.isPending ? undefined : options.data?.users;
  const mutation = useMutation({ retry: false, mutationFn: async (v: { target: number | null; userId: number; token: string }) => {
    const now = current.current;
    if (uncertain || controller.signal.aborted || !canAreaScreen(now.user, 'crm', 'lead', 'edit') || now.token !== v.token || now.user?.id !== v.userId || !choices) throw new Error('Task assignment access changed. Refresh the lead.');
    await assignLeadTask(v.token, leadId, task.id, v.target, choices, controller.signal);
  }, onSuccess: async () => { setSearch(''); await Promise.all([client.invalidateQueries({ queryKey: ['lead', leadId] }), client.invalidateQueries({ queryKey: ['leads'] }), client.invalidateQueries({ queryKey: ['calendar'] })]); }, onError: () => setUncertain(true) });
  const choose = (target: number | null, name: string) => { const submitted = { target, userId: auth.user!.id!, token: auth.token! }; Alert.alert('Change task assignee?', `Assign “${task.title}” to ${name}?`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm task assignment', onPress: () => mutation.mutate(submitted) }]); };
  if (!canAreaScreen(auth.user, 'crm', 'lead')) return null;
  const disabled = mutation.isPending || uncertain || !choices;
  return <View style={{ gap: 8 }}><ThemedText>Task assignee: {task.assigned_to_name || (task.assigned_to ? `User ${task.assigned_to}` : 'Unassigned')}</ThemedText>{edit ? <><TextInput accessibilityLabel={`Find task ${task.id} assignee`} value={search} onChangeText={setSearch} maxLength={255} editable={!mutation.isPending} placeholder="Search task assignees" style={{ minHeight: 44, padding: 12 }} />
    <Pressable accessibilityRole="button" accessibilityLabel={`Assign task ${task.id} Unassigned`} disabled={disabled || task.assigned_to === null} onPress={() => choose(null, 'Unassigned')} style={{ minHeight: 44, padding: 12 }}><ThemedText>Unassigned</ThemedText></Pressable>
    {(choices || []).filter(u => u.name.toLowerCase().includes(search.toLowerCase())).slice(0, 30).map(u => <Pressable key={u.id} accessibilityRole="button" accessibilityLabel={`Assign task ${task.id} ${u.name}`} disabled={disabled || task.assigned_to === u.id} onPress={() => choose(u.id, u.name)} style={{ minHeight: 44, padding: 12 }}><ThemedText>{u.name}</ThemedText></Pressable>)}
    {options.isError ? <ThemedText>Task assignees unavailable. Reopen the lead to retry.</ThemedText> : null}
    {uncertain ? <Pressable accessibilityRole="button" accessibilityLabel="Refresh task assignment" onPress={() => { void client.refetchQueries({ queryKey: ['lead', leadId] }, { throwOnError: true }).then(() => { setUncertain(false); mutation.reset(); }).catch(() => {}); }} style={{ minHeight: 44, padding: 12 }}><ThemedText>Refresh task assignment</ThemedText></Pressable> : null}
    {mutation.isError ? <ThemedText accessibilityRole="alert">{mutation.error.message}</ThemedText> : null}</> : null}</View>;
}
