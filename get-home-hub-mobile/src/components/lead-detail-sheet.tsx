import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { assignmentChange } from '@/leads/lead-assignment';
import { LeadAssignment, LeadProvenance } from './lead-context';
import { LeadActivity } from '@/components/lead-activity';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fetchLead, fetchLeadOptions, fetchLeadTags, updateLead, type LeadUpdate, type LeadOptions, type MobileLead } from '@/leads/leads-api';
import { addLeadTag, matchingLeadTags } from '@/leads/lead-tags';
import { remainingLeadDraft } from '@/leads/lead-draft';
import { preferenceNumbers, serializePreferences, type PropertyPreference } from '@/leads/property-preferences';
import { assertLeadIdentityUpdateAllowed, leadIdentityLocked } from '@/leads/lead-permissions';
import { personalisationFields, serializePersonalisation } from '@/leads/personalisation';
import { serializeDemographics } from '@/leads/demographics';

const CLASSIFICATION_FIELDS: (Exclude<keyof LeadOptions, 'genders' | 'users'>)[] = ['lead_status', 'lead_type', 'lead_source', 'lead_response', 'client_type', 'lead_conversion', 'lead_estimation', 'lead_quality'];

function openContactUrl(url: string, label: string): void {
  Linking.openURL(url).catch(() => Alert.alert(`${label} is unavailable`, `This device cannot open ${label.toLowerCase()} right now.`));
}

function title(value: string): string {
  if (value === 'refferal') return 'Referral';
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function LeadDetailSheet({ leadId, onClose }: { leadId: number | null; onClose: () => void }) {
  const { token, user } = useMobileAuth();
  // Unmount the editor (including drafts and activity) as soon as access is revoked.
  return leadId === null || !token || !canAreaScreen(user, 'crm', 'lead')
    ? null : <LeadDetailEditor key={leadId} leadId={leadId} onClose={onClose} />;
}

function LeadDetailEditor({ leadId, onClose }: { leadId: number; onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const canEdit = canAreaScreen(user, 'crm', 'lead', 'edit');
  const theme = useTheme();
  const queryClient = useQueryClient();
  const scroll = useRef<ScrollView>(null);
  const timelineY = useRef(0);
  const [draft, setDraft] = useState<LeadUpdate>({});
  const [tagInput, setTagInput] = useState('');
  const tags = useQuery({ queryKey: ['lead-tags'], queryFn: ({ signal }) => fetchLeadTags(token!, signal), enabled: Boolean(token && leadId) });
  const options = useQuery({ queryKey: ['lead-options'], queryFn: ({ signal }) => fetchLeadOptions(token!, signal), enabled: Boolean(token && leadId) });
  const leadQuery = useQuery({
    queryKey: ['lead', leadId],
    queryFn: ({ signal }) => fetchLead(token!, leadId!, signal),
    enabled: Boolean(token && leadId),
  });
  const save = useMutation({
    mutationFn: (update: LeadUpdate) => {
      if (!canEdit) throw new Error('You do not have permission to edit leads.');
      assertLeadIdentityUpdateAllowed(leadIdentityLocked(user, leadQuery.data), update);
      assignmentChange(leadQuery.data, update, options.isError || options.isPending ? undefined : options.data?.users);
      return updateLead(token!, leadId!, {
        ...update,
        ...serializeDemographics(update),
        ...serializePersonalisation(update),
        ...('property_preferences' in update ? { property_preferences: serializePreferences(update.property_preferences ?? []) } : {}),
      });
    },
    onSuccess: (lead, submitted) => {
      // PUT returns core fields, while GET includes the activity collections.
      queryClient.setQueryData<MobileLead>(['lead', lead.id], (current) => ({ ...current, ...lead }));
      queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead-tags'] });
      setDraft((current) => remainingLeadDraft(current, submitted));
    },
  });

  // A denied or failed refresh must not leave previously cached contact details visible.
  const lead = leadQuery.isError ? undefined : leadQuery.data;
  const identityLocked = leadIdentityLocked(user, lead);
  const value = <K extends keyof LeadUpdate>(key: K): LeadUpdate[K] =>
    (key in draft ? draft[key] : lead?.[key]) as LeadUpdate[K];
  const set = <K extends keyof LeadUpdate>(key: K, next: LeadUpdate[K]) =>
    canEdit && setDraft((current) => ({ ...current, [key]: next }));
  const reviewSave = () => {
    try {
      const change = assignmentChange(lead, draft, options.isError || options.isPending ? undefined : options.data?.users);
      if (change) Alert.alert('Change lead assignment?', `Assign this lead to ${change.label}? This changes who can access the lead.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm and save', onPress: () => save.mutate(draft) }]);
      else save.mutate(draft);
    } catch (error) { Alert.alert('Could not save assignment', error instanceof Error ? error.message : 'Refresh this lead and retry.'); }
  };
  const close = () => {
    if (save.isPending) return;
    setTagInput('');
    setDraft({});
    save.reset();
    onClose();
  };
  const addTag = (input = tagInput) => {
    if (!canEdit || save.isPending) return;
    try {
      set('tags', addLeadTag(value('tags') ?? [], input));
      setTagInput('');
    } catch (error) {
      Alert.alert('Could not add tag', error instanceof Error ? error.message : 'Please try again.');
    }
  };
  const matchingTags = matchingLeadTags(tags.data ?? [], value('tags') ?? [], tagInput);

  return (
    <Modal animationType="slide" onRequestClose={close} presentationStyle="pageSheet" visible={leadId !== null}>
      <ThemedView style={styles.screen}>
        <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <Pressable accessibilityRole="button" disabled={save.isPending} accessibilityState={{ disabled: save.isPending }} onPress={close}><ThemedText type="smallBold" themeColor="primary">Close</ThemedText></Pressable>
            <ThemedText type="smallBold">Lead details</ThemedText>
            <Pressable accessibilityRole="button" accessibilityLabel="Jump to lead activity" disabled={!lead} onPress={() => scroll.current?.scrollTo({ y: timelineY.current, animated: true })} style={{ minHeight: 44, justifyContent: 'center' }}><ThemedText type="smallBold" themeColor="primary">Activity</ThemedText></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Save lead changes" disabled={!lead || !canEdit || !Object.keys(draft).length || save.isPending} accessibilityState={{ disabled: !lead || !canEdit || !Object.keys(draft).length || save.isPending }} onPress={reviewSave} style={{ minHeight: 44, justifyContent: 'center' }}><ThemedText type="smallBold" themeColor="primary">Save</ThemedText></Pressable>
          </View>
          {leadQuery.isPending ? <View style={styles.center}><ActivityIndicator color={theme.primary} /></View> : null}
          {leadQuery.isError ? (
            <View style={styles.center}>
              <ThemedText type="smallBold" themeColor="danger">Could not open this lead</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">{leadQuery.error.message}</ThemedText>
              <Pressable onPress={() => leadQuery.refetch()} style={styles.primaryButton}><ThemedText type="smallBold" style={styles.white}>Try again</ThemedText></Pressable>
            </View>
          ) : null}
          {lead ? (
            <><ScrollView ref={scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <View style={styles.identity}>
                <View style={styles.avatar}><ThemedText style={styles.avatarText}>{lead.name.slice(0, 1).toUpperCase()}</ThemedText></View>
                <ThemedText style={styles.name}>{lead.name}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">{lead.email}</ThemedText>
              </View>
              <View style={styles.actions}>
                <Action label="Call" disabled={!lead.phone} onPress={() => openContactUrl(`tel:${lead.phone}`, 'Calling')} />
                <Action label="Email" disabled={!lead.email} onPress={() => openContactUrl(`mailto:${lead.email}`, 'Email')} />
              </View>
              <Section title="Contact">
                {identityLocked ? <ThemedText type="small" themeColor="textSecondary">Contact identity and lead source are locked because you do not own this lead. Ask a manager or administrator to change them. Activity and preferences can be updated with edit access.</ThemedText> : null}
                <Field label="Name" editable={canEdit && !save.isPending && !identityLocked} value={String(value('name') ?? '')} onChangeText={(text) => set('name', text)} />
                {(['first_name', 'middle_name', 'last_name'] as const).map(key => <Field key={key} label={title(key.replaceAll('_', ' '))} accessibilityLabel={`Lead ${key.replaceAll('_', ' ')}`} maxLength={128} editable={canEdit && !save.isPending && !identityLocked} value={String(value(key) ?? '')} onChangeText={text => set(key, text.trim() ? text : null)} />)}
                <ThemedText type="small" themeColor="textSecondary">Name above is the displayed contact name. Separate name components are optional; update the displayed name as needed.</ThemedText>
                <Field label="Email" editable={canEdit && !save.isPending && !identityLocked} keyboardType="email-address" value={String(value('email') ?? '')} onChangeText={(text) => set('email', text)} />
                <Field label="Phone" editable={canEdit && !save.isPending && !identityLocked} keyboardType="phone-pad" value={String(value('phone') ?? '')} onChangeText={(text) => set('phone', text)} />
                <Field editable={canEdit && !save.isPending} label="Property summary" accessibilityLabel="Lead property summary" maxLength={255} value={String(value('property') ?? '')} onChangeText={text => set('property', text.trim() ? text : null)} />
                <Field editable={canEdit && !save.isPending} label="Location" value={String(value('location') ?? '')} onChangeText={(text) => set('location', text)} />
                <Field editable={canEdit && !save.isPending} label="Preferred language" accessibilityLabel="Lead preferred language" maxLength={64} placeholder="Enter a language, e.g. Telugu" value={String(value('language') ?? '')} onChangeText={(text) => set('language', text)} />
              </Section>
              <Section title="Property personalisation">
                <ThemedText type="small">Details used by personalised templates. Property preferences below describe what the client is looking for.</ThemedText>
                {personalisationFields.map(({ key, label, maxLength }) => <Field key={key} label={label} accessibilityLabel={`Lead personalisation ${label.toLowerCase()}`} maxLength={maxLength} multiline={key === 'key_features'} editable={canEdit && !save.isPending} value={String(value(key) ?? '')} onChangeText={text => set(key, text.trim() ? text : null)} />)}
              </Section>
              <Section title="Assignment"><LeadAssignment lead={lead} value={value('assigned_to')} choices={options.isError || options.isPending ? undefined : options.data?.users} disabled={!canEdit || identityLocked || save.isPending} onChange={id => set('assigned_to', id)} /></Section>
              <Section title="Intake and subscription"><LeadProvenance lead={lead} /></Section>
              {options.isPending ? <ActivityIndicator accessibilityLabel="Loading lead classifications" color={theme.primary} /> : null}
              <Section title="Demographics">
                <Field editable={canEdit && !save.isPending} label="Age" accessibilityLabel="Lead age" keyboardType="number-pad" value={String(value('age') ?? '')} onChangeText={(text) => set('age', text)} />
                <ThemedText type="small" themeColor="textSecondary">Gender</ThemedText>
                <View style={styles.chips}>
                  {(options.data?.genders ?? []).map((gender) => <Pressable key={gender} accessibilityRole="radio" disabled={!canEdit || save.isPending} accessibilityState={{ selected: value('gender') === gender, disabled: !canEdit || save.isPending }} onPress={() => set('gender', value('gender') === gender ? null : gender)} style={[styles.chip, { borderColor: value('gender') === gender ? theme.primary : theme.border, minHeight: 44 }]}><ThemedText>{title(gender)}</ThemedText></Pressable>)}
                </View>
                {!options.data?.genders?.length ? <ThemedText type="small" themeColor="textSecondary">Gender options unavailable. Existing value: {value('gender') || 'Not set'}.</ThemedText> : null}
                <Field editable={canEdit && !save.isPending} label="Religion" accessibilityLabel="Lead religion" maxLength={64} value={value('religion') ?? ''} onChangeText={(text) => set('religion', text)} />
                {(['date_of_birth', 'marriage_day'] as const).map((key) => <Field editable={canEdit && !save.isPending} key={key} label={key === 'date_of_birth' ? 'Birthday (YYYY-MM-DD)' : 'Marriage anniversary (YYYY-MM-DD)'} accessibilityLabel={key === 'date_of_birth' ? 'Lead birthday' : 'Lead marriage anniversary'} placeholder="YYYY-MM-DD" autoCapitalize="none" value={value(key) ?? ''} onChangeText={(text) => set(key, text)} />)}
                <ThemedText type="small" themeColor="textSecondary">Optional. Clear a field to remove its value when saving.</ThemedText>
              </Section>
              {options.isError ? <Pressable accessibilityRole="button" onPress={() => options.refetch()}><ThemedText themeColor="danger">Could not load classifications. Tap to retry.</ThemedText></Pressable> : null}
              {options.data ? CLASSIFICATION_FIELDS.map((key) => (
                <Section key={key} title={title(key.replace('lead_', ''))}>
                  <View style={styles.chips}>
                    {(options.data[key] ?? []).map((option) => {
                      const selected = value(key) === option;
                      const disabled = !canEdit || save.isPending || (identityLocked && key === 'lead_source');
                      return <Pressable accessibilityRole="radio" disabled={disabled} accessibilityState={{ selected, disabled }} accessibilityLabel={`${title(key.replaceAll('_', ' '))}: ${title(option)}`} key={option} onPress={() => set(key, selected ? null : option)} style={[styles.chip, { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.primarySoft : theme.backgroundElement }, disabled && styles.disabled]}><ThemedText type="smallBold" themeColor={selected ? 'primary' : 'textSecondary'}>{title(option)}</ThemedText></Pressable>;
                    })}
                  </View>
                  {!(options.data[key]?.length) || (value(key) && !options.data[key]?.includes(String(value(key)))) ? <ThemedText type="small">Existing value: {value(key) || 'Not set'}. {!(options.data[key]?.length) ? 'Options unavailable.' : 'This value is no longer in the available options; it is kept unless you choose another value.'}</ThemedText> : null}
                </Section>
              )) : null}
              <Section title="Tags">
                <View style={styles.chips}>
                  {(value('tags') ?? []).map((tag) => <Pressable key={tag} accessibilityRole="button" accessibilityLabel={`Remove tag ${tag}`} disabled={!canEdit || save.isPending} onPress={() => set('tags', (value('tags') ?? []).filter((item) => item !== tag))} style={[styles.chip, { borderColor: theme.border }]}><ThemedText type="smallBold">{tag} ×</ThemedText></Pressable>)}
                </View>
                <Field label="Find or add a tag" accessibilityLabel="Find or add lead tag" value={tagInput} editable={canEdit && !save.isPending} onChangeText={setTagInput} onSubmitEditing={() => addTag()} returnKeyType="done" />
                {tags.isPending ? <ActivityIndicator accessibilityLabel="Loading existing tags" color={theme.primary} /> : null}
                {tags.isError ? <Pressable accessibilityRole="button" onPress={() => tags.refetch()} style={{ minHeight: 44, justifyContent: 'center' }}><ThemedText themeColor="danger">Could not load existing tags. Tap to retry.</ThemedText></Pressable> : null}
                <View style={styles.chips}>
                  {matchingTags.slice(0, 20).map((tag) => <Pressable key={tag} accessibilityRole="button" accessibilityLabel={`Add existing tag ${tag}`} disabled={!canEdit || save.isPending} onPress={() => addTag(tag)} style={[styles.chip, { borderColor: theme.border, minHeight: 44, justifyContent: 'center' }]}><ThemedText type="smallBold">+ {tag}</ThemedText></Pressable>)}
                </View>
                {matchingTags.length > 20 ? <ThemedText type="small" themeColor="textSecondary">Showing 20 of {matchingTags.length} matching tags. Type to narrow the results.</ThemedText> : null}
                {tags.isSuccess && !matchingTags.length ? <ThemedText type="small" themeColor="textSecondary">No unselected matching tags.</ThemedText> : null}
                <Pressable accessibilityRole="button" disabled={!tagInput.trim() || save.isPending} onPress={() => addTag()} style={{ minHeight: 44, justifyContent: 'center' }}><ThemedText themeColor="primary">Add typed tag</ThemedText></Pressable>
                <ThemedText type="small" themeColor="textSecondary">Tag changes are applied with Save changes.</ThemedText>
              </Section>
              <Section title="Notes">
                <Field editable={canEdit && !save.isPending} multiline numberOfLines={4} label="Notes" value={String(value('notes') ?? '')} onChangeText={(text) => set('notes', text)} />
              </Section>
              <Section title="Property preferences">
                <PropertyPreferencesEditor value={value('property_preferences') ?? []} disabled={!canEdit || save.isPending} onChange={(preferences) => set('property_preferences', preferences)} />
              </Section>
              <View onLayout={event => { timelineY.current = event.nativeEvent.layout.y; }}><Section title="Timeline">
                <LeadActivity lead={lead} />
              </Section></View>
              {save.isError ? <ThemedText type="small" themeColor="danger" accessibilityLiveRegion="polite">{save.error.message}</ThemedText> : null}
              {!canEdit ? <ThemedText accessibilityRole="alert">You have view-only access to this lead.</ThemedText> : null}
            </ScrollView>
              <Pressable accessibilityRole="button" disabled={!canEdit || !Object.keys(draft).length || save.isPending} accessibilityState={{ disabled: !canEdit || !Object.keys(draft).length || save.isPending }} onPress={reviewSave} style={[styles.saveButton, (!canEdit || !Object.keys(draft).length || save.isPending) && styles.disabled]}>
                {save.isPending ? <ActivityIndicator color="#FFFFFF" /> : <ThemedText type="smallBold" style={styles.white}>{save.isSuccess && !Object.keys(draft).length ? 'Saved' : 'Save changes'}</ThemedText>}
              </Pressable>
            </>
          ) : null}
        </SafeAreaView>
      </ThemedView>
    </Modal>
  );
}

function Action({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.action, disabled && styles.disabled]}><ThemedText type="smallBold" themeColor="primary">{label}</ThemedText></Pressable>;
}

function PropertyPreferencesEditor({ value, disabled, onChange }: { value: PropertyPreference[]; disabled: boolean; onChange: (value: PropertyPreference[]) => void }) {
  const change = (index: number, patch: Partial<PropertyPreference>) => onChange(value.map((item, i) => i === index ? { ...item, ...patch } : item));
  return <View style={{ gap: Spacing.three }}>
    {!value.length ? <ThemedText type="small" themeColor="textSecondary">No property preferences recorded.</ThemedText> : null}
    {value.map((preference, index) => <View key={index} style={{ gap: Spacing.two }}>
      <ThemedText type="smallBold">Preference {index + 1}</ThemedText>
      {(['min', 'max'] as const).map((key) => <Field key={key} label={`Budget ${key}`} accessibilityLabel={`Preference ${index + 1} budget ${key}`} keyboardType="decimal-pad" editable={!disabled} value={String(preference.budget?.[key] ?? '')} onChangeText={(text) => change(index, { budget: { ...preference.budget, [key]: text } })} />)}
      {preferenceNumbers.map(([key, label]) => <Field key={key} label={label} accessibilityLabel={`Preference ${index + 1} ${label}`} keyboardType="decimal-pad" editable={!disabled} value={String(preference[key] ?? '')} onChangeText={(text) => change(index, { [key]: text })} />)}
      <Field label="Lot size" accessibilityLabel={`Preference ${index + 1} lot size`} editable={!disabled} value={preference.lotSize ?? ''} onChangeText={(lotSize) => change(index, { lotSize })} />
      {(['propertyType', 'locations', 'features'] as const).map((key) => <Field key={key} label={`${key === 'propertyType' ? 'Property types' : title(key)} — one per line`} accessibilityLabel={`Preference ${index + 1} ${key}`} multiline editable={!disabled} value={(preference[key] ?? []).join('\n')} onChangeText={(text) => change(index, { [key]: text.split('\n') })} />)}
      <Pressable accessibilityRole="button" disabled={disabled} style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => onChange(value.filter((_, i) => i !== index))}><ThemedText themeColor="danger">Remove preference {index + 1}</ThemedText></Pressable>
    </View>)}
    <Pressable accessibilityRole="button" disabled={disabled} style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => onChange([...value, {}])}><ThemedText themeColor="primary">Add preference set</ThemedText></Pressable>
    <ThemedText type="small" themeColor="textSecondary">Changes, including removals, apply only when you save the lead.</ThemedText>
  </View>;
}

function Section({ title: heading, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return <View style={[styles.section, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}><ThemedText type="smallBold">{heading}</ThemedText>{children}</View>;
}

function Field(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, style, ...inputProps } = props;
  const theme = useTheme();
  return <View style={styles.field}><ThemedText type="small" themeColor="textSecondary">{label}</ThemedText><TextInput {...inputProps} placeholderTextColor={theme.textSecondary} style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.background }, style]} /></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 }, safe: { flex: 1 }, header: { height: 52, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.three }, headerSpacer: { width: 38 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.three, padding: Spacing.four }, content: { padding: Spacing.three, paddingBottom: Spacing.six, gap: Spacing.three }, identity: { alignItems: 'center', gap: Spacing.one, paddingVertical: Spacing.three }, avatar: { width: 72, height: 72, borderRadius: 24, backgroundColor: '#5146E5', alignItems: 'center', justifyContent: 'center' }, avatarText: { color: '#FFFFFF', fontSize: 30, fontWeight: '800' }, name: { fontSize: 25, lineHeight: 32, fontWeight: '800' }, actions: { flexDirection: 'row', gap: Spacing.two }, action: { flex: 1, height: 46, borderRadius: 14, backgroundColor: '#E9E7FF', alignItems: 'center', justifyContent: 'center' }, section: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.three, gap: Spacing.three }, field: { gap: Spacing.one }, input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 11, fontSize: 16, textAlignVertical: 'top' }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two }, chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 }, primaryButton: { borderRadius: 12, backgroundColor: '#5146E5', paddingHorizontal: Spacing.three, paddingVertical: 10 }, saveButton: { height: 54, borderRadius: 16, backgroundColor: '#5146E5', alignItems: 'center', justifyContent: 'center' }, white: { color: '#FFFFFF' }, disabled: { opacity: 0.45 },
});
