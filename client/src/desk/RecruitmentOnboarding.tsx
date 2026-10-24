import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { crmPath } from './area';
import {
  addOnboardingPerson, addOnboardingStep, getOnboarding, importOnboardingSheet, previewOnboardingImport,
  removeOnboardingPerson, setOnboardingMark, updateOnboardingPerson, updateOnboardingStep,
  type OnboardingImportSummary, type OnboardingKind, type OnboardingList, type OnboardingPerson,
} from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';

/** What counts towards "done" in the Done column. N/A and "Agent using own email" close an onboarding step. */
const DONE: Record<OnboardingKind, string[]> = { onboarding: ['yes', 'na', 'own_email'], training: ['yes'] };

/** A cell's colour follows its meaning, like the sheet's: green done, red not, amber under way. */
const CELL_STYLE: Record<string, CSSProperties> = {
  yes: { background: 'var(--ok-soft)', color: 'var(--ok-ink)' },
  no: { background: 'var(--bad-soft)', color: 'var(--bad-ink)' },
  in_progress: { background: 'var(--warn-soft)', color: 'var(--warn-ink)' },
  not_attended: { background: 'var(--surface-3)', color: 'var(--muted)' },
  na: { background: 'var(--surface-3)', color: 'var(--text-3)' },
  own_email: { background: 'var(--info-soft)', color: 'var(--info-ink)' },
  interested: { background: 'var(--brand-soft)', color: 'var(--brand-dark)' },
};

const MAX_BYTES = 2 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

/**
 * RECRUITMENT → ONBOARDING & TRAINING — the brokerage's "Onboarding & Trainings" sheet as a tab.
 *
 * One row per agent, one column per onboarding step or training topic, each cell one of the sheet's
 * values. Super Admin, Admin and Recruiter fill in cells and add agents; Super Admin and Admin also
 * change the step list, remove agents and import the sheet. Candidates who reach Onboarding or Active
 * appear here by themselves. The server enforces all of it; hiding a control is only a courtesy.
 */
export default function RecruitmentOnboarding({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { confirm, askDelete, closeConfirm } = useConfirm();
  const [data, setData] = useState<OnboardingList | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<OnboardingKind>('onboarding');
  const [search, setSearch] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<{ id: number; name: string; tag: string } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await getOnboarding());
      setError('');
    } catch (ex) {
      setError(apiErrorMessage(ex, 'Could not load onboarding'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const canManage = !!data?.can_manage;
  const steps = useMemo(() => (data?.steps ?? []).filter((s) => s.kind === kind && !s.hidden), [data, kind]);
  const doneOf = useCallback((p: OnboardingPerson) => steps.filter((s) => DONE[kind].includes(p.marks[s.id] ?? '')).length, [steps, kind]);
  const people = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.people ?? []).filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!onlyOpen || doneOf(p) < steps.length));
  }, [data, search, onlyOpen, doneOf, steps.length]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      await load();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'That did not save'), 'bad');
    } finally {
      setBusy('');
    }
  };

  /** One cell, saved at once and shown at once; put back if the server refuses it. */
  const setCell = async (p: OnboardingPerson, stepId: number, value: string) => {
    const before = p.marks[stepId] ?? '';
    const patch = (v: string) => setData((d) => d && {
      ...d,
      people: d.people.map((x) => {
        if (x.id !== p.id) return x;
        const marks = { ...x.marks };
        if (v) marks[stepId] = v; else delete marks[stepId];
        return { ...x, marks };
      }),
    });
    patch(value);
    try {
      await setOnboardingMark(p.id, stepId, value);
    } catch (ex) {
      patch(before);
      toast(apiErrorMessage(ex, 'That did not save'), 'bad');
    }
  };

  if (error) return <div className="card"><p className="help bad">{error}</p></div>;
  if (!data) return <div className="card"><p className="help">Loading onboarding…</p></div>;

  const counts = (k: OnboardingKind) => data.steps.filter((s) => s.kind === k && !s.hidden).length;
  const labels = data.labels;
  const sticky: CSSProperties = { position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 };

  return (
    <div className="card" data-testid="onboarding-tab">
      <div className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        {(['onboarding', 'training'] as OnboardingKind[]).map((k) => (
          <button key={k} type="button" className={kind === k ? 'btn primary sm' : 'btn ghost sm'} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === 'onboarding' ? `Onboarding steps (${counts('onboarding')})` : `Training topics (${counts('training')})`}
          </button>
        ))}
        <input placeholder="Search agent name" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 200 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} style={{ width: 'auto', minWidth: 0 }} />
          Not finished only
        </label>
        <span style={{ flex: 1 }} />
        {canEdit && <button className="btn ghost sm" type="button" onClick={() => setAdding((v) => !v)}>+ Add agent</button>}
        {canManage && <button className="btn ghost sm" type="button" aria-pressed={managing} onClick={() => setManaging((v) => !v)}>Manage {kind === 'onboarding' ? 'steps' : 'topics'}</button>}
        {canManage && <button className="btn ghost sm" type="button" onClick={() => setImporting(true)}>Import sheet</button>}
      </div>

      {adding && canEdit && (
        <div className="toolbar-row" style={{ gap: 8, marginBottom: 10 }}>
          <input autoFocus placeholder="Agent name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ minWidth: 260 }} />
          <button
            className="btn primary sm"
            type="button"
            disabled={busy !== '' || !newName.trim()}
            onClick={() => void run('add', async () => { await addOnboardingPerson({ name: newName }); setNewName(''); setAdding(false); }, 'Agent added.')}
          >
            Add
          </button>
          <span className="help" style={{ margin: 0 }}>Candidates reaching Onboarding or Active are added automatically.</span>
        </div>
      )}

      {managing && canManage && (
        <StepManager data={data} kind={kind} busy={busy} run={run} />
      )}

      <p className="help" style={{ marginTop: 0 }}>
        {people.length} agent{people.length === 1 ? '' : 's'}{people.length !== data.people.length ? ` of ${data.people.length}` : ''}.
        {canEdit ? ' Choose a value in any cell; it saves straight away.' : ''}
      </p>

      <div className="lead-scroll" style={{ overflow: 'auto', maxHeight: '70vh', border: '1px solid var(--line)', borderRadius: 8 }}>
        <table className="list-table" data-testid="onboarding-grid" style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...sticky, top: 0, zIndex: 3, minWidth: 220 }}>Agent</th>
              <th style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', whiteSpace: 'nowrap' }}>Done</th>
              {steps.map((s) => (
                <th key={s.id} title={s.title} style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', minWidth: 104, maxWidth: 130, whiteSpace: 'normal', fontSize: 11, lineHeight: 1.25, verticalAlign: 'bottom' }}>
                  {s.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.length === 0 && (
              <tr><td colSpan={steps.length + 2} className="muted">{data.people.length ? 'Nobody matches.' : 'Nobody on the list yet. Import the sheet or add an agent.'}</td></tr>
            )}
            {people.map((p) => {
              const done = doneOf(p);
              return (
                <tr key={p.id} data-person={p.id}>
                  <td style={{ ...sticky, minWidth: 220 }}>
                    {editing?.id === p.id ? (
                      <div className="toolbar-row" style={{ gap: 4 }}>
                        <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={{ width: 130 }} aria-label="Name" />
                        <input value={editing.tag} onChange={(e) => setEditing({ ...editing, tag: e.target.value })} style={{ width: 40 }} placeholder="Tag" aria-label="Tag" />
                        <button className="btn primary sm" type="button" disabled={busy !== '' || !editing.name.trim()}
                          onClick={() => void run(`ed-${p.id}`, async () => { await updateOnboardingPerson(p.id, { name: editing.name, tag: editing.tag }); setEditing(null); }, 'Saved.')}>Save</button>
                        <button className="btn ghost sm" type="button" onClick={() => setEditing(null)}>✕</button>
                      </div>
                    ) : (
                      <div className="toolbar-row" style={{ gap: 6, justifyContent: 'space-between' }}>
                        <span>
                          <strong>{p.name}</strong>
                          {p.tag && <span className="pill info" style={{ marginLeft: 6, fontSize: 10 }}>{p.tag}</span>}
                          {p.candidate_id && canManage && (
                            <button className="prop-link" type="button" style={{ marginLeft: 6, fontSize: 11 }} onClick={() => navigate(crmPath(`recruitment/${p.candidate_id}`))}>candidate</button>
                          )}
                        </span>
                        <span style={{ whiteSpace: 'nowrap' }}>
                          {canEdit && (
                            <button className="btn ghost sm" type="button" title="Rename" aria-label={`Rename ${p.name}`}
                              onClick={() => setEditing({ id: p.id, name: p.name, tag: p.tag ?? '' })}>✎</button>
                          )}
                          {canManage && (
                            <button className="btn ghost sm" type="button" title="Remove from the list" aria-label={`Remove ${p.name}`}
                              onClick={() => askDelete({
                                title: `Remove ${p.name}?`,
                                message: 'They leave the Onboarding & Training list. Their recorded steps are kept, and nothing else in the CRM changes.',
                                confirmLabel: 'Remove',
                                onConfirm: () => { closeConfirm(); void run(`rm-${p.id}`, () => removeOnboardingPerson(p.id), 'Removed from the list.'); },
                              })}>✕</button>
                          )}
                        </span>
                      </div>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className={done === steps.length && steps.length ? 'pill ok' : 'pill info'}>{done}/{steps.length}</span>
                  </td>
                  {steps.map((s) => {
                    const v = p.marks[s.id] ?? '';
                    const style: CSSProperties = { ...(CELL_STYLE[v] ?? {}), fontSize: 12, borderRadius: 6, padding: '3px 4px', width: '100%' };
                    return (
                      <td key={s.id} style={{ padding: 4 }}>
                        {canEdit ? (
                          <select value={v} aria-label={`${p.name} — ${s.title}`} style={{ ...style, border: '1px solid var(--line)' }}
                            onChange={(e) => void setCell(p, s.id, e.target.value)}>
                            <option value="">—</option>
                            {data.values[kind].map((code) => <option key={code} value={code}>{labels[code] ?? code}</option>)}
                            {/* A value from the other kind (a step moved between lists) still shows. */}
                            {v && !data.values[kind].includes(v) && <option value={v}>{labels[v] ?? v}</option>}
                          </select>
                        ) : (
                          <span style={{ ...style, display: 'inline-block' }}>{v ? labels[v] ?? v : '—'}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {importing && <OnboardingImport onClose={() => setImporting(false)} onImported={() => void load()} />}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </div>
  );
}

/** Super Admin and Admin: add, rename, reorder and hide the current list's steps. Hidden steps keep their values. */
function StepManager({ data, kind, busy, run }: {
  data: OnboardingList;
  kind: OnboardingKind;
  busy: string;
  run: (key: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [names, setNames] = useState<Record<number, string>>({});
  const all = data.steps.filter((s) => s.kind === kind);
  return (
    <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 10 }} data-testid="step-manager">
      <div className="modal-sub">{kind === 'onboarding' ? 'Onboarding steps' : 'Training topics'}</div>
      {all.map((s, i) => (
        <div key={s.id} className="toolbar-row" style={{ gap: 6, marginBottom: 4, opacity: s.hidden ? 0.55 : 1 }}>
          <span className="muted" style={{ width: 22, textAlign: 'right' }}>{i + 1}.</span>
          <input value={names[s.id] ?? s.title} onChange={(e) => setNames({ ...names, [s.id]: e.target.value })} style={{ flex: 1, minWidth: 240 }} aria-label={`Title of step ${i + 1}`} />
          {names[s.id] !== undefined && names[s.id] !== s.title && (
            <button className="btn primary sm" type="button" disabled={busy !== '' || !names[s.id].trim()}
              onClick={() => void run(`st-${s.id}`, async () => {
                await updateOnboardingStep(s.id, { title: names[s.id] });
                setNames((n) => { const c = { ...n }; delete c[s.id]; return c; });
              }, 'Renamed.')}>Save</button>
          )}
          <button className="btn ghost sm" type="button" disabled={busy !== '' || i === 0} aria-label="Move up" onClick={() => void run(`st-${s.id}`, () => updateOnboardingStep(s.id, { move: 'up' }))}>↑</button>
          <button className="btn ghost sm" type="button" disabled={busy !== '' || i === all.length - 1} aria-label="Move down" onClick={() => void run(`st-${s.id}`, () => updateOnboardingStep(s.id, { move: 'down' }))}>↓</button>
          <button className="btn ghost sm" type="button" disabled={busy !== ''} onClick={() => void run(`st-${s.id}`, () => updateOnboardingStep(s.id, { hidden: !s.hidden }), s.hidden ? 'Shown again.' : 'Hidden. Its values are kept.')}>
            {s.hidden ? 'Show' : 'Hide'}
          </button>
        </div>
      ))}
      <div className="toolbar-row" style={{ gap: 6, marginTop: 8 }}>
        <input placeholder={kind === 'onboarding' ? 'New onboarding step' : 'New training topic'} value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
        <button className="btn primary sm" type="button" disabled={busy !== '' || !title.trim()}
          onClick={() => void run('st-add', async () => { await addOnboardingStep(kind, title); setTitle(''); }, 'Added.')}>Add</button>
      </div>
    </div>
  );
}

/**
 * IMPORT THE "Onboarding & Trainings" WORKBOOK. Reads its NEW ONBOARD TASK SHEET and Training topics
 * tabs; fills blanks only, so a value already set in the CRM is never overwritten. Training-tab names
 * that match nobody on the onboarding tab are shown with a suggested match, which the administrator
 * confirms or changes before anything is saved.
 */
function OnboardingImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<{ filename: string; content_base64: string } | null>(null);
  const [preview, setPreview] = useState<OnboardingImportSummary | null>(null);
  const [result, setResult] = useState<OnboardingImportSummary | null>(null);
  const [matches, setMatches] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'' | 'preview' | 'import'>('');
  const [error, setError] = useState('');

  const choose = async (f: File | null) => {
    setPreview(null); setResult(null); setError(''); setFile(null);
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.xlsx')) { setError('Choose the Excel workbook (.xlsx).'); return; }
    if (f.size > MAX_BYTES) { setError('The file is larger than 2 MB.'); return; }
    setBusy('preview');
    try {
      const payload = { filename: f.name, content_base64: await fileToBase64(f) };
      const p = await previewOnboardingImport(payload);
      setPreview(p);
      setMatches(Object.fromEntries(p.unmatched.map((u) => [u.key, u.suggestion ?? ''])));
      setFile(payload);
    } catch (ex) {
      setError(apiErrorMessage(ex, 'The file could not be checked'));
    } finally {
      setBusy('');
    }
  };

  const chosen = Object.values(matches).filter(Boolean);
  const clash = chosen.length !== new Set(chosen).size;

  const runImport = async () => {
    if (!file || busy || result) return;
    setBusy('import');
    setError('');
    try {
      const r = await importOnboardingSheet(file, matches);
      setResult(r);
      onImported();
      toast(`Imported ${r.imported?.people ?? 0} agents and ${r.imported?.marks ?? 0} values.`, 'ok');
    } catch (ex) {
      setError(apiErrorMessage(ex, 'The import did not complete. Nothing was saved; try again.'));
    } finally {
      setBusy('');
    }
  };

  const s = result ?? preview;
  // Portalled like ConfirmDialog: inside the tab's card the overlay would be laid out against the card, not the window.
  return createPortal(
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && busy !== 'import') onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-import-title" style={{ maxWidth: 820, width: '96vw' }}>
        <button className="close" type="button" onClick={onClose} disabled={busy === 'import'} aria-label="Close">✕</button>
        <div className="modal-h" id="onboarding-import-title">Import the Onboarding &amp; Trainings sheet</div>
        <p className="help" style={{ marginTop: 0 }}>
          Reads the <strong>NEW ONBOARD TASK SHEET</strong> and <strong>Training topics</strong> tabs. It only fills empty cells:
          a value already set in the CRM is never changed. Nothing is saved until you press Import.
        </p>
        <div className="toolbar-row" style={{ gap: 8, alignItems: 'center' }}>
          <label className="btn ghost sm" style={{ cursor: busy ? 'default' : 'pointer' }}>
            {preview ? 'Choose a different file' : 'Choose file (.xlsx)'}
            <input type="file" accept=".xlsx" data-testid="onboarding-import-file" style={{ display: 'none' }} disabled={busy !== '' || !!result}
              onChange={(e) => { void choose(e.target.files?.[0] ?? null); e.target.value = ''; }} />
          </label>
          {busy === 'preview' && <span className="help" style={{ margin: 0 }}>Checking the file…</span>}
          {file && <span className="muted">{file.filename}</span>}
        </div>
        {error && <p className="help bad" role="alert">{error}</p>}

        {s && (
          <div data-testid="onboarding-import-summary" style={{ marginTop: 10 }}>
            {result?.imported ? (
              <p><strong>Imported:</strong> {result.imported.people} new agents, {result.imported.marks} values.
                {' '}{result.marks.kept_crm_value ? `${result.marks.kept_crm_value} cells kept the CRM's value.` : ''}</p>
            ) : (
              <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                <li>Tabs read: {[s.sheets.onboarding, s.sheets.training].filter(Boolean).join(', ') || '—'}
                  {s.ignored_sheets.length ? ` (not read: ${s.ignored_sheets.join(', ')})` : ''}</li>
                <li>Agents: {s.people.total} — {s.people.new} new, {s.people.existing} already on the list</li>
                <li>Values: {s.marks.new} to add{s.marks.already_same ? `, ${s.marks.already_same} already the same` : ''}
                  {s.marks.kept_crm_value ? `, ${s.marks.kept_crm_value} differ and will keep the CRM's value` : ''}</li>
                {s.unknown_columns.length > 0 && (
                  <li className="bad">Columns with no matching step (skipped): {s.unknown_columns.map((u) => u.title).join('; ')}</li>
                )}
                {s.unknown_value_count > 0 && (
                  <li>Cells that are not one of the sheet's values (skipped): {s.unknown_values.map((u) => `${u.cell} "${u.value}"`).join(', ')}
                    {s.unknown_value_count > s.unknown_values.length ? ` and ${s.unknown_value_count - s.unknown_values.length} more` : ''}</li>
                )}
              </ul>
            )}

            {!result && s.unmatched.length > 0 && (
              <>
                <div className="modal-sub">Names on the Training tab that are not on the onboarding tab</div>
                <p className="help" style={{ marginTop: 0 }}>Check each one. A suggested match is chosen where the names share a word.</p>
                <div className="lead-scroll" style={{ maxHeight: 260, overflow: 'auto' }}>
                  <table className="list-table" data-testid="onboarding-import-unmatched">
                    <thead><tr><th>Training tab name</th><th>Same person as</th></tr></thead>
                    <tbody>
                      {s.unmatched.map((u) => (
                        <tr key={u.key}>
                          <td>{u.name}</td>
                          <td>
                            <select value={matches[u.key] ?? ''} aria-label={`Match for ${u.name}`}
                              onChange={(e) => setMatches({ ...matches, [u.key]: e.target.value })}>
                              <option value="">Nobody — add as a new agent</option>
                              {s.pool.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {clash && <p className="help bad">Two names are matched to the same person. Change one of them.</p>}
              </>
            )}
          </div>
        )}

        <div className="toolbar-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          {result ? (
            <button className="btn primary" type="button" onClick={onClose}>Done</button>
          ) : (
            <>
              <button className="btn ghost" type="button" onClick={onClose} disabled={busy === 'import'}>Cancel</button>
              <button className="btn primary" type="button" disabled={!preview || busy !== '' || clash} onClick={() => void runImport()}>
                {busy === 'import' ? 'Importing…' : 'Import'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
