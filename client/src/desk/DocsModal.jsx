import { useEffect, useState } from 'react';
import {
  getDocuments, saveDocuments, uploadDocumentFile, deleteDocument, documentFileUrl,
  uploadDocClientFile, deleteDocClientFile, docClientFileUrl,
  uploadDocValidationFile, deleteDocValidationFile, docValidationFileUrl,
} from '../lib/api';
import { useToast } from './toast';

const BRAND = '#c8102e';

export default function DocsModal({ open, onClose, transactionId }) {
  const toast = useToast();
  const [docs, setDocs] = useState([]);
  const [clients, setClients] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const load = (showSpin = true) => {
    if (showSpin) setLoading(true);
    getDocuments(transactionId)
      .then((d) => { setDocs(d.documents); setClients(d.clients || []); })
      .catch(() => toast('Could not load documents', 'bad'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (open) load(); }, [open, transactionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const total = docs.length;
  const received = docs.filter((d) => d.status === 'Received').length;
  const mandatory = docs.filter((d) => d.mandatory).length;
  const pending = total - received;
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;

  const upd = (i, k, v) => setDocs((ds) => ds.map((d, idx) => idx === i ? { ...d, [k]: v } : d));
  const toggle = (key) => setExpanded((e) => ({ ...e, [key]: !e[key] }));
  const addDoc = () => {
    const title = newTitle.trim(); if (!title) return;
    setDocs((ds) => [...ds, { title, mandatory: false, status: 'Pending', validation: 'Pending', remarks: '', has_file: false, kind: 'single', files: [], file_count: 0 }]);
    setNewTitle('');
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = docs.map((d) => ({ id: d.id, title: d.title, mandatory: d.mandatory, status: d.status, validation: d.validation, remarks: d.remarks }));
      const res = await saveDocuments(transactionId, payload);
      setDocs(res.documents); setClients(res.clients || []);
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
    try { const r = await uploadDocClientFile(transactionId, doc.id, file, clientName); setDocs(r.documents); toast('File uploaded', 'ok'); }
    catch { toast('Upload failed', 'bad'); }
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
    if (doc.is_condition) { toast('Condition rows follow the Conditional Offer section', 'info'); return; }
    if (!window.confirm(`Delete "${doc.title}"?`)) return;
    if (doc.id) { try { await deleteDocument(doc.id); } catch { /* ignore */ } }
    setDocs((ds) => ds.filter((_, idx) => idx !== i));
    toast('Document deleted', 'ok');
  };

  const sel = { width: '100%' };
  const fileById = (doc, name) => (doc.files || []).find((f) => f.client_name === name);
  const COLS = '1.7fr 1.4fr 110px 110px 110px 90px 60px'; // Title · Upload · Status · Validation · View/Download · Replace · Delete
  const hCell = { fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.03em' };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Legal &amp; Documentation</div>

        <div className="stat-grid">
          <div className="stat-card"><div className="lbl">Total Documents</div><div className="val">{total}</div></div>
          <div className="stat-card"><div className="lbl">Mandatory</div><div className="val">{mandatory}</div></div>
          <div className="stat-card"><div className="lbl">Pending</div><div className="val" style={{ color: pending > 0 ? 'var(--bad)' : 'var(--ok)' }}>{pending}</div></div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 12, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Document Completion</strong>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>{received} / {total} received ({pct}%)</span>
          </div>
          <div style={{ background: '#f3f4f6', height: 10, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#10b981,#059669)' }} />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <strong>Document List</strong>
          <div style={{ display: 'flex', gap: 6 }}>
            <input placeholder="Document name" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} style={{ width: 200 }} />
            <button className="btn primary sm" onClick={addDoc}>+ Add</button>
          </div>
        </div>

        {!loading && docs.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 8, alignItems: 'center', padding: '6px 12px', borderBottom: '2px solid var(--line)' }}>
            <div style={hCell}>Title</div>
            <div style={hCell}>Upload</div>
            <div style={hCell}>Status</div>
            <div style={hCell}>Validation</div>
            <div style={{ ...hCell, textAlign: 'center' }}>View / Download</div>
            <div style={{ ...hCell, textAlign: 'center' }}>Replace</div>
            <div style={{ ...hCell, textAlign: 'center' }}>Delete</div>
          </div>
        )}
        {loading ? <div className="centered">Loading…</div> : docs.map((d, i) => {
          const key = d.id ?? `new-${i}`;
          const open2 = !!expanded[key];
          const expandable = d.kind === 'multi' || d.kind === 'per_client';
          const single = d.kind === 'single' || d.kind === 'condition';
          return (
            <div key={key} style={{ border: '1px solid var(--line)', borderRadius: 8, marginBottom: 8, background: '#fff' }}>
              <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', gap: 8, padding: '8px 12px' }}>
                {/* Title */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {expandable
                    ? <button className="row-rm" style={{ color: BRAND }} onClick={() => toggle(key)}>{open2 ? '▼' : '▶'}</button>
                    : <span style={{ width: 14 }} />}
                  <div>
                    <input value={d.title} onChange={(e) => upd(i, 'title', e.target.value)} readOnly={d.is_condition}
                      style={{ fontWeight: 600, color: BRAND, border: 'none', background: 'transparent', width: '100%', padding: 0 }} />
                    {d.is_condition && d.deadline && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Deadline: {d.deadline}</div>}
                    {d.mandatory && <span className="pill bad" style={{ fontSize: 9, padding: '1px 5px' }}>Mandatory</span>}
                    {d.is_condition && <span className="pill warn" style={{ fontSize: 9, padding: '1px 5px' }}>Condition</span>}
                  </div>
                </div>
                {/* Upload */}
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  {d.kind === 'multi' && <span>📎 Multiple files</span>}
                  {d.kind === 'per_client' && <span>👥 Per-client uploads</span>}
                  {single && <input type="file" onChange={(e) => { onSingle(d, e.target.files[0]); e.target.value = ''; }} style={{ fontSize: 12 }} />}
                </div>
                {/* Status / Validation */}
                <select style={{ ...sel, ...(d.status === 'Received' ? { color: '#16a34a', fontWeight: 700 } : null) }}
                  value={d.status} onChange={(e) => upd(i, 'status', e.target.value)}>
                  <option>Pending</option><option>Received</option>
                </select>
                {d.status === 'Received'
                  ? <select style={sel} value={!d.validation || d.validation === 'Pending' ? 'Pending' : d.validation}
                      onChange={(e) => upd(i, 'validation', e.target.value)}>
                      <option>Pending</option><option>Valid</option><option>Invalid</option>
                    </select>
                  : <span style={{ fontSize: 12.5, color: 'var(--muted-2)', textAlign: 'center' }}>N/A</span>}
                {/* View / Download */}
                <div style={{ fontSize: 12.5, textAlign: 'center' }}>
                  {expandable
                    ? <span style={{ color: 'var(--muted)' }}>{d.file_count} file(s)</span>
                    : (d.has_file
                      ? <a className="btn ghost sm" href={documentFileUrl(d.id)} target="_blank" rel="noreferrer">👁 View</a>
                      : <span style={{ color: 'var(--muted-2)' }}>—</span>)}
                </div>
                {/* Replace */}
                <div style={{ textAlign: 'center' }}>
                  {single
                    ? <label className="btn ghost sm" style={{ cursor: 'pointer' }}>{d.has_file ? 'Replace' : 'Upload'}
                        <input type="file" style={{ display: 'none' }} onChange={(e) => { onSingle(d, e.target.files[0]); e.target.value = ''; }} /></label>
                    : <span style={{ color: 'var(--muted-2)' }}>—</span>}
                </div>
                {/* Delete */}
                <div style={{ textAlign: 'center' }}>
                  {d.mandatory || d.is_condition
                    ? <span style={{ color: '#9ca3af', fontSize: 11 }}>—</span>
                    : <button className="row-rm" onClick={() => onDeleteRow(d, i)}>🗑️</button>}
                </div>
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
                          <input type="file" onChange={(e) => { onMulti(d, e.target.files[0], name); e.target.value = ''; }} style={{ fontSize: 12 }} />
                          {f && <span style={{ fontSize: 11, color: 'var(--ok)', marginLeft: 6 }}>✓ {f.file_name}</span>}</div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {f ? <><a className="btn ghost sm" href={docClientFileUrl(d.id, f.index)} target="_blank" rel="noreferrer">👁 View</a><button className="row-rm" onClick={() => onRemoveFile(d, f.index)}>🗑️</button></> : <span style={{ color: 'var(--muted-2)', fontSize: 12 }}>—</span>}
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
                    <label className="btn primary sm" style={{ cursor: 'pointer' }}>+ Add File
                      <input type="file" style={{ display: 'none' }} onChange={(e) => { onMulti(d, e.target.files[0]); e.target.value = ''; }} /></label>
                  </div>
                  {(d.files || []).length === 0 && <div className="help">No files added yet.</div>}
                  {(d.files || []).map((f) => (
                    <div key={f.index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', marginBottom: 6, background: '#fff' }}>
                      <span style={{ fontSize: 13 }}>{f.file_name}</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <a className="btn ghost sm" href={docClientFileUrl(d.id, f.index)} target="_blank" rel="noreferrer">👁 View</a>
                        <button className="row-rm" onClick={() => onRemoveFile(d, f.index)}>🗑️</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {d.validation === 'Invalid' && (
                <div style={{ background: 'var(--brand-soft)', borderTop: '1px solid var(--line)', padding: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, display: 'block', marginBottom: 4 }}>⚠ Reason for Invalid</label>
                  <textarea rows={2} value={d.remarks || ''} onChange={(e) => upd(i, 'remarks', e.target.value)} placeholder="Describe why this document is invalid…" style={{ background: '#fff', width: '100%' }} />
                  <label style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, display: 'block', margin: '8px 0 4px' }}>Attachment</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <input type="file" onChange={(e) => { onValidationFile(d, e.target.files[0]); e.target.value = ''; }} style={{ fontSize: 12 }} />
                    {d.has_validation_file && (
                      <>
                        <a className="btn ghost sm" href={docValidationFileUrl(d.id)} target="_blank" rel="noreferrer">👁 {d.validation_file_name || 'View'}</a>
                        <button className="row-rm" onClick={() => onRemoveValidationFile(d)}>🗑️</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
