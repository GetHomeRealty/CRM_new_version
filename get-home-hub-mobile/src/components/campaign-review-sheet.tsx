import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { fetchCampaignTemplates, previewCampaignAudience, type AudienceFilters, type AudiencePreview, type CampaignTemplate } from '@/campaigns/campaign-preview-api';
import { campaignPayload } from '@/campaigns/campaign-write-api';
import { readCampaignAttempt, verifyConfirmedCampaign, recoverPendingCampaign, acknowledgeConfirmedCampaign, guardedSubmitCampaign, type CampaignAttempt } from '@/campaigns/campaign-send-guard';
import { environment } from '@/config/environment';
import { templateText } from '@/campaigns/template-text';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';

export function CampaignReviewSheet({ template, filters, tag, onClose }: { template: CampaignTemplate; filters: AudienceFilters; tag: string; onClose: () => void }) {
  const { token, user } = useMobileAuth(); const theme = useTheme();
  const canEdit = canAreaScreen(user, 'crm', 'campaigns', 'edit');
  const editAllowed = useRef(canEdit);
  useLayoutEffect(() => { editAllowed.current = canEdit; return () => { editAllowed.current = false; }; }, [canEdit]);
  const [attempt, setAttempt] = useState<CampaignAttempt | null>(null);
  const [safetyError, setSafetyError] = useState('');
  const [safetyReady, setSafetyReady] = useState(false);
  const [submissionMessage, setSubmissionMessage] = useState('');
  const localSending = environment.localCampaignSendTesting && /^http:\/\/(?:localhost|127\.0\.0\.1):8000$/.test(environment.apiUrl);
  const sendingEnabled = canEdit && (localSending || environment.campaignSendingEnabled);
  const [verified, setVerified] = useState<{ id: number; status: string } | null>(null);
  const [name, setName] = useState(''); const [schedule, setSchedule] = useState('');
  const [review, setReview] = useState<{ template: CampaignTemplate; audience: AudiencePreview; schedule?: string; reviewedAt: number } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    let mounted = true;
    readCampaignAttempt(user?.id ?? 0).then(value => { if (mounted) { setAttempt(value); setVerified(null); setSafetyError(''); setSafetyReady(true); } }).catch(() => { if (mounted) { setAttempt(null); setVerified(null); setSafetyError('Could not read campaign safety history. Do not send until this is resolved.'); setSafetyReady(false); } });
    return () => { mounted = false; };
  }, [user?.id]);
  const verifyPrevious = async () => {
    if (!user?.id || !token || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setSafetyError(''); setVerified(null);
    try {
      const campaign = attempt?.state === 'pending'
        ? await recoverPendingCampaign(user.id, token, controller.signal)
        : await verifyConfirmedCampaign(user.id, token, controller.signal);
      if (!controller.signal.aborted) {
        setAttempt(await readCampaignAttempt(user.id));
        setVerified({ id: campaign.id, status: campaign.status });
      }
    } catch (e) { if (!controller.signal.aborted) setSafetyError(e instanceof Error ? e.message : 'Could not verify campaign.'); }
    finally { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  const acknowledge = async () => {
    if (!user?.id || !verified || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true);
    try { await acknowledgeConfirmedCampaign(user.id, verified.id); if (!controller.signal.aborted) { setAttempt(null); setVerified(null); setReview(null); } }
    catch (e) { if (!controller.signal.aborted) setSafetyError(e instanceof Error ? e.message : 'Could not acknowledge campaign.'); }
    finally { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  const close = () => {
    if (pending.current) return;
    if (attempt || submissionMessage) { onClose(); return; }
    if (!name && !schedule) { onClose(); return; }
    Alert.alert('Discard campaign draft?', 'This draft exists only on this screen. Nothing has been sent or scheduled.', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: onClose }]);
  };
  const confirmSend = () => {
    if (!editAllowed.current) return;
    if (!sendingEnabled || !token || !user?.id || !review || !safetyReady || safetyError || attempt || pending.current) return;
    const snapshot = review;
    Alert.alert(localSending ? 'Submit local test campaign?' : 'Submit campaign?', `${snapshot.audience.count} eligible recipients. ${snapshot.schedule ? `Scheduled for ${snapshot.schedule}` : 'Immediate delivery requested'}. ${localSending ? 'Use only isolated test recipients and blocked mail transport.' : 'Sent emails cannot be recalled.'}`, [{ text: 'Keep reviewing', style: 'cancel' }, { text: localSending ? 'Submit local test' : 'Submit campaign', onPress: () => { void (async () => {
      if (!editAllowed.current || pending.current) return;
      if (Date.now() - snapshot.reviewedAt > 60000) { setReview(null); setError('Review expired. Refresh before submitting.'); return; }
      const controller = new AbortController(); pending.current = controller; setBusy(true); setError(''); setReview(null);
      try {
        const result = await guardedSubmitCampaign(user.id!, token, { name, templateId: snapshot.template.id, tag, filters, ...(snapshot.schedule ? { scheduledFor: snapshot.schedule } : {}) }, controller.signal);
        if (!controller.signal.aborted) setSubmissionMessage(`Campaign #${result.id} accepted with status ${result.status}. Acceptance is not proof of delivery.`);
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Outcome unknown. Do not resubmit.'); }
      finally {
        if (!controller.signal.aborted) {
          try { const value = await readCampaignAttempt(user.id!); if (!controller.signal.aborted) setAttempt(value); }
          catch { if (!controller.signal.aborted) { setSafetyReady(false); setSafetyError('Could not read campaign safety history. Do not resend.'); } }
        }
        pending.current = null; if (!controller.signal.aborted) setBusy(false);
      }
    })(); } }]);
  };
  const refreshReview = async () => {
    if (!token || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError(''); setReview(null);
    try {
      const payload = campaignPayload({ name, templateId: template.id, tag, filters, ...(schedule.trim() ? { scheduledFor: schedule.trim() } : {}) });
      const [templates, audience] = await Promise.all([fetchCampaignTemplates(token, controller.signal), previewCampaignAudience(token, tag, controller.signal, filters)]);
      const fresh = templates.find(item => item.id === template.id);
      if (!fresh?.is_active || fresh.content === undefined) throw new Error('This template is inactive or unavailable. Return to templates and refresh.');
      if (fresh.attachment_count && !fresh.attachments) throw new Error('Attachment details are unavailable.');
      if (!audience.count) throw new Error('No eligible recipients match these filters.');
      if (!controller.signal.aborted) setReview({ template: fresh, audience, schedule: payload.scheduled_for, reviewedAt: Date.now() });
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not prepare campaign review.'); }
    finally { if (pending.current === controller) pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  return <Modal visible animationType="slide" onRequestClose={close}><SafeAreaProvider><SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <ThemedText type="subtitle">Review campaign</ThemedText><ThemedText>{localSending ? 'Isolated local send testing enabled. Submission can request delivery through the local API.' : sendingEnabled ? 'Review recipients, content and timing before confirming. Sent emails cannot be recalled.' : 'Local draft only. This screen does not send or schedule emails.'}</ThemedText>
    {submissionMessage ? <ThemedText accessibilityRole="alert">{submissionMessage}</ThemedText> : null}
    {safetyError ? <ThemedText accessibilityRole="alert" themeColor="danger">{safetyError}</ThemedText> : null}
    {attempt ? <>
      <ThemedText>Previous attempt: {attempt.startedAt}. {attempt.state === 'pending' ? 'Outcome unresolved. Check campaign history with your administrator. Do not resend; this screen cannot safely clear an unknown outcome.' : `Campaign #${attempt.campaignId} was confirmed. Verify its current status before acknowledging.`}</ThemedText>
      {attempt.state === 'confirmed' || attempt.requestKey ? <Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={() => { void verifyPrevious(); }}><ThemedText>{attempt.state === 'pending' ? 'Recover submission status' : 'Verify previous campaign'}</ThemedText></Pressable> : null}
      {verified ? <><ThemedText>Verified campaign #{verified.id}: {verified.status}. This is not proof of delivery to every recipient.</ThemedText><Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={() => { void acknowledge(); }}><ThemedText>Acknowledge verified campaign</ThemedText></Pressable></> : null}
    </> : null}
    <ThemedText>Template: {template.name}</ThemedText>
    <TextInput accessibilityLabel="Campaign name" placeholder="Campaign name" maxLength={255} editable={!busy} value={name} onChangeText={value => { setName(value); setReview(null); }} style={[styles.input, { color: theme.text, borderColor: theme.textSecondary }]} />
    <ThemedText>Optional schedule — ISO date/time with timezone, for example 2026-12-01T09:00:00-05:00. Blank means immediate sending would be requested.</ThemedText>
    <TextInput accessibilityLabel="Campaign schedule" autoCapitalize="none" autoCorrect={false} editable={!busy} value={schedule} onChangeText={value => { setSchedule(value); setReview(null); }} style={[styles.input, { color: theme.text, borderColor: theme.textSecondary }]} />
    <ThemedText>Audience: {Object.entries(filters).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'All eligible leads in your permitted scope'}. Tag: {tag.trim() || 'Any'}.</ThemedText>
    <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} style={styles.button} onPress={() => { void refreshReview(); }}><ThemedText>Refresh campaign review</ThemedText></Pressable>
    {busy ? <ActivityIndicator accessibilityLabel="Preparing campaign review" /> : null}
    {error ? <ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText> : null}
    {review ? <>
      <ThemedText type="subtitle">{review.audience.count} eligible recipients</ThemedText><ThemedText>Sample only (up to five), not the complete recipient list. Audience and template can change after this review.</ThemedText>
      {review.audience.sample.map((recipient, index) => <ThemedText key={`${recipient.email}-${index}`}>{recipient.name} — {recipient.email}</ThemedText>)}
      <ThemedText>Timing: {review.schedule || 'Immediately (not submitted)'}</ThemedText><ThemedText>Subject: {review.template.subject}</ThemedText>
      <ThemedText>Approximate text preview; formatting and personalization are not rendered.</ThemedText><ThemedText selectable>{templateText(review.template.content!) || 'No readable text.'}</ThemedText>
      <ThemedText>Attachments: {review.template.attachment_count}</ThemedText>{review.template.attachments?.map(file => <ThemedText key={file.id}>{file.filename} · {file.size} bytes</ThemedText>)}
      {sendingEnabled ? <Pressable accessibilityRole="button" disabled={busy || !safetyReady || Boolean(attempt) || Boolean(safetyError)} style={styles.button} onPress={confirmSend}><ThemedText>{localSending ? 'Confirm local test submission' : 'Confirm campaign submission'}</ThemedText></Pressable> : <ThemedText>Sending is not enabled in this build. A verified server release is required before enabling campaign submission.</ThemedText>}
    </> : null}
    <Pressable accessibilityRole="button" style={styles.button} onPress={close}><ThemedText>Back to campaign tools</ThemedText></Pressable>
  </ScrollView></SafeAreaView></SafeAreaProvider></Modal>;
}
const styles = StyleSheet.create({ container: { flex: 1, padding: 16 }, content: { gap: 16, paddingBottom: 32 }, input: { minHeight: 48, borderWidth: 1, borderRadius: 12, padding: 12 }, button: { minHeight: 48, padding: 12 } });
