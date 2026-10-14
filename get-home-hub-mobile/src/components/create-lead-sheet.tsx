import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { createLead } from '@/leads/leads-api';

export function CreateLeadSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { token, user } = useMobileAuth();
  const canEdit = canAreaScreen(user, 'crm', 'lead', 'edit');
  const theme = useTheme();
  const cache = useQueryClient();
  const [draft, setDraft] = useState({ name: '', email: '', phone: '', location: '', notes: '' });
  const mutation = useMutation({
    mutationFn: () => {
      if (!canEdit) throw new Error('You do not have permission to create leads.');
      return createLead(token!, draft);
    },
    onSuccess: (lead) => {
      void cache.invalidateQueries({ queryKey: ['leads'] });
      void cache.invalidateQueries({ queryKey: ['hub-dashboard'] });
      onCreated(lead.id);
    },
  });
  const canSave = Boolean(canEdit && draft.name.trim() && draft.phone.trim() && token && !mutation.isPending);
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!mutation.isPending) onClose(); }}>
    <ThemedView style={styles.screen}><SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" disabled={mutation.isPending} onPress={onClose} style={styles.button}><ThemedText>Cancel</ThemedText></Pressable>
        <ThemedText type="smallBold">New lead</ThemedText>
        <Pressable accessibilityRole="button" accessibilityLabel="Save new lead" accessibilityState={{ disabled: !canSave, busy: mutation.isPending }} disabled={!canSave} onPress={() => mutation.mutate()} style={styles.button}>
          {mutation.isPending ? <ActivityIndicator color={theme.primary} /> : <ThemedText themeColor={canSave ? 'primary' : 'textSecondary'}>Save</ThemedText>}
        </Pressable>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
        <ThemedText type="small" themeColor="textSecondary">Name and phone are required. Email is optional. You can add classification and activity details after saving.</ThemedText>
        {(['name', 'email', 'phone', 'location', 'notes'] as const).map((field) => <View key={field} style={styles.field}>
          <ThemedText type="smallBold">{field[0].toUpperCase() + field.slice(1)}{field === 'name' || field === 'phone' ? ' *' : ''}</ThemedText>
          <TextInput accessibilityLabel={`New lead ${field}`} editable={canEdit && !mutation.isPending} value={draft[field]} onChangeText={(value) => setDraft((current) => ({ ...current, [field]: value }))}
            autoCapitalize={field === 'email' ? 'none' : 'sentences'} autoCorrect={field !== 'email'} keyboardType={field === 'email' ? 'email-address' : field === 'phone' ? 'phone-pad' : 'default'}
            multiline={field === 'notes'} maxLength={field === 'name' || field === 'email' ? 255 : field === 'phone' ? 64 : undefined}
            style={[styles.input, { color: theme.text, borderColor: theme.border }, field === 'notes' && styles.notes]} />
        </View>)}
        {mutation.error ? <ThemedText accessibilityRole="alert" themeColor="danger">{mutation.error.message}</ThemedText> : null}
      </ScrollView>
    </SafeAreaView></ThemedView>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16 },
  button: { minHeight: 48, minWidth: 60, justifyContent: 'center', alignItems: 'center' },
  form: { padding: 20, gap: 18, paddingBottom: 48 }, field: { gap: 8 },
  input: { borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 48, fontSize: 16 }, notes: { minHeight: 100, textAlignVertical: 'top' },
});
