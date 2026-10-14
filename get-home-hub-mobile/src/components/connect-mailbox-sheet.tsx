import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Pressable, ScrollView } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { connectMailbox, emptyMailbox, gmailConnectUrl, mailboxConnections, pendingMailbox, type MailboxLimit } from '@/account/mailbox-connect';
import { mailboxInput, type Mailbox } from '@/account/account-api';
import { useTheme } from '@/hooks/use-theme';
import { MailboxEditor } from './mailbox-editor';
import { ThemedText } from './themed-text';

function Button({ title, disabled, onPress }: { title: string; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={{ padding: 12, minHeight: 44, opacity: disabled ? 0.5 : 1 }}><ThemedText type="smallBold">{title}</ThemedText></Pressable>;
}
export function ConnectMailboxSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth(), theme = useTheme();
  const [limit, setLimit] = useState<MailboxLimit>();
  const [accounts, setAccounts] = useState<Mailbox[]>([]);
  const [manual, setManual] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(true);
  const [message, setMessage] = useState('');
  const active = useRef(false), controller = useRef<AbortController | null>(null);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, [token, user?.id]);
  const load = async (signal: AbortSignal) => {
    const data = await mailboxConnections(token!, signal);
    const pending = await pendingMailbox(user!.id!, data.accounts);
    if (active.current && !signal.aborted) { setAccounts(data.accounts); setLimit(data.limit); setUncertain(pending); }
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (!token || !user?.id || !active.current || controller.current) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setMessage('');
    const timer = setTimeout(() => current.abort(), 30000);
    try { await action(current.signal); }
    catch (error) { if (active.current) { setLimit(undefined); setUncertain(true); setMessage(error instanceof Error ? error.message : 'Connection could not be confirmed. Refresh connection status.'); } }
    finally { clearTimeout(timer); controller.current = null; if (active.current) setBusy(false); }
  };
  useEffect(() => {
    // Initial network read is deferred so Strict Mode cleanup cancels the discarded mount.
    const timer = setTimeout(() => { void run(load); }, 0);
    return () => clearTimeout(timer);
  }, [token, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    if (controller.current) return;
    if (manual) Alert.alert('Discard mailbox draft?', 'No connection is created until you confirm Connect mailbox.', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: onClose }]);
    else onClose();
  };
  const canAdd = Boolean(token && user?.id && limit?.canAdd && !uncertain && !busy);
  const save = (draft: Mailbox, password: string) => {
    if (!canAdd) return;
    try { mailboxInput(draft, password); if (!password.trim() || !draft.username?.trim()) throw new Error('Enter the mailbox username and provider app password.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Check your mailbox entries.'); return; }
    Alert.alert('Connect this mailbox?', 'Your credentials will be stored by the Hub server for sending and optional incoming sync. This does not send a test email. The first mailbox may become your default sender.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Connect', onPress: () => { void run(async signal => {
        await connectMailbox(user!.id!, token!, draft, password, signal);
        if (active.current && !signal.aborted) { setManual(false); setMessage('Mailbox saved. Provider sign-in and delivery have not been tested.'); }
        await load(signal);
      }); } },
    ]);
  };
  const gmail = () => Alert.alert('Connect Gmail?', 'Continue in your browser to choose a Google account and review its permissions. Return here and refresh connection status afterward.', [
    { text: 'Cancel', style: 'cancel' }, { text: 'Continue', onPress: () => { void run(async signal => {
      const latest = await mailboxConnections(token!, signal);
      if (!latest.limit.canAdd || await pendingMailbox(user!.id!, latest.accounts)) throw new Error('Review your existing mailbox or pending connection before adding another.');
      const url = await gmailConnectUrl(token!, signal);
      if (!active.current || signal.aborted) return;
      await Linking.openURL(url);
      if (active.current) setMessage('Finish Google authorization in your browser, then return and refresh connection status. Browser opening alone does not confirm connection.');
    }); } },
  ]);
  return <Modal visible animationType="slide" onRequestClose={close}><SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ThemedText type="smallBold">Connect a new mailbox</ThemedText>
    <Button title="Close connection setup" disabled={busy} onPress={close} />
    <ThemedText>One Hub connection is shared by CRM and Transactions. Use Gmail authorization or your provider’s SMTP/IMAP settings. Credentials are not saved on this device.</ThemedText>
    {busy ? <ActivityIndicator /> : null}{message ? <ThemedText accessibilityLiveRegion="polite">{message}</ThemedText> : null}
    <Button title="Refresh connection status" disabled={busy} onPress={() => { void run(load); }} />
    {limit ? <ThemedText>{limit.max === null ? 'Your account has no mailbox limit.' : `${limit.used} of ${limit.max} Hub mailboxes connected.`}</ThemedText> : null}
    {limit && uncertain ? <ThemedText>A previous connection is unconfirmed. Refresh later or ask your administrator to reconcile it. Do not submit it again.</ThemedText> : null}
    {limit && !limit.canAdd ? <ThemedText>Your mailbox limit has been reached. Manage the existing connection before adding another.</ThemedText> : null}
    {accounts.map(account => <ThemedText key={account.id}>Connected: {account.from_email}</ThemedText>)}
    {!manual ? <><Button title="Connect Gmail" disabled={!canAdd} onPress={gmail} /><Button title="Connect with SMTP / IMAP" disabled={!canAdd} onPress={() => setManual(true)} /></> : <MailboxEditor creating mailbox={emptyMailbox} busy={!canAdd} onSave={save} onCancel={() => setManual(false)} />}
  </ScrollView></SafeAreaView></SafeAreaProvider></Modal>;
}
