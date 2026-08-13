import { useArea } from './AreaContext';
import { useCallback, useEffect, useState } from 'react';
import { createTodo, deleteTodo, listTodos, updateTodo } from '../lib/todosApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import type { Todo, TodoCounts, TodoFilters, TodoPriority, TodoStatus } from '../types';

const EMPTY_FILTERS: TodoFilters = { search: '', status: '', priority: '' };
const EMPTY_COUNTS: TodoCounts = { total: 0, pending: 0, completed: 0, cancelled: 0, overdue: 0 };

const STATUSES: TodoStatus[] = ['pending', 'completed', 'cancelled'];
const PRIORITIES: TodoPriority[] = ['low', 'medium', 'high'];

/** "2026-07-08" → "Jul 8, 2026" */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dueLabel = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : ymd;
};

const priorityPill = (p: string): string => (p === 'high' ? 'bad' : p === 'low' ? 'ok' : 'warn');
const statusPill = (s: string): string => (s === 'completed' ? 'ok' : s === 'cancelled' ? '' : 'info');
const title = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

/**
 * Quick checklist on the Dashboard. Todos are personal — each user only ever sees their own —
 * and carry no time slot, which is what separates them from calendar events.
 *
 * They are still stored and permissioned under the Calendar screen (`/api/calendar/todos`), so
 * the Dashboard only renders this for someone who can see the Calendar.
 */
export default function TodoList({ onCounts }: { onCounts?: (c: TodoCounts) => void } = {}) {
  const { area } = useArea();
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('calendar', 'edit');
  const { confirm, askDelete, closeConfirm } = useConfirm();

  const [todos, setTodos] = useState<Todo[]>([]);
  const [counts, setCounts] = useState<TodoCounts>(EMPTY_COUNTS);
  const [filters, setFilters] = useState<TodoFilters>(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(0);
  /*
   * Collapsed until asked for, matching the two lead panels above it on the dashboard.
   *
   * The heading and the item count stay visible when shut, so the card still reports how much is
   * on the list; what folds is the toolbar and the rows. Nothing about loading, filtering, adding,
   * completing or deleting changes — this only decides what is drawn.
   */
  const [showList, setShowList] = useState(false);

  // Debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setFilters((f) => (f.search === search ? f : { ...f, search })), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await listTodos(area, filters);
      setTodos(res.data);
      setCounts(res.counts);
      // The summary card above reads the same numbers, so it cannot drift out of step with the
      // list after an add, a tick or a delete. The counts are unfiltered server-side.
      onCounts?.(res.counts);
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load todos'), 'bad');
    } finally {
      setLoading(false);
    }
    // `area` is a dependency: the CRM's list and the Transaction Desk's are different lists.
  }, [filters, toast, onCounts, area]);

  useEffect(() => { void load(); }, [load]);

  const run = async (id: number, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try {
      await fn();
      toast(ok, 'ok');
      await load(true);
    } catch (ex) {
      toast(apiErrorMessage(ex, 'That did not work'), 'bad');
    } finally {
      setBusy(0);
    }
  };

  const remove = (t: Todo) => askDelete({
    title: 'Delete this todo?',
    message: t.title,
    onConfirm: async () => {
      await run(t.id, () => deleteTodo(area, t.id), 'Todo deleted.');
      closeConfirm();
    },
  });

  const filtersActive = filters.search !== '' || filters.status !== '' || filters.priority !== '';
  const clearFilters = () => { setSearch(''); setFilters(EMPTY_FILTERS); };

  // Grouped by status, in workflow order, so the list reads like a checklist.
  const groups: { key: TodoStatus; label: string; items: Todo[] }[] = STATUSES.map((key) => ({
    key,
    label: title(key),
    items: todos.filter((t) => t.status === key),
  }));

  return (
    <>
      <div className="card todo-card">
      <div className="todo-head">
        <div className="todo-head-title">
          <h3 className="todo-title">Todo List</h3>
          <div className="muted todo-sub">Quick checklist and reminders</div>
        </div>
        <div className="todo-head-actions">
          <span className="todo-count">{counts.total} item{counts.total === 1 ? '' : 's'}</span>
          {counts.overdue > 0 && <span className="pill bad">{counts.overdue} overdue</span>}
          {/* The controls that only make sense against a visible list fold away with it; the count
              and the overdue pill stay, because those are what the card says when it is shut. */}
          {showList && (
            <>
              <button className="btn ghost sm" type="button" onClick={clearFilters} disabled={!filtersActive}>Clear filters</button>
              <button className="btn ghost sm" type="button" onClick={() => void load()}>↻ Refresh</button>
              {canEdit && <button className="btn primary sm" type="button" onClick={() => setAdding(true)}>+ Add todo</button>}
            </>
          )}
          <button
            type="button"
            className="btn ghost sm"
            aria-expanded={showList}
            title={showList ? 'Hide the todo list' : 'Show the todo list'}
            onClick={() => setShowList((v) => !v)}
          >
            {showList ? '▲ Hide' : '▼ View'}
          </button>
        </div>
      </div>

      {showList && (
      <>
      <div className="todo-filters">
        <input
          className="todo-search"
          placeholder="Search todos…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{title(s)}</option>)}
        </select>
        <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
          <option value="">All priority</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{title(p)}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="help">Loading todos…</p>
      ) : todos.length === 0 ? (
        <p className="help">
          {filtersActive ? 'No todos match these filters.' : 'Nothing on the list.'}
          {canEdit && !filtersActive ? ' Add one to get started.' : ''}
        </p>
      ) : (
        groups.filter((g) => g.items.length > 0).map((g) => (
          <div key={g.key} className="todo-group">
            <div className="todo-group-h">
              <span className={`todo-dot ${g.key}`} aria-hidden />
              {g.label} ({g.items.length})
            </div>
            {g.items.map((t) => (
              <div key={t.id} className={`todo-row${t.overdue ? ' overdue' : ''}${t.status !== 'pending' ? ' done' : ''}`}>
                <button
                  type="button"
                  className={`todo-check${t.status === 'completed' ? ' on' : ''}`}
                  disabled={!canEdit || busy === t.id || t.status === 'cancelled'}
                  aria-label={t.status === 'completed' ? `Reopen ${t.title}` : `Complete ${t.title}`}
                  title={t.status === 'completed' ? 'Mark as pending' : 'Mark as complete'}
                  onClick={() => void run(t.id,
                    () => updateTodo(area, t.id, { status: t.status === 'completed' ? 'pending' : 'completed' }),
                    t.status === 'completed' ? 'Todo reopened.' : 'Todo completed.')}
                >
                  {t.status === 'completed' ? '✓' : ''}
                </button>

                <div className="todo-body">
                  <div className="todo-row-title">{t.title}</div>
                  {t.description && <div className="muted todo-desc">{t.description}</div>}
                  {t.due_date && (
                    <div className={`todo-due${t.overdue ? ' overdue' : ''}`}>
                      ⏱ Due {dueLabel(t.due_date)}{t.overdue ? ' (Overdue)' : ''}
                    </div>
                  )}
                </div>

                <div className="todo-tags">
                  <span className={`pill ${priorityPill(t.priority)}`}>{t.priority}</span>
                  <span className={`pill ${statusPill(t.status)}`}>{t.status}</span>
                </div>

                {canEdit && (
                  <div className="todo-actions">
                    {t.status === 'pending' ? (
                      <button className="btn ghost sm todo-cancel" type="button" disabled={busy === t.id}
                        onClick={() => void run(t.id, () => updateTodo(area, t.id, { status: 'cancelled' }), 'Todo cancelled.')}>
                        Cancel
                      </button>
                    ) : (
                      <button className="btn ghost sm" type="button" disabled={busy === t.id}
                        onClick={() => void run(t.id, () => updateTodo(area, t.id, { status: 'pending' }), 'Todo reopened.')}>
                        Reopen
                      </button>
                    )}
                    <button className="btn sm todo-del" type="button" disabled={busy === t.id}
                      title="Delete todo" aria-label={`Delete ${t.title}`} onClick={() => remove(t)}>
                      🗑
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))
      )}
      </>
      )}

      </div>

      {/* Rendered OUTSIDE the card, like every other modal in the app. A `.card` animates a
          transform, and while that runs it becomes the containing block for any fixed-position
          descendant — which left this dialog positioned against the card instead of the
          viewport, overlapping the list behind it. */}
      {adding && (
        <TodoEditor
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); void load(true); }}
        />
      )}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}

function TodoEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  // The editor is its own component, so it reads the area itself — a new task belongs to the area
  // whose dashboard it was added from.
  const { area } = useArea();
  const toast = useToast();
  const [form, setForm] = useState({ title: '', description: '', priority: 'medium' as TodoPriority, due_date: '' });
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await createTodo(area, {
        title: form.title.trim(),
        description: form.description.trim(),
        priority: form.priority,
        due_date: form.due_date,
      });
      toast('Todo added.', 'ok');
      onSaved();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not add the todo'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    // Escape closes it, like every other dismissable layer. Without this the modal could only be
    // left through Cancel, and its overlay swallows clicks on everything behind — a keyboard user
    // reaching it had no way out at all.
    <div className="overlay open"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      role="dialog" aria-modal="true" aria-labelledby="todo-add-heading">
      <div className="modal" style={{ maxWidth: 460 }}>
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h" id="todo-add-heading">Add Todo</div>
        {/* Each label carries htmlFor and each control an id. They were adjacent but unassociated,
            so a screen reader announced four unnamed boxes. */}
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="todo-title">Title *</label>
            <input id="todo-title" name="title" value={form.title} autoFocus required
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="todo-description">Description</label>
            <textarea id="todo-description" name="description" rows={2} value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="g2">
            <div className="field">
              <label htmlFor="todo-priority">Priority</label>
              <select id="todo-priority" name="priority" value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as TodoPriority }))}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{title(p)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="todo-due-date">Due date</label>
              <input id="todo-due-date" name="due_date" type="date" value={form.due_date}
                onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
            </div>
          </div>
          <div className="actions">
            <button className="btn ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn primary" type="submit" disabled={saving || !form.title.trim()}>
              {saving ? 'Saving…' : 'Add Todo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
