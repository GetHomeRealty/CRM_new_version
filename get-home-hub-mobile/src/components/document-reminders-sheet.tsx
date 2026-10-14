import { useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMobileAuth } from '@/auth/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { canDocumentReminders, fetchReminderPreview, saveReminderFlags, recoverReminder, RejectedReminderSendError, UnconfirmedReminderChangeError, type ReminderReceipt } from '@/transactions/document-reminder-api';
import { readReminderAttempt, guardedReminderSend, clearConfirmedReminder, type ReminderAttempt } from '@/transactions/document-reminder-guard';
import { ThemedText } from './themed-text';
export function DocumentRemindersSheet({ transactionId, onClose }: { transactionId: number; onClose: () => void }) {
 const {token,user}=useMobileAuth(); if(!token||typeof user?.id!=='number'||!Number.isSafeInteger(user.id)||!canDocumentReminders(user))return null;
 return <DocumentReminderEditor key={`${user.id}:${transactionId}:${user.role}:${user.permissions?.transactions}`} transactionId={transactionId} onClose={onClose}/>;
}
function DocumentReminderEditor({ transactionId, onClose }: { transactionId: number; onClose: () => void }) {
 const { token, user } = useMobileAuth(), theme = useTheme(), client = useQueryClient(); const view = Boolean(token && canDocumentReminders(user)), edit = view && canDocumentReminders(user, true);
 const auth = useRef({ token, user, view, edit }), active = useRef<AbortController | null>(null), locked = useRef(false), blocked = useRef(false), mounted = useRef(true);
 const [busy,setBusy] = useState(false), [needsRefresh,setNeedsRefresh] = useState(false), [error,setError] = useState(''), [loaded,setLoaded] = useState(false), [attempt,setAttempt] = useState<ReminderAttempt | null>(null), [receipt,setReceipt] = useState<ReminderReceipt | null>(null);
 const query = useQuery({ queryKey: ['document-reminders', transactionId,user?.id,user?.role], queryFn: ({ signal }) => fetchReminderPreview(token!,transactionId,signal), enabled:view,refetchOnMount:'always' });
 useLayoutEffect(() => { if (auth.current.token !== token || auth.current.user?.role !== user?.role || !view || (auth.current.edit && !edit)) active.current?.abort(); auth.current={token,user,view,edit}; },[token,user,view,edit]);
 const currentUserId=user?.id;
 useLayoutEffect(() => {let cancelled=false;void readReminderAttempt(currentUserId??0,transactionId).then(value=>{if(!cancelled)setAttempt(value);}).catch(caught=>{if(!cancelled){blocked.current=true;setNeedsRefresh(true);setError((caught as Error).message);}}).finally(()=>{if(!cancelled)setLoaded(true);});return()=>{cancelled=true;};},[currentUserId,transactionId]);
 useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;active.current?.abort();};},[]);
 const run = async(kind:'flag'|'clear'|'send'|'recover'|'new',startToken:string,startRole:string,version:string) => {
  if (!mounted.current || locked.current || !auth.current.view || auth.current.token!==startToken || auth.current.user?.role!==startRole || (kind!=='recover' && !auth.current.edit) || (blocked.current && !['recover','new'].includes(kind)))return;
  const principal=auth.current.user!,principalId=principal.id;if(typeof principalId!=='number'||!Number.isSafeInteger(principalId)||principalId<1){setError('Verified account required.');return;}
  locked.current=true;setBusy(true);setError(''); const controller=new AbortController();active.current=controller;
  try {
   if(kind==='flag'||kind==='clear') {await saveReminderFlags(startToken,principal,transactionId,kind==='flag',version,controller.signal); if(!controller.signal.aborted){await client.invalidateQueries({queryKey:['document-reminders',transactionId]});await client.invalidateQueries({queryKey:['transaction-documents',transactionId]});}}
   else if(kind==='send') {const saved=await guardedReminderSend(startToken,principal,transactionId,version,controller.signal); if(!controller.signal.aborted&&mounted.current){const stored=await readReminderAttempt(principalId,transactionId);if(!controller.signal.aborted&&mounted.current){setReceipt(saved);setAttempt(stored);}}}
   else if(kind==='recover') {const saved=await readReminderAttempt(principalId,transactionId);if(!saved)throw new Error('No saved send.'); const result=await recoverReminder(startToken,transactionId,saved.request_id,controller.signal); if(!controller.signal.aborted&&mounted.current){setAttempt(saved);setReceipt(result);}}
   else {await clearConfirmedReminder(startToken,principalId,transactionId,controller.signal);if(!controller.signal.aborted&&mounted.current){setAttempt(null);setReceipt(null);blocked.current=false;setNeedsRefresh(false);await query.refetch();}}
  }catch(caught){if(!controller.signal.aborted&&mounted.current){if(kind==='send'){try{const stored=await readReminderAttempt(principalId,transactionId);if(!controller.signal.aborted&&mounted.current)setAttempt(stored);}catch{blocked.current=true;setNeedsRefresh(true);}}if(caught instanceof RejectedReminderSendError)await query.refetch();if(caught instanceof UnconfirmedReminderChangeError && kind!=='recover'){blocked.current=true;setNeedsRefresh(true);}setError(caught instanceof Error?caught.message:'Could not update reminders.');}}
  finally{active.current=null;locked.current=false;if(mounted.current)setBusy(false);}
 };
 const confirm=(kind:'flag'|'clear'|'send'|'new')=>{
  if(!token||!user||!edit||busy||!loaded||query.isFetching||query.isError||!query.data||(needsRefresh&&kind!=='new'))return;
  const s=query.data, flagged=s.documents.filter(doc=>doc.eligible&&doc.flagged); if(kind==='send'&&(!s.can_send||attempt))return;
  const message=kind==='flag'?'Flag visible pending/invalid documents that can be reminded. Valid, submitted and Not Accepted documents remain unflagged. No email is sent.':kind==='clear'?'Clear reminder flags on the visible checklist. No email is sent.':kind==='new'?'The last send was accepted by the mail transport. Prepare a separate reminder? You must review and confirm it again.':`${flagged.map(doc=>`${doc.title}${doc.validation==='Invalid'?` — Invalid: ${doc.remarks||'no reason recorded'}`:''}`).join('\n')}\n\nTo: ${s.recipients.map(person=>`${person.name} <${person.email}>`).join(', ')}\nFrom: ${s.sender}\nSubject: ${s.subject}${s.attachments.length?`\nTemplate attachments: ${s.attachments.map(file=>file.name).join(', ')}`:''}`;
  const startToken=token,startRole=user.role,version=kind==='send'?s.send_version:s.flag_version;
  Alert.alert(kind==='send'?'Send document reminder?':'Confirm reminder action',message,[{text:'Cancel',style:'cancel'},{text:kind==='send'?'Send reminder':kind==='new'?'Prepare another':'Apply flags',onPress:()=>{void run(kind,startToken,startRole,version);}}]);
 };
 if(!view)return null;
 return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaView style={{flex:1,padding:16,backgroundColor:theme.background}}><ScrollView contentContainerStyle={{gap:14}}>
 <ThemedText type="subtitle">Document reminders</ThemedText><Pressable accessibilityRole="button" onPress={onClose} style={{padding:12}}><ThemedText>Close</ThemedText></Pressable>
 {query.isFetching||busy||!loaded?<ActivityIndicator accessibilityLabel="Loading reminders"/>:null}
 {query.isError?<ThemedText accessibilityRole="alert" themeColor="danger">{query.error.message}</ThemedText>:null}
 {!query.isFetching&&!query.isError&&query.data?<>
 {query.data.documents.map(doc=><ThemedText key={doc.id}>{doc.flagged&&doc.eligible?'🔔 ':''}{doc.title} · {doc.status} · {doc.validation}{!doc.eligible?' · Not remindable':''}</ThemedText>)}
 {edit?<><Pressable accessibilityRole="button" accessibilityLabel="Flag all remindable documents" disabled={busy||needsRefresh||!loaded} onPress={()=>confirm('flag')} style={{padding:12}}><ThemedText>Flag all remindable</ThemedText></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Clear all document reminder flags" disabled={busy||needsRefresh||!loaded} onPress={()=>confirm('clear')} style={{padding:12}}><ThemedText>Clear all flags</ThemedText></Pressable></>:null}
 {query.data.disabled_reason?<ThemedText>{query.data.disabled_reason}</ThemedText>:null}
 {query.data.recipients.map(person=><ThemedText key={person.id}>{person.name} · {person.email}</ThemedText>)}
 {edit?<Pressable accessibilityRole="button" accessibilityLabel="Confirm document reminder send" disabled={busy||needsRefresh||!loaded||!!attempt||!query.data.can_send} onPress={()=>confirm('send')} style={{padding:12}}><ThemedText>Review and send reminder</ThemedText></Pressable>:null}
 </>:null}
 {attempt?<><ThemedText>Saved send {attempt.request_id}. Do not resend while its outcome is unresolved.</ThemedText><Pressable accessibilityRole="button" accessibilityLabel="Recover saved document reminder" disabled={busy} onPress={()=>{if(token&&user)void run('recover',token,user.role,'');}} style={{padding:12}}><ThemedText>Recover saved status</ThemedText></Pressable></>:null}
 {receipt?<ThemedText>{receipt.status==='sent'?'Accepted by mail transport':receipt.status==='sending'?'Sending or interrupted; check provider before any resend':'Delivery unconfirmed; check provider, do not resend'} · {receipt.document_count} documents · {receipt.recipient_count} recipients</ThemedText>:null}
 {receipt?.status==='sent'&&edit?<Pressable accessibilityRole="button" accessibilityLabel="Prepare another document reminder" disabled={busy} onPress={()=>confirm('new')} style={{padding:12}}><ThemedText>Prepare another reminder</ThemedText></Pressable>:null}
 {error?<ThemedText accessibilityRole="alert" themeColor="danger">{error}</ThemedText>:null}
 </ScrollView></SafeAreaView></Modal>;
}
