import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Share, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';
import { ThemedText } from './themed-text';
import { useTheme } from '@/hooks/use-theme';
import { cancelReviewRequest, createReviewRequest, fetchReviewChoices, fetchReviewLink, fetchReviewMailboxes, fetchReviews, type ReviewRequestInput } from '@/reviews/reviews-api';

export function ClientReviewsSheet({ onClose }: { onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const allowed = !!token && canAreaScreen(user, 'crm', 'reviews');
  const editable = allowed && canAreaScreen(user, 'crm', 'reviews', 'edit');
  const theme = useTheme(), cache = useQueryClient();
  const [controller] = useState(() => new AbortController());
  useEffect(() => () => controller.abort(), [controller]);
  const current = useRef({ token, editable });
  useLayoutEffect(() => { current.current = { token, editable }; }, [token, editable]);
  const [before, setBefore] = useState<number | null>(null), [pages, setPages] = useState<(number | null)[]>([]);
  const [search, setSearch] = useState(''), [chosen, setChosen] = useState<{ transaction_id: number; client_id: number; name: string; email: string } | null>(null);
  const [account, setAccount] = useState<number | null>(null), [pending, setPending] = useState<ReviewRequestInput | null>(null), [link, setLink] = useState<string | null>(null);
  const reviews = useQuery({ queryKey: ['client-reviews', user?.id, before], queryFn: ({ signal }) => fetchReviews(token!, before, signal), enabled: allowed, retry: false });
  const deals = useQuery({ queryKey: ['review-deals', user?.id, search], queryFn: ({ signal }) => fetchReviewChoices(token!, search, signal), enabled: editable, retry: false });
  const mailboxes = useQuery({ queryKey: ['review-mailboxes', user?.id], queryFn: ({ signal }) => fetchReviewMailboxes(token!, signal), enabled: editable, retry: false });
  const page = allowed && !reviews.isError && !reviews.isFetching ? reviews.data : undefined;
  const refresh = () => cache.invalidateQueries({ queryKey: ['client-reviews', user?.id] });
  const send = useMutation({ retry: false, mutationFn: ({ input, credential }: { input: ReviewRequestInput; credential: string }) => {
    if (!current.current.editable || current.current.token !== credential || controller.signal.aborted) throw new Error('Review access changed.');
    return createReviewRequest(credential, input, controller.signal);
  }, onSuccess: result => { if (!current.current.editable || current.current.token !== token || controller.signal.aborted) return; setPending(null); setChosen(null); setLink(result.link); void refresh(); } });
  const cancel = useMutation({ retry: false, mutationFn: ({ id, credential }: { id: number; credential: string }) => {
    if (!current.current.editable || current.current.token !== credential || controller.signal.aborted) throw new Error('Review access changed.');
    return cancelReviewRequest(credential, id, controller.signal);
  }, onSuccess: () => { setLink(null); void refresh(); } });
  const recover = useMutation({ retry: false, mutationFn: ({ id, credential }: { id: number; credential: string }) => {
    if (!current.current.editable || current.current.token !== credential || controller.signal.aborted) throw new Error('Review access changed.');
    return fetchReviewLink(credential, id, controller.signal);
  }, onSuccess: value => { if (current.current.editable && current.current.token === token && !controller.signal.aborted) setLink(value); } });
  const busy = send.isPending || cancel.isPending || recover.isPending;
  const button = (label: string, action: () => void, disabled = false) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={action} style={{ padding: 12, minHeight: 44 }}><ThemedText>{label}</ThemedText></Pressable>;
  const confirm = (email: boolean) => {
    if (!chosen || !editable || pending || busy) return;
    const input: ReviewRequestInput = { transaction_id: chosen.transaction_id, client_id: chosen.client_id, submission_id: randomUUID(), send_email: email, ...(email && account ? { account_id: account } : {}) };
    const credential = token!;
    Alert.alert(email ? 'Send review request?' : 'Create private review link?', `${chosen.name} · ${chosen.email}. The link expires in 30 days. Feedback stays private.`, [{ text: 'Cancel', style: 'cancel' }, { text: email ? 'Send request' : 'Create link', onPress: () => { if (busy || pending) return; setLink(null); setPending(input); send.mutate({ input, credential }); } }]);
  };
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}><ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}><ThemedText type="subtitle">Client Reviews</ThemedText>{button('Close Client Reviews', onClose)}
    {!allowed ? <ThemedText>Client Reviews access unavailable.</ThemedText> : <><ThemedText>Private feedback from your review requests for closed transactions. Reviews are never published automatically.</ThemedText>{button('Refresh client reviews', () => { setLink(null); void reviews.refetch(); }, busy || reviews.isFetching)}
    {reviews.isFetching || busy ? <ActivityIndicator /> : null}{reviews.isError ? <ThemedText accessibilityRole="alert">{reviews.error.message}</ThemedText> : null}
    {page?.data.map(row => <View key={row.id} style={{ padding: 12, borderWidth: 1, borderColor: theme.border, gap: 8 }}><ThemedText type="smallBold">{row.client_name} · Deal {row.transaction_id}</ThemedText><ThemedText>{row.status} · {row.client_email}</ThemedText>{row.rating !== null ? <ThemedText>{row.rating} / 5 stars</ThemedText> : null}{row.comment ? <ThemedText>{row.comment}</ThemedText> : null}<ThemedText type="small">Link expires {new Date(row.expires_at).toLocaleDateString()}</ThemedText>{row.status === 'uncertain' || row.status === 'sending' ? <ThemedText>Email delivery is unconfirmed. This request will not be sent again automatically.</ThemedText> : null}{['ready', 'sent', 'uncertain', 'sending'].includes(row.status) && editable ? button(`Recover private review link ${row.id}`, () => recover.mutate({ id: row.id, credential: token! }), busy) : null}{['ready', 'sent', 'uncertain', 'sending'].includes(row.status) && editable ? button(`Cancel review request ${row.id}`, () => { const credential = token!; Alert.alert('Cancel review request?', 'The private link will stop accepting feedback.', [{ text: 'Keep request', style: 'cancel' }, { text: 'Cancel request', onPress: () => cancel.mutate({ id: row.id, credential }) }]); }, busy) : null}</View>)}
    {page && !page.data.length ? <ThemedText>No review requests on this page.</ThemedText> : null}{pages.length ? button('Newer review requests', () => { setBefore(pages[pages.length - 1]); setPages(pages.slice(0, -1)); }, busy) : null}{page?.next ? button('Older review requests', () => { setPages([...pages, before]); setBefore(page.next); }, busy) : null}
    {editable ? <><ThemedText type="smallBold">Request a client review</ThemedText><TextInput accessibilityLabel="Search closed transactions for reviews" value={search} editable={!busy && !pending} onChangeText={text => { setSearch(text); setChosen(null); }} placeholder="Trade number or property" style={{ color: theme.text, borderWidth: 1, borderColor: theme.border, padding: 12 }} />
    {deals.isFetching ? <ActivityIndicator /> : null}{deals.isError ? <ThemedText accessibilityRole="alert">{deals.error.message}</ThemedText> : null}{!deals.isError && !deals.isFetching ? deals.data?.map(deal => <View key={deal.id}><ThemedText>{deal.trade_no} · {deal.property}</ThemedText>{deal.clients.filter(client => client.email).map(client => button(`${chosen?.client_id === client.id ? 'Selected: ' : ''}${client.name} · ${client.email}`, () => setChosen({ transaction_id: deal.id, client_id: client.id, name: client.name, email: client.email! }), busy || !!pending))}</View>) : null}
    {chosen ? <ThemedText>Selected recipient: {chosen.name} · {chosen.email}</ThemedText> : null}{button('Create private review link', () => confirm(false), !chosen || busy || !!pending)}
    {page?.email_enabled ? <><ThemedText>Choose your CRM sending mailbox</ThemedText>{mailboxes.isError ? <ThemedText>{mailboxes.error.message}</ThemedText> : null}{!mailboxes.isError && !mailboxes.isFetching ? mailboxes.data?.map(mailbox => button(`${account === mailbox.id ? 'Selected: ' : ''}${mailbox.name}`, () => setAccount(mailbox.id), busy || !!pending)) : null}{button('Send review request email', () => confirm(true), !chosen || !account || busy || !!pending || mailboxes.isError || mailboxes.isFetching)}</> : <ThemedText>Review request email sending is disabled.</ThemedText>}
    {pending && send.isError ? <><ThemedText>Request creation could not be confirmed. Check the same request before starting another.</ThemedText>{button('Check same review request', () => send.mutate({ input: pending, credential: token! }), busy)}{button('Leave failed request and refresh', () => { setPending(null); setChosen(null); send.reset(); void reviews.refetch(); }, busy)}</> : null}
    {link ? <><ThemedText>Private link created. Share it only with the selected client.</ThemedText>{button('Share private client review link', () => { void Share.share({ message: link }).catch(() => Alert.alert('Sharing unavailable', 'The private link could not be shared.')); }, busy)}</> : null}
    </> : null}{send.isError ? <ThemedText accessibilityRole="alert">{send.error.message}</ThemedText> : null}{recover.isError ? <ThemedText accessibilityRole="alert">{recover.error.message}</ThemedText> : null}{cancel.isError ? <ThemedText accessibilityRole="alert">{cancel.error.message}</ThemedText> : null}
    </>}
  </ScrollView></SafeAreaView></SafeAreaProvider></Modal>;
}
