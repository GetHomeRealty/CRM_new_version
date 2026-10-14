import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useMobileAuth } from '@/auth/auth-context';
import { MobileScreen } from '@/components/mobile-screen';
import { RecordList } from '@/components/record-list';
import { TransactionDetailSheet } from '@/components/transaction-detail-sheet';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fetchTransactions } from '@/transactions/transactions-api';

export default function TransactionsScreen() {
  const { token } = useMobileAuth();
  const theme = useTheme();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const request = useMemo(() => ({ search, page }), [search, page]);
  const deferred = useDeferredValue(request);
  const query = useQuery({ queryKey: ['transactions', deferred.search, deferred.page], queryFn: ({ signal }) => fetchTransactions(token!, deferred.search, signal, deferred.page), enabled: Boolean(token) });
  const items = (query.data?.data ?? []).map((transaction) => {
    const status = transaction.statuses?.at(-1) || transaction.valid_status || 'Open';
    return { id: transaction.id, title: transaction.property || transaction.trade_no || `Transaction #${transaction.id}`, detail: [transaction.type, transaction.closing_date ? `Closing ${transaction.closing_date}` : null].filter(Boolean).join(' · '), meta: status, tone: status.toLowerCase().includes('closed') || status.toLowerCase().includes('sold') ? 'success' as const : 'primary' as const };
  });
  return (
    <MobileScreen eyebrow="Transaction Desk" title="Transactions" subtitle="Closings, documents and commissions">
      <View style={[styles.searchBox, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
        <ThemedText themeColor="textSecondary" style={styles.searchIcon}>⌕</ThemedText>
        <TextInput accessibilityLabel="Search transactions" autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" onChangeText={(value) => { setSearch(value); setPage(1); }} placeholder="Search property, trade number, agent…" placeholderTextColor={theme.textSecondary} returnKeyType="search" style={[styles.searchInput, { color: theme.text }]} value={search} />
      </View>
      {query.isPending ? <View style={styles.state}><ActivityIndicator color={theme.primary} /><ThemedText type="small" themeColor="textSecondary">Loading transactions…</ThemedText></View>
        : query.isError ? <View style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}><ThemedText type="smallBold" themeColor="danger">Transactions could not be loaded</ThemedText><ThemedText type="small" themeColor="textSecondary">{query.error.message}</ThemedText><Pressable onPress={() => query.refetch()} style={styles.retry}><ThemedText type="smallBold" style={styles.white}>Try again</ThemedText></Pressable></View>
          : items.length ? <><View style={styles.count}><ThemedText type="small" themeColor="textSecondary">{query.data.meta?.total ?? items.length} transactions</ThemedText><Pressable onPress={() => query.refetch()}><ThemedText type="smallBold" themeColor="primary">Refresh</ThemedText></Pressable></View><RecordList items={items} onPress={(item) => setSelectedId(Number(item.id))} /></>
            : <View style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}><ThemedText type="smallBold">{search ? 'No matching transactions' : 'No transactions yet'}</ThemedText><ThemedText type="small" themeColor="textSecondary">{search ? 'Try a different property, trade number, or agent.' : 'Transactions visible to your CRM account will appear here.'}</ThemedText></View>}
      <TransactionDetailSheet transactionId={selectedId} onClose={() => setSelectedId(null)} />
      {query.data?.meta && items.length > 0 ? <View style={styles.count}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous transactions page" style={styles.pageButton} disabled={page <= 1 || query.isFetching} onPress={() => setPage((value) => Math.max(1, value - 1))}><ThemedText themeColor={page <= 1 ? 'textSecondary' : 'primary'}>Previous</ThemedText></Pressable>
        <ThemedText accessibilityLiveRegion="polite" type="small">Page {query.data.meta.current_page} of {query.data.meta.last_page}</ThemedText>
        <Pressable accessibilityRole="button" accessibilityLabel="Next transactions page" style={styles.pageButton} disabled={page >= query.data.meta.last_page || query.isFetching} onPress={() => setPage((value) => value + 1)}><ThemedText themeColor={page >= query.data.meta.last_page ? 'textSecondary' : 'primary'}>Next</ThemedText></Pressable>
      </View> : null}
      {page > 1 && (query.isError || (!query.isPending && !items.length)) ? <Pressable accessibilityRole="button" style={styles.pageButton} onPress={() => setPage(1)}><ThemedText themeColor="primary">Back to first page</ThemedText></Pressable> : null}
    </MobileScreen>
  );
}

const styles = StyleSheet.create({
  pageButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  searchBox: { height: 52, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.three, gap: Spacing.two }, searchIcon: { fontSize: 24, transform: [{ rotate: '-20deg' }] }, searchInput: { flex: 1, height: '100%', fontSize: 16, fontWeight: '500' }, state: { minHeight: 180, alignItems: 'center', justifyContent: 'center', gap: Spacing.three }, card: { minHeight: 150, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.four, alignItems: 'center', justifyContent: 'center', gap: Spacing.two }, retry: { marginTop: Spacing.two, borderRadius: 12, backgroundColor: '#5146E5', paddingHorizontal: Spacing.three, paddingVertical: 10 }, white: { color: '#FFFFFF' }, count: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: Spacing.one },
});
