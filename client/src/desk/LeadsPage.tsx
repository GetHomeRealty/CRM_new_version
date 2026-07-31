import { crmPath } from './area';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  bulkDeleteLeads, createLeadTag, deleteLead, deleteLeadTag, exportLeads,
  leadOptions, listDeletedLeads, listLeadTags, listLeads, purgeLead, restoreLead, tagLeads,
  updateLead,
} from '../lib/leadsApi';
import { apiErrorMessage } from '../lib/apiError';
import { runLeadImport, type ImportJob } from '../lib/leadImportApi';
import ImportProgress from '../components/ImportProgress';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import Icon from '../ui/Icon';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import LeadEditorModal, { label } from './LeadEditorModal';
import type {
  DeletedLead, Lead, LeadFilters, LeadOptions, LeadStats, LeadTagCounts,
} from '../types';

const PAGE_SIZE = 50;

const EMPTY_FILTERS: LeadFilters = {
  search: '', leadStatus: '', leadType: '', leadSource: '', leadResponse: '',
  clientType: '', leadConversion: '', tag: '', gender: '', language: '', religion: '',
  minAge: '', maxAge: '', assignedTo: '', recent: '',
};

const EMPTY_STATS: LeadStats = {
  total: 0, noCalls: 0, websiteEnquiries: 0, recent: 0,
  byStatus: { hot: 0, warm: 0, cold: 0, mild: 0, closed: 0 },
  bySource: { google: 0, meta: 0, website: 0, referral: 0, other: 0 },
};

/** Status buttons across the top, in temperature order. */
const STATUS_TABS: { key: keyof LeadStats['byStatus'] | 'all'; label: string }[] = [
  { key: 'all', label: 'All Leads' },
  { key: 'hot', label: 'Hot' },
  { key: 'warm', label: 'Warm' },
  { key: 'cold', label: 'Cold' },
  { key: 'mild', label: 'Mild' },
  { key: 'closed', label: 'Closed' },
];

const statusPill = (s: string | null): string => {
  switch (s) {
    case 'hot': return 'bad';
    case 'warm': return 'warn';
    case 'cold': return 'info';
    case 'mild': return 'ok';
    case 'closed': return 'type-res-sell';
    default: return '';
  }
};

const typePill = (t: string | null): string => {
  switch (t) {
    case 'Pre construction': return 'type-pre';
    case 'resale': return 'type-res-sell';
    case 'seller': return 'type-referral';
    case 'buyer': return 'type-res-buy';
    default: return 'type-commercial';
  }
};

const SOURCE_PILL: Record<string, string> = { meta: 'info', 'google ads': 'warn', website: 'ok' };

/**
 * The Source cell: a pill for the channel and, underneath, the exact form the lead came through.
 * Only Meta leads carry a form/page name (`meta.form_name` / `meta.page_name`); website and Google
 * leads have no form recorded in the data, so they show just the channel.
 */
function SourceCell({ lead }: { lead: Lead }) {
  const src = lead.lead_source;
  if (!src) return <span className="muted">—</span>;
  const form = lead.meta?.form_name;
  const page = lead.meta?.page_name;
  return (
    <>
      <span className={`pill ${SOURCE_PILL[src] ?? ''}`}>{label(src)}</span>
      {(form || page) && (
        <div className="muted lead-form-name" title={[page, form].filter(Boolean).join(' · ')}>
          {form ? <><Icon name="clipboard" size={12} /> {form}</> : <><Icon name="doc" size={12} /> {page}</>}
        </div>
      )}
    </>
  );
}

const shortDate = (iso: string | null): string => (iso ? iso.slice(0, 10) : '—');

/** Build a CSV from row objects and hand it to the browser as a download. */
function downloadCsv(rows: Record<string, unknown>[], filename: string): void {
  const headers = Object.keys(rows[0] ?? {});
  const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
  // The BOM makes Excel read the file as UTF-8 rather than the local ANSI codepage.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function LeadsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  // An agent working a lead the brokerage created cannot delete it or change its identity fields.
  // owner_user_id is the creator; a lead the agent created themselves is fully theirs.
  const isBrokerageLead = (l: Lead): boolean =>
    user?.role === 'agent' && l.owner_user_id != null && l.owner_user_id !== user.id;
  const canEdit = can('lead', 'edit');
  const { confirm, askDelete, closeConfirm } = useConfirm();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<LeadStats>(EMPTY_STATS);
  const [options, setOptions] = useState<LeadOptions | null>(null);
  const [tagData, setTagData] = useState<LeadTagCounts>({ tags: [], counts: [] });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [lastPage, setLastPage] = useState(1);
  const [total, setTotal] = useState(0);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<LeadFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [editing, setEditing] = useState<Lead | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagSelectedOpen, setTagSelectedOpen] = useState(false);
  const [binOpen, setBinOpen] = useState(false);

  // Search is debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setFilters((f) => (f.search === search ? f : { ...f, search }));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  /**
   * Only the very first fetch shows a loading state. Every later one — a filter change, a page
   * change, or a refresh after adding or deleting a lead — swaps the rows in place, so the screen
   * never blanks out and re-draws underneath the user.
   */
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      const res = await listLeads(filters, page, PAGE_SIZE);
      setLeads(res.data);
      setStats(res.stats);
      setLastPage(res.meta.last_page);
      setTotal(res.meta.total);
      setSelected(new Set());
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load leads'), 'bad');
      setLeads([]);
      setStats(EMPTY_STATS);
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [filters, page, toast]);

  useEffect(() => { void load(); }, [load]);

  const loadTags = useCallback(async () => {
    try { setTagData(await listLeadTags()); } catch { /* the tag list is optional */ }
  }, []);

  useEffect(() => {
    leadOptions().then(setOptions).catch(() => setOptions(null));
    void loadTags();
  }, [loadTags]);

  // ------------------------------------------------------------- filtering
  const setFilter = (k: keyof LeadFilters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  const activeFilterCount = useMemo(
    () => (Object.entries(filters) as [keyof LeadFilters, string][])
      .filter(([k, v]) => k !== 'search' && v !== '').length,
    [filters],
  );

  const clearFilters = () => {
    setSearch('');
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  // ------------------------------------------------------------- selection
  const allChecked = leads.length > 0 && leads.every((l) => selected.has(l.id));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(leads.map((l) => l.id)));
  const toggle = (id: number) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // --------------------------------------------------------------- actions
  const doExport = async () => {
    try {
      const rows = await exportLeads([...selected], filters);
      if (!rows.length) { toast('Nothing to export.', 'info'); return; }
      downloadCsv(rows, `leads-${new Date().toISOString().slice(0, 10)}.csv`);
      toast(`Exported ${rows.length} lead${rows.length === 1 ? '' : 's'}.`, 'ok');
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not export leads'), 'bad');
    }
  };

  const doBulkDelete = () => {
    const count = selected.size;
    askDelete({
      title: `Delete ${count} lead${count === 1 ? '' : 's'}?`,
      message: `${count} lead${count === 1 ? '' : 's'} will move to Recently Deleted, where they can be restored.`,
      onConfirm: async () => {
        try {
          const res = await bulkDeleteLeads([...selected]);
          toast(`${res.deleted} lead${res.deleted === 1 ? '' : 's'} moved to Recently Deleted.`, 'ok');
          void load();
        } catch (ex) {
          toast(apiErrorMessage(ex, 'Could not delete the leads'), 'bad');
        } finally {
          closeConfirm();
        }
      },
    });
  };

  const doDelete = (lead: Lead) => askDelete({
    title: `Delete ${lead.name}?`,
    message: 'The lead moves to Recently Deleted and can be restored from there.',
    onConfirm: async () => {
      try {
        await deleteLead(lead.id);
        toast('Lead moved to Recently Deleted.', 'ok');
        void load();
      } catch (ex) {
        toast(apiErrorMessage(ex, 'Could not delete the lead'), 'bad');
      } finally {
        closeConfirm();
      }
    },
  });

  const toggleClosed = async (lead: Lead) => {
    const next = lead.lead_status === 'closed' ? 'hot' : 'closed';
    try {
      await updateLead(lead.id, { lead_status: next });
      toast(next === 'closed' ? 'Lead closed.' : 'Lead reopened.', 'ok');
      void load();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not update the lead'), 'bad');
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div className="lead-counters">
            <button className={`lead-counter as-btn${filters.recent === 'true' ? ' on' : ''}`} type="button"
              title={`Leads that arrived in the last ${options?.recent_days ?? 30} days`}
              onClick={() => setFilter('recent', filters.recent === 'true' ? '' : 'true')}>
              🆕 Recent Leads <strong>{stats.recent}</strong>
            </button>
            <button className="lead-counter as-btn" type="button" title="Leads with no logged call"
              onClick={() => { setFilter('recent', ''); toast(`${stats.noCalls} lead(s) have no logged call.`, 'info'); }}>
              <Icon name="phone" size={13} /> No Calls <strong>{stats.noCalls}</strong>
            </button>
            <button className={`lead-counter as-btn${filters.leadSource === 'website' ? ' on' : ''}`} type="button" title="Leads from the website"
              onClick={() => setFilter('leadSource', filters.leadSource === 'website' ? '' : 'website')}>
              <Icon name="globe" size={13} /> Website Enquiries <strong>{stats.bySource.website}</strong>
            </button>
            <button className={`lead-counter as-btn${filters.leadSource === 'meta' ? ' on' : ''}`} type="button" title="Leads from Meta (Facebook / Instagram)"
              onClick={() => setFilter('leadSource', filters.leadSource === 'meta' ? '' : 'meta')}>
              <Icon name="globe" size={13} /> Meta <strong>{stats.bySource.meta}</strong>
            </button>
            <button className={`lead-counter as-btn${filters.leadSource === 'google ads' ? ' on' : ''}`} type="button" title="Leads from Google Ads"
              onClick={() => setFilter('leadSource', filters.leadSource === 'google ads' ? '' : 'google ads')}>
              <Icon name="search" size={13} /> Google <strong>{stats.bySource.google}</strong>
            </button>
          </div>
          <div className="toolbar-row">
            {/* Import and Export sit together — the two ways leads move in and out of the list.
                Export is always available; with nothing ticked it falls back to the current filters. */}
            <div className="btn-pair">
              {canEdit && <button className="btn ghost" type="button" onClick={() => setImportOpen(true)}><Icon name="upload" size={14} /> Import Leads</button>}
              <button className="btn ghost" type="button" onClick={doExport}
                title={selected.size ? `Export the ${selected.size} selected lead(s)` : 'Export every lead matching the current filters'}>
                <Icon name="download" size={14} /> Export {selected.size ? `Selected (${selected.size})` : 'Leads'}
              </button>
            </div>
            <button className="btn ghost" type="button" onClick={() => { setTagsOpen(true); void loadTags(); }}>
              <Icon name="tag" size={14} /> Tags ({tagData.counts.length})
            </button>
            <button className="btn ghost" type="button" onClick={() => setBinOpen(true)}><Icon name="trash" size={14} /> Recently Deleted</button>
            {canEdit && (
              <button className="btn primary" type="button" onClick={() => { setEditing(null); setEditorOpen(true); }}>
                + Add Lead
              </button>
            )}
          </div>
        </div>

        <div className="lead-tabs">
          {STATUS_TABS.map((t) => {
            const value = t.key === 'all' ? '' : t.key;
            const count = t.key === 'all' ? stats.total : stats.byStatus[t.key];
            return (
              <button key={t.key} type="button"
                className={`lead-tab${filters.leadStatus === value ? ' on' : ''}`}
                onClick={() => setFilter('leadStatus', value)}>
                {t.label} <span className="lead-tab-n">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="toolbar-row" style={{ marginTop: 10 }}>
          <input className="inp" placeholder="Search name, email, phone, location or property…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn ghost" type="button" onClick={() => setShowFilters((v) => !v)}>
            {showFilters ? 'Hide Filters' : 'Show Filters'}{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </button>
          <button className="btn ghost" type="button" onClick={clearFilters} disabled={activeFilterCount === 0 && search === ''}>
            Clear
          </button>
        </div>

        {showFilters && options && (
          <div className="lead-filters">
            <FilterSelect label="Lead Type" value={filters.leadType} options={options.lead_type} none={options.none_filter_value}
              onChange={(v) => setFilter('leadType', v)} />
            <FilterSelect label="Lead Source" value={filters.leadSource} options={options.lead_source} none={options.none_filter_value}
              onChange={(v) => setFilter('leadSource', v)} />
            <FilterSelect label="Lead Response" value={filters.leadResponse} options={options.lead_response} none={options.none_filter_value}
              onChange={(v) => setFilter('leadResponse', v)} />
            <FilterSelect label="Client Type" value={filters.clientType} options={options.client_type} none={options.none_filter_value}
              onChange={(v) => setFilter('clientType', v)} />
            <FilterSelect label="Conversion" value={filters.leadConversion} options={options.lead_conversion} none={options.none_filter_value}
              onChange={(v) => setFilter('leadConversion', v)} />
            <FilterSelect label="Tag" value={filters.tag} options={tagData.tags} none={options.none_filter_value}
              onChange={(v) => setFilter('tag', v)} />
            <FilterSelect label="Gender" value={filters.gender} options={options.genders} none={options.none_filter_value}
              onChange={(v) => setFilter('gender', v)} />
            <FilterSelect label="Language" value={filters.language} options={options.languages} none={options.none_filter_value}
              onChange={(v) => setFilter('language', v)} />
            <FilterSelect label="Religion" value={filters.religion} options={options.religions} none={options.none_filter_value}
              onChange={(v) => setFilter('religion', v)} />
            <div className="field">
              <label>Assigned To</label>
              <select value={filters.assignedTo} onChange={(e) => setFilter('assignedTo', e.target.value)}>
                <option value="">All users</option>
                <option value="unassigned">Unassigned</option>
                {options.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Age Range</label>
              <div className="lead-age">
                <input type="number" placeholder="Min" value={filters.minAge} onChange={(e) => setFilter('minAge', e.target.value)} />
                <span>–</span>
                <input type="number" placeholder="Max" value={filters.maxAge} onChange={(e) => setFilter('maxAge', e.target.value)} />
              </div>
            </div>
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="lead-bulkbar">
          <span><strong>{selected.size}</strong> selected</span>
          <div className="toolbar-row">
            <button className="btn ghost sm" type="button" onClick={doExport}><Icon name="download" size={13} /> Export Selected</button>
            {canEdit && <button className="btn ghost sm" type="button" onClick={() => setTagSelectedOpen(true)}><Icon name="tag" size={13} /> Tag Selected</button>}
            {canEdit && <button className="btn ghost sm" type="button" onClick={doBulkDelete}><Icon name="trash" size={13} /> Delete Selected</button>}
            <button className="btn ghost sm" type="button" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="lead-scroll">
          <table className="list-table lead-table">
            <thead>
              <tr>
                <th className="lead-sel-col">
                  <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all leads" />
                </th>
                <th>Name</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Type</th>
                <th>Source</th>
                <th>Tags</th>
                <th>Assigned To</th>
                <th>Activity</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={11} className="empty-cell">Loading leads…</td></tr>}
              {!loading && leads.length === 0 && (
                <tr><td colSpan={11} className="empty-cell">
                  No leads match these filters.{canEdit ? ' Add one, or import a CSV.' : ''}
                </td></tr>
              )}
              {!loading && leads.map((l) => (
                <tr key={l.id}>
                  <td className="lead-sel-col">
                    <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.name}`} />
                  </td>
                  <td>
                    <button className="prop-link" type="button" onClick={() => navigate(crmPath(`lead/${l.id}`))}>{l.name}</button>
                    {l.unsubscribed && <span className="pill bad lead-unsub" title="Opted out of email — excluded from campaigns">Unsubscribed</span>}
                  </td>
                  <td className="lead-contact">
                    <div>{l.email}</div>
                    <div className="muted">{l.phone || '—'}</div>
                    <div className="muted">{l.location || 'No location'}</div>
                  </td>
                  <td>{l.lead_status ? <span className={`pill ${statusPill(l.lead_status)}`}>{label(l.lead_status)}</span> : <span className="muted">—</span>}</td>
                  <td>{l.lead_type ? <span className={`pill ${typePill(l.lead_type)}`}>{label(l.lead_type)}</span> : <span className="muted">—</span>}</td>
                  <td><SourceCell lead={l} /></td>
                  <td>
                    {l.tags.length === 0 ? <span className="muted">—</span> : (
                      <div className="lead-tags">
                        {l.tags.slice(0, 3).map((t) => (
                          <button key={t} type="button" className="lead-tag" title={`Filter by "${t}"`}
                            onClick={() => setFilter('tag', t)}>{t}</button>
                        ))}
                        {l.tags.length > 3 && <span className="lead-tag more">+{l.tags.length - 3}</span>}
                      </div>
                    )}
                  </td>
                  <td>{l.assigned_to_name ?? <span className="muted">Unassigned</span>}</td>
                  <td className="lead-activity-cell">
                    <span title="Logged calls"><Icon name="phone" size={12} /> {l.call_count}</span>
                    <span title="Pending of total tasks"><Icon name="check" size={12} /> {l.pending_task_count}/{l.task_count}</span>
                  </td>
                  <td>{shortDate(l.created_at)}</td>
                  {/* Icon-only actions: four labelled buttons per row cost more width than the
                      rest of the table put together. `title` + `aria-label` keep the action
                      discoverable on hover and to screen readers. */}
                  <td className="lead-actions">
                    <button className="icon-btn" type="button" title="View" aria-label="View" onClick={() => navigate(crmPath(`lead/${l.id}`))}><Icon name="eye" size={15} /></button>
                    {canEdit && <button className="icon-btn" type="button" title="Edit" aria-label="Edit" onClick={() => { setEditing(l); setEditorOpen(true); }}><Icon name="edit" size={15} /></button>}
                    {canEdit && (
                      <button className="icon-btn" type="button"
                        title={l.lead_status === 'closed' ? 'Reopen' : 'Close'}
                        aria-label={l.lead_status === 'closed' ? 'Reopen' : 'Close'}
                        onClick={() => void toggleClosed(l)}>
                        {l.lead_status === 'closed' ? <Icon name="refresh" size={15} /> : <Icon name="check" size={15} />}
                      </button>
                    )}
                    {canEdit && !isBrokerageLead(l) && <button className="icon-btn danger" type="button" title="Delete" aria-label="Delete" onClick={() => doDelete(l)}><Icon name="trash" size={15} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {lastPage > 1 && (
          <div className="lead-pager">
            <span className="muted">Page {page} of {lastPage} · {total} leads</span>
            <div className="toolbar-row">
              <button className="btn ghost sm" type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <button className="btn ghost sm" type="button" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>

      {editorOpen && (
        <LeadEditorModal
          lead={editing}
          options={options}
          lockIdentity={editing ? isBrokerageLead(editing) : false}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); void load(); void loadTags(); }}
        />
      )}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void load(); void loadTags(); }} tags={tagData.tags} />}
      {tagsOpen && <TagsModal data={tagData} canEdit={canEdit} onClose={() => setTagsOpen(false)} onChanged={() => { void loadTags(); void load(); }} onFilter={(t) => { setFilter('tag', t); setTagsOpen(false); }} />}
      {tagSelectedOpen && (
        <TagSelectedModal
          count={selected.size}
          tags={tagData.tags}
          onClose={() => setTagSelectedOpen(false)}
          onApply={async (tag, mode) => {
            try {
              const res = await tagLeads([...selected], tag, mode);
              toast(res.message, 'ok');
              setTagSelectedOpen(false);
              void load();
              void loadTags();
            } catch (ex) {
              toast(apiErrorMessage(ex, 'Could not tag the leads'), 'bad');
            }
          }}
        />
      )}
      {binOpen && <RecycleModal canEdit={canEdit} onClose={() => setBinOpen(false)} onChanged={() => void load()} />}

      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}

/** A dropdown filter that also offers the "never filled in" sentinel. */
function FilterSelect({ label: name, value, options, none, onChange }: {
  label: string; value: string; options: string[]; none: string; onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label>{name}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        <option value={none}>None (not set)</option>
        {options.map((o) => <option key={o} value={o}>{label(o)}</option>)}
      </select>
    </div>
  );
}

// ------------------------------------------------------------------ import
function ImportModal({ onClose, onDone, tags }: { onClose: () => void; onDone: () => void; tags: string[] }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportJob | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Read by the poll loop, which outlives a render — a state flag would be captured stale.
  const closedRef = useRef(false);
  useEffect(() => () => { closedRef.current = true; }, []);

  const readFile = async (file: File) => {
    setCsv(await file.text());
    toast(`Loaded ${file.name}.`, 'info');
  };

  const run = async () => {
    setBusy(true);
    setProgress(null);
    try {
      // Queued server-side and polled, so a large file is not held open in one request. `cancelled`
      // stops this modal asking once it has closed — it does not stop the import, which finishes
      // on the server either way.
      const job = await runLeadImport(csv, tag.trim(), {
        source: 'leads',
        onProgress: setProgress,
        cancelled: () => closedRef.current,
      });
      if (closedRef.current) return;
      if (job.status === 'Failed') { toast(job.message, 'bad'); return; }
      toast(job.message, 'ok');
      onDone();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not import the leads'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <button className="close" type="button" onClick={onClose} aria-label="Close"><Icon name="close" size={15} /></button>
        <div className="modal-h">Import Leads</div>
        <p className="help">
          Paste CSV, or pick a .csv file. The first row must be a header. Recognised columns:
          <strong> name, email, phone, location, property, lead status, lead type, lead source, lead response, client type</strong>.
          An address already on file is tagged rather than duplicated.
        </p>
        <div className="field">
          <label>CSV file</label>
          <input ref={fileRef} type="file" accept=".csv,text/csv"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
        </div>
        <div className="field">
          <label>CSV data</label>
          <textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)}
            placeholder="name,email,phone&#10;Jane Doe,jane@example.com,416-555-0100" />
        </div>
        <div className="field">
          <label>Tag every imported lead (optional)</label>
          <input list="import-tags" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. Expo-2026" />
          <datalist id="import-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
        </div>
        {progress && <ImportProgress job={progress} />}
        <div className="actions">
          {/* Deliberately NOT disabled while importing. The work is on the server now, so closing
              only stops this tab watching it — there is no reason to trap somebody in a modal for
              several minutes. */}
          <button className="btn ghost" type="button" onClick={onClose}>
            {busy ? 'Close — the import keeps running' : 'Cancel'}
          </button>
          <button className="btn primary" type="button" onClick={() => void run()} disabled={busy || csv.trim() === ''}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- tags
function TagsModal({ data, canEdit, onClose, onChanged, onFilter }: {
  data: LeadTagCounts; canEdit: boolean; onClose: () => void; onChanged: () => void; onFilter: (tag: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // Keeps the last delete undoable — the API returns the leads the tag was pulled from.
  const [undo, setUndo] = useState<{ tag: string; leadIds: number[] } | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      await createLeadTag(name.trim());
      toast(`Tag "${name.trim()}" created.`, 'ok');
      setName('');
      onChanged();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not create the tag'), 'bad');
    } finally { setBusy(false); }
  };

  const remove = async (tag: string) => {
    setBusy(true);
    try {
      const res = await deleteLeadTag(tag);
      setUndo({ tag, leadIds: res.lead_ids });
      toast(`Tag "${tag}" removed from ${res.removed} lead(s).`, 'ok');
      onChanged();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not delete the tag'), 'bad');
    } finally { setBusy(false); }
  };

  const restoreTag = async () => {
    if (!undo) return;
    setBusy(true);
    try {
      await createLeadTag(undo.tag);
      if (undo.leadIds.length) await tagLeads(undo.leadIds, undo.tag, 'add');
      toast(`Tag "${undo.tag}" restored to ${undo.leadIds.length} lead(s).`, 'ok');
      setUndo(null);
      onChanged();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not restore the tag'), 'bad');
    } finally { setBusy(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <button className="close" type="button" onClick={onClose} aria-label="Close"><Icon name="close" size={15} /></button>
        <div className="modal-h">Lead Tags</div>

        {canEdit && (
          <div className="toolbar-row" style={{ marginBottom: 12 }}>
            <input className="inp" value={name} placeholder="New tag name" onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} />
            <button className="btn primary" type="button" disabled={busy || !name.trim()} onClick={() => void create()}>Create</button>
          </div>
        )}

        {undo && (
          <div className="lead-undo">
            <span>Deleted <strong>“{undo.tag}”</strong>{undo.leadIds.length ? ` from ${undo.leadIds.length} lead(s)` : ''}.</span>
            <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void restoreTag()}>Restore</button>
            <button className="btn ghost sm" type="button" onClick={() => setUndo(null)}>Dismiss</button>
          </div>
        )}

        {data.counts.length === 0
          ? <p className="help">No tags yet. Create one above, or add tags on a lead.</p>
          : (
            <ul className="lead-taglist">
              {data.counts.map((t) => (
                <li key={t.name}>
                  <button className="prop-link" type="button" onClick={() => onFilter(t.name)}>{t.name}</button>
                  <span className="pill info">{t.count} {t.count === 1 ? 'lead' : 'leads'}</span>
                  {canEdit && <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void remove(t.name)}>Delete</button>}
                </li>
              ))}
            </ul>
          )}
        <p className="help">Tags are shared with Campaigns — the audience builder targets these same names.</p>
      </div>
    </div>
  );
}

function TagSelectedModal({ count, tags, onClose, onApply }: {
  count: number; tags: string[]; onClose: () => void; onApply: (tag: string, mode: 'add' | 'remove') => void;
}) {
  const [tag, setTag] = useState('');
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <button className="close" type="button" onClick={onClose} aria-label="Close"><Icon name="close" size={15} /></button>
        <div className="modal-h">Tag {count} selected lead{count === 1 ? '' : 's'}</div>
        <div className="field">
          <label>Tag</label>
          <input list="tag-selected-list" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Pick or type a tag" autoFocus />
          <datalist id="tag-selected-list">{tags.map((t) => <option key={t} value={t} />)}</datalist>
        </div>
        <div className="field">
          <label>Action</label>
          <select value={mode} onChange={(e) => setMode(e.target.value === 'remove' ? 'remove' : 'add')}>
            <option value="add">Add this tag</option>
            <option value="remove">Remove this tag</option>
          </select>
        </div>
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn primary" type="button" disabled={!tag.trim()} onClick={() => onApply(tag.trim(), mode)}>Apply</button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------- recently deleted
function RecycleModal({ canEdit, onClose, onChanged }: { canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<DeletedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows((await listDeletedLeads()).data); }
    catch (ex) { toast(apiErrorMessage(ex, 'Could not load deleted leads'), 'bad'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const act = async (id: number, kind: 'restore' | 'purge') => {
    setBusy(id);
    try {
      if (kind === 'restore') { await restoreLead(id); toast('Lead restored.', 'ok'); }
      else { await purgeLead(id); toast('Lead permanently deleted.', 'ok'); }
      setRows((r) => r.filter((x) => x.id !== id));
      onChanged();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'That did not work'), 'bad');
    } finally { setBusy(null); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" type="button" onClick={onClose} aria-label="Close"><Icon name="close" size={15} /></button>
        <div className="modal-h">Recently Deleted Leads ({rows.length})</div>
        <p className="help">Deleted leads are kept here so they can be restored. Deleting permanently also removes their notes, tasks, showings and calls.</p>
        {loading ? <p className="help">Loading…</p> : rows.length === 0 ? <p className="help">Nothing here.</p> : (
          <div className="lead-scroll">
            <table className="list-table">
              <thead><tr><th>Name</th><th>Contact</th><th>Deleted</th><th>By</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td className="muted">{[r.email, r.phone].filter(Boolean).join(' · ')}</td>
                    <td>{shortDate(r.deleted_at)}</td>
                    <td className="muted">{r.deleted_by ?? '—'}</td>
                    <td className="lead-actions">
                      {canEdit && <button className="btn ghost sm" type="button" disabled={busy === r.id} onClick={() => void act(r.id, 'restore')}>Restore</button>}
                      {canEdit && <button className="btn ghost sm" type="button" disabled={busy === r.id} onClick={() => void act(r.id, 'purge')}>Delete Forever</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
