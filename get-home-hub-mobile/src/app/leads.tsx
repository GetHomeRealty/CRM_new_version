import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { MobileScreen } from '@/components/mobile-screen';
import { LeadDetailSheet } from '@/components/lead-detail-sheet';
import { CreateLeadSheet } from '@/components/create-lead-sheet';
import { DeletedLeadsSheet } from '@/components/deleted-leads-sheet';
import { LeadImportSheet } from '@/components/lead-import-sheet';
import { LeadBulkSheet } from '@/components/lead-bulk-sheet';
import type { MobileLead } from '@/leads/leads-api';
import { LeadListTools, LeadResultList } from '@/components/lead-list-tools';
import type { LeadDisplayField, LeadFilters } from '@/leads/list-filters';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fetchLeads, fetchLeadOptions } from '@/leads/leads-api';

function statusTone(status: string | null): 'primary' | 'success' | 'warning' {
  const value = status?.toLowerCase() ?? '';
  if (value.includes('active') || value.includes('closed') || value.includes('convert')) return 'success';
  if (value.includes('follow') || value.includes('warm') || value.includes('contact')) return 'warning';
  return 'primary';
}

export default function LeadsScreen() {
  const { token, user } = useMobileAuth();
  const canView = Boolean(token) && canAreaScreen(user, 'crm', 'lead');
  const canEdit = canAreaScreen(user, 'crm', 'lead', 'edit');
  const theme = useTheme();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<LeadFilters>({});
  const [fields, setFields] = useState<LeadDisplayField[]>(['lead_type', 'lead_source']);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [status, setStatus] = useState('');
  const options = useQuery({ queryKey: ['lead-options'], queryFn: ({ signal }) => fetchLeadOptions(token!, signal), enabled: canView });
  const [creating, setCreating] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [importsOpen, setImportsOpen] = useState(false);
  const [bulkLeads, setBulkLeads] = useState<MobileLead[] | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  const request = useMemo(() => ({ search, page, status, filters }), [search, page, status, filters]);
  const deferred = useDeferredValue(request);
  const leadsQuery = useQuery({
    queryKey: ['leads', deferred.search, deferred.page, deferred.status, deferred.filters],
    queryFn: ({ signal }) => fetchLeads(token!, deferred.search, signal, deferred.page, deferred.status, deferred.filters),
    enabled: canView,
  });
  const items = (leadsQuery.data?.data ?? []).map((lead) => ({
    id: lead.id,
    title: lead.name,
    detail: [lead.lead_type, lead.lead_source].filter(Boolean).join(' · ') || lead.email || lead.phone || 'No contact details',
    meta: lead.lead_status || 'Not set',
    tone: statusTone(lead.lead_status),
  }));

  if (!canView) return <MobileScreen eyebrow="CRM" title="Leads" subtitle="Access unavailable">
    <ThemedText accessibilityRole="alert">You do not have access to leads.</ThemedText>
  </MobileScreen>;

  return (
    <MobileScreen
      eyebrow="CRM"
      title="Leads"
      subtitle="Prioritize conversations and follow-ups"
      action={canEdit ? <Pressable accessibilityLabel="Add lead" accessibilityRole="button" onPress={() => setCreating(true)} style={styles.addButton}><ThemedText style={styles.addText}>＋</ThemedText></Pressable> : null}>
      <Pressable accessibilityRole="button" style={styles.pageButton} onPress={() => setDeletedOpen(true)}><ThemedText themeColor="primary">Recently deleted leads</ThemedText></Pressable>
      <Pressable accessibilityRole="button" style={styles.pageButton} onPress={() => setImportsOpen(true)}><ThemedText themeColor="primary">Lead imports</ThemedText></Pressable>
      <View style={[styles.searchBox, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
        <ThemedText themeColor="textSecondary" style={styles.searchIcon}>⌕</ThemedText>
        <TextInput
          accessibilityLabel="Search leads"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onChangeText={(value) => { setSearch(value); setPage(1); }}
          placeholder="Search name, email, phone…"
          placeholderTextColor={theme.textSecondary}
          returnKeyType="search"
          style={[styles.searchInput, { color: theme.text }]}
          value={search}
        />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two }}>
        {['', ...(options.data?.lead_status ?? [])].map((item) => <Pressable key={item} accessibilityRole="radio" accessibilityLabel={`Filter leads: ${item || 'All statuses'}`} accessibilityState={{ selected: status === item }} onPress={() => { setStatus(item); setPage(1); }} style={[styles.pageButton, { borderWidth: 1, borderRadius: 14, borderColor: status === item ? theme.primary : theme.border, backgroundColor: status === item ? theme.primarySoft : theme.backgroundElement }]}><ThemedText>{item || 'All statuses'}</ThemedText></Pressable>)}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Lead filters and displayed fields" style={styles.pageButton} onPress={() => setToolsOpen(true)}><ThemedText themeColor="primary">More filters and displayed fields</ThemedText></Pressable>
      {toolsOpen ? <LeadListTools value={filters} fields={fields} options={!options.isError && !options.isFetching ? options.data : undefined} onApply={(next, columns) => { setFilters(next); setFields(columns); setPage(1); }} onClose={() => setToolsOpen(false)} /> : null}
      {options.isError ? <Pressable accessibilityRole="button" onPress={() => options.refetch()} style={styles.pageButton}><ThemedText themeColor="danger">Could not load filters. Retry</ThemedText></Pressable> : null}
      {leadsQuery.isPending ? (
        <View style={styles.state}><ActivityIndicator color={theme.primary} /><ThemedText type="small" themeColor="textSecondary">Loading your leads…</ThemedText></View>
      ) : leadsQuery.isError ? (
        <View style={[styles.stateCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
          <ThemedText type="smallBold" themeColor="danger">Leads could not be loaded</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">{leadsQuery.error.message}</ThemedText>
          <Pressable accessibilityRole="button" onPress={() => leadsQuery.refetch()} style={styles.retryButton}>
            <ThemedText type="smallBold" style={styles.retryText}>Try again</ThemedText>
          </Pressable>
        </View>
      ) : items.length ? (
        <>
          <View style={styles.resultRow}>
            <ThemedText type="small" themeColor="textSecondary">
              {leadsQuery.data.meta.total} {leadsQuery.data.meta.total === 1 ? 'lead' : 'leads'}
            </ThemedText>
            <Pressable accessibilityRole="button" onPress={() => leadsQuery.refetch()}>
              <ThemedText type="smallBold" themeColor="primary">Refresh</ThemedText>
            </Pressable>
          </View>
          <LeadResultList leads={leadsQuery.data.data} fields={fields} onOpen={setSelectedLeadId} />
          {canEdit ? <Pressable accessibilityRole="button" style={styles.pageButton} onPress={() => setBulkLeads(leadsQuery.data.data.slice(0, 50))}><ThemedText themeColor="primary">Select leads for export or deletion</ThemedText></Pressable> : null}
          <View style={styles.resultRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous leads page" disabled={page <= 1 || leadsQuery.isFetching} onPress={() => setPage((value) => Math.max(1, value - 1))} style={styles.pageButton}>
              <ThemedText themeColor={page <= 1 ? 'textSecondary' : 'primary'}>Previous</ThemedText>
            </Pressable>
            <ThemedText accessibilityLiveRegion="polite" type="small">Page {leadsQuery.data.meta.current_page} of {leadsQuery.data.meta.last_page}</ThemedText>
            <Pressable accessibilityRole="button" accessibilityLabel="Next leads page" disabled={page >= leadsQuery.data.meta.last_page || leadsQuery.isFetching} onPress={() => setPage((value) => value + 1)} style={styles.pageButton}>
              <ThemedText themeColor={page >= leadsQuery.data.meta.last_page ? 'textSecondary' : 'primary'}>Next</ThemedText>
            </Pressable>
          </View>
        </>
      ) : (
        <View style={[styles.stateCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
          <ThemedText type="smallBold">{search || status || Object.values(filters).some(Boolean) ? 'No matching leads' : 'No leads yet'}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {search || status || Object.values(filters).some(Boolean) ? 'Try different search or filters.' : 'New CRM leads will appear here automatically.'}
          </ThemedText>
        </View>
      )}
      {page > 1 && (leadsQuery.isError || (!leadsQuery.isPending && items.length === 0)) ? (
        <Pressable accessibilityRole="button" onPress={() => setPage(1)} style={styles.pageButton}>
          <ThemedText themeColor="primary">Back to first page</ThemedText>
        </Pressable>
      ) : null}
      <LeadDetailSheet leadId={selectedLeadId} onClose={() => setSelectedLeadId(null)} />
      {deletedOpen ? <DeletedLeadsSheet onClose={() => setDeletedOpen(false)} /> : null}
      {importsOpen ? <LeadImportSheet onClose={() => setImportsOpen(false)} /> : null}
      {bulkLeads && canEdit ? <LeadBulkSheet leads={bulkLeads} onClose={() => { setBulkLeads(null); void leadsQuery.refetch(); }} /> : null}
      {creating && canEdit ? <CreateLeadSheet onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelectedLeadId(id); }} /> : null}
    </MobileScreen>
  );
}

const styles = StyleSheet.create({
  pageButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.two },
  addButton: { width: 44, height: 44, borderRadius: 15, backgroundColor: '#5146E5', alignItems: 'center', justifyContent: 'center' },
  addText: { color: '#FFFFFF', fontSize: 25, lineHeight: 28 },
  searchBox: { height: 52, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.three, gap: Spacing.two },
  searchIcon: { fontSize: 24, lineHeight: 28, transform: [{ rotate: '-20deg' }] },
  searchInput: { flex: 1, height: '100%', fontSize: 16, fontWeight: '500' },
  state: { minHeight: 180, alignItems: 'center', justifyContent: 'center', gap: Spacing.three },
  stateCard: { minHeight: 150, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.four, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  retryButton: { marginTop: Spacing.two, borderRadius: 12, backgroundColor: '#5146E5', paddingHorizontal: Spacing.three, paddingVertical: 10 },
  retryText: { color: '#FFFFFF' },
  resultRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.one },
});
