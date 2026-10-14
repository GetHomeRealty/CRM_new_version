import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { accountRequest, mailboxInput, preferencesInput, profileInput, type EmailPreferences, type Mailbox, type Profile } from '@/account/account-api';
import { MailboxEditor } from './mailbox-editor';
import { ConnectMailboxSheet } from './connect-mailbox-sheet';
import { SecuritySettingsSheet } from './security-settings-sheet';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';

export function AccountSettingsSheet({ onClose }: { onClose: () => void }) {
  const { token } = useMobileAuth();
  const theme = useTheme();
  const [profile, setProfile] = useState<Profile>();
  const [prefs, setPrefs] = useState<EmailPreferences>();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [profileDirty, setProfileDirty] = useState(false);
  const [preferencesDirty, setPreferencesDirty] = useState(false);
  const dirty = profileDirty || preferencesDirty;
  const [editing, setEditing] = useState<Mailbox>();
  const [connecting, setConnecting] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef(true), pending = useRef<AbortController | null>(null);
  const currentToken = useRef(token);
  useLayoutEffect(() => { currentToken.current = token; return () => { currentToken.current = null; }; }, [token]);
  const load = async (signal: AbortSignal) => {
    const [p, s, m] = await Promise.all([
      accountRequest<Profile>(token!, 'profile', 'GET', undefined, signal),
      accountRequest<{ emailSettings: EmailPreferences }>(token!, 'settings', 'GET', undefined, signal),
      accountRequest<Mailbox[]>(token!, 'mail-accounts', 'GET', undefined, signal),
    ]);
    if (!p || typeof p.name !== 'string' || !s?.emailSettings || !Array.isArray(m)) throw new Error('Invalid account response.');
    if (active.current && currentToken.current === token && !signal.aborted) { setProfile(p); setPrefs(s.emailSettings); setMailboxes(m); setProfileDirty(false); setPreferencesDirty(false); }
  };
  const run = async (work: (signal: AbortSignal) => Promise<void>, success = '') => {
    if (!token || token !== currentToken.current || pending.current || !active.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setMessage('');
    const timer = setTimeout(() => controller.abort(), 30000);
    try { await work(controller.signal); if (active.current && !controller.signal.aborted) setMessage(success); }
    catch (error) { if (active.current) setMessage(error instanceof Error ? error.message : 'Could not confirm the change. Reload settings.'); }
    finally { clearTimeout(timer); pending.current = null; if (active.current) setBusy(false); }
  };
  // Mount starts the initial request; subsequent requests are explicit user actions.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { active.current = true; void run(load); return () => { active.current = false; pending.current?.abort(); }; }, [token]);
  const close = () => { if (pending.current) return; if (dirty || editing) Alert.alert('Discard unsaved changes?', 'Your edits may not have been saved.', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: onClose }]); else onClose(); };
  const mailboxAction = (title: string, detail: string, work: (signal: AbortSignal) => Promise<void>) => Alert.alert(title, detail, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: () => { void run(async signal => { await work(signal); const accounts = await accountRequest<Mailbox[]>(token!, 'mail-accounts', 'GET', undefined, signal); if (!Array.isArray(accounts)) throw new Error('Reload mailbox status.'); if (active.current && !signal.aborted) { setMailboxes(accounts); setEditing(undefined); } }, 'Mailbox action completed.'); } }]);
  // This renderer stores callbacks on Pressable; it never invokes them during render.
  /* eslint-disable react-hooks/refs */
  const button = (title: string, action: () => void) => <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} onPress={action} style={{ minHeight: 44, padding: 12, opacity: busy ? 0.5 : 1 }}><ThemedText type="smallBold">{title}</ThemedText></Pressable>;
  const field = (label: string, value: string, change: (value: string) => void, multiline = false, section: 'profile' | 'preferences' = 'preferences') => <View style={{ gap: 6 }}><ThemedText>{label}</ThemedText><TextInput accessibilityLabel={label} editable={!busy} value={value ?? ''} multiline={multiline} autoCapitalize="none" onChangeText={v => { if (section === 'profile') setProfileDirty(true); else setPreferencesDirty(true); change(v); }} style={{ color: theme.text, borderColor: theme.textSecondary, borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 44 }} /></View>;
  const toggle = (label: string, value: boolean, change: (v: boolean) => void) => <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><ThemedText>{label}</ThemedText><Switch accessibilityLabel={label} disabled={busy} value={value} onValueChange={v => { setPreferencesDirty(true); change(v); }} /></View>;
  return <Modal visible animationType="slide" onRequestClose={close}><SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ThemedText type="smallBold">My account settings</ThemedText>{button('Close settings', close)}
    <ThemedText>Changes apply to your own hub account, not brokerage-wide settings.</ThemedText>
    {button('Account security', () => setSecurityOpen(true))}
    {securityOpen && token ? <SecuritySettingsSheet key={token} onClose={() => setSecurityOpen(false)} /> : null}
    {busy ? <ActivityIndicator /> : null}{message ? <ThemedText accessibilityLiveRegion="polite">{message}</ThemedText> : null}
    {button('Reload settings', () => { const reload = () => { setProfile(undefined); setPrefs(undefined); setMailboxes([]); void run(load); }; if (dirty) Alert.alert('Discard edits and reload?', '', [{ text: 'Cancel', style: 'cancel' }, { text: 'Reload', onPress: reload }]); else reload(); })}
    {profile ? <><ThemedText type="smallBold">Profile</ThemedText><ThemedText>{profile.email} · {profile.role} · {profile.status}</ThemedText>
      {field('Name', profile.name, name => setProfile({ ...profile, name }), false, 'profile')}{field('Username', profile.username, username => setProfile({ ...profile, username }), false, 'profile')}{field('Phone', profile.phone, phone => setProfile({ ...profile, phone }), false, 'profile')}
      {button('Save profile', () => { void run(async signal => { const saved = await accountRequest<Profile>(token!, 'profile', 'PUT', profileInput(profile), signal); if (active.current && !signal.aborted && currentToken.current === token) { setProfile(saved); setProfileDirty(false); } }, 'Profile saved.'); })}</> : null}
    {prefs ? <><ThemedText type="smallBold">Personal email preferences</ThemedText>
      {field('Email signature', prefs.signature, signature => setPrefs({ ...prefs, signature }), true)}
      {field('Reply template', prefs.replyTemplate, replyTemplate => setPrefs({ ...prefs, replyTemplate }), true)}
      {toggle('Automatic sync preference', prefs.autoSync, autoSync => setPrefs({ ...prefs, autoSync }))}
      <ThemedText>Automatic sync records your preference; it does not enable a background polling service. Other automatic email behavior depends on server support.</ThemedText>
      {toggle('Automatic responder', prefs.autoResponder.enabled, enabled => setPrefs({ ...prefs, autoResponder: { ...prefs.autoResponder, enabled } }))}
      {field('Automatic response message', prefs.autoResponder.message, message => setPrefs({ ...prefs, autoResponder: { ...prefs.autoResponder, message } }), true)}
      {field('Forwarding email', prefs.forwardingAddress, forwardingAddress => setPrefs({ ...prefs, forwardingAddress }))}
      {button('Save email preferences', () => Alert.alert('Save email preferences?', 'These settings can affect automatic email handling on your account.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Save', onPress: () => { void run(async signal => { await accountRequest(token!, 'settings', 'PUT', { emailSettings: preferencesInput(prefs) }, signal); if (active.current && !signal.aborted && currentToken.current === token) setPreferencesDirty(false); }, 'Email preferences saved.'); } }]))}</> : null}
    <ThemedText type="smallBold">Connected mailboxes</ThemedText><ThemedText>All of your existing hub mailboxes are shown here. No duplicate connection is created.</ThemedText>
    {!editing ? button('Connect a new mailbox', () => setConnecting(true)) : null}
    {connecting && token ? <ConnectMailboxSheet key={token} onClose={() => { setConnecting(false); void run(async signal => { const accounts = await accountRequest<Mailbox[]>(token, 'mail-accounts', 'GET', undefined, signal); if (active.current && Array.isArray(accounts)) setMailboxes(accounts); }); }} /> : null}
    {editing ? <MailboxEditor key={editing.id} mailbox={editing} busy={busy} onCancel={() => setEditing(undefined)} onSave={(draft, password) => { try { const body = mailboxInput(draft, password); mailboxAction('Save mailbox configuration?', 'This can affect email sending and incoming sync for this account across the hub.', async signal => { await accountRequest(token!, `mail-accounts/${draft.id}`, 'PUT', body, signal); }); } catch (error) { setMessage(error instanceof Error ? error.message : 'Invalid mailbox settings.'); } }} /> : null}
    {profile && !mailboxes.length ? <ThemedText>No connected mailboxes.</ThemedText> : null}
    {mailboxes.map(mailbox => <View key={mailbox.id} style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: theme.textSecondary, borderRadius: 12 }}><ThemedText type="smallBold">{mailbox.name}</ThemedText><ThemedText>{mailbox.from_email}</ThemedText><ThemedText>{mailbox.is_active ? 'Active' : 'Inactive'} · {mailbox.is_default ? 'Default sender' : 'Additional sender'} · Incoming sync {mailbox.inbound_enabled ? 'enabled' : 'disabled'}</ThemedText><ThemedText>Last sync: {mailbox.last_synced_at || 'Never'}</ThemedText>{mailbox.sync_error ? <ThemedText>Sync needs attention. Review mailbox configuration.</ThemedText> : null}
      {!editing ? button(`Edit ${mailbox.name}`, () => setEditing(mailbox)) : null}
      {!mailbox.is_default && mailbox.is_active ? button(`Use ${mailbox.name} as default`, () => mailboxAction('Change default sender?', 'This changes the default sending mailbox for your hub account.', async signal => { await accountRequest(token!, `mail-accounts/${mailbox.id}/default`, 'POST', {}, signal); })) : null}
      {mailbox.inbound_enabled && mailbox.is_active ? button(`Sync ${mailbox.name} now`, () => mailboxAction('Sync incoming email?', 'This imports new incoming messages from your connected mailbox.', async signal => { const result = await accountRequest<{ error: string | null }>(token!, `inbox/sync/${mailbox.id}?area=crm`, 'POST', {}, signal); if (result.error) throw new Error('Sync failed. Review your mailbox configuration.'); })) : null}
    </View>)}
  </ScrollView></SafeAreaView></SafeAreaProvider></Modal>;
}
