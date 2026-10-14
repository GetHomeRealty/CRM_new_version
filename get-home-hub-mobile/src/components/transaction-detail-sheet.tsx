import { InvoicesSheet } from './invoices-sheet';
import { canInvoice } from '@/transactions/invoices-api';
import { DeskWorkspaceSheet } from './desk-workspace-sheet';
import { canDeskWorkspace } from '@/transactions/desk-workspace-api';
import { Form630Sheet } from './form630-sheet';
import { canForm630 } from '@/transactions/form630-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '@/auth/auth-context';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fetchTransaction, fetchTransactionDocuments, type MobileCondition, type MobileDocument, updateTransaction } from '@/transactions/transactions-api';
import { DocumentRemindersSheet } from './document-reminders-sheet';
import { canDocumentReminders } from '@/transactions/document-reminder-api';
import { ValidFileReplacementSheet } from './valid-file-replacement-sheet';
import { canReplaceValidFile } from '@/transactions/valid-file-replacement-api';
import { ChecklistToolsSheet } from './checklist-tools-sheet';
import { canChecklistTools } from '@/transactions/checklist-actions-api';
import { DocumentLifecycleSheet } from './document-lifecycle-sheet';
import { canManageDocuments } from '@/transactions/document-lifecycle-api';
import { ValidationAttachmentSheet } from './validation-attachment-sheet';
import { DocumentReviewSheet } from './document-review-sheet';
import { canReviewDocument } from '@/transactions/document-review-api';
import { DocumentUploadSheet } from './document-upload-sheet';
import { canAreaScreen } from '@/auth/access-policy';
import { DocumentFilesSheet } from './document-files-sheet';

import { conditionChanges, conditionDraftError } from '@/transactions/condition-draft';
import { validActivityDate } from '@/leads/activity-date';
import { TransactionChatSheet } from './transaction-chat-sheet';

const money = (value: number | null | undefined) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(value ?? 0);
const securedTypes = new Set(['Residential Buying', 'Residential Lease', 'Commercial Property Buying', 'Commercial Property Lease', 'Business Buying']);
const listingTypes = new Set(['Residential Sale Listing', 'Residential Lease Listing', 'Commercial Property Sale Listing', 'Commercial Property Lease Listing', 'Business Sale']);
const statusOptions = (type: string | null) => {
  if (type === 'Referral') return ['Open', 'Closed'];
  if (type && listingTypes.has(type)) {
    const lease = /lease/i.test(type);
    return ['Active', lease ? 'Lease Conditional' : 'Sold Conditional', lease ? 'Leased' : 'Sold', 'Closed', 'Mutual Release', 'DFT', 'Void', 'Suspended', 'Terminated', 'Expired'];
  }
  return type && securedTypes.has(type) ? ['Secured Firm', 'Secured Conditional', 'Closed', 'Mutual Release', 'DFT', 'Void'] : ['Open', 'Closed', 'Mutual Release', 'DFT', 'Void'];
};
const conditionStatuses = ['Pending', 'Waived', 'Fulfilled', 'Not Met'];

export function TransactionDetailSheet({ transactionId, onClose }: { transactionId: number | null; onClose: () => void }) {
  return transactionId === null ? null : <TransactionDetailEditor key={transactionId} transactionId={transactionId} onClose={onClose} />;
}

function TransactionDetailEditor({ transactionId, onClose }: { transactionId: number; onClose: () => void }) {
  const { token, user } = useMobileAuth();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [statusEditorOpen, setStatusEditorOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [invoicesOpen,setInvoicesOpen] = useState(false);
  const [workspaceSection,setWorkspaceSection] = useState<'financial'|'team'|null>(null);
  const [form630Client, setForm630Client] = useState<number | null>(null);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [validReplacement, setValidReplacement] = useState<MobileDocument | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [validationDocument, setValidationDocument] = useState<MobileDocument | null>(null);
  const [reviewDocument, setReviewDocument] = useState<MobileDocument | null>(null);
  const [uploadDocument, setUploadDocument] = useState<MobileDocument | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<MobileDocument | null>(null);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [conditionEditorOpen, setConditionEditorOpen] = useState(false);
  const [conditionDraft, setConditionDraft] = useState<MobileCondition[]>([]);
  const [dateDraft, setDateDraft] = useState<Partial<Record<'offer_date' | 'closing_date', string>> | null>(null);
  const dateMutation = useMutation({
    mutationFn: (draft: Partial<Record<'offer_date' | 'closing_date', string>>) => {
      if (Object.values(draft).some((date) => date !== '' && !validActivityDate(date!))) throw new Error('Enter valid dates in YYYY-MM-DD format.');
      return updateTransaction(token!, transactionId, Object.fromEntries(Object.entries(draft).map(([key, date]) => [key, date || null])));
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['transaction', updated.id], updated);
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['hub-dashboard'] });
      setDateDraft(null);
    },
  });
  const query = useQuery({ queryKey: ['transaction', transactionId], queryFn: ({ signal }) => fetchTransaction(token!, transactionId!, signal), enabled: Boolean(token && transactionId) });
  const documentsQuery = useQuery({ queryKey: ['transaction-documents', transactionId], queryFn: ({ signal }) => fetchTransactionDocuments(token!, transactionId!, signal), enabled: Boolean(token && transactionId) });
  const transaction = query.data;
  const statusMutation = useMutation({
    mutationFn: () => updateTransaction(token!, transactionId!, { statuses: selectedStatuses }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['transaction', transactionId], updated);
      void queryClient.invalidateQueries({ queryKey: ['transaction-documents', transactionId] });
      void queryClient.invalidateQueries({ queryKey: ['document-reminders', transactionId] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['hub-dashboard'] });
      setStatusEditorOpen(false);
    },
    onError: (error: Error) => Alert.alert('Could not update status', error.message),
  });
  const conditionMutation = useMutation({
    mutationFn: () => updateTransaction(token!, transactionId!, conditionChanges(conditionDraft)),
    onSuccess: (updated) => {
      queryClient.setQueryData(['transaction', transactionId], updated);
      queryClient.invalidateQueries({ queryKey: ['transaction-documents', transactionId] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      setConditionEditorOpen(false);
    },
    onError: (error: Error) => Alert.alert('Could not update conditions', error.message),
  });
  const updateCondition = (index: number, changes: Partial<MobileCondition>) => setConditionDraft((current) => current.map((condition, itemIndex) => itemIndex === index ? { ...condition, ...changes } : condition));
  if (chatOpen) return <TransactionChatSheet transactionId={transactionId} onClose={() => setChatOpen(false)} />;
  if (invoicesOpen) return <InvoicesSheet transactionId={transactionId} onClose={() => {setInvoicesOpen(false);void query.refetch();}} />;
  if (workspaceSection) return <DeskWorkspaceSheet transactionId={transactionId} section={workspaceSection} onClose={() => {setWorkspaceSection(null);void query.refetch();}} />;
  if (form630Client !== null) return <Form630Sheet transactionId={transactionId} clientId={form630Client} onClose={() => setForm630Client(null)} />;
  if (remindersOpen) return <DocumentRemindersSheet transactionId={transactionId} onClose={() => { setRemindersOpen(false); void documentsQuery.refetch(); }} />;
  if (validReplacement) return <ValidFileReplacementSheet transactionId={transactionId} document={validReplacement} onClose={() => { setValidReplacement(null); void documentsQuery.refetch(); }} />;
  if (toolsOpen) return <ChecklistToolsSheet transactionId={transactionId} onClose={() => { setToolsOpen(false); void documentsQuery.refetch(); }} />;
  if (lifecycleOpen) return <DocumentLifecycleSheet transactionId={transactionId} onClose={() => { setLifecycleOpen(false); void documentsQuery.refetch(); }} />;
  if (validationDocument) return <ValidationAttachmentSheet transactionId={transactionId} document={validationDocument} onClose={() => { setValidationDocument(null); void documentsQuery.refetch(); }} />;
  if (reviewDocument) return <DocumentReviewSheet transactionId={transactionId} document={reviewDocument} onClose={() => { setReviewDocument(null); void documentsQuery.refetch(); }} />;
  if (uploadDocument && transactionId) return <DocumentUploadSheet transactionId={transactionId} document={uploadDocument} clients={(transaction?.clients ?? []).map(client => client.name)} onClose={() => { setUploadDocument(null); void documentsQuery.refetch(); }} />;
  if (selectedDocument) return <DocumentFilesSheet document={selectedDocument} onClose={() => setSelectedDocument(null)} />;
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={transactionId !== null}>
      <ThemedView style={styles.screen}><SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={[styles.header, { borderBottomColor: theme.border }]}><Pressable onPress={onClose}><ThemedText type="smallBold" themeColor="primary">Close</ThemedText></Pressable><ThemedText type="smallBold">Transaction details</ThemedText><View style={styles.spacer} /></View>
        {query.isPending ? <View style={styles.center}><ActivityIndicator color={theme.primary} /></View> : null}
        {query.isError ? <View style={styles.center}><ThemedText type="smallBold" themeColor="danger">Could not open transaction</ThemedText><ThemedText type="small" themeColor="textSecondary">{query.error.message}</ThemedText><Pressable style={styles.retry} onPress={() => query.refetch()}><ThemedText type="smallBold" style={styles.white}>Try again</ThemedText></Pressable></View> : null}
        {transaction ? <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.hero}><ThemedText style={styles.title}>{transaction.property || `Trade ${transaction.trade_no}`}</ThemedText><ThemedText themeColor="textSecondary">{transaction.type} · {transaction.agent || 'Unassigned'}</ThemedText><View style={styles.statusLine}><View style={styles.statuses}>{transaction.statuses.map((status) => <View key={status} style={[styles.pill, { backgroundColor: theme.primarySoft }]}><ThemedText type="smallBold" themeColor="primary">{status}</ThemedText></View>)}</View><Pressable accessibilityLabel="Edit transaction statuses" accessibilityRole="button" onPress={() => { setSelectedStatuses(transaction.statuses); setStatusEditorOpen(true); }} style={[styles.editButton, { borderColor: theme.border }]}><ThemedText type="smallBold" themeColor="primary">Edit</ThemedText></Pressable></View></View>
          <Pressable accessibilityRole="button" onPress={() => setChatOpen(true)} style={styles.cancelButton}><ThemedText type="smallBold">Open team conversation</ThemedText></Pressable>
          <Card title="Overview"><Row label="Trade number" value={transaction.trade_no || '—'} /><Row label="Offer date" value={transaction.offer_date || '—'} /><Row label="Closing date" value={transaction.closing_date || '—'} /><Row label="Validation" value={transaction.valid_status || '—'} /></Card>
          <Card title="Transaction dates">
            {dateDraft === null ? <Pressable accessibilityRole="button" onPress={() => { dateMutation.reset(); setDateDraft({}); }} style={styles.editButton}><ThemedText themeColor="primary">Edit offer and closing dates</ThemedText></Pressable> : <>
              {(['offer_date', 'closing_date'] as const).map((key) => <View key={key}>
                <ThemedText>{key === 'offer_date' ? 'Offer date' : 'Closing date'} (YYYY-MM-DD)</ThemedText>
                <TextInput accessibilityLabel={key === 'offer_date' ? 'Transaction offer date' : 'Transaction closing date'} editable={!dateMutation.isPending} value={dateDraft[key] ?? transaction[key] ?? ''} onChangeText={(text) => setDateDraft((current) => ({ ...current, [key]: text }))} placeholder="YYYY-MM-DD" style={[styles.input, { color: theme.text, borderColor: theme.border }]} />
              </View>)}
              <ThemedText type="small" themeColor="textSecondary">Only edited fields are saved. Clear a date to remove it.</ThemedText>
              {dateMutation.isError ? <ThemedText themeColor="danger" accessibilityLiveRegion="polite">{dateMutation.error.message}</ThemedText> : null}
              <View style={styles.editorActions}>
                <Pressable accessibilityRole="button" disabled={dateMutation.isPending} onPress={() => setDateDraft(null)} style={styles.cancelButton}><ThemedText>Cancel</ThemedText></Pressable>
                <Pressable accessibilityRole="button" disabled={dateMutation.isPending || !Object.keys(dateDraft).length} onPress={() => dateMutation.mutate(dateDraft)} style={styles.saveButton}>{dateMutation.isPending ? <ActivityIndicator color="#FFFFFF" /> : <ThemedText style={styles.white}>Save dates</ThemedText>}</Pressable>
              </View>
            </>}
          </Card>
          <Card title="Financial">
            {canDeskWorkspace(user, 'financial') && workspaceVisible(transaction.type,transaction.statuses,'financial',user?.role,transaction.comm_paid_status) ? <Pressable accessibilityRole="button" accessibilityLabel="Open financial information" onPress={() => setWorkspaceSection('financial')} style={styles.editButton}><ThemedText themeColor="primary">Financial information</ThemedText></Pressable> : null}<Row label="Price" value={money(transaction.price)} /><Row label="Deposit" value={money(transaction.deposit)} /><Row label="Commission" value={transaction.comm_status || 'Pending'} /><Row label="Payout" value={transaction.comm_paid_status || '—'} /></Card>
          <Card title={`Clients (${transaction.clients?.length ?? 0})`}>{transaction.clients?.length ? transaction.clients.map((client) => <Item key={client.id} title={client.name} detail={[client.email, client.phone].filter(Boolean).join(' · ')} />) : <Empty label="No clients recorded." />}</Card>
          <Card title={`Conditions (${transaction.conditions?.length ?? 0})`} action={<Pressable accessibilityLabel="Edit transaction conditions" accessibilityRole="button" onPress={() => { setConditionDraft((transaction.conditions ?? []).map((condition) => ({ ...condition }))); setConditionEditorOpen(true); }}><ThemedText type="smallBold" themeColor="primary">Edit</ThemedText></Pressable>}>{transaction.conditions?.length ? transaction.conditions.map((condition) => <Item key={condition.id} title={condition.custom_name || condition.type} detail={[condition.deadline, condition.status].filter(Boolean).join(' · ')} />) : <Empty label="No conditions recorded." />}</Card>
          <Card title={`Documents (${documentsQuery.data?.stats.total ?? 0})`}>
            {canDocumentReminders(user) ? <Pressable accessibilityRole="button" accessibilityLabel="Manage document reminders" onPress={() => setRemindersOpen(true)} style={styles.editButton}><ThemedText themeColor="primary">Document reminders</ThemedText></Pressable> : null}
            {canChecklistTools(user) ? <Pressable accessibilityRole="button" accessibilityLabel="Open checklist tools" onPress={() => setToolsOpen(true)} style={styles.editButton}><ThemedText themeColor="primary">Create document, files and RECO readiness</ThemedText></Pressable> : null}
            {canManageDocuments(user) ? <Pressable accessibilityRole="button" accessibilityLabel="Manage document removal and restore" onPress={() => setLifecycleOpen(true)} style={styles.editButton}><ThemedText themeColor="primary">Removal and restore</ThemedText></Pressable> : null}
            {documentsQuery.isPending ? <ActivityIndicator accessibilityLabel="Loading documents" color={theme.primary} /> : null}
            {documentsQuery.isError ? <ThemedText type="small" themeColor="danger">{documentsQuery.error.message}</ThemedText> : null}
            {documentsQuery.data && !documentsQuery.isError ? <>
              <View accessibilityLabel={`${documentsQuery.data.stats.pct}% of documents received`} style={styles.documentSummary}><ThemedText type="smallBold" themeColor="primary">{documentsQuery.data.stats.pct}% received</ThemedText><ThemedText type="small" themeColor="textSecondary">{documentsQuery.data.stats.received} received · {documentsQuery.data.stats.pending} pending · {documentsQuery.data.stats.mandatory} mandatory</ThemedText></View>
              {documentsQuery.data.documents.length ? documentsQuery.data.documents.map((document) => <View key={document.id}><Pressable accessibilityRole="button" accessibilityLabel={`View files for ${document.title}`} onPress={() => setSelectedDocument(document)}>
                <Item title={`${document.mandatory ? 'Required · ' : ''}${document.title}`} detail={[document.status, document.validation, document.deadline ? `Due ${document.deadline}` : null, document.file_count ? `${document.file_count} files` : document.has_file ? document.file_name || 'File attached' : null].filter(Boolean).join(' · ')} />
                <ThemedText type="small" themeColor="primary">View files</ThemedText>
              </Pressable>
                {document.title.toLowerCase().includes('fintrac') && canForm630(user) ? <>{(transaction?.clients ?? []).map(client => <Pressable key={client.id} accessibilityRole="button" accessibilityLabel={`Form 630 for ${client.name}`} disabled={documentsQuery.isFetching} onPress={() => setForm630Client(client.id)} style={styles.editButton}><ThemedText themeColor="primary">Form 630 · {client.name}</ThemedText></Pressable>)}{!transaction?.clients?.length ? <ThemedText type="small">Add a transaction client to prepare Form 630.</ThemedText> : null}</> : null}
                {canAreaScreen(user, 'desk', 'transactions', 'edit') && !document.title.toLowerCase().includes('fintrac') && document.validation !== 'Valid' && document.agent_accepted !== 'Not Accepted' ? <Pressable accessibilityRole="button" accessibilityLabel={`Upload file for ${document.title}`} disabled={documentsQuery.isFetching} onPress={() => setUploadDocument(document)} style={styles.editButton}><ThemedText themeColor="primary">Upload file</ThemedText></Pressable> : null}
                {canReviewDocument(user, document) ? <Pressable accessibilityRole="button" accessibilityLabel={`Review ${document.title}`} disabled={documentsQuery.isFetching} onPress={() => setReviewDocument(document)} style={styles.editButton}><ThemedText themeColor="primary">{user?.role === 'agent' ? 'Accept document' : 'Review document'}</ThemedText></Pressable> : null}
                {document.validation === 'Invalid' && canAreaScreen(user, 'desk', 'transactions') ? <Pressable accessibilityRole="button" accessibilityLabel={`Validation attachment for ${document.title}`} disabled={documentsQuery.isFetching} onPress={() => setValidationDocument(document)} style={styles.editButton}><ThemedText themeColor="primary">Validation attachment</ThemedText></Pressable> : null}
                {canReplaceValidFile(user, document) && (document.has_file || document.files?.length) ? <Pressable accessibilityRole="button" accessibilityLabel={`Replace Valid file for ${document.title}`} disabled={documentsQuery.isFetching} onPress={() => setValidReplacement(document)} style={styles.editButton}><ThemedText themeColor="primary">Replace Valid file</ThemedText></Pressable> : null}
              </View>) : <Empty label="No documents recorded." />}
            </> : null}
          </Card>
          <Card title={`Team (${transaction.team?.length ?? 0})`}>
            {canDeskWorkspace(user, 'team') && workspaceVisible(transaction.type,transaction.statuses,'team',user?.role,transaction.comm_paid_status) ? <Pressable accessibilityRole="button" accessibilityLabel="Open team split" onPress={() => setWorkspaceSection('team')} style={styles.editButton}><ThemedText themeColor="primary">Team split</ThemedText></Pressable> : null}{transaction.team?.length ? transaction.team.map((member) => <Item key={member.id} title={member.name} detail={`${member.split}% · ${member.access}`} />) : <Empty label="No team members recorded." />}</Card>
          <Card title={`Invoices (${transaction.invoices?.length ?? 0})`}>{canInvoice(user) ? <Pressable accessibilityRole="button" accessibilityLabel="Manage transaction invoices" onPress={() => setInvoicesOpen(true)} style={styles.editButton}><ThemedText themeColor="primary">Manage invoices</ThemedText></Pressable> : null}{transaction.invoices?.length ? transaction.invoices.map((invoice) => <Item key={invoice.id} title={invoice.invoice_no} detail={`${money(invoice.total)} · ${invoice.status}`} />) : <Empty label="No invoices recorded." />}</Card>
        </ScrollView> : null}
        {transaction ? <Modal animationType="fade" onRequestClose={() => setStatusEditorOpen(false)} transparent visible={statusEditorOpen}>
          <View style={styles.overlay}><ThemedView type="backgroundElement" style={[styles.editor, { borderColor: theme.border }]}><ThemedText style={styles.editorTitle}>Transaction status</ThemedText><ThemedText type="small" themeColor="textSecondary">Select one or more statuses, then save.</ThemedText><View style={styles.statusChoices}>{statusOptions(transaction.type).map((status) => { const chosen = selectedStatuses.includes(status); return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: chosen }} key={status} onPress={() => setSelectedStatuses((current) => chosen ? current.filter((item) => item !== status) : [...current, status])} style={[styles.choice, { borderColor: chosen ? theme.primary : theme.border, backgroundColor: chosen ? theme.primarySoft : theme.backgroundElement }]}><ThemedText type="smallBold" themeColor={chosen ? 'primary' : 'text'}>{status}</ThemedText></Pressable>; })}</View><View style={styles.editorActions}><Pressable onPress={() => { setSelectedStatuses(transaction.statuses); setStatusEditorOpen(false); }} style={styles.cancelButton}><ThemedText type="smallBold">Cancel</ThemedText></Pressable><Pressable accessibilityLabel="Save transaction statuses" disabled={statusMutation.isPending || selectedStatuses.length === 0} onPress={() => statusMutation.mutate()} style={[styles.saveButton, selectedStatuses.length === 0 && styles.disabled]}>{statusMutation.isPending ? <ActivityIndicator color="#FFFFFF" /> : <ThemedText type="smallBold" style={styles.white}>Save</ThemedText>}</Pressable></View></ThemedView></View>
        </Modal> : null}
        {transaction ? <Modal animationType="slide" onRequestClose={() => setConditionEditorOpen(false)} presentationStyle="pageSheet" visible={conditionEditorOpen}>
          <ThemedView style={styles.screen}><SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}><View style={[styles.header, { borderBottomColor: theme.border }]}><Pressable onPress={() => setConditionEditorOpen(false)}><ThemedText type="smallBold">Cancel</ThemedText></Pressable><ThemedText type="smallBold">Conditions</ThemedText><Pressable accessibilityLabel="Save transaction conditions" disabled={conditionMutation.isPending || Boolean(conditionDraftError(conditionDraft))} onPress={() => conditionMutation.mutate()}>{conditionMutation.isPending ? <ActivityIndicator color={theme.primary} /> : <ThemedText type="smallBold" themeColor="primary">Save</ThemedText>}</Pressable></View><ScrollView contentContainerStyle={styles.conditionContent} keyboardShouldPersistTaps="handled">
            <ThemedText type="small" themeColor="textSecondary">Add the condition name, deadline and current status. Saving an empty list marks the offer as unconditional.</ThemedText>
            {conditionDraft.map((condition, index) => <View key={`${condition.id ?? 'new'}-${index}`} style={[styles.conditionCard, { borderColor: theme.border }]}><View style={styles.conditionTop}><ThemedText type="smallBold">Condition {index + 1}</ThemedText><Pressable accessibilityLabel={`Remove condition ${index + 1}`} onPress={() => setConditionDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}><ThemedText type="smallBold" themeColor="danger">Remove</ThemedText></Pressable></View><ThemedText type="small" themeColor="textSecondary">Name</ThemedText><TextInput accessibilityLabel={`Condition ${index + 1} name`} onChangeText={(custom_name) => updateCondition(index, { custom_name })} placeholder="Financing, inspection…" placeholderTextColor={theme.textSecondary} style={[styles.input, { borderColor: theme.border, color: theme.text }]} editable={condition.type === 'Custom'} value={condition.type === 'Custom' ? condition.custom_name ?? '' : condition.custom_name || condition.type} /><ThemedText type="small" themeColor="textSecondary">Deadline (YYYY-MM-DD)</ThemedText><TextInput accessibilityLabel={`Condition ${index + 1} deadline`} autoCapitalize="none" keyboardType="numbers-and-punctuation" onChangeText={(deadline) => updateCondition(index, { deadline })} placeholder="2026-09-30" placeholderTextColor={theme.textSecondary} style={[styles.input, { borderColor: theme.border, color: theme.text }]} value={condition.deadline ?? ''} /><View style={styles.statusChoices}>{conditionStatuses.map((status) => <Pressable accessibilityRole="radio" accessibilityState={{ selected: condition.status === status }} key={status} onPress={() => updateCondition(index, { status })} style={[styles.choice, { borderColor: condition.status === status ? theme.primary : theme.border, backgroundColor: condition.status === status ? theme.primarySoft : theme.backgroundElement }]}><ThemedText type="smallBold" themeColor={condition.status === status ? 'primary' : 'text'}>{status}</ThemedText></Pressable>)}</View></View>)}
            {conditionDraftError(conditionDraft) ? <ThemedText accessibilityRole="alert" type="small" themeColor="danger">{conditionDraftError(conditionDraft)}</ThemedText> : null}
            <Pressable accessibilityLabel="Add condition" onPress={() => setConditionDraft((current) => [...current, { type: 'Custom', custom_name: '', deadline: null, status: 'Pending' }])} style={[styles.addButton, { borderColor: theme.primary }]}><ThemedText type="smallBold" themeColor="primary">+ Add condition</ThemedText></Pressable>
          </ScrollView></SafeAreaView></ThemedView>
        </Modal> : null}
      </SafeAreaView></ThemedView>
    </Modal>
  );
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) { const theme = useTheme(); return <View style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}><View style={styles.cardHeader}><ThemedText type="smallBold">{title}</ThemedText>{action}</View>{children}</View>; }
function Row({ label, value }: { label: string; value: string }) { return <View style={styles.row}><ThemedText type="small" themeColor="textSecondary">{label}</ThemedText><ThemedText type="smallBold" style={styles.rowValue}>{value}</ThemedText></View>; }
function Item({ title, detail }: { title: string; detail: string }) { const theme = useTheme(); return <View style={[styles.item, { borderTopColor: theme.border }]}><ThemedText type="smallBold">{title}</ThemedText>{detail ? <ThemedText type="small" themeColor="textSecondary">{detail}</ThemedText> : null}</View>; }
function Empty({ label }: { label: string }) { return <ThemedText type="small" themeColor="textSecondary">{label}</ThemedText>; }

const styles = StyleSheet.create({
  screen: { flex: 1 }, safe: { flex: 1 }, header: { height: 52, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: Spacing.three, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, spacer: { width: 38 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.four, gap: Spacing.three }, retry: { backgroundColor: '#5146E5', borderRadius: 12, paddingHorizontal: Spacing.three, paddingVertical: 10 }, white: { color: '#FFFFFF' }, content: { padding: Spacing.three, paddingBottom: Spacing.six, gap: Spacing.three }, hero: { paddingVertical: Spacing.three, gap: Spacing.two }, title: { fontSize: 28, lineHeight: 34, fontWeight: '800' }, statusLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two }, statuses: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two }, pill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 }, editButton: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }, card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.three, gap: Spacing.three }, cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, row: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.three }, rowValue: { flex: 1, textAlign: 'right' }, item: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Spacing.two, gap: 2 }, documentSummary: { gap: 2 }, overlay: { flex: 1, backgroundColor: 'rgba(14,18,32,0.55)', justifyContent: 'center', padding: Spacing.four }, editor: { borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.four, gap: Spacing.three }, editorTitle: { fontSize: 24, lineHeight: 30, fontWeight: '800' }, statusChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two }, choice: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10 }, editorActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: Spacing.two }, cancelButton: { paddingHorizontal: Spacing.three, paddingVertical: 12 }, saveButton: { minWidth: 90, minHeight: 44, borderRadius: 13, backgroundColor: '#5146E5', alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.three }, disabled: { opacity: 0.45 }, conditionContent: { padding: Spacing.three, paddingBottom: Spacing.six, gap: Spacing.three }, conditionCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: Spacing.three, gap: Spacing.two }, conditionTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, input: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 13, fontSize: 16 }, addButton: { borderWidth: 1, borderRadius: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});

function workspaceVisible(type:string|null,statuses:string[],section:'financial'|'team',role?:string,paid?:string|null){const listing=/Listing$/.test(type??'')||type==='Business Sale';if(!listing&&statuses.some(s=>['Void','Mutual Release'].includes(s)))return false;if(listing&&!/Lease/.test(type??'')&&statuses.includes('Terminated'))return false;return section!=='team'||!statuses.includes('Closed')||paid!=='Yes'||role==='admin';}
