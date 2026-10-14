import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import type { LeadAssignee, MobileLead } from '@/leads/leads-api';
import { ThemedText } from './themed-text';
import { useTheme } from '@/hooks/use-theme';
const labels: Record<string, string> = { page_name: 'Page', page_id: 'Page ID', form_name: 'Lead form', form_id: 'Form ID', campaign_name: 'Campaign', campaign_id: 'Campaign ID', adset_name: 'Ad set', adset_id: 'Ad set ID', ad_name: 'Ad', ad_id: 'Ad ID', lead_id: 'Meta lead ID', submitted_at: 'Submitted', imported_at: 'Imported', budget: 'Budget', timeline: 'Timeline', property_type: 'Property type', message: 'Imported message' };
export function LeadAssignment({ lead, value, choices, disabled, onChange }: { lead: MobileLead; value: number | null | undefined; choices?: LeadAssignee[]; disabled: boolean; onChange: (id: number | null) => void }) {
  const theme = useTheme(); const [search, setSearch] = useState('');
  const available = lead.assigned_to !== undefined && choices !== undefined;
  const name = value === undefined ? 'Unavailable' : value === null ? 'Unassigned' : choices?.find(u => u.id === value)?.name || (value === lead.assigned_to ? lead.assigned_to_name : null) || `User ${value}`;
  const matches = choices?.filter(u => u.name.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  return <View style={{ gap: 10 }}><ThemedText type="smallBold">Assigned to: {name}</ThemedText>
    {!available ? <ThemedText>Assignment choices unavailable. The current assignment is kept.</ThemedText> : null}
    {available && !disabled ? <><TextInput accessibilityLabel="Find lead assignee" value={search} onChangeText={setSearch} maxLength={255} placeholder="Search assignment choices" style={{ color: theme.text, borderColor: theme.border, borderWidth: 1, minHeight: 48, padding: 12 }} />
      <Pressable accessibilityRole="radio" accessibilityLabel="Assign lead: Unassigned" accessibilityState={{ selected: value === null }} onPress={() => onChange(null)} style={{ minHeight: 44, padding: 10 }}><ThemedText>Unassigned</ThemedText></Pressable>
      {matches.slice(0, 30).map(u => <Pressable key={u.id} accessibilityRole="radio" accessibilityLabel={`Assign lead: ${u.name}`} accessibilityState={{ selected: value === u.id }} onPress={() => onChange(u.id)} style={{ minHeight: 44, padding: 10 }}><ThemedText>{u.name} · {u.role}</ThemedText></Pressable>)}
      {matches.length > 30 ? <ThemedText>Showing 30 choices. Narrow your search.</ThemedText> : null}
      <ThemedText>Assignment changes apply only after confirmation and Save.</ThemedText></> : null}
  </View>;
}
export function LeadProvenance({ lead }: { lead: MobileLead }) {
  return <View style={{ gap: 10 }}><ThemedText type="smallBold">Email subscription</ThemedText><ThemedText>{lead.unsubscribed === true ? 'Unsubscribed from email' : lead.unsubscribed === false ? 'Not marked unsubscribed. Campaigns may still exclude this lead.' : 'Email subscription status unavailable.'}</ThemedText>
    {lead.source ? <ThemedText>Intake source: {lead.source}</ThemedText> : null}
    {lead.meta ? <><ThemedText type="smallBold">Meta provenance</ThemedText>{Object.entries(labels).map(([key,label]) => { const value = lead.meta?.[key]; return typeof value === 'string' && value ? <ThemedText key={key} selectable>{label}: {value.slice(0, 4000)}</ThemedText> : null; })}</> : null}
  </View>;
}
