import { useEffect, useState } from 'react';
import {
  getDocuments, saveDocuments, uploadDocumentFile, deleteDocument, restoreDocument, documentFileUrl,
  uploadDocClientFile, deleteDocClientFile, docClientFileUrl,
  uploadDocValidationFile, deleteDocValidationFile, docValidationFileUrl, documentsDownloadAllUrl,
} from '../lib/api';
import { extractClientIdentification } from '../lib/api';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import Form630Modal from './Form630Modal';

const BRAND = '#c8102e';

export default function DocsModal({ open, onClose, transactionId, txn = null, restrictTitles = null, hideTitles = [], readOnly = false, agentMode = false, canDeleteConditionDocs = false, canReviewDeleted = false }) {
  const toast = useToast();
  const { isSuperAdmin } = useAuth();
  // Once a document is Valid, only a Super Admin may replace or delete it.
  const validLocked = (d) => d.validation === 'Valid' && !isSuperAdmin;
  const [docs, setDocs] = useState([]);
  const [f630Client, setF630Client] = useState(null); // FINTRAC → view Form 630 for this client
  const [extracting, setExtracting] = useState({});   // clientName → true while ID extraction runs
  const [deletedDocs, setDeletedDocs] = useState([]); // agent-flagged deletions (admin review)
  // §5.1 — Mutual Release / Void limit the visible checklist to specific documents.
  // hideTitles blacklists titles regardless of the whitelist (e.g. the Mutual
  // Release doc must only ever appear while the status is Mutual Release).
  const docVisible = (d) => {
    const t = (d.title || '').toLowerCase();
    if (hideTitles.some((k) => t.includes(k))) return false;
    return !restrictTitles || restrictTitles.some((k) => t.includes(k));
  };
  const [clients, setClients] = useState([]);
  // "Ready for RECO Audit" (Yes/No) + reason when No.
  const [recoReady, setRecoReady] = useState('');
  const [recoRemarks, setRecoRemarks] = useState('');
  const [expanded, setExpanded] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const load = (showSpin = true) => {
    if (showSpin) setLoading(true);
    getDocuments(transactionId)
      .then((d) => { setDocs(d.documents); setClients(d.clients || []); setDeletedDocs(d.deleted_documents || []); setRecoReady(d.reco_audit_ready || ''); setRecoRemarks(d.reco_audit_remarks || ''); })
      .catch(() => toast('Could not load documents', 'bad'))
      .finally(() => setLoading(false));
  };
  const onRestoreDeleted = async (doc) => {
    try { await restoreDocument(doc.id); toast('Document restored', 'ok'); load(false); }
    catch { toast('Could not restore', 'bad'); }
  };
  const onPurgeDeleted = async (doc) => {
    if (!window.confirm(`Permanently delete "${doc.title}"? This cannot be undone.`)) return;
    try { await deleteDocument(doc.id); toast('Document permanently deleted', 'ok'); load(false); }
    catch { toast('Could not delete', 'bad'); }
  };
  useEffect(() => { if (open) load(); }, [open, transactionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  // Counts reflect the documents actually shown (status-restricted list), not all docs.
  const shownDocs = docs.filter(docVisible);
  const total = shownDocs.length;
  const received = shownDocs.filter((d) => d.status === 'Received').length;
  const pending = total - received;
  const valid = shownDocs.filter((d) => d.validation === 'Valid').length;
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;
  const pctValid = total > 0 ? Math.round((valid / total) * 100) : 0;

  const upd = (i, k, v) => setDocs((ds) => ds.map((d, idx) => idx === i ? { ...d, [k]: v } : d));

  // Agent acceptance answer. "Not Accepted" also clears any reminder on that doc
  // (uploads + reminders are disabled while a doc is not accepted).
  const setAccept = (i, v) => setDocs((ds) => ds.map((d, idx) => idx === i
    ? { ...d, agent_accepted: v, reminder: v === 'Not Accepted' ? false : d.reminder }
    : d));

  // "Select all pending" reminder toggle: turn reminders on for every pending doc,
  // or clear them all if every pending doc is already selected.
  // Not-accepted docs are excluded — they never get reminders.
  const pendingDocs = shownDocs.filter((d) => d.status !== 'Received' && d.agent_accepted !== 'Not Accepted');
  const allPendingReminders = pendingDocs.length > 0 && pendingDocs.every((d) => d.reminder);
  const toggleAllPendingReminders = () => {
    const next = !allPendingReminders;
    setDocs((ds) => ds.map((d) => (d.status !== 'Received' && d.agent_accepted !== 'Not Accepted') ? { ...d, reminder: next } : d));
  };
  const toggle = (key) => setExpanded((e) => ({ ...e, [key]: !e[key] }));
  const addDoc = () => {
    const title = newTitle.trim(); if (!title) return;
    setDocs((ds) => [...ds, { title, mandatory: false, manual: true, status: 'Pending', validation: 'Pending', drive_uploaded: null, reminder: false, remarks: '', has_file: false, kind: 'single', files: [], file_count: 0 }]);
    setNewTitle('');
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = docs.map((d) => ({ id: d.id, title: d.title, mandatory: d.mandatory, status: d.status, validation: d.validation, drive_uploaded: d.drive_uploaded || 'No', reminder: d.reminder, agent_accepted: d.agent_accepted || null, remarks: d.remarks }));
      const res = await saveDocuments(transactionId, payload, { reco_audit_ready: recoReady || null, reco_audit_remarks: recoReady === 'No' ? recoRemarks : null });
      setDocs(res.documents); setClients(res.clients || []);
      setRecoReady(res.reco_audit_ready || ''); setRecoRemarks(res.reco_audit_remarks || '');
      toast('Documents saved', 'ok');
    } catch { toast('Could not save documents', 'bad'); } finally { setSaving(false); }
  };

  const needSaved = (doc) => { if (!doc.id) { toast('Save first, then upload', 'info'); return true; } return false; };
  const onSingle = async (doc, file) => {
    if (!file || needSaved(doc)) return;
    try { const r = await uploadDocumentFile(transactionId, doc.id, file); setDocs(r.documents); toast('File uploaded', 'ok'); }
    catch { toast('Upload failed', 'bad'); }
  };
  const onMulti = async (doc, file, clientName) => {
    if (!file || needSaved(doc)) return;
    let uploaded = false;
    try { const r = await uploadDocClientFile(transactionId, doc.id, file, clientName); setDocs(r.documents); uploaded = true; toast('File uploaded', 'ok'); }
    catch { toast('Upload failed', 'bad'); }
    // FINTRAC: after the ID saves, auto-extract identity fields for Form 630 (non-blocking).
    if (uploaded && clientName && (doc.title || '').toLowerCase().includes('fintrac')) {
      setExtracting((s) => ({ ...s, [clientName]: true }));
      try {
        const ex = await extractClientIdentification(transactionId, clientName, doc.id);
        toast(ex.message || (ex.ok ? 'ID details extracted' : 'Enter the ID details manually'), ex.ok ? 'ok' : 'info');
      } catch { toast('Could not auto-read the ID — enter the details manually', 'info'); }
      finally { setExtracting((s) => ({ ...s, [clientName]: false })); }
    }
  };
  const onRemoveFile = async (doc, index) => {
    try { const r = await deleteDocClientFile(transactionId, doc.id, index); setDocs(r.documents); }
    catch { toast('Could not remove file', 'bad'); }
  };
  const onValidationFile = async (doc, file) => {
    if (!file || needSaved(doc)) return;
    try { const r = await uploadDocValidationFile(transactionId, doc.id, file); setDocs(r.documents); toast('Attachment uploaded', 'ok'); }
    catch { toast('Upload failed', 'bad'); }
  };
  const onRemoveValidationFile = async (doc) => {
    try { const r = await deleteDocValidationFile(transactionId, doc.id); setDocs(r.documents); }
    catch { toast('Could not remove attachment', 'bad'); }
  };
  const onDeleteRow = async (doc, i) => {
    // §6 — conditional-offer-related documents may only be deleted by a Super Admin.
    if (doc.is_condition && !canDeleteConditionDocs) { toast('Conditional-offer documents can only be deleted by a Super Admin', 'info'); return; }
    if (!window.confirm(`Delete "${doc.title}"?`)) return;
    if (doc.id) { try { await deleteDocument(doc.id); } catch { /* ignore */ } }
    setDocs((ds) => ds.filter((_, idx) => idx !== i));
    toast('Document deleted', 'ok');
  };

  const sel = { width: '100%' };
  const fileById = (doc, name) => (doc.files || []).find((f) => f.client_name === name);
  // Title · Upload · Status · Validation · View/Download · [Uploaded to Drive · Replace · Delete].
  // Uploaded to Drive + Delete are admin-only (hidden for agents).
  const COLS = agentMode ? '2.2fr 1.2fr 105px 105px 105px 85px' : '2.2fr 1.2fr 105px 105px 105px 110px 85px 55px';
  const hCell = { fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.03em' };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h" style={{ marginBottom: 4 }}>Legal &amp; Documentation</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 16px 12px' }}>Track receipt &amp; validation of every required document for this transaction.</div>

        {readOnly && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: '#eff6ff', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: '#1e3a8a' }}>🔒 View-only — click <strong>Edit</strong> on the transaction to change documents. (View &amp; download remain available.)</span>
          </div>
        )}


        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 12, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Documents Received</strong>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>{received} / {total} received ({pct}%)</span>
            </div>
            <div style={{ background: '#f3f4f6', height: 10, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#10b981,#059669)' }} />
            </div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 12, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Valid Documents</strong>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>{valid} / {total} valid ({pctValid}%)</span>
            </div>
            <div style={{ background: '#f3f4f6', height: 10, borderRadius: 6, overflow: 'hidden' }}>
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
            {recoReady === 'Yes' && <span className="pill ok" style={{ fontSize: 11 }}>✓ Audit-ready</span>}
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
            {docs.some((d) => d.has_file || d.file_count > 0) && (
              <a className="btn ghost sm" title="Download every uploaded document for this transaction as a ZIP"
                href={documentsDownloadAllUrl(transactionId)}>
                📦 Download all
              </a>
            )}
            {!agentMode && pendingDocs.length > 0 && (
              <button className="btn ghost sm" onClick={toggleAllPendingReminders}
                title="Select every pending document for automated email reminders">
                🔔 {allPendingReminders ? 'Clear all reminders' : 'Remind all pending'}
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
          // Agent marked this doc "Not Accepted" → uploads (and reminders) are
          // disabled for everyone, admins included.
          const notAccepted = d.agent_accepted === 'Not Accepted';
          const uploadBlocked = notAccepted;
          return (
            <div key={key} className={`doc-row ${d.is_condition ? 'cond' : (d.status === 'Received' ? 'rcv' : 'pend')}`}>
              <div className="doc-head" style={{ gridTemplateColumns: COLS }}>
                {/* Title */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {expandable
                    ? <button className="row-rm" style={{ color: BRAND }} onClick={() => toggle(key)}>{open2 ? '▼' : '▶'}</button>
                    : <span style={{ width: 14 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: BRAND, lineHeight: 1.3, wordBreak: 'break-word' }}>{d.title}</div>
                    {d.is_condition && d.deadline && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Deadline: {d.deadline}</div>}
                    {d.is_condition && <span className="pill warn" style={{ fontSize: 9, padding: '1px 5px' }}>Condition</span>}
                    {/* Include this document in automated pending-document email reminders — admins
                        only; disabled once the agent marks the doc "Not Accepted". */}
                    {!agentMode && (
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: notAccepted ? 'var(--muted-2)' : (d.reminder ? '#b45309' : 'var(--muted)'), marginTop: 3, cursor: (readOnly || notAccepted) ? 'default' : 'pointer' }} title={notAccepted ? 'Reminders are off — this document was not accepted by the agent' : 'Include this document in automated pending-document email reminders'}>
                        <input type="checkbox" checked={!!d.reminder && !notAccepted} disabled={readOnly || notAccepted} onChange={(e) => upd(i, 'reminder', e.target.checked)} /> 🔔 Reminder
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
                        {d.agent_accepted === 'Accepted' ? '✔ Accepted by agent' : '✖ Not accepted by agent'}
                      </span>
                    )}
                  </div>
                </div>
                {/* Upload — disabled while the agent hasn't accepted the document. */}
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  {uploadBlocked ? (
                    <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>🚫 Upload disabled (not accepted)</span>
                  ) : (<>
                    {d.kind === 'multi' && <span>📎 Multiple files</span>}
                    {d.kind === 'per_client' && <span>👥 Per-client uploads</span>}
                    {single && <input type="file" onChange={(e) => { onSingle(d, e.target.files[0]); e.target.value = ''; }} style={{ fontSize: 12 }} />}
                  </>)}
                </div>
                {/* Status / Validation — agents may view but not change these. Agents
                    see an uploaded doc as "Sent"; admins see it as "Received". */}
                {agentMode ? (
                  <div style={{ ...sel, boxSizing: 'border-box', padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 6, background: '#f9fafb', fontSize: 12.5, ...(d.status === 'Received' ? { color: '#16a34a', fontWeight: 700 } : { color: 'var(--muted)' }) }}>
                    {d.status === 'Received' ? 'Sent' : 'Pending'}
                  </div>
                ) : (
                  <select style={{ ...sel, ...(d.status === 'Received' ? { color: '#16a34a', fontWeight: 700 } : null) }}
                    value={d.status} onChange={(e) => upd(i, 'status', e.target.value)}>
                    <option>Pending</option><option>Received</option>
                  </select>
                )}
                {d.status === 'Received'
                  ? <select
                      disabled={agentMode}
                      style={{ ...sel, ...(d.validation === 'Valid' ? { color: '#16a34a', fontWeight: 700 } : d.validation === 'Invalid' ? { color: '#dc2626', fontWeight: 700 } : null), ...(agentMode ? { background: '#f9fafb' } : null) }}
                      value={!d.validation || d.validation === 'Pending' ? 'Pending' : d.validation}
                      onChange={(e) => upd(i, 'validation', e.target.value)}>
                      <option>Pending</option><option>Valid</option><option>Invalid</option>
                    </select>
                  : <span style={{ fontSize: 12.5, color: 'var(--muted-2)', textAlign: 'center' }}>N/A</span>}
                {/* View (in-browser) + Download */}
                <div style={{ fontSize: 12.5, textAlign: 'center' }}>
                  {expandable
                    ? <span style={{ color: 'var(--muted)' }}>{d.file_count} file(s)</span>
                    : (d.has_file
                      ? <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                          <a className="btn ghost sm" title="View" href={`${documentFileUrl(d.id)}?inline=1`} target="_blank" rel="noreferrer">👁</a>
                          <a className="btn ghost sm" title="Download" href={documentFileUrl(d.id)}>⬇</a>
                        </div>
                      : <span style={{ color: 'var(--muted-2)' }}>—</span>)}
                </div>
                {/* Uploaded to Drive — Yes/No radio (admins only; hidden for agents). Default No (red); Yes green. */}
                {!agentMode && (
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'center', fontSize: 12 }}>
                    {['Yes', 'No'].map((opt) => {
                      const selected = (d.drive_uploaded || 'No') === opt;
                      const color = selected ? (opt === 'Yes' ? '#16a34a' : '#dc2626') : 'var(--muted-2)';
                      return (
                        <label key={opt} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: readOnly ? 'default' : 'pointer', color, fontWeight: selected ? 700 : 400 }}>
                          <input type="radio" name={`drive-${d.id ?? 'n' + i}`} checked={selected} disabled={readOnly} onChange={() => upd(i, 'drive_uploaded', opt)} style={{ accentColor: opt === 'Yes' ? '#16a34a' : '#dc2626' }} />{opt}
                        </label>
                      );
                    })}
                  </div>
                )}
                {/* Replace — after a file is uploaded; locked to Super Admin once Valid. */}
                <div style={{ textAlign: 'center' }}>
                  {single && d.has_file && !uploadBlocked && !validLocked(d)
                    ? <label className="btn ghost sm" style={{ cursor: 'pointer' }}>Replace
                        <input type="file" style={{ display: 'none' }} onChange={(e) => { onSingle(d, e.target.files[0]); e.target.value = ''; }} /></label>
                    : <span style={{ color: 'var(--muted-2)' }} title={validLocked(d) ? 'Valid — only a Super Admin can replace' : undefined}>{validLocked(d) && d.has_file ? '🔒' : '—'}</span>}
                </div>
                {/* Delete — admins only (hidden for agents); locked to Super Admin once Valid. */}
                {!agentMode && (
                  <div style={{ textAlign: 'center' }}>
                    {((d.is_condition && !canDeleteConditionDocs) || validLocked(d))
                      ? <span style={{ color: '#9ca3af', fontSize: 11 }} title={validLocked(d) ? 'Valid — only a Super Admin can delete' : undefined}>{validLocked(d) ? '🔒' : '—'}</span>
                      : <button className="row-rm" disabled={readOnly} onClick={() => onDeleteRow(d, i)}>🗑️</button>}
                  </div>
                )}
              </div>

              {/* Expanded: per-client or multi-file uploads */}
              {open2 && d.kind === 'per_client' && (
                <div style={{ background: '#f8fafc', borderTop: '1px solid var(--line)', padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong style={{ fontSize: 12.5 }}>👥 {d.title} — by Client</strong>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>Each upload is mapped to its respective client name.</span>
                  </div>
                  {clients.length === 0 && <div className="help">No clients on this transaction yet.</div>}
                  {clients.map((name) => {
                    const f = fileById(d, name);
                    return (
                      <div key={name} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 10, alignItems: 'center', border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 6, background: '#fff' }}>
                        <div><div style={{ fontSize: 11, color: 'var(--muted)' }}>Client Name</div><strong>{name}</strong></div>
                        <div><div style={{ fontSize: 11, color: 'var(--muted)' }}>Upload</div>
                          <input type="file" disabled={uploadBlocked || validLocked(d)} onChange={(e) => { onMulti(d, e.target.files[0], name); e.target.value = ''; }} style={{ fontSize: 12 }} />
                          {f && <span style={{ fontSize: 11, color: 'var(--ok)', marginLeft: 6 }}>✓ {f.file_name}</span>}
                          {validLocked(d) && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }} title="Valid — only a Super Admin can replace">🔒 locked</span>}
                          {extracting[name] && <span style={{ fontSize: 11, color: '#2563eb', marginLeft: 6 }}>⏳ Reading ID…</span>}</div>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          {/* FINTRAC: once a client uploads their ID, offer their prefilled Form 630. */}
                          {f && txn && (d.title || '').toLowerCase().includes('fintrac') && (
                            <button className="btn ghost sm" title="View this client's Form 630" onClick={() => setF630Client(name)}>📄 630</button>
                          )}
                          {f ? <>
                            <a className="btn ghost sm" title="View" href={`${docClientFileUrl(d.id, f.index)}?inline=1`} target="_blank" rel="noreferrer">👁</a>
                            <a className="btn ghost sm" title="Download" href={docClientFileUrl(d.id, f.index)}>⬇</a>
                            {!agentMode && !validLocked(d) && <button className="row-rm" onClick={() => onRemoveFile(d, f.index)}>🗑️</button>}
                          </> : <span style={{ color: 'var(--muted-2)', fontSize: 12 }}>—</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {open2 && d.kind === 'multi' && (
                <div style={{ background: '#f8fafc', borderTop: '1px solid var(--line)', padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong style={{ fontSize: 12.5 }}>📎 {d.title} — files</strong>
                    {uploadBlocked
                      ? <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>🚫 Upload disabled (not accepted)</span>
                      : <label className="btn primary sm" style={{ cursor: 'pointer' }}>+ Add File
                          <input type="file" style={{ display: 'none' }} onChange={(e) => { onMulti(d, e.target.files[0]); e.target.value = ''; }} /></label>}
                  </div>
                  {(d.files || []).length === 0 && <div className="help">No files added yet.</div>}
                  {(d.files || []).map((f) => (
                    <div key={f.index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', marginBottom: 6, background: '#fff' }}>
                      <span style={{ fontSize: 13 }}>{f.file_name}</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <a className="btn ghost sm" href={docClientFileUrl(d.id, f.index)} target="_blank" rel="noreferrer">👁 View</a>
                        {!agentMode && <button className="row-rm" onClick={() => onRemoveFile(d, f.index)}>🗑️</button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {d.validation === 'Invalid' && (
                <div style={{ background: 'var(--brand-soft)', borderTop: '1px solid var(--line)', padding: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, display: 'block', marginBottom: 4 }}>⚠ Reason for Invalid</label>
                  {/* Agents may read the reason & attachment but not change them. */}
                  <textarea rows={2} value={d.remarks || ''} readOnly={agentMode} onChange={(e) => upd(i, 'remarks', e.target.value)} placeholder="Describe why this document is invalid…" style={{ background: agentMode ? '#f9fafb' : '#fff', width: '100%' }} />
                  <label style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, display: 'block', margin: '8px 0 4px' }}>Attachment</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {!agentMode && <input type="file" onChange={(e) => { onValidationFile(d, e.target.files[0]); e.target.value = ''; }} style={{ fontSize: 12 }} />}
                    {d.has_validation_file
                      ? <>
                        <a className="btn ghost sm" href={docValidationFileUrl(d.id)} target="_blank" rel="noreferrer">👁 {d.validation_file_name || 'View'}</a>
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

        {/* Agent-flagged deletions — admins decide to restore or permanently delete. */}
        {canReviewDeleted && deletedDocs.length > 0 && (
          <div className="card" style={{ borderLeft: '4px solid #d97706', background: '#fffbeb', marginTop: 12 }}>
            <div className="modal-sub" style={{ marginTop: 0, color: '#92400e' }}>Deleted Documents — pending review ({deletedDocs.length})</div>
            <div className="help" style={{ marginTop: -4, marginBottom: 8 }}>An agent removed these. Restore them to the checklist, or delete them permanently.</div>
            {deletedDocs.map((d) => (
              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: '1px solid #fde68a' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: '#78350f', wordBreak: 'break-word' }}>{d.title}</div>
                  <div style={{ fontSize: 11, color: '#92400e' }}>Deleted by {d.deleted_by || 'agent'}{d.has_file || d.file_count ? ' · has file(s)' : ''}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn ghost sm" onClick={() => onRestoreDeleted(d)}>↺ Restore</button>
                  <button className="btn sm" style={{ background: '#dc2626', color: '#fff' }} onClick={() => onPurgeDeleted(d)}>🗑 Delete permanently</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {!readOnly && <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>}
        </div>
      </div>

      {f630Client && txn && (
        <Form630Modal open onClose={() => setF630Client(null)} txn={txn} clientName={f630Client} />
      )}
    </div>
  );
}
