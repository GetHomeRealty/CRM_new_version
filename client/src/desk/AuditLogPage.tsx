import { useEffect, useState, type CSSProperties } from 'react';
import { getAuditLogs, exportAuditLogs, saveBlob } from '../lib/api';
import { useToast } from './toast';
import { useArea } from './AreaContext';
import { AREA_LABEL, AREA_SHORT } from './area';
import type { AuditEntry } from '../types';

/**
 * How much of this area's trail to show.
 *
 * "Shared" is Users, Company Settings and Inventory — the modules that belong to neither area. They
 * are included by default, because a change to a user is not CRM history or Transaction history but
 * both, and leaving them out of each trail would make those records unreachable. The dropdown is
 * here so the strict single-area view is still one click away.
 */
const SCOPES: { value: string; label: string; help: string }[] = [
  { value: 'default', label: 'This area + shared', help: 'this area’s activity plus changes to shared modules' },
  { value: 'area', label: 'This area only', help: 'nothing but this area’s own activity' },
  { value: 'shared', label: 'Shared only', help: 'Users, Company Settings and Inventory' },
  { value: 'all', label: 'Everything', help: 'both areas and shared, for reconciling the two' },
];

const cell: CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--surface-3)', fontSize: 12, verticalAlign: 'top' };
const th: CSSProperties = { ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)', whiteSpace: 'nowrap', textAlign: 'left' };

const fmt = (s: string | undefined) => {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
};
const actionColor = (a: string | undefined) => {
  const t = (a || '').toLowerCase();
  if (t.includes('remov') || t.includes('delet')) return 'var(--bad-ink)';
  if (t.includes('add') || t.includes('creat') || t.includes('upload') || t.includes('sent')) return 'var(--ok-ink)';
  return 'var(--text-2)';
};

interface AuditMeta { current_page: number; last_page: number; total: number; }

export default function AuditLogPage() {
  const toast = useToast();
  const { area } = useArea();
  const [scope, setScope] = useState('default');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [meta, setMeta] = useState<AuditMeta>({ current_page: 1, last_page: 1, total: 0 });
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /** Which format is currently generating, so the button can say so and cannot be pressed twice. */
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1); }, [category, from, to, scope, area]);

  /**
   * The filters, in one place.
   *
   * Used by BOTH the listing request and the export, so the file and the screen cannot be asking
   * different questions — the same reason the server keeps a single `buildWhere`.
   */
  const exportParams = {
    area,
    scope,
    category: category || undefined,
    q: q || undefined,
    from: from || undefined,
    to: to || undefined,
  };

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      getAuditLogs({ ...exportParams, page })
        .then((d) => { setRows(d.data || []); setMeta(d.meta || { current_page: 1, last_page: 1, total: 0 }); if (d.categories) setCategories(d.categories); })
        .catch(() => toast('Could not load audit trail', 'bad'))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [category, q, from, to, page, area, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Download what is on screen.
   *
   * The filters passed are EXACTLY those the listing was loaded with — the same object, built once
   * below — so the file cannot describe a different query from the one the person is looking at.
   * The server re-applies them regardless; this only ensures the two agree by construction here too.
   */
  const doExport = async (format: 'csv' | 'xlsx') => {
    setExporting(format);
    try {
      const { blob, filename, rows, truncated } = await exportAuditLogs(exportParams, format);
      saveBlob(blob, filename);
      toast(
        truncated
          ? `Exported the first ${rows.toLocaleString()} entries — narrow the filters for the rest.`
          : `Exported ${rows.toLocaleString()} ${rows === 1 ? 'entry' : 'entries'}.`,
        truncated ? 'bad' : 'ok',
      );
    } catch {
      // Deliberately plain: the server's error may carry detail nobody signed in here needs.
      toast('Could not export the audit trail. Try again.', 'bad');
    } finally {
      setExporting(null);
    }
  };

  // Deduplicated: the server's category list already contains "Transactions", and prepending it
  // to bring it to the front listed it twice in the dropdown — and gave React two children with
  // the same key. A Set keeps insertion order, so it stays first and the later copy is dropped.
  //
  // It is only prepended in the Transaction Desk, whose list contains it; the CRM's category list
  // has no Transactions, and offering it there would produce a filter that always returns nothing.
  const catOptions = [...new Set([...(area === 'desk' ? ['Transactions'] : []), ...categories.filter((c) => c !== 'Audit Trail')])];

  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="modal-h" style={{ fontSize: 16 }}>{AREA_SHORT[area]} Audit Trail</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Every change recorded in <strong>{AREA_LABEL[area]}</strong>, most recent first. The other
        area keeps its own trail; shared modules appear in both.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All categories</option>
          {catOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ maxWidth: 190 }}
          title={SCOPES.find((s) => s.value === scope)?.help}>
          {SCOPES.map((s) => <option key={s.value} value={s.value} title={s.help}>{s.label}</option>)}
        </select>
        <input placeholder="Search user, field, value…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {(category || q || from || to || scope !== 'default') && <button className="btn ghost sm" onClick={() => { setCategory(''); setQ(''); setFrom(''); setTo(''); setScope('default'); }}>Clear</button>}
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.total} entries</span>
        {/* Export reflects the filters above, not the whole trail. Disabled while one is
            generating so a second press cannot start a duplicate download. */}
        <button
          className="btn ghost sm"
          type="button"
          disabled={exporting !== null || loading}
          title="Download the entries matching the filters above"
          onClick={() => void doExport('csv')}
        >
          {exporting === 'csv' ? 'Exporting…' : '⭳ CSV'}
        </button>
        <button
          className="btn ghost sm"
          type="button"
          disabled={exporting !== null || loading}
          title="Download the entries matching the filters above"
          onClick={() => void doExport('xlsx')}
        >
          {exporting === 'xlsx' ? 'Exporting…' : '⭳ Excel'}
        </button>
      </div>

      <div style={{ maxHeight: '64vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
        {loading ? (
          <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)' }}>No audit entries found.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: '#fff7f7', position: 'sticky', top: 0, zIndex: 1 }}>
              <tr>
                <th style={th}>Timestamp</th>
                <th style={th}>Category</th>
                <th style={th}>Record</th>
                <th style={th}>User</th>
                <th style={th}>Section</th>
                <th style={th}>Field</th>
                <th style={th}>Action</th>
                <th style={th}>Old Value</th>
                <th style={th}>New Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td style={{ ...cell, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmt(e.stamp)}</td>
                  <td style={cell}><span className="pill info" style={{ fontSize: 10 }}>{e.category}</span></td>
                  <td style={cell}>{e.record || '—'}</td>
                  <td style={{ ...cell, fontWeight: 600 }}>{e.who}</td>
                  <td style={cell}>{e.section || '—'}</td>
                  <td style={cell}>{e.field || '—'}</td>
                  <td style={{ ...cell, color: actionColor(e.action), fontWeight: 600 }}>{e.action}{e.details ? ` — ${e.details}` : ''}</td>
                  <td style={{ ...cell, color: 'var(--bad-ink)', background: e.old_value ? '#fff5f5' : 'transparent' }}>{e.old_value || ''}</td>
                  <td style={{ ...cell, color: 'var(--ok-ink)', background: e.new_value ? 'var(--ok-bg)' : 'transparent' }}>{e.new_value || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {meta.last_page > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button className="btn ghost sm" disabled={meta.current_page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Page {meta.current_page} of {meta.last_page}</span>
          <button className="btn ghost sm" disabled={meta.current_page >= meta.last_page} onClick={() => setPage((p) => Math.min(meta.last_page, p + 1))}>Next →</button>
        </div>
      )}
    </div>
  );
}
