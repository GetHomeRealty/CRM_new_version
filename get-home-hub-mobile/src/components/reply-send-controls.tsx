import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { useMobileAuth } from '@/auth/auth-context';
import { environment } from '@/config/environment';
import { acknowledgeAcceptedReply, guardedSubmitReply, readReplyAttempt, recoverReplyAttempt, type ReplyAttempt } from '@/inbox/reply-send-guard';
import type { InboxArea } from '@/inbox/inbox-api';
import type { ReplyAttachment } from '@/inbox/reply-attachments';
import { ThemedText } from './themed-text';

export function ReplySendControls({ area, messageId, recipient, body, attachments, picking, onAccepted, subject = '', serverEnabled = false, recoveryOnly = false, onBusy }: {
  area: InboxArea; messageId: number; recipient: string; body: string; attachments: readonly ReplyAttachment[]; picking: boolean; onAccepted: () => void;
  subject?: string; serverEnabled?: boolean; recoveryOnly?: boolean; onBusy?: (busy: boolean) => void;
}) {
  const { token, user } = useMobileAuth();
  const [attempt, setAttempt] = useState<ReplyAttempt | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let active = true;
    if (user?.id) void readReplyAttempt(user.id).then(value => {
      if (active) { setAttempt(value); setLoaded(true); }
    }).catch(() => { if (active) setError('Could not read the reply safety record. Sending is blocked.'); });
    return () => { active = false; alive.current = false; operation.current?.abort(); };
  }, [user?.id]);
  const run = async (kind: 'send' | 'recover' | 'acknowledge') => {
    if (!alive.current || operation.current || !token || !user?.id) return;
    if (kind === 'send' && (!loaded || attempt || !environment.inboxReplySendingEnabled || !serverEnabled || recoveryOnly || picking)) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); onBusy?.(true); setError('');
    try {
      if (kind === 'send') await guardedSubmitReply(user.id, token, area, messageId, body, attachments, controller.signal, messageId === 0 ? { to: recipient, subject } : undefined);
      else if (kind === 'recover') await recoverReplyAttempt(user.id, token, controller.signal);
      else {
        if (!attempt) return;
        await acknowledgeAcceptedReply(user.id, attempt.key);
        if (!controller.signal.aborted) onAccepted();
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not confirm the reply. Do not send again.');
    } finally {
      // Refresh even after submission failure: the durable pending record must block resend.
      if (!controller.signal.aborted) {
        try { const value = await readReplyAttempt(user.id); if (!controller.signal.aborted) setAttempt(value); }
        catch { if (!controller.signal.aborted) { setLoaded(false); setError('Reply safety record unavailable. Do not send again.'); } }
        if (!controller.signal.aborted) { setBusy(false); onBusy?.(false); }
      }
      operation.current = null;
    }
  };
  const disabled = !loaded || busy || picking || Boolean(attempt) || !body.trim() || !environment.inboxReplySendingEnabled || !serverEnabled || (messageId === 0 && (!recipient.trim() || !subject.trim()));
  return <View style={{ gap: 12 }}>
    {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
    {attempt ? <>
      <ThemedText accessibilityLiveRegion="polite">{attempt.status === 'accepted'
        ? 'The mail server accepted your previous reply. This does not confirm delivery.'
        : 'Your previous reply is pending or uncertain. Do not resend. Recover its status, or ask an administrator to reconcile it.'}</ThemedText>
      <Pressable accessibilityRole="button" disabled={busy || picking} accessibilityState={{ disabled: busy || picking }} style={{ minHeight: 48, padding: 12 }} onPress={() => { void run('recover'); }}><ThemedText>Recover reply status</ThemedText></Pressable>
      {attempt.status === 'accepted' ? <Pressable accessibilityRole="button" disabled={busy || picking} accessibilityState={{ disabled: busy || picking }} style={{ minHeight: 48, padding: 12 }} onPress={() => { void run('acknowledge'); }}><ThemedText>Acknowledge accepted reply and clear draft</ThemedText></Pressable> : null}
    </> : !recoveryOnly ? <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }} style={{ minHeight: 48, padding: 12, opacity: disabled ? 0.45 : 1 }} onPress={() => {
      if (disabled) return;
      Alert.alert(messageId === 0 ? 'Send email?' : 'Send reply?', `Send to ${recipient} with ${attachments.length} attachment(s)? Email cannot be recalled.`, [
        { text: 'Keep editing', style: 'cancel' }, { text: messageId === 0 ? 'Send email' : 'Send reply', onPress: () => { void run('send'); } },
      ]);
    }}><ThemedText>{environment.inboxReplySendingEnabled && serverEnabled ? (busy ? 'Submitting reply…' : messageId === 0 ? 'Send email' : 'Send reply') : 'Sending unavailable'}</ThemedText></Pressable> : null}
  </View>;
}
