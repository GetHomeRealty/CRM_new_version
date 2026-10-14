import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Modal, Pressable, ScrollView } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { sentDetail, sentPage } from '@/inbox/mail-archive-api';
import type { InboxArea } from '@/inbox/inbox-api';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';
import { MailAttachments } from './mail-attachments';
export function SentMailSheet({ area, onClose }: { area: InboxArea; onClose: () => void }) {
  const { token, user } = useMobileAuth(), theme = useTheme();
  const [page, setPage] = useState(1), [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['sent-mail', user?.id, area, page], queryFn: ({ signal }) => sentPage(token!, area, page, signal), enabled: Boolean(token) && !selected, retry: false });
  const detail = useQuery({ queryKey: ['sent-detail', user?.id, area, selected], queryFn: ({ signal }) => sentDetail(token!, area, selected!, signal), enabled: Boolean(token && selected), retry: false, gcTime: 0 });
  const data = list.isError ? undefined : list.data, message = detail.isError ? undefined : detail.data;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ThemedText type="subtitle">Sent from Hub</ThemedText>
    <ThemedText>Replies and new emails accepted through the Hub inbox. This is not your provider’s entire Sent folder and does not include campaign emails. Acceptance is not proof of delivery.</ThemedText>
    <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 12 }}><ThemedText>Close sent mail</ThemedText></Pressable>
    {selected ? <><Pressable accessibilityRole="button" onPress={() => setSelected(null)} style={{ padding: 12 }}><ThemedText>Back to sent list</ThemedText></Pressable>
      {detail.isPending ? <ActivityIndicator /> : null}{detail.isError ? <ThemedText>{detail.error.message}</ThemedText> : null}
      <Pressable accessibilityRole="button" onPress={() => { void detail.refetch(); }} style={{ padding: 12 }}><ThemedText>Refresh message</ThemedText></Pressable>
      {message ? <><ThemedText type="smallBold">{message.subject || 'Older message'}</ThemedText><ThemedText>To: {message.to_email || 'Not archived'}</ThemedText><ThemedText>{new Date(message.sent_at).toLocaleString()}</ThemedText>
        <ThemedText selectable>{message.content_available ? message.body_text : 'Content was not archived for this older submission.'}</ThemedText>
        <MailAttachments key={selected} area={area} kind="sent" id={selected} attachments={message.attachments} /></> : null}
    </> : <>{list.isPending ? <ActivityIndicator /> : null}{list.isError ? <ThemedText>{list.error.message}</ThemedText> : null}
      <Pressable accessibilityRole="button" onPress={() => { void list.refetch(); }} style={{ padding: 12 }}><ThemedText>Refresh sent mail</ThemedText></Pressable>
      {data?.data.length === 0 ? <ThemedText>No accepted Hub emails on this page.</ThemedText> : null}
      {data?.data.map(row => <Pressable key={row.id} accessibilityRole="button" onPress={() => setSelected(row.id)} style={{ padding: 12, borderWidth: 1, borderColor: theme.textSecondary, borderRadius: 10 }}><ThemedText>{row.subject || 'Older message — content unavailable'}</ThemedText><ThemedText>To: {row.to_email || 'Not archived'}</ThemedText><ThemedText>{new Date(row.sent_at).toLocaleString()}</ThemedText></Pressable>)}
      <ThemedText>Page {page}</ThemedText><Pressable accessibilityRole="button" disabled={page === 1 || list.isFetching} onPress={() => setPage(page - 1)} style={{ padding: 12 }}><ThemedText>Previous sent page</ThemedText></Pressable>
      <Pressable accessibilityRole="button" disabled={!data?.has_more || list.isFetching} onPress={() => setPage(page + 1)} style={{ padding: 12 }}><ThemedText>Next sent page</ThemedText></Pressable>
    </>}
  </ScrollView></SafeAreaView></SafeAreaProvider></Modal>;
}
