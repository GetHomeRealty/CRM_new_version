import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { fetchProviderSent, fetchProviderSentDetail, type ProviderSentReference } from '@/inbox/provider-sent-api';
import type { InboxArea } from '@/inbox/inbox-api';
import { ThemedText } from './themed-text';
import { useTheme } from '@/hooks/use-theme';
import { MailMessageBody } from './mail-message-body';
export function ProviderSentSheet({ area, onClose }: { area: InboxArea; onClose: () => void }) {
  const { token, user } = useMobileAuth(), theme = useTheme();
  const [pages, setPages] = useState<ProviderSentReference[]>([{}]);
  const [selected, setSelected] = useState<{ uid: number; account: number; validity: string } | null>(null);
  const reference = pages[pages.length - 1];
  const list = useQuery({ queryKey: ['provider-sent', user?.id, area, reference], queryFn: ({ signal }) => fetchProviderSent(token!, area, reference, signal), enabled: Boolean(token && !selected), retry: false });
  const detail = useQuery({ queryKey: ['provider-sent-detail', user?.id, area, selected], queryFn: ({ signal }) => fetchProviderSentDetail(token!, area, selected!.uid, selected!, signal), enabled: Boolean(token && selected), retry: false });
  const data = (!token || list.isError || list.isFetching) ? undefined : list.data, message = (!token || detail.isError || detail.isFetching) ? undefined : detail.data;
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }} onPress={action} style={{ padding: 12, minHeight: 44 }}><ThemedText>{label}</ThemedText></Pressable>;
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ThemedText type="subtitle">Mailbox Sent</ThemedText><ThemedText>Read-only messages from your primary mailbox’s Sent folder. Nothing is sent, deleted or marked read. Sent from Hub remains a separate record of accepted Hub sends.</ThemedText>
    {button('Close mailbox Sent', onClose)}
    {selected ? <>{button('Back to mailbox Sent list', () => setSelected(null))}{button('Refresh Sent message', () => { void detail.refetch(); }, detail.isFetching)}
      {detail.isPending ? <ActivityIndicator /> : null}{detail.isError ? <ThemedText accessibilityRole="alert">{detail.error.message}</ThemedText> : null}
      {message ? <><ThemedText type="smallBold">{message.subject || '(No subject)'}</ThemedText><ThemedText>From: {message.from}</ThemedText><ThemedText>To: {message.to}</ThemedText><ThemedText>{message.sent_at ? new Date(message.sent_at).toLocaleString() : 'Date unavailable'}</ThemedText>
        {message.content_available ? <MailMessageBody key={message.uid} body_text={message.body_text} body_html={message.body_html} /> : <ThemedText>This message is too large to display here. Open it in your mail provider.</ThemedText>}
        {message.truncated ? <ThemedText>This message is shortened. Open your mail provider for the full content.</ThemedText> : null}
        {message.attachments.length ? <ThemedText type="small">Attachments are listed below; open or download them in your mail provider.</ThemedText> : null}
        {message.attachments.map((a, i) => <ThemedText key={i}>{a.filename} · {a.size} bytes</ThemedText>)}</> : null}
    </> : <>{button('Refresh mailbox Sent', () => { if (pages.length > 1) setPages([{}]); else { void list.refetch(); } }, list.isFetching)}
      {list.isPending ? <ActivityIndicator /> : null}{list.isError ? <ThemedText accessibilityRole="alert">{list.error.message}</ThemedText> : null}
      {data && !data.available ? <ThemedText>Your mailbox’s Sent folder is not available here. Use Sent from Hub or your mail provider.</ThemedText> : null}
      {data?.available && !data.data.length ? <ThemedText>No Sent messages on this page.</ThemedText> : null}
      {data?.data.map(row => <Pressable key={row.uid} accessibilityRole="button" accessibilityLabel={`Open Sent: ${row.subject || 'No subject'}`} onPress={() => setSelected({ uid: row.uid, account: data.account_id!, validity: data.validity! })} style={{ borderWidth: 1, borderColor: theme.textSecondary, borderRadius: 10, padding: 12 }}><ThemedText type="smallBold">{row.subject || '(No subject)'}</ThemedText><ThemedText>To: {row.to}</ThemedText></Pressable>)}
      <ThemedText>Page {pages.length}</ThemedText>{button('Previous mailbox Sent page', () => setPages(p => p.slice(0, -1)), pages.length === 1 || list.isFetching)}
      {button('Next mailbox Sent page', () => { if (data?.next_cursor && data.account_id && data.validity) setPages(p => [...p, { cursor: data.next_cursor!, account: data.account_id!, validity: data.validity! }]); }, !data?.next_cursor || list.isFetching)}
    </>}
  </ScrollView></SafeAreaView></SafeAreaProvider></Modal>;
}
