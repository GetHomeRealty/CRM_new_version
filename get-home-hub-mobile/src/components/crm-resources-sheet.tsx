import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';
import { changeFavorite, emptyMlsFilters, fetchFavoriteKeys, fetchFavorites, fetchInventory, fetchListing, fetchMls, fetchMlsStatus, mlsQuery, UnconfirmedFavorite, type Listing, type MlsFilters } from '@/crm/resources-api';

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={{ minHeight: 44, padding: 12 }}><ThemedText type="smallBold">{label}</ThemedText></Pressable>;
}
function Field({ label, value, onChange, numeric = false }: { label: string; value: string; onChange: (v: string) => void; numeric?: boolean }) {
  const theme = useTheme();
  return <View><ThemedText type="small">{label}</ThemedText><TextInput accessibilityLabel={label} value={value} onChangeText={onChange} maxLength={255} keyboardType={numeric ? 'decimal-pad' : 'default'} style={{ color: theme.text, borderWidth: 1, borderColor: theme.textSecondary, borderRadius: 8, padding: 12 }} /></View>;
}
function Choices({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (v: string) => void }) {
  return <View><ThemedText type="smallBold">{label}</ThemedText><View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{values.map(v => <Pressable key={v} accessibilityRole="radio" accessibilityLabel={`${label}: ${v || 'All'}`} accessibilityState={{ selected: v === value }} onPress={() => onChange(v)} style={{ padding: 12, minHeight: 44, borderWidth: v === value ? 2 : 0, borderRadius: 8 }}><ThemedText>{v === 'any' || !v ? 'All' : v}</ThemedText></Pressable>)}</View></View>;
}
function Frame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const theme = useTheme();
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}><View style={{ padding: 16 }}><ThemedText type="subtitle">{title}</ThemedText><Button label={`Close ${title}`} onPress={onClose} /></View>{children}</SafeAreaView></SafeAreaProvider></Modal>;
}
function ListingSummary({ item }: { item: Listing }) {
  return <View style={{ gap: 4 }}><ThemedText type="smallBold">{String(item.UnparsedAddress || item.ListingKey)}</ThemedText><ThemedText>{[item.City, item.StateOrProvince, item.PostalCode].filter(Boolean).join(', ')}</ThemedText><ThemedText>{typeof item.ListPrice === 'number' ? '$' + item.ListPrice.toLocaleString() : 'Price unavailable'} · {String(item.StandardStatus || 'Status unavailable')}</ThemedText><ThemedText>{String(item.BedroomsTotal ?? '—')} beds · {String(item.BathroomsTotalInteger ?? '—')} baths · {String(item.LivingArea ?? '—')} area · {String(item.PropertyType || '')}</ThemedText></View>;
}
function ListingDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { token, user } = useMobileAuth();
  const allowed = Boolean(token && user?.id && canAreaScreen(user, 'desk', 'mls'));
  const query = useQuery({ queryKey: ['crm-listing', user?.id, id], queryFn: ({ signal }) => fetchListing(token!, id, signal), enabled: allowed, retry: false });
  const item = allowed && !query.isFetching && !query.isError ? query.data : undefined;
  return <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}><Button label="Back to listings" onPress={onBack} />{!allowed ? <ThemedText>MLS access is unavailable.</ThemedText> : <><Button label="Refresh listing" onPress={() => { void query.refetch(); }} disabled={query.isFetching} />{query.isFetching ? <ActivityIndicator /> : null}{query.isError ? <ThemedText accessibilityRole="alert">{query.error.message}</ThemedText> : null}{item ? <><ListingSummary item={item} />{Object.entries(item).filter(([k]) => k !== 'ListingKey').map(([k, v]) => <ThemedText key={k}>{k.replace(/([a-z])([A-Z])/g, '$1 $2')}: {String(v ?? '—')}</ThemedText>)}</> : null}</>}</ScrollView>;
}
function useFavoritesActions() {
  const auth = useMobileAuth(), client = useQueryClient();
  const current = useRef(auth);
  useLayoutEffect(() => { current.current = auth; }, [auth]);
  const pending = useRef(false), controller = useRef<AbortController | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const allowed = Boolean(auth.token && auth.user?.id && canAreaScreen(auth.user, 'desk', 'favorites'));
  const keys = useQuery({ queryKey: ['crm-favorite-keys', auth.user?.id], queryFn: ({ signal }) => fetchFavoriteKeys(auth.token!, signal), enabled: allowed, retry: false });
  useEffect(() => () => { controller.current?.abort(); }, []);
  const mutation = useMutation({ retry: false, mutationFn: async ({ item, remove }: { item: Listing; remove: boolean }) => {
    const identity = { token: current.current.token, id: current.current.user?.id };
    const guard = () => {
      const now = current.current;
      if (!identity.token || !identity.id || now.token !== identity.token || now.user?.id !== identity.id || !canAreaScreen(now.user, 'desk', 'favorites')) throw new Error('You no longer have access to favourites.');
    };
    guard();
    if (pending.current || uncertain) throw new Error('Refresh saved listings before making another change.');
    pending.current = true;
    const abort = new AbortController(); controller.current = abort;
    try {
      // Refresh the current state before adding: POST toggle is not idempotent.
      const actual = await fetchFavoriteKeys(identity.token!, abort.signal);
      guard();
      if (remove || !actual.includes(item.ListingKey)) await changeFavorite(identity.token!, item, remove, abort.signal);
      await Promise.all([client.invalidateQueries({ queryKey: ['crm-favorite-keys', identity.id] }), client.invalidateQueries({ queryKey: ['crm-favorites', identity.id] })]);
    } finally { pending.current = false; controller.current = null; }
  }, onError: error => { if (error instanceof UnconfirmedFavorite) setUncertain(true); } });
  const refresh = async () => {
    if (!current.current.token || !canAreaScreen(current.current.user, 'desk', 'favorites') || pending.current) return;
    const result = await keys.refetch();
    if (!result.isError && current.current.token === auth.token && current.current.user?.id === auth.user?.id && canAreaScreen(current.current.user, 'desk', 'favorites')) { setUncertain(false); mutation.reset(); await client.invalidateQueries({ queryKey: ['crm-favorites', current.current.user?.id] }); }
  };
  const ready = allowed && !uncertain && !mutation.isPending && !keys.isFetching && !keys.isError && Boolean(keys.data);
  return { allowed, keys, mutation, uncertain, ready, refresh };
}
export function MlsSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const allowed = Boolean(token && user?.id && canAreaScreen(user, 'desk', 'mls'));
  const [draft, setDraft] = useState<MlsFilters>({ ...emptyMlsFilters }), [filters, setFilters] = useState<MlsFilters>({ ...emptyMlsFilters });
  const [page, setPage] = useState(1), [selected, setSelected] = useState<string | null>(null), [error, setError] = useState('');
  const status = useQuery({ queryKey: ['crm-mls-status', user?.id], queryFn: ({ signal }) => fetchMlsStatus(token!, signal), enabled: allowed, retry: false });
  const search = useQuery({ queryKey: ['crm-mls', user?.id, filters, page], queryFn: ({ signal }) => fetchMls(token!, filters, page, signal), enabled: allowed && status.data === true && !status.isError && !status.isFetching && !selected, retry: false });
  const favorites = useFavoritesActions();
  const data = allowed && status.data === true && !status.isFetching && !status.isError && !search.isFetching && !search.isError ? search.data : undefined;
  const set = (k: keyof MlsFilters, v: string) => setDraft(d => ({ ...d, [k]: v }));
  return <Frame title="MLS" onClose={onClose}>{!allowed ? <ThemedText>MLS access is unavailable.</ThemedText> : selected ? <ListingDetail id={selected} onBack={() => setSelected(null)} /> : <FlatList data={data?.properties || []} keyExtractor={i => i.ListingKey} contentContainerStyle={{ padding: 20, gap: 12 }} ListHeaderComponent={<View style={{ gap: 12 }}>
    <Field label="MLS address or city" value={draft.search} onChange={v => set('search', v)} /><Field label="Minimum price" numeric value={draft.priceMin} onChange={v => set('priceMin', v)} /><Field label="Maximum price" numeric value={draft.priceMax} onChange={v => set('priceMax', v)} />
    <Choices label="MLS sort" value={draft.sort} values={['newest', 'price_asc', 'price_desc']} onChange={v => set('sort', v)} /><Choices label="Bedrooms" value={draft.beds} values={['any', '1', '2', '3', '4', '5']} onChange={v => set('beds', v)} /><Choices label="Bathrooms" value={draft.baths} values={['any', '1', '2', '3', '4']} onChange={v => set('baths', v)} /><Choices label="Property type" value={draft.propertyType} values={['any', 'Residential', 'Condo', 'Townhouse', 'MultiFamily', 'Land']} onChange={v => set('propertyType', v)} /><Choices label="MLS status" value={draft.status} values={['any', 'Active', 'Pending', 'Sold']} onChange={v => set('status', v)} />
    <Button label="Apply MLS filters" onPress={() => { try { mlsQuery(draft, 1); setFilters({ ...draft }); setPage(1); setError(''); } catch (e) { setError((e as Error).message); } }} />
    <Button label="Reset MLS filters" onPress={() => { setDraft({ ...emptyMlsFilters }); setFilters({ ...emptyMlsFilters }); setPage(1); setError(''); }} />
    <Button label="Refresh MLS" onPress={() => { void status.refetch().then(result => { if (!result.isError && result.data === true) void search.refetch(); }); }} disabled={status.isFetching || search.isFetching || status.data !== true && !status.isError && status.data !== false} />
    {status.isFetching || search.isFetching && status.data === true ? <ActivityIndicator /> : null}{status.isError ? <ThemedText accessibilityRole="alert">{status.error.message}</ThemedText> : null}{status.data === false && !status.isError && !status.isFetching ? <ThemedText>MLS listings are not available yet. Your saved favourites remain available separately.</ThemedText> : null}
    {error ? <ThemedText accessibilityRole="alert">{error}</ThemedText> : null}{search.isError && status.data === true ? <ThemedText accessibilityRole="alert">{search.error.message}</ThemedText> : null}
    {favorites.allowed ? <><Button label="Refresh saved listings" onPress={() => { void favorites.refresh(); }} disabled={favorites.mutation.isPending || favorites.keys.isFetching} />{favorites.keys.isError ? <ThemedText accessibilityRole="alert">{favorites.keys.error.message}</ThemedText> : null}{favorites.mutation.isError ? <ThemedText accessibilityRole="alert">{favorites.mutation.error.message}</ThemedText> : null}</> : null}
    {data ? <ThemedText>{data.total} listings · Page {page} of {data.totalPages}</ThemedText> : null}
  </View>} ListEmptyComponent={data ? <ThemedText>No matching MLS listings.</ThemedText> : null} renderItem={({ item }) => <View style={{ padding: 12, borderWidth: 1, borderRadius: 12 }}><ListingSummary item={item} /><Button label={`Open listing ${item.ListingKey}`} onPress={() => setSelected(item.ListingKey)} />{favorites.allowed ? <Button label={`${favorites.keys.data?.includes(item.ListingKey) ? 'Remove favourite' : 'Save favourite'} ${item.ListingKey}`} disabled={!favorites.ready} onPress={() => favorites.mutation.mutate({ item, remove: favorites.keys.data!.includes(item.ListingKey) })} /> : null}</View>} ListFooterComponent={<View><Button label="Previous MLS page" disabled={!data || page === 1} onPress={() => setPage(p => p - 1)} /><Button label="Next MLS page" disabled={!data || page >= data.totalPages} onPress={() => setPage(p => p + 1)} /></View>} />}</Frame>;
}
export function FavoritesSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const actions = useFavoritesActions();
  const [search, setSearch] = useState(''), [sort, setSort] = useState('recent'), [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['crm-favorites', user?.id], queryFn: ({ signal }) => fetchFavorites(token!, signal), enabled: actions.allowed, retry: false });
  const data = actions.allowed && !list.isError && !list.isFetching ? list.data : undefined;
  const shown = (data || []).filter(f => [f.listing_key, f.snapshot.UnparsedAddress, f.snapshot.City, f.snapshot.PropertyType].some(v => String(v ?? '').toLowerCase().includes(search.toLowerCase()))).sort((a, b) => sort === 'recent' ? 0 : (Number(a.snapshot.ListPrice) || 0) - (Number(b.snapshot.ListPrice) || 0));
  if (sort === 'price_desc') shown.reverse();
  return <Frame title="Favourites" onClose={onClose}>{!actions.allowed ? <ThemedText>Favourites access is unavailable.</ThemedText> : selected && canAreaScreen(user, 'desk', 'mls') ? <ListingDetail id={selected} onBack={() => setSelected(null)} /> : <FlatList data={shown} keyExtractor={i => i.listing_key} contentContainerStyle={{ padding: 20, gap: 12 }} ListHeaderComponent={<View style={{ gap: 12 }}><ThemedText>Your private saved MLS listings. Saved details may differ from the current listing.</ThemedText><Field label="Search favourites" value={search} onChange={setSearch} /><Choices label="Favourites sort" value={sort} values={['recent', 'price_asc', 'price_desc']} onChange={setSort} /><Button label="Refresh favourites" disabled={actions.mutation.isPending || actions.keys.isFetching || list.isFetching} onPress={() => { void actions.refresh(); void list.refetch(); }} />{list.isFetching ? <ActivityIndicator /> : null}{list.isError ? <ThemedText accessibilityRole="alert">{list.error.message}</ThemedText> : null}{actions.keys.isError ? <ThemedText accessibilityRole="alert">{actions.keys.error.message}</ThemedText> : null}{actions.mutation.isError ? <ThemedText accessibilityRole="alert">{actions.mutation.error.message}</ThemedText> : null}</View>} ListEmptyComponent={data ? <ThemedText>No matching favourites.</ThemedText> : null} renderItem={({ item }) => <View style={{ padding: 12, borderWidth: 1, borderRadius: 12 }}><ListingSummary item={item.snapshot} />{item.notes ? <ThemedText>{item.notes}</ThemedText> : null}{canAreaScreen(user, 'desk', 'mls') ? <Button label={`Open saved listing ${item.listing_key}`} onPress={() => setSelected(item.listing_key)} /> : null}<Button label={`Remove saved listing ${item.listing_key}`} disabled={!actions.ready} onPress={() => actions.mutation.mutate({ item: item.snapshot, remove: true })} /></View>} />}</Frame>;
}
export function InventorySheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const allowed = Boolean(token && user?.id && canAreaScreen(user, 'desk', 'inventory'));
  const [draft, setDraft] = useState({ search: '', type: '', status: '' }), [filters, setFilters] = useState(draft);
  const query = useQuery({ queryKey: ['crm-inventory', user?.id, filters], queryFn: ({ signal }) => fetchInventory(token!, filters, signal), enabled: allowed, retry: false });
  const data = allowed && !query.isError && !query.isFetching ? query.data : undefined;
  return <Frame title="Inventory" onClose={onClose}>{!allowed ? <ThemedText>Inventory access is unavailable.</ThemedText> : <FlatList data={data?.items || []} keyExtractor={i => i._id} contentContainerStyle={{ padding: 20, gap: 12 }} ListHeaderComponent={<View style={{ gap: 12 }}><ThemedText>Marketing supplies and assigned quantities. Your account determines which stock is visible.</ThemedText><Field label="Search inventory" value={draft.search} onChange={search => setDraft(d => ({ ...d, search }))} /><Choices label="Inventory type" value={draft.type} values={['', 'For Sale Signboards', 'Lock Box', 'Roll Up Banner', 'Post Card', 'For Lease Signboards', 'Open House Signboards', 'Directional Signboards', 'Custom']} onChange={type => setDraft(d => ({ ...d, type }))} /><Choices label="Inventory status" value={draft.status} values={['', 'Available', 'Not Returned', 'Returned']} onChange={status => setDraft(d => ({ ...d, status }))} /><Button label="Apply inventory filters" onPress={() => setFilters({ ...draft })} /><Button label="Reset inventory filters" onPress={() => { const blank = { search: '', type: '', status: '' }; setDraft(blank); setFilters(blank); }} /><Button label="Refresh inventory" onPress={() => { void query.refetch(); }} disabled={query.isFetching} />{query.isFetching ? <ActivityIndicator /> : null}{query.isError ? <ThemedText accessibilityRole="alert">{query.error.message}</ThemedText> : null}{data ? <ThemedText>{data.total} items</ThemedText> : null}</View>} ListEmptyComponent={data ? <ThemedText>No matching inventory.</ThemedText> : null} renderItem={({ item }) => <View style={{ padding: 12, borderWidth: 1, borderRadius: 12, gap: 6 }}><ThemedText type="smallBold">{item.type === 'Custom' ? item.customType || 'Custom' : item.type}</ThemedText><ThemedText>{item.status} · Quantity {item.count} · Assigned {item.assignedQty}</ThemedText><ThemedText>As of {item.asOnDate || 'Date unavailable'}</ThemedText>{(item.assignments.length ? item.assignments : item.assignedTo ? [{ assignedTo: item.assignedTo, qty: item.assignedQty, assignedDate: item.assignedDate, returnedDate: item.returnedDate }] : []).map((a, i) => <ThemedText key={i}>{a.assignedTo} · {a.qty} units · Assigned {a.assignedDate || '—'} · Return date {a.returnedDate || '—'}</ThemedText>)}{item.remarks ? <ThemedText>{item.remarks}</ThemedText> : null}</View>} />}</Frame>;
}
