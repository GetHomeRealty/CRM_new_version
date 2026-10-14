import { useState } from 'react';
import { Pressable, Switch, TextInput, View } from 'react-native';
import type { Mailbox } from '@/account/account-api';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';

export function MailboxEditor({ mailbox, busy, onSave, onCancel, creating = false }: { mailbox: Mailbox; busy: boolean; onSave: (draft: Mailbox, password: string) => void; onCancel: () => void; creating?: boolean }) {
  const [draft, setDraft] = useState(mailbox), [password, setPassword] = useState('');
  const theme = useTheme();
  const field = (label: string, value: string, change: (v: string) => void, secure = false) => <View><ThemedText>{label}</ThemedText><TextInput accessibilityLabel={label} value={value} editable={!busy} autoCapitalize="none" autoCorrect={false} secureTextEntry={secure} onChangeText={change} style={{ color: theme.text, borderWidth: 1, borderColor: theme.textSecondary, padding: 12, borderRadius: 8, minHeight: 44 }} /></View>;
  const encryption = (key: 'encryption' | 'imap_encryption') => <View style={{ flexDirection: 'row', gap: 16 }}>{(['tls', 'ssl'] as const).map(value => <Pressable key={value} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: draft[key] === value }} onPress={() => setDraft({ ...draft, [key]: value })} style={{ padding: 12 }}><ThemedText>{draft[key] === value ? '● ' : '○ '}{value.toUpperCase()}</ThemedText></Pressable>)}</View>;
  return <View style={{ gap: 12 }}><ThemedText type="smallBold">Mailbox configuration</ThemedText>
    {field('Mailbox name', draft.name, name => setDraft({ ...draft, name }))}
    {field('Sender email', draft.from_email, from_email => setDraft({ ...draft, from_email }))}
    {field('SMTP host', draft.host, host => setDraft({ ...draft, host }))}
    {field('SMTP port', String(draft.port || ''), port => setDraft({ ...draft, port: Number(port) }))}{encryption('encryption')}
    {field('Mailbox username', draft.username || '', username => setDraft({ ...draft, username }))}
    {field(creating ? 'Provider app password' : 'New mailbox password (blank keeps existing)', password, setPassword, true)}
    <ThemedText>Mailbox active</ThemedText><Switch accessibilityLabel="Mailbox active" disabled={busy} value={draft.is_active} onValueChange={is_active => setDraft({ ...draft, is_active })} />
    <ThemedText>Incoming mail sync enabled</ThemedText><Switch accessibilityLabel="Incoming mail sync enabled" disabled={busy} value={draft.inbound_enabled} onValueChange={inbound_enabled => setDraft({ ...draft, inbound_enabled })} />
    {field('IMAP host', draft.imap_host || '', imap_host => setDraft({ ...draft, imap_host }))}
    {field('IMAP port', draft.imap_port === null ? '' : String(draft.imap_port), value => setDraft({ ...draft, imap_port: value ? Number(value) : null }))}{encryption('imap_encryption')}
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => { onSave(draft, password); setPassword(''); }} style={{ padding: 12 }}><ThemedText>{creating ? 'Connect mailbox' : 'Save mailbox configuration'}</ThemedText></Pressable>
    <Pressable accessibilityRole="button" disabled={busy} onPress={onCancel} style={{ padding: 12 }}><ThemedText>Cancel mailbox edits</ThemedText></Pressable>
  </View>;
}
