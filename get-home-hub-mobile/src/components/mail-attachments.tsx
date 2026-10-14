import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { useMobileAuth } from '@/auth/auth-context';
import type { InboxArea } from '@/inbox/inbox-api';
import { validAttachments, type ArchiveAttachments } from '@/inbox/mail-archive-api';
import { shareArchivedAttachment } from '@/inbox/archive-download';
import { ThemedText } from './themed-text';
export function MailAttachments({ area, kind, id, attachments }: { area: InboxArea; kind: 'sent' | 'inbound'; id: string | number; attachments?: ArchiveAttachments }) {
  const { token } = useMobileAuth();
  if (attachments && !validAttachments(attachments)) attachments = undefined;
  const pending = useRef<AbortController | null>(null), active = useRef(true);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { active.current = true; return () => { active.current = false; pending.current?.abort(); }; }, []);
  const download = (index: number) => {
    if (!token || pending.current || !active.current) return;
    Alert.alert('Open or save this attachment?', 'Attachments can be unsafe. Only open files from senders you trust. Choose a destination in the system share sheet; nothing is shared automatically.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Continue', onPress: () => { void (async () => {
      if (!active.current || pending.current) return;
      const controller = new AbortController(); pending.current = controller; setBusy(true); setMessage('');
      const timer = setTimeout(() => controller.abort(), 60000);
      try { await shareArchivedAttachment(token, area, kind, id, index, controller.signal); if (active.current) setMessage(controller.signal.aborted ? 'Download cancelled or timed out.' : 'Share sheet closed. A file is saved only if you selected a destination.'); }
      catch { if (active.current) setMessage('Attachment could not be opened. Please retry.'); }
      finally { clearTimeout(timer); pending.current = null; if (active.current) setBusy(false); }
    })(); } }]);
  };
  return <View style={{ gap: 10 }}><ThemedText type="smallBold">Attachments</ThemedText>
    {!attachments?.available ? <ThemedText>Attachment data was not archived for this message. Check your email provider.</ThemedText> : null}
    {attachments?.available && !attachments.total ? <ThemedText>No attachments.</ThemedText> : null}
    {attachments?.files.map(file => <View key={file.id}><ThemedText>{file.name} · {Math.ceil(file.size / 1024)} KB</ThemedText>
      {file.available ? <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} onPress={() => download(file.id)} style={{ padding: 12, minHeight: 44 }}><ThemedText>{busy ? 'Opening…' : `Open or save ${file.name}`}</ThemedText></Pressable> : <ThemedText>{file.reason || 'Unavailable'}</ThemedText>}</View>)}
    {attachments && attachments.total > attachments.files.length ? <ThemedText>Additional attachments are available only from your email provider.</ThemedText> : null}
    {message ? <ThemedText accessibilityLiveRegion="polite">{message}</ThemedText> : null}
  </View>;
}
