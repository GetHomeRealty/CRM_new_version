import { useEffect, useState, type CSSProperties } from 'react';
import Icon from '../ui/Icon';
import {
  getDocuments, saveDocuments, uploadDocumentFile, deleteDocument,
  uploadDocClientFile, deleteDocClientFile,
  uploadDocValidationFile, deleteDocValidationFile,
  viewDocumentFile, downloadDocumentFile, viewDocClientFile, downloadDocClientFile,
  viewDocValidationFile, downloadAllDocuments, sendDocumentReminders,
} from '../lib/api';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import Form630Modal from './Form630Modal';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import type { DeskDocFile, DeskDocument, Transaction } from '../types';

const BRAND = 'var(--brand-red)';

interface DocsModalProps {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  txn?: Transaction | null;
  restrictTitles?: string[] | null;
  hideTitles?: string[];
  readOnly?: boolean;
  agentMode?: boolean;
  canDeleteConditionDocs?: boolean;
  onSaved?: (() => void) | null;
}

export default function DocsModal({ open, onClose, transactionId, txn = null, restrictTitles = null, hideTitles = [], readOnly = false, agentMode = false, canDeleteConditionDocs = false, onSaved = null }: DocsModalProps) {
  const toast = useToast();
  const { isSuperAdmin } = useAuth();
  const { confirm, askDelete, closeConfirm } = useConfirm();
  // Wrap a blob view/download so failures surface a toast instead of a dead link.
  // The doc-id passed is guaranteed present at each call site (a file exists there).
  const openFile = <A extends unknown[]>(fn: (...args: A) => Promise<unknown>, ...args: A) => fn(...args).catch(() => toast('Could not open the file', 'bad'));
  // Once a document is Valid, only a Super Admin may replace or delete it.
  const validLocked = (d: DeskDocument) => d.validation === 'Valid' && !isSuperAdmin;
  const [docs, setDocs] = useState<DeskDocument[]>([]);
  const [f630Client, setF630Client] = useState<string | null>(null); // FINTRACK → open Form 630 for this client
  // §5.1 — Mutual Release / Void limit the visible checklist to specific documents.
  const docVisible = (d: DeskDocument) => {
    const t = (d.title || '').toLowerCase();
    if (hideTitles.some((k) => t.includes(k))) return false;
    return !restrictTitles || restrictTitles.some((k) => t.includes(k));
  };
  const [clients, setClients] = useState<string[]>([]);
  // "Ready for RECO Audit" (Yes/No) + reason when No.
  const [recoReady, setRecoReady] = useState('');
  const [recoRemarks, setRecoRemarks] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const load = (showSpin = true) => {
    if (showSpin) setLoading(true);
    getDocuments(transactionId)
      .then((d) => { setDocs(d.documents || []); setClients(d.clients || []); setRecoReady(d.reco_audit_ready || ''); setRecoRemarks(d.reco_audit_remarks || ''); })
      .catch(() => toast('Could not load documents', 'bad'))
      .finally(() => setLoading(false));
  };
  /*
   * `onRestoreDeleted` and `onPurgeDeleted` were here, driving a "Deleted Documents — pending
   * review" panel further down. Both are gone with the panel: it was fed by `deleted_documents`,
   * which the API built from the `pending_delete` column, which nothing in the application ever
   * set. The panel never rendered and `restoreDocument` could not restore anything.
   *
   * Deleting a document is unchanged and still works: soft delete → Recycle Bin → a Super Admin
   * restores or destroys it.
   */
  useEffect(() => { if (open) load(); }, [open, transactionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  // Counts reflect the documents actually shown (status-restricted list), not all docs.
  const shownDocs = docs.filter(docVisible);
  const total = shownDocs.length;
  const received = shownDocs.filter((d) => d.status === 'Received').length;
  const valid = shownDocs.filter((d) => d.validation === 'Valid').length;
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;
  const pctValid = total > 0 ? Math.round((valid / total) * 100) : 0;

  const upd = (i: number, k: string, v: unknown) => setDocs((ds) => ds.map((d, idx) => idx === i ? { ...d, [k]: v } : d));

  // Agent acceptance answer. "Not Accepted" also clears any reminder on that doc.
  const setAccept = (i: number, v: string) => setDocs((ds) => ds.map((d, idx) => idx === i
    ? { ...d, agent_accepted: v, reminder: v === 'Not Accepted' ? false : d.reminder }
    : d));

  // A document is remindable only while the ball is in the AGENT'S court. Once they submit it
  // (status "Received") it is the reviewer's job to validate — a submitted doc still awaiting
  // validation is NOT chased. It becomes remindable again only if the reviewer marks it Invalid.
  // (Mirrors the backend reminder filter in documents.service.)
  const remindable = (d: DeskDocument) =>
    d.validation !== 'Valid' && d.agent_accepted !== 'Not Accepted'
    && (d.status !== 'Received' || d.validation === 'Invalid');
  const remindableDocs = shownDocs.filter(remindable);
  const allRemindersOn = remindableDocs.length > 0 && remindableDocs.every((d) => d.reminder);
  // Docs the "Send reminders now" email will actually chase.
  const flaggedReminderDocs = shownDocs.filter((d) => d.reminder && remindable(d));
  const toggleAllReminders = () => {
    const next = !allRemindersOn;
    setDocs((ds) => ds.map((d) => (remindable(d) ? { ...d, reminder: next } : d)));
  };
  const toggle = (key: string | number) => setExpanded((e) => ({ ...e, [key]: !e[key] }));
  const addDoc = () => {
    const title = newTitle.trim(); if (!title) return;
    setDocs((ds) => [...ds, { title, mandatory: false, manual: true, status: 'Pending', validation: 'Pending', drive_uploaded: null, reminder: false, remarks: '', has_file: false, kind: 'single', files: [], file_count: 0 }]);
    setNewTitle('');
  };

  // Never persist a reminder flag on a document that isn't remindable (Valid, or submitted and not
  // yet marked Invalid) — so a stale 🔔 can't linger on a doc that has moved out of the agent's court.
  const persistReminder = (d: DeskDocument) =>
    (d.validation === 'Valid' || (d.status === 'Received' && d.validation !== 'Invalid')) ? false : d.reminder;
  const docPayload = () => docs.map((d) => ({ id: d.id, title: d.title, mandatory: d.mandatory, status: d.status, validation: d.validation, drive_uploaded: d.drive_uploaded || 'No', reminder: persistReminder(d), agent_accepted: d.agent_accepted || null, remarks: d.remarks }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await saveDocuments(transactionId, docPayload(), { reco_audit_ready: recoReady || null, reco_audit_remarks: recoReady === 'No' ? recoRemarks : null });
      setDocs(res.documents || []); setClients(res.clients || []);
      setRecoReady(res.reco_audit_ready || ''); setRecoRemarks(res.reco_audit_remarks || '');
      // Refresh the parent transaction so Agent Payment Readiness' "Valid Docs Cleared" flag is never stale.
      onSaved?.();
      toast(agentMode ? 'Documents submitted — the admin team has been notified.' : 'Documents saved', 'ok');
    } catch { toast('Could not save documents', 'bad'); } finally { setSaving(false); }
  };

  // Manually email the agent the list of still-outstanding, reminder-flagged docs.
  const sendRemindersNow = async () => {
    setSaving(true);
    try {
      const res = await saveDocuments(transactionId, docPayload(), { reco_audit_ready: recoReady || null, reco_audit_remarks: recoReady === 'No' ? recoRemarks : null });
      setDocs(res.documents || []); setClients(res.clients || []);
      const r = await sendDocumentReminders(transactionId);
      toast(r.message || `Reminder sent for ${r.count} document(s).`, 'ok');
    } catch (e) { toast(apiErrorMessage(e, 'Could not send reminders'), 'bad'); } finally { setSaving(false); }
  };

  const needSaved = (doc: DeskDocument) => { if (!doc.id) { toast('Save first, then upload', 'info'); return true; } return false; };
  const onSingle = async (doc: DeskDocument, file: File | undefined) => {
    if (!file || needSaved(doc) || !doc.id) return;
    try { const r = await uploadDocumentFile(transactionId, doc.id, file); setDocs(r.documents || []); toast('File uploaded', 'ok'); }
    catch { toast('Upload failed', 'bad'); }
  };
  const onMulti = async (doc: DeskDocument, file: File | undefined, clientName?: string) => {
    if (!file || needSaved(doc) || !doc.id) return;
    try { const r = await uploadDocClientFile(transactionId, doc.id, file, clientName); setDocs(r.documents || []); toast('File uploaded', 'ok'); }
    catch { toast('Upload failed', 'bad'); }
  };
  const onRemoveFile = async (doc: DeskDocument, index: number) => {
    if (!doc.id) return;
    try { const r = await deleteDocClientFile(transactionId, doc.id, index); setDocs(r.documents || []); }
    catch { toast('Could not remove file', 'bad'); }
  };
  const onValidationFile = async (doc: DeskDocument, file: File | undefined) => {
    if (!file || needSaved(doc) || !doc.id) return;
    try { const r = await uploadDocValidationFile(transactionId, doc.id, file); setDocs(r.documents || []); toast('Attachment uploaded', 'ok'); }
    catch { toast('Upload failed', 'bad'); }
  };
  const onRemoveValidationFile = async (doc: DeskDocument) => {
    if (!doc.id) return;
    try { const r = await deleteDocValidationFile(transactionId, doc.id); setDocs(r.documents || []); }
    catch { toast('Could not remove attachment', 'bad'); }
  };
  const onDeleteRow = (doc: DeskDocument, i: number) => {
    // §6 — conditional-offer-related documents may only be deleted by a Super Admin.
    if (doc.is_condition && !canDeleteConditionDocs) { toast('Conditional-offer documents can only be deleted by a Super Admin', 'info'); return; }
    askDelete({
      title: `Delete "${doc.title}"?`,
      message: 'This document will be removed. A Super Admin can restore it from the Recycle Bin.',
      linked: doc.has_file ? ['The uploaded file for this document'] : [],
      onConfirm: async () => {
        if (doc.id) { try { await deleteDocument(doc.id); } catch { /* ignore */ } }
        setDocs((ds) => ds.filter((_, idx) => idx !== i));
        toast('Document deleted', 'ok');
      },
    });
  };

  const sel: CSSProperties = { width: '100%' };
  const fileById = (doc: DeskDocument, name: string): DeskDocFile | undefined => (doc.files || []).find((f) => f.client_name === name);
  // Title · Upload · Status · Validation · View/Download · [Uploaded to Drive · Replace · Delete].
  const COLS = agentMode ? '2.2fr 1.2fr 105px 105px 105px 85px' : '2.2fr 1.2fr 105px 105px 105px 110px 85px 55px';
  const hCell: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.03em' };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}><Icon name="close" size={15} /></button>
        <div className="modal-h" style={{ marginBottom: 4 }}>Legal &amp; Documentation</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 16px 12px' }}>Track receipt &amp; validation of every required document for this transaction.</div>

        {readOnly && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: 'var(--info-bg)', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--info-ink)' }}><Icon name="lock" size={13} /> View-only — click <strong>Edit</strong> on the transaction to change documents. (View &amp; download remain available.)</span>
          </div>
        )}


        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 12, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Documents Received</strong>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>{received} / {total} received ({pct}%)</span>
            </div>
            <div style={{ background: 'var(--surface-3)', height: 10, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#10b981,#059669)' }} />
            </div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 12, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Valid Documents</strong>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>{valid} / {total} valid ({pctValid}%)</span>
            </div>
            <div style={{ background: 'var(--surface-3)', height: 10, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pctValid}%`, background: 'linear-gradient(90deg,#3b82f6,#2563eb)' }} />
            </div>
          </div>
        </div>

        <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>

        {/* Ready for RECO Audit — Yes/No; a "No" requires a reason. Admins only. */}
        {!agentMode && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderLeft: `4px solid ${BRAND}`, borderRadius: 'var(--r-md)', padding: 14, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>Ready for RECO Audit</strong>
            <select value={recoReady} disabled={agentMode} onChange={(e) => setRecoReady(e.target.value)} style={{ width: 150 }}>
              <option value="">Select</option>
              <option>Yes</option>
              <option>No</option>
            </select>
            {recoReady === 'Yes' && <span className="pill ok" style={{ fontSize: 11 }}><Icon name="check" size={11} /> Audit-ready</span>}
            {recoReady === 'No' && <span className="pill bad" style={{ fontSize: 11 }}>Not audit-ready</span>}
          </div>
          {recoReady === 'No' && (
            <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
              <label style={{ fontSize: 12, color: 'var(--muted)' }}>Reason — why isn't this file ready for the RECO audit?</label>
              <textarea rows={2} value={recoRemarks} disabled={agentMode} onChange={(e) => setRecoRemarks(e.target.value)} placeholder="Enter the reason…" style={{ width: '100%' }} />
            </div>
          )}
        </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <strong>Document List</strong>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {docs.some((d) => d.has_file || (d.file_count || 0) > 0) && (
              <button type="button" className="btn ghost sm" title="Download every uploaded document for this transaction as a ZIP"
                onClick={() => openFile(downloadAllDocuments, transactionId)}>
                <Icon name="package" size={13} /> Download all
              </button>
            )}
            {!agentMode && remindableDocs.length > 0 && (
              <button className="btn ghost sm" onClick={toggleAllReminders}
                title="Select every pending or invalid document for automated email reminders">
                <Icon name="bell" size={13} /> {allRemindersOn ? 'Clear all reminders' : 'Remind all pending / invalid'}
              </button>
            )}
            {!agentMode && flaggedReminderDocs.length > 0 && (
              <button className="btn ghost sm" onClick={sendRemindersNow} disabled={saving}
                title="Email the agent now with every reminder-flagged document still outstanding">
                <Icon name="mail" size={13} /> Send reminders now ({flaggedReminderDocs.length})
              </button>
            )}
            <input placeholder="Document name" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} style={{ width: 200 }} />
            <button className="btn primary sm" onClick={addDoc}>+ Add</button>
          </div>
        </div>

        {!loading && docs.some(docVisible) && (
          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 8, alignItems: 'center', padding: '6px 12px', borderBottom: '2px solid var(--line)' }}>
            <div style={hCell}>Title</div>
            <div style={hCell}>Upload</div>
            <div style={hCell}>Status</div>
            <div style={hCell}>Validation</div>
            <div style={{ ...hCell, textAlign: 'center' }}>View / Download</div>
            {!agentMode && <div style={{ ...hCell, textAlign: 'center' }}>Uploaded to Drive</div>}
            <div style={{ ...hCell, textAlign: 'center' }}>Replace</div>
            {!agentMode && <div style={{ ...hCell, textAlign: 'center' }}>Delete</div>}
          </div>
        )}
        {loading ? <div className="centered">Loading…</div> : docs.map((d, i) => {
          if (!docVisible(d)) return null;
          const key = d.id ?? `new-${i}`;
          const open2 = !!expanded[key];
          const expandable = d.kind === 'multi' || d.kind === 'per_client';
          const single = d.kind === 'single' || d.kind === 'condition';
          // Agent marked this doc "Not Accepted" → uploads (and reminders) are disabled for everyone.
          const notAccepted = d.agent_accepted === 'Not Accepted';
          const uploadBlocked = notAccepted;
          return (
            <div key={key} className={`doc-row ${d.is_condition ? 'cond' : (d.status === 'Received' ? 'rcv' : 'pend')}`}>
              <div className="doc-head" style={{ gridTemplateColumns: COLS }}>
                {/* Title */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {expandable
                    ? <button className="row-rm" style={{ color: BRAND }} onClick={() => toggle(key)}>{open2 ? <Icon name="chevronDown" size={12} /> : <Icon name="chevronRight" size={12} />}</button>
                    : <span style={{ width: 14 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: BRAND, lineHeight: 1.3, wordBreak: 'break-word' }}>{d.title}</div>
                    {d.is_condition && d.deadline && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Deadline: {d.deadline}</div>}
                    {d.is_condition && <span className="pill warn" style={{ fontSize: 9, padding: '1px 5px' }}>Condition</span>}
                    {/* No reminder option once a doc is submitted and awaiting validation — only a
                        still-missing or reviewer-rejected (Invalid) doc is the agent's to chase. */}
                    {!agentMode && d.validation !== 'Valid' && (d.status !== 'Received' || d.validation === 'Invalid') && (
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: notAccepted ? 'var(--muted-2)' : (d.reminder ? 'var(--warn-700)' : 'var(--muted)'), marginTop: 3, cursor: (readOnly || notAccepted) ? 'default' : 'pointer' }} title={notAccepted ? 'Reminders are off — this document was not accepted by the agent' : 'Include this document in automated pending-document email reminders'}>
                        <input type="checkbox" checked={!!d.reminder && !notAccepted} disabled={readOnly || notAccepted} onChange={(e) => upd(i, 'reminder', e.target.checked)} /> <Icon name="bell" size={12} /> Reminder
                      </label>
                    )}
                    {/* Agent acceptance — only for manually-added ("+ Add") documents. */}
                    {d.manual && !d.is_condition && agentMode && (
                      <div style={{ marginTop: 4 }}>
                        <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Accept this document?</label>
                        <select value={d.agent_accepted || ''} onChange={(e) => setAccept(i, e.target.value)} style={{ fontSize: 12, padding: '3px 6px' }}>
                          <option value="">Pending</option>
                          <option value="Accepted">✔ Accepted</option>
                          <option value="Not Accepted">✖ Not Accepted</option>
                        </select>
                      </div>
                    )}
                    {/* Admins see the agent's answer (manual docs only). */}
                    {d.manual && !d.is_condition && !agentMode && d.agent_accepted && (
                      <span className={`pill ${d.agent_accepted === 'Accepted' ? 'ok' : 'bad'}`} style={{ fontSize: 9, padding: '1px 6px', marginTop: 3, display: 'inline-block' }}>
                        {d.agent_accepted === 'Accepted' ? <><Icon name="check" size={12} /> Accepted by agent</> : <><Icon name="close" size={12} /> Not accepted by agent</>}
                      </span>
                    )}
                  </div>
                </div>
                {/* Upload — disabled while the agent hasn't accepted the document. */}
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  {uploadBlocked ? (
                    <span style={{ fontSize: 11, color: 'var(--muted-2)' }}><Icon name="alert" size={11} /> Upload disabled (not accepted)</span>
                  ) : (<>
                    {d.kind === 'multi' && <span><Icon name="doc" size={11} /> Multiple files</span>}
                    {d.kind === 'per_client' && <span><Icon name="users" size={11} /> Per-client uploads</span>}
                    {single && (d.has_file
                      ? <span style={{ fontSize: 11.5, color: 'var(--ok-600)', fontWeight: 600 }}><Icon name="check" size={11} /> Uploaded</span>
                      : validLocked(d)
                        ? <span style={{ fontSize: 11, color: 'var(--muted-2)' }} title="Marked Valid — only a Super Admin can upload over it"><Icon name="lock" size={11} /> Locked (Valid)</span>
                        : <input type="file" onChange={(e) => { onSingle(d, e.target.files?.[0]); e.target.value = ''; }} style={{ fontSize: 12 }} />)}
                  </>)}
                </div>
                {/* Status / Validation — agents may view but not change these. */}
                {agentMode ? (
                  <div style={{ ...sel, boxSizing: 'border-box', padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface-2)', fontSize: 12.5, ...(d.status === 'Received' ? { color: 'var(--ok-600)', fontWeight: 700 } : { color: 'var(--muted)' }) }}>
                    {d.status === 'Received' ? 'Sent' : 'Pending'}
                  </div>
                ) : (
                  <select style={{ ...sel, ...(d.status === 'Received' ? { color: 'var(--ok-600)', fontWeight: 700 } : null) }}
                    value={d.status} onChange={(e) => upd(i, 'status', e.target.value)}>
                    <option>Pending</option><option>Received</option>
                  </select>
                )}
                {d.status === 'Received'
                  ? <select
                      disabled={agentMode}
                      style={{ ...sel, ...(d.validation === 'Valid' ? { color: 'var(--ok-600)', fontWeight: 700 } : d.validation === 'Invalid' ? { color: 'var(--bad)', fontWeight: 700 } : null), ...(agentMode ? { background: 'var(--surface-2)' } : null) }}
                      value={!d.validation || d.validation === 'Pending' ? 'Pending' : d.validation}
                      onChange={(e) => {
                        const v = e.target.value;
                        // Selecting "Valid" (each time) resets Uploaded to Drive to No until explicitly chosen.
                        setDocs((ds) => ds.map((doc, idx) => idx === i
                          ? { ...doc, validation: v, ...(v === 'Valid' ? { drive_uploaded: 'No' } : {}) }
                          : doc));
                      }}>
                      <option>Pending</option><option>Valid</option><option>Invalid</option>
                    </select>
                  : <span style={{ fontSize: 12.5, color: 'var(--muted-2)', textAlign: 'center' }}>N/A</span>}
                {/* View (in-browser) + Download */}
                <div style={{ fontSize: 12.5, textAlign: 'center' }}>
                  {expandable
                    ? <span style={{ color: 'var(--muted)' }}>{d.file_count} file(s)</span>
                    : (d.has_file
                      ? <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                          <button type="button" className="btn ghost sm" title="View" onClick={() => openFile(viewDocumentFile, d.id!)}><Icon name="eye" size={14} /></button>
                          <button type="button" className="btn ghost sm" title="Download" onClick={() => openFile(downloadDocumentFile, d.id!)}><Icon name="download" size={14} /></button>
                        </div>
                      : <span style={{ color: 'var(--muted-2)' }}>—</span>)}
                </div>
                {/* Uploaded to Drive — Yes/No radio (admins only). Only offered once Valid. */}
                {!agentMode && (
                  d.validation === 'Valid' ? (
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', fontSize: 12 }}>
                      {['Yes', 'No'].map((opt) => {
                        const selected = (d.drive_uploaded || 'No') === opt;
                        const color = selected ? (opt === 'Yes' ? 'var(--ok-600)' : 'var(--bad)') : 'var(--muted-2)';
                        return (
                          <label key={opt} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: readOnly ? 'default' : 'pointer', color, fontWeight: selected ? 700 : 400 }}>
                            <input type="radio" name={`drive-${d.id ?? 'n' + i}`} checked={selected} disabled={readOnly} onChange={() => upd(i, 'drive_uploaded', opt)} style={{ accentColor: opt === 'Yes' ? 'var(--ok-600)' : 'var(--bad)' }} />{opt}
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', color: 'var(--muted-2)', fontSize: 12 }} title="Available once the document is marked Valid">—</div>
                  )
                )}
                {/* Replace — shown only while a file exists and is NOT yet Valid. */}
                <div style={{ textAlign: 'center' }}>
                  {/*
                    `validLocked`, not `validation !== 'Valid'`. The backend lets a Super Admin
                    replace a document marked Valid (`documents.override-valid`); the old test hid
                    the control from them too, so the one role that may do it could not. Everyone
                    else sees the padlock and is told why, instead of discovering it through a 403.
                  */}
                  {single && d.has_file && !uploadBlocked && !validLocked(d)
                    ? <label className="btn ghost sm" style={{ cursor: 'pointer' }}>Replace
                        <input type="file" style={{ display: 'none' }} onChange={(e) => { onSingle(d, e.target.files?.[0]); e.target.value = ''; }} /></label>
                    : <span style={{ color: 'var(--muted-2)' }} title={validLocked(d) ? 'Marked Valid — only a Super Admin can replace it' : undefined}>{validLocked(d) && d.has_file ? <Icon name="lock" size={12} /> : '—'}</span>}
                </div>
                {/* Delete — admins only (hidden for agents); locked to Super Admin once Valid. */}
                {!agentMode && (
                  <div style={{ textAlign: 'center' }}>
                    {((d.is_condition && !canDeleteConditionDocs) || validLocked(d))
                      ? <span style={{ color: 'var(--muted-2)', fontSize: 11 }} title={validLocked(d) ? 'Valid — only a Super Admin can delete' : undefined}>{validLocked(d) ? '🔒' : '—'}</span>
                      : <button className="row-rm" disabled={readOnly} onClick={() => onDeleteRow(d, i)}><Icon name="trash" size={13} /></button>}
                  </div>
                )}
              </div>

              {/* Expanded: per-client or multi-file uploads */}
              {open2 && d.kind === 'per_client' && (
                <div style={{ background: 'var(--surface-2)', borderTop: '1px solid var(--line)', padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong style={{ fontSize: 12.5 }}><Icon name="users" size={12} /> {d.title} — by Client</strong>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>Each upload is mapped to its respective client name.</span>
                  </div>
                  {clients.length === 0 && <div className="help">No clients on this transaction yet.</div>}
                  {clients.map((name) => {
                    const file = fileById(d, name);
                    // FINTRACK doesn't store client ID files — each client gets their OREA Form 630.
                    const isFintrack = (d.title || '').toLowerCase().includes('fintrac');
                    return (
                      <div key={name} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 10, alignItems: 'center', border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 6, background: '#fff' }}>
                        <div><div style={{ fontSize: 11, color: 'var(--muted)' }}>Client Name</div><strong>{name}</strong></div>
                        {isFintrack ? (
                          <>
                            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Fill and download this client's OREA Form 630.</div>
                            <div style={{ textAlign: 'right' }}>
                              {txn && <button className="btn ghost sm" title="Open this client's Form 630" onClick={() => setF630Client(name)}><Icon name="doc" size={13} /> Form 630</button>}
                            </div>
                          </>
                        ) : (
                          <>
                            <div><div style={{ fontSize: 11, color: 'var(--muted)' }}>Upload</div>
                              <input type="file" disabled={uploadBlocked || validLocked(d)} onChange={(e) => { onMulti(d, e.target.files?.[0], name); e.target.value = ''; }} style={{ fontSize: 12 }} />
                              {file && <span style={{ fontSize: 11, color: 'var(--ok)', marginLeft: 6 }}>✓ {file.file_name}</span>}
                              {validLocked(d) && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }} title="Valid — only a Super Admin can replace">🔒 locked</span>}</div>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              {file ? <>
                                <button type="button" className="btn ghost sm" title="View" onClick={() => openFile(viewDocClientFile, d.id!, file.index)}>👁</button>
                                <button type="button" className="btn ghost sm" title="Download" onClick={() => openFile(downloadDocClientFile, d.id!, file.index)}>⬇</button>
                                {!agentMode && !validLocked(d) && <button className="row-rm" onClick={() => onRemoveFile(d, file.index)}>🗑️</button>}
                              </> : <span style={{ color: 'var(--muted-2)', fontSize: 12 }}>—</span>}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {open2 && d.kind === 'multi' && (
                <div style={{ background: 'var(--surface-2)', borderTop: '1px solid var(--line)', padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong style={{ fontSize: 12.5 }}>📎 {d.title} — files</strong>
                    {uploadBlocked
                      ? <span style={{ fontSize: 11, color: 'var(--muted-2)' }}><Icon name="alert" size={11} /> Upload disabled (not accepted)</span>
                      : validLocked(d)
                        ? <span style={{ fontSize: 11, color: 'var(--muted-2)' }} title="Marked Valid — only a Super Admin can add to it"><Icon name="lock" size={11} /> Locked (Valid)</span>
                        : <label className="btn primary sm" style={{ cursor: 'pointer' }}>+ Add File
                            <input type="file" style={{ display: 'none' }} onChange={(e) => { onMulti(d, e.target.files?.[0]); e.target.value = ''; }} /></label>}
                  </div>
                  {(d.files || []).length === 0 && <div className="help">No files added yet.</div>}
                  {(d.files || []).map((file) => (
                    <div key={file.index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', marginBottom: 6, background: '#fff' }}>
                      <span style={{ fontSize: 13 }}>{file.file_name}</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button type="button" className="btn ghost sm" onClick={() => openFile(viewDocClientFile, d.id!, file.index)}>👁 View</button>
                        <button type="button" className="btn ghost sm" onClick={() => openFile(downloadDocClientFile, d.id!, file.index)}>⬇</button>
                        {!agentMode && <button className="row-rm" onClick={() => onRemoveFile(d, file.index)}>🗑️</button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {d.validation === 'Invalid' && (
                <div style={{ background: 'var(--brand-soft)', borderTop: '1px solid var(--line)', padding: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, display: 'block', marginBottom: 4 }}>⚠ Reason for Invalid</label>
                  {/* Agents may read the reason & attachment but not change them. */}
                  <textarea rows={2} value={d.remarks || ''} readOnly={agentMode} onChange={(e) => upd(i, 'remarks', e.target.value)} placeholder="Describe why this document is invalid…" style={{ background: agentMode ? 'var(--surface-2)' : '#fff', width: '100%' }} />
                  <label style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, display: 'block', margin: '8px 0 4px' }}>Attachment</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {!agentMode && <input type="file" onChange={(e) => { onValidationFile(d, e.target.files?.[0]); e.target.value = ''; }} style={{ fontSize: 12 }} />}
                    {d.has_validation_file
                      ? <>
                        <button type="button" className="btn ghost sm" onClick={() => openFile(viewDocValidationFile, d.id!)}>👁 {d.validation_file_name || 'View'}</button>
                        {!agentMode && <button className="row-rm" onClick={() => onRemoveValidationFile(d)}>🗑️</button>}
                      </>
                      : (agentMode && <span style={{ fontSize: 12, color: 'var(--muted)' }}>No attachment.</span>)}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        </fieldset>

        {/*
          A "Deleted Documents — pending review" panel used to sit here, with Restore and Delete
          permanently for documents an agent had removed. It never rendered: `deleted_documents` was
          built from the `pending_delete` column, and nothing in the application ever set it.
          Removed rather than wired up — document deletion already has a working route (soft delete
          → Recycle Bin → Super Admin restores or destroys), and a second review queue beside it
          would be new workflow rather than a repair.
        */}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {!readOnly && <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>}
        </div>
      </div>

      {f630Client && txn && (
        <Form630Modal open onClose={() => setF630Client(null)} txn={txn} clientName={f630Client} />
      )}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </div>
  );
}
