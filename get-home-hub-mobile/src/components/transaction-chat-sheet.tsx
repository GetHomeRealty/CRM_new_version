import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { fetchMentionCandidates, fetchTransactionMessages, sendTransactionMessage } from '@/transactions/messages-api';
import { ThemedText } from './themed-text';

export function TransactionChatSheet({ transactionId, onClose }: { transactionId: number; onClose: () => void }) {
  const { token } = useMobileAuth();
  const theme = useTheme();
  const client = useQueryClient();
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<number[]>([]);
  const [showPeople, setShowPeople] = useState(false);
  const key = ['transaction-messages', transactionId];
  const messages = useQuery({ queryKey: key, queryFn: ({ signal }) => fetchTransactionMessages(token!, transactionId, signal),
    enabled: Boolean(token), refetchOnWindowFocus: false });
  const people = useQuery({ queryKey: ['transaction-mentions', transactionId],
    queryFn: ({ signal }) => fetchMentionCandidates(token!, transactionId, '', signal), enabled: Boolean(token && showPeople) });
  const send = useMutation({
    mutationFn: (draft: { body: string; mentions: number[] }) => sendTransactionMessage(token!, transactionId, draft.body, draft.mentions),
    onMutate: async () => { await client.cancelQueries({ queryKey: key }); },
    onSuccess: (result, draft) => {
      client.setQueryData(key, result);
      setBody((current) => current === draft.body ? '' : current);
      setMentions([]);
    },
  });
  const close = () => {
    if (send.isPending) return;
    if (!body.trim() && !mentions.length) return onClose();
    Alert.alert('Discard message?', 'Your unsent message will be lost.', [
      { text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  };
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={action} style={styles.button}><ThemedText type="smallBold">{label}</ThemedText></Pressable>;
  return <Modal visible animationType="slide" onRequestClose={close}>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.row}><ThemedText type="subtitle">Team conversation</ThemedText>{button('Back', close, send.isPending)}</View>
        {button('Refresh messages', () => { void messages.refetch(); }, messages.isFetching || send.isPending)}
        {messages.isPending || send.isPending ? <ActivityIndicator color={theme.primary} /> : null}
        {messages.error || send.error ? <ThemedText accessibilityRole="alert" themeColor="danger">{messages.error?.message || send.error?.message}</ThemedText> : null}
        <ScrollView contentContainerStyle={styles.content}>
          {messages.data?.length === 0 ? <ThemedText>No messages yet.</ThemedText> : null}
          {messages.data?.map((message) => <View key={message.id} style={[styles.message, { borderColor: theme.primary }]}>
            <ThemedText type="smallBold">{message.mine ? 'You' : message.author || 'Team member'}</ThemedText>
            <ThemedText selectable>{message.body}</ThemedText>
            {message.at ? <ThemedText type="small">{message.at}</ThemedText> : null}
          </View>)}
        </ScrollView>
        {button(showPeople ? 'Hide mention recipients' : 'Mention people', () => setShowPeople((value) => !value), send.isPending)}
        {showPeople ? <View style={styles.people}>
          <ThemedText type="small">Selected people may receive notifications when you send.</ThemedText>
          {people.isPending ? <ActivityIndicator color={theme.primary} /> : null}
          {people.isError ? button('Retry recipients', () => { void people.refetch(); }) : null}
          <ScrollView>{people.data?.map((person) => <Pressable key={person.id} accessibilityRole="checkbox" accessibilityState={{ checked: mentions.includes(person.id), disabled: send.isPending }} disabled={send.isPending}
            onPress={() => setMentions((current) => current.includes(person.id) ? current.filter((id) => id !== person.id) : current.length < 20 ? [...current, person.id] : current)} style={styles.button}>
            <ThemedText>{mentions.includes(person.id) ? '✓ ' : ''}{person.name}</ThemedText>
          </Pressable>)}</ScrollView>
        </View> : null}
        <TextInput accessibilityLabel="Message" multiline maxLength={5000} editable={!send.isPending} value={body} onChangeText={setBody} placeholder="Write to your transaction team"
          style={[styles.input, { borderColor: theme.primary, color: theme.text }]} />
        <ThemedText type="small">{body.length}/5000 · {mentions.length} mentioned</ThemedText>
        {button('Send message', () => send.mutate({ body, mentions: [...mentions] }), send.isPending || !body.trim() || !messages.data)}
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 }, fill: { flex: 1, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
  button: { minHeight: 44, padding: 12, justifyContent: 'center' }, content: { gap: 12, paddingVertical: 12 },
  message: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 12, gap: 6 },
  input: { borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 70, maxHeight: 150 }, people: { maxHeight: 180 },
});
