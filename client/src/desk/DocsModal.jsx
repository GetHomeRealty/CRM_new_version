import { useEffect, useRef, useState } from 'react';
import { getDocuments, saveDocuments, uploadDocumentFile, deleteDocument, documentFileUrl } from '../lib/api';
import { useToast } from './toast';

export default function DocsModal({ open, onClose, transactionId }) {
  const toast = useToast();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const fileInputs = useRef({});

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getDocuments(transactionId)
      .then((d) => setDocs(d.documents))
      .catch(() => toast('Could not load documents', 'bad'))
      .finally(() => setLoading(false));
  }, [open, transactionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const total = docs.length;
  const received = docs.filter((d) => d.status === 'Received').length;
  const mandatory = docs.filter((d) => d.mandatory).length;
  const pending = total - received;
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;

  const upd = (i, k, v) => setDocs((ds) => ds.map((d, idx) => idx === i ? { ...d, [k]: v } : d));
  const addDoc = () => {
    const title = newTitle.trim() || 'New Document';
    setDocs((ds) => [...ds, { title, mandatory: false, status: 'Pending', validation: 'Pending', remarks: '', has_file: false }]);
    setNewTitle('');
  };
  const removeDoc = (i) => setDocs((ds) => ds.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    try {
      const payload = docs.map((d) => ({ id: d.id, title: d.title, mandatory: d.mandatory, status: d.status, validation: d.validation, remarks: d.remarks }));
      const res = await saveDocuments(transactionId, payload);
      setDocs(res.documents);
      toast('Documents saved', 'ok');
    } catch { toast('Could not save documents', 'bad'); } finally { setSaving(false); }
  };

  const onFile = async (doc, file) => {
    if (!file) return;
    if (!doc.id) { toast('Save the document first, then upload', 'info'); return; }
    try {
      const res = await uploadDocumentFile(transactionId, doc.id, file);
      setDocs(res.documents);
      toast('File uploaded — marked Received', 'ok');
    } catch { toast('Upload failed', 'bad'); }
  };

  const onDelete = async (doc, i) => {
    if (!window.confirm(`Delete "${doc.title}"?`)) return;
    if (doc.id) { try { await deleteDocument(doc.id); } catch { /* ignore */ } }
    removeDoc(i);
    toast('Document deleted', 'ok');
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl">
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
            <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#10b981,#059669)', transition: 'width .3s ease' }} />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <strong>Document List</strong>
          <div style={{ display: 'flex', gap: 6 }}>
            <input placeholder="Document name" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} style={{ width: 200 }} />
            <button className="btn primary sm" onClick={addDoc}>+ Add</button>
          </div>
        </div>

        {loading ? <div className="centered">Loading…</div> : (
          <table className="doc-table">
            <thead><tr>
              <th style={{ width: '30%' }}>Title</th><th style={{ width: '14%' }}>Status</th><th style={{ width: '14%' }}>Validation</th>
              <th style={{ width: '22%' }}>File</th><th style={{ width: '12%' }}>Upload</th><th style={{ width: '8%' }}>Delete</th>
            </tr></thead>
            <tbody>
              {docs.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: 16 }}>No documents.</td></tr>}
              {docs.map((d, i) => (
                <Row key={d.id ?? `new-${i}`}>
                  <tr>
                    <td>
                      <input value={d.title} onChange={(e) => upd(i, 'title', e.target.value)} />
                      {d.mandatory && <span className="pill bad" style={{ fontSize: 9, padding: '2px 5px', marginTop: 4, display: 'inline-block' }}>Mandatory</span>}
                    </td>
                    <td>
                      <select value={d.status} onChange={(e) => upd(i, 'status', e.target.value)}><option>Pending</option><option>Received</option></select>
                    </td>
                    <td>
                      <select value={d.validation} onChange={(e) => upd(i, 'validation', e.target.value)}><option>Pending</option><option>Valid</option><option>Invalid</option></select>
                    </td>
                    <td>
                      {d.has_file
                        ? <a className="prop-link" href={documentFileUrl(d.id)} target="_blank" rel="noreferrer">⬇ {d.file_name || 'download'}</a>
                        : <span style={{ color: 'var(--muted-2)', fontSize: 12 }}>No file</span>}
                    </td>
                    <td>
                      <input type="file" ref={(el) => { fileInputs.current[i] = el; }} style={{ display: 'none' }} onChange={(e) => onFile(d, e.target.files[0])} />
                      <button className="btn ghost sm" onClick={() => fileInputs.current[i]?.click()}>{d.has_file ? 'Replace' : 'Upload'}</button>
                    </td>
                    <td>{!d.mandatory ? <button className="row-rm" onClick={() => onDelete(d, i)}>🗑️</button> : <span style={{ color: '#9ca3af', fontSize: 11 }}>—</span>}</td>
                  </tr>
                  {d.validation === 'Invalid' && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--brand-soft)' }}>
                        <label style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, display: 'block', marginBottom: 4 }}>⚠ Reason for Invalid</label>
                        <textarea rows={2} value={d.remarks || ''} onChange={(e) => upd(i, 'remarks', e.target.value)} placeholder="Describe why this document is invalid…" style={{ background: '#fff' }} />
                      </td>
                    </tr>
                  )}
                </Row>
              ))}
            </tbody>
          </table>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// Fragment wrapper so each document can render a main row + an optional remarks row.
function Row({ children }) {
  return <>{children}</>;
}
