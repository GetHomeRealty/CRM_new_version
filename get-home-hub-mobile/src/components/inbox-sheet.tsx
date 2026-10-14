import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { ThemedText } from './themed-text';
import { ReplySendControls } from './reply-send-controls';
import { MailAttachments } from './mail-attachments';
import { ProviderSentSheet } from './provider-sent-sheet';
import { SentMailSheet } from './sent-mail-sheet';
import { useTheme } from '@/hooks/use-theme';
import { pickReplyAttachment, type ReplyAttachment } from '@/inbox/reply-attachments';
import { MailMessageBody } from './mail-message-body';
import { fetchInbox, fetchInboxReplyContext, openInboxMessage, setInboxMessageSeen, type InboxArea, type InboxDetail, type InboxReplyContext } from '@/inbox/inbox-api';

export function InboxSheet({ area, onClose }: { area: InboxArea; onClose: () => void }) {
  const { token } = useMobileAuth();
  const theme = useTheme();
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [sentOpen, setSentOpen] = useState(false);
  const [providerSentOpen, setProviderSentOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const [message, setMessage] = useState<InboxDetail | null>(null);
  const [replyId, setReplyId] = useState<number | null>(null);
  const [reply, setReply] = useState<InboxReplyContext | null>(null);
  const [replyError, setReplyError] = useState('');
  const [body, setBody] = useState('');
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ReplyAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const picker = useRef<AbortController | null>(null);
  useEffect(() => () => { picker.current?.abort(); }, []);
  const chooseAttachment = async () => {
    if (picker.current || sending) return;
    const controller = new AbortController(); picker.current = controller;
    setPicking(true); setAttachmentError('');
    try {
      if (Platform.OS === 'web') throw new Error('Choose attachments in the iOS or Android app.');
      const file = await pickReplyAttachment(attachments, controller.signal);
      if (file && !controller.signal.aborted) setAttachments(previous => [...previous, file]);
    } catch (error) {
      if (!controller.signal.aborted) setAttachmentError(error instanceof Error ? error.message : 'Could not read this attachment.');
    } finally { picker.current = null; if (!controller.signal.aborted) setPicking(false); }
  };
  useEffect(() => {
    if (replyId === null || !token) return;
    const controller = new AbortController();
    void fetchInboxReplyContext(token, area, replyId, controller.signal).then(value => {
      if (!controller.signal.aborted) setReply(value);
    }).catch(() => {
      if (!controller.signal.aborted) setReplyError('Could not prepare this reply. Return to the message and try again. No email was sent.');
    });
    return () => controller.abort();
  }, [replyId, token, area]);
  const leaveDraft = (action: () => void) => {
    if (picker.current || sending) return;
    if (!body && !attachments.length && !recipient && !subject) { action(); return; }
    Alert.alert('Discard reply draft?', 'Unsaved draft content will be lost. Submitted email cannot be recalled; its status remains available for recovery.', [
      { text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { setBody(''); setAttachments([]); setRecipient(''); setSubject(''); action(); } },
    ]);
  };
  const inbox = useQuery({ queryKey: ['inbox', area, page, unread],
    queryFn: ({ signal }) => fetchInbox(token!, area, { page, unread, signal }), enabled: Boolean(token) });
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['inbox'] });
    void client.invalidateQueries({ queryKey: ['hub-dashboard'] });
  };
  const open = useMutation({ mutationFn: (id: number) => openInboxMessage(token!, area, id),
    onSuccess: (result) => { setMessage(result); invalidate(); } });
  const seen = useMutation({ mutationFn: (item: InboxDetail) => setInboxMessageSeen(token!, area, item.id, !item.seen),
    onSuccess: (result, item) => { setMessage((current) => current?.id === item.id ? { ...current, seen: result.seen } : current); invalidate(); } });
  const busy = open.isPending || seen.isPending;
  const inboxData = inbox.isError ? undefined : inbox.data;
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={action}
      style={[styles.button, { borderColor: theme.primary, opacity: disabled ? 0.45 : 1 }]}>
      <ThemedText type="smallBold">{label}</ThemedText>
    </Pressable>
  );
  return <Modal visible animationType="slide" onRequestClose={() => leaveDraft(onClose)}>
    <SafeAreaProvider>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.row}><ThemedText type="subtitle">{replyId === null ? 'Inbox' : replyId === 0 ? 'New email' : 'Reply draft'}</ThemedText>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: picking || sending }} disabled={picking || sending} onPress={() => leaveDraft(onClose)} style={[styles.button, { borderColor: theme.primary, opacity: picking || sending ? 0.45 : 1 }]}><ThemedText type="smallBold">Close inbox</ThemedText></Pressable>
      </View>
      {busy ? <ActivityIndicator accessibilityLabel="Updating inbox" color={theme.primary} /> : null}
      {open.isError || seen.isError ? <ThemedText accessibilityRole="alert" themeColor="danger">{open.error?.message || seen.error?.message}</ThemedText> : null}
      {replyId !== null ? <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: picking || sending }} disabled={picking || sending} onPress={() => leaveDraft(() => setReplyId(null))} style={[styles.button, { borderColor: theme.primary, opacity: picking || sending ? 0.45 : 1 }]}><ThemedText type="smallBold">{replyId === 0 ? 'Back to inbox' : 'Back to message'}</ThemedText></Pressable>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {!reply && !replyError ? <ActivityIndicator accessibilityLabel="Preparing reply" color={theme.primary} /> : null}
          {replyError ? <ThemedText accessibilityRole="alert" themeColor="danger">{replyError}</ThemedText> : null}
          {reply ? <>
            <ThemedText selectable>From: {reply.from}</ThemedText>
            {replyId === 0 ? <>
              <ThemedText type="smallBold">To</ThemedText>
              <TextInput accessibilityLabel="Email recipient" autoCapitalize="none" keyboardType="email-address" editable={!sending} value={recipient} onChangeText={setRecipient} maxLength={254} style={[styles.draftField, { color: theme.text, borderColor: theme.primary }]} />
              <ThemedText type="smallBold">Subject</ThemedText>
              <TextInput accessibilityLabel="Email subject" editable={!sending} value={subject} onChangeText={setSubject} maxLength={255} style={[styles.draftField, { color: theme.text, borderColor: theme.primary }]} />
            </> : <><ThemedText selectable>To: {reply.to}</ThemedText>
            <ThemedText type="small">{reply.recipient_source === 'reply-to' ? 'Using the Reply-To address supplied by this message.' : 'Replying to the sender.'}</ThemedText>
            <ThemedText type="smallBold">Subject: {reply.subject}</ThemedText></>}
            <ThemedText type="smallBold">Message</ThemedText>
            <TextInput accessibilityLabel="Reply message" editable={!sending} multiline maxLength={20000} value={body} onChangeText={setBody}
              style={[styles.draft, { color: theme.text, borderColor: theme.primary }]} textAlignVertical="top" />
            <ThemedText type="smallBold">Attachments ({attachments.length}/5)</ThemedText>
            <ThemedText type="small">Maximum 5 MB total. Selected files stay in this draft; nothing is uploaded.</ThemedText>
            {attachments.map((file, index) => <View key={index} style={styles.message}>
              <ThemedText>{file.filename} · {Math.ceil(file.size / 1024)} KB</ThemedText>
              {button(`Remove ${file.filename}`, () => setAttachments(previous => previous.filter((_, i) => i !== index)), picking || sending)}
            </View>)}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: picking || sending || attachments.length >= 5 }} disabled={picking || sending || attachments.length >= 5} onPress={() => { void chooseAttachment(); }} style={[styles.button, { borderColor: theme.primary, opacity: picking || sending || attachments.length >= 5 ? 0.45 : 1 }]}><ThemedText type="smallBold">{picking ? 'Reading attachment…' : 'Add attachment'}</ThemedText></Pressable>
            {attachmentError ? <ThemedText accessibilityRole="alert" themeColor="danger">{attachmentError}</ThemedText> : null}
            <ThemedText type="small">Draft text and attachments are not saved when closed. Submitted reply status is retained for recovery.</ThemedText>
            <ReplySendControls area={area} messageId={replyId} recipient={replyId === 0 ? recipient : reply.to} subject={subject} serverEnabled={reply.sending_enabled} body={body} attachments={attachments} picking={picking} onBusy={setSending}
              onAccepted={() => { setBody(''); setAttachments([]); setRecipient(''); setSubject(''); }} />
          </> : null}
        </ScrollView>
      </KeyboardAvoidingView> : message ? <>
        <View style={styles.row}>
          {button('Back to messages', () => { setMessage(null); seen.reset(); open.reset(); }, busy)}
          {button(message.seen ? 'Mark unread' : 'Mark read', () => seen.mutate(message), busy)}
          {button('Draft reply', () => { setReply(null); setReplyError(''); setBody(''); setAttachments([]); setAttachmentError(''); setReplyId(message.id); }, busy)}
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <ThemedText type="subtitle">{message.subject || '(No subject)'}</ThemedText>
          <ThemedText selectable>{message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email}</ThemedText>
          <ThemedText type="small">To: {message.to_email}</ThemedText>
          <ThemedText type="small">{new Date(message.received_at).toLocaleString()}</ThemedText>
          <MailMessageBody key={message.id} body_text={message.body_text} body_html={message.body_html} />
          <MailAttachments key={message.id} area={area} kind="inbound" id={message.id} attachments={message.attachments} />
        </ScrollView>
      </> : <>
        {button('Sent from Hub', () => setSentOpen(true), busy)}
        {button('Mailbox Sent', () => setProviderSentOpen(true), busy)}
        {providerSentOpen ? <ProviderSentSheet area={area} onClose={() => setProviderSentOpen(false)} /> : null}
        {sentOpen ? <SentMailSheet area={area} onClose={() => setSentOpen(false)} /> : null}
        {button('Compose email', () => { setReply(null); setReplyError(''); setBody(''); setRecipient(''); setSubject(''); setAttachments([]); setAttachmentError(''); setReplyId(0); }, busy)}
        <ReplySendControls area={area} messageId={0} recipient="" body="" attachments={[]} picking={false} recoveryOnly onAccepted={() => {}} />
        <View style={styles.row}>
          {button(unread ? 'Show all messages' : 'Show unread only', () => { setUnread((value) => !value); setPage(1); }, busy)}
          {button('Refresh', () => { void inbox.refetch(); }, inbox.isFetching || busy)}
        </View>
        {inbox.isPending ? <ActivityIndicator color={theme.primary} /> : null}
        {inbox.isError ? <ThemedText accessibilityRole="alert" themeColor="danger">{inbox.error.message}</ThemedText> : null}
        {inboxData ? <ThemedText type="small">{inboxData.mailbox?.address || 'No primary mailbox connected'} · {inboxData.unread} unread</ThemedText> : null}
        <ScrollView contentContainerStyle={styles.content}>
          {inboxData?.data.length === 0 ? <ThemedText>{unread ? 'No unread messages.' : 'No messages on this page.'}</ThemedText> : null}
          {inboxData?.data.map((item) => <Pressable key={item.id} accessibilityRole="button"
            accessibilityLabel={`${item.seen ? 'Read' : 'Unread'}: ${item.subject || 'No subject'}, from ${item.from_name || item.from_email}`}
            disabled={busy} accessibilityState={{ disabled: busy }} onPress={() => { seen.reset(); open.mutate(item.id); }}
            style={[styles.message, { borderColor: theme.primary }]}>
            <ThemedText type="smallBold">{item.seen ? '' : '● '}{item.from_name || item.from_email}</ThemedText>
            <ThemedText>{item.subject || '(No subject)'}</ThemedText>
            <ThemedText type="small" numberOfLines={2}>{item.snippet || ''}</ThemedText>
            <ThemedText type="small">{new Date(item.received_at).toLocaleString()}</ThemedText>
          </Pressable>)}
        </ScrollView>
        <View style={styles.row}>
          {button('Previous', () => setPage((value) => Math.max(1, value - 1)), page === 1 || busy || inbox.isFetching)}
          <ThemedText type="small">Page {page}{inboxData ? ` of ${inboxData.meta.last_page}` : ''}</ThemedText>
          {button('Next', () => setPage((value) => value + 1), !inboxData || page >= inboxData.meta.last_page || busy || inbox.isFetching)}
        </View>
      </>}
    </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  button: { minHeight: 44, padding: 12, borderRadius: 12, borderWidth: 1, justifyContent: 'center' },
  content: { gap: 16, paddingVertical: 12 },
  message: { padding: 16, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 6 },
  draft: { minHeight: 180, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16 },
  draftField: { minHeight: 48, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16 },
});
