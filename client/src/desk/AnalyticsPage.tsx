import { useEffect, useState } from 'react';
import {
  getDeskAnalytics, getDeskAnalyticsOptions, exportDeskAnalytics,
  type AnalyticsQuery, type AnalyticsFilterOptions,
} from '../lib/api';
import { formatCurrency, typeClass, taxLabel } from './format';
import MonthCommissionChart from './MonthCommissionChart';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import type { DeskAnalytics } from '../types';

/**
 * Transaction Desk Analytics.
 *
 * The screen is unchanged — the same three figures, the same commission-by-month bars, the same two
 * tables. What changed is where the arithmetic happens. It used to call `listTransactions()`, which
 * with no query returns EVERY transaction the caller can see, fully serialised — statuses, clients,
 * co-operating brokerage and its agents, delete requests, unread counts — and then reduced all of
 * that in the browser to fourteen numbers. Opening Analytics therefore cost one full copy of the
 * brokerage's deal book over the wire and in memory, growing with the brokerage.
 *
 * `GET /api/dashboard/analytics` computes the same values where the data is and returns only them.
 *
 * EVERY FIGURE IS BEFORE HST. Commission is what the brokerage earns; HST is collected on its
 * behalf and remitted, so counting it as revenue overstates performance by 13%. This screen used to
 * mix the two — paid and pending before HST, the three groupings after, and a tile labelled
 * "incl. HST" over figures that excluded it. One basis now, stated on the tile.
 *
 * THE FILTERS DO NOT FILTER HERE. Each one is sent to the server and applied to the aggregate, so
 * the figures are computed over the filtered set rather than computed over everything and then
 * trimmed. Filtering in the browser would mean fetching the unfiltered brokerage to do it — the
 * exact thing this screen was moved off — and the totals would stop being totals OF the rows shown.
 *
 * THE AGENT SELECTOR IS NOT A SECURITY CONTROL. It is hidden for an agent because there is nothing
 * for them to choose, not to protect anything: the server locks an agent to their own figures and
 * refuses another agent's id whatever the browser sends.
 */
const EMPTY: AnalyticsQuery = { from: '', to: '', agent_user_id: '', type: '', status: '' };

/*
 * PERIOD WINDOW. With years of history the agent table was mostly the past. It now opens on deals
 * closing in the last twelve months onward, and loads earlier years twelve months at a time. (The
 * month chart has its own period picker — see MonthCommissionChart.) The window applies only when
 * no From/To range is set — a chosen range is shown whole. It is a view over the response, not a
 * filter: the totals cards and the export still cover everything.
 */
const WINDOW = 12;
/** First `YYYY-MM` shown with `chunks` blocks loaded: this month and the 12·chunks − 1 before it. */
function cutoffMonth(chunks: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - (WINDOW * chunks - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/** `2025-11` → `Nov 2025`. */
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-CA', { month: 'short', year: 'numeric' });
}

type AgentRow = DeskAnalytics['by_agent'][number];
/** The agent table over deals closing from `cut` on; deals with no closing date belong to no period. */
function agentsSince(agents: AgentRow[], byMonth: NonNullable<DeskAnalytics['by_agent_month']>, cut: string): AgentRow[] {
  const sums = new Map<number, { count: number; total: number }>();
  for (const r of byMonth) {
    if (r.month === 'none' || r.month < cut) continue;
    const s = sums.get(r.agent_id) ?? { count: 0, total: 0 };
    s.count += r.count;
    s.total += r.total ?? 0;
    sums.set(r.agent_id, s);
  }
  return agents
    .filter((a) => a.id !== undefined && sums.has(a.id))
    .map((a) => {
      const s = sums.get(a.id!)!;
      // Rounded once here: the per-month figures are already to the cent.
      return { ...a, count: s.count, total: typeof a.total === 'number' ? Math.round(s.total * 100) / 100 : a.total };
    })
    .sort((x, y) => (y.total ?? 0) - (x.total ?? 0) || y.count - x.count || x.agent.localeCompare(y.agent));
}

/** "Showing … · Load previous 12 months · Show latest 12 months" under a windowed card. */
function WindowBar({ from, older, expanded, onMore, onLess }: {
  from: string; older: boolean; expanded: boolean; onMore: () => void; onLess: () => void;
}) {
  if (!older && !expanded) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
      <span className="help" style={{ flex: 1 }}>
        {older ? `Showing closings from ${monthLabel(from)} onward.` : 'Showing all closings.'}
      </span>
      {older && <button className="btn sm" onClick={onMore}>Load previous 12 months</button>}
      {expanded && <button className="btn ghost sm" onClick={onLess}>Show latest 12 months</button>}
    </div>
  );
}

export default function AnalyticsPage() {
  const toast = useToast();
  const [data, setData] = useState<DeskAnalytics | null>(null);
  const [options, setOptions] = useState<AnalyticsFilterOptions | null>(null);
  const [filters, setFilters] = useState<AnalyticsQuery>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Whether the figures on screen were loaded with a From/To range — which turns the window off. */
  const [ranged, setRanged] = useState(false);
  /** The From/To the figures on screen were loaded with — not what is typed in the inputs. */
  const [appliedRange, setAppliedRange] = useState<{ from?: string; to?: string }>({});
  const [agentChunks, setAgentChunks] = useState(1);

  const load = (f: AnalyticsQuery) => {
    setBusy(true);
    return getDeskAnalytics(f)
      .then((d) => {
        setData(d); setRanged(!!f.from || !!f.to); setAgentChunks(1);
        setAppliedRange({ from: f.from || undefined, to: f.to || undefined });
      })
      .catch((e) => toast(apiErrorMessage(e, 'Could not load analytics'), 'bad'))
      .finally(() => { setBusy(false); setLoading(false); });
  };

  useEffect(() => {
    getDeskAnalyticsOptions().then(setOptions).catch(() => setOptions(null));
    load(EMPTY);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<AnalyticsQuery>) => setFilters((f) => ({ ...f, ...patch }));

  /*
   * The range is checked here too, so an obvious mistake is answered instantly rather than by a
   * round trip. The server checks it as well and is the authority — this is a courtesy, not the
   * validation.
   */
  const rangeBackwards = !!filters.from && !!filters.to && filters.from > filters.to;

  const apply = () => { if (!rangeBackwards) void load(filters); };
  const clear = () => { setFilters(EMPTY); void load(EMPTY); };

  const download = () => {
    if (rangeBackwards) return;
    setExporting(true);
    exportDeskAnalytics(filters)
      .catch((e) => toast(apiErrorMessage(e, 'Could not export analytics'), 'bad'))
      .finally(() => setExporting(false));
  };

  /** An agent has nothing to choose: the server locks them to themselves. */
  const agentLocked = options?.locked_agent_id != null;

  if (loading) return <div className="centered">Loading analytics…</div>;
  if (!data) return <div className="card stub"><h2>Nothing to show</h2><p className="help">Analytics could not be loaded. Try Refresh.</p></div>;

  const { totals, by_month: months, by_agent: agents, by_type: types } = data;

  // Newest month first; the "No closing date" bucket stays last and is always shown.

  // The agent table over the same kind of window, when the server sent the per-month split.
  const agentCut = cutoffMonth(agentChunks);
  const agentMonths = data.by_agent_month;
  const olderAgents = !ranged && !!agentMonths && agentMonths.some((r) => r.month !== 'none' && r.month < agentCut);
  const agentRows = olderAgents ? agentsSince(agents, agentMonths!, agentCut) : agents;
  const showMoney = agents.some((x) => typeof x.total === 'number');

  return (
    <>
      {/* Filters. Applied by the server; see the note at the top of this file. */}
      <div className="toolbar">
        <div className="toolbar-row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 150 }}>
            <span className="lbl">From</span>
            <input type="date" value={filters.from ?? ''} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="field" style={{ minWidth: 150 }}>
            <span className="lbl">To</span>
            <input type="date" value={filters.to ?? ''} onChange={(e) => set({ to: e.target.value })} />
          </label>

          {!agentLocked && (
            <label className="field" style={{ minWidth: 190 }}>
              <span className="lbl">Agent</span>
              <select
                value={String(filters.agent_user_id ?? '')}
                onChange={(e) => set({ agent_user_id: e.target.value === '' ? '' : Number(e.target.value) })}
              >
                <option value="">All agents</option>
                {(options?.agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}

          <label className="field" style={{ minWidth: 190 }}>
            <span className="lbl">Transaction type</span>
            <select value={filters.type ?? ''} onChange={(e) => set({ type: e.target.value })}>
              <option value="">All types</option>
              {(options?.types ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>

          <label className="field" style={{ minWidth: 170 }}>
            <span className="lbl">Status</span>
            <select value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value })}>
              <option value="">All statuses</option>
              {(options?.statuses ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>

          <div style={{ flex: 1 }} />
          <button className="btn primary sm" disabled={busy || rangeBackwards} onClick={apply}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
          <button className="btn ghost sm" disabled={busy} onClick={clear}>Clear</button>
          <button className="btn sm" disabled={exporting || rangeBackwards} onClick={download}>
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
        {rangeBackwards && (
          <p className="help" style={{ color: 'var(--bad-ink)' }}>
            The end date is before the start date.
          </p>
        )}
        {agentLocked && (
          <p className="help">Showing your own transactions.</p>
        )}
      </div>

      <div className="stat-grid">
        {/* TD-002 - for an agent these figures are the WHOLE deal's commission on their own deals,
            not their personal share (Dashboard and Reports show the share). Said on the card, so the
            two numbers are not read as one disagreeing with the other. */}
        <div className="stat-card"><div className="lbl">Total Commission{agentLocked ? ' (whole deal)' : ''}</div><div className="val">{formatCurrency(totals.total)}</div><div className="help">{agentLocked ? `before ${taxLabel()} · the full commission on your deals, not your share` : `before ${taxLabel()}`}</div></div>
        <div className="stat-card"><div className="lbl">Paid</div><div className="val" style={{ color: 'var(--ok-ink)' }}>{formatCurrency(totals.paid)}</div><div className="help">before {taxLabel()}</div></div>
        <div className="stat-card"><div className="lbl">Pending</div><div className="val" style={{ color: 'var(--warn-ink)' }}>{formatCurrency(totals.pending)}</div><div className="help">before {taxLabel()}</div></div>
      </div>

      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>Commission by Closing Month <span className="help" style={{ fontWeight: 400 }}>· before {taxLabel()}</span></div>
        {/* TD-092 — deals with no closing date (the API's `none` bucket) are stated under the chart,
            never charted under another month. Keyed by the applied range so a new range opens on it. */}
        {months.length === 0
          ? <div className="help">No transactions yet.</div>
          : <MonthCommissionChart key={`${appliedRange.from}|${appliedRange.to}`} months={months} from={appliedRange.from} to={appliedRange.to} />}
      </div>

      <div className="g2">
        <div className="card">
          {/*
            TD-109 — THIS BLOCK GROUPS BY THE DEAL'S PRIMARY AGENT, AND NOW SAYS SO.
            The figure on each line is the DEAL's commission, grouped by whoever is named as the
            deal's agent — not that person's own share. Headed as a ranking of agents by commission
            it read as each agent's earnings, so an agent looking at their own screen saw money
            under a colleague's name: on a team deal they are a member of, the deal is grouped under
            its primary agent. Nothing here is another agent's data — the scoping was tested
            separately and is right — and the counts and totals are unchanged. Only the heading and
            the column say which question they answer.
          */}
          <div className="modal-h" style={{ fontSize: 14 }}>Deals by Primary Agent<span className="help" style={{ fontWeight: 400 }}> · the deal’s commission, grouped by the agent named on it</span></div>
          <table className="list-table">{/* TD-002. The column is drawn only when the API sends commission at all. Driven by the
              data, not by the role: the server decides who may see money, and repeating that rule
              here would be a second copy of it to drift out of step. */}
            <thead><tr><th>Primary Agent</th><th>Deals</th>{showMoney && <th>Deal Commission</th>}</tr></thead>
            <tbody>
              {agentRows.length === 0 && <tr><td colSpan={showMoney ? 3 : 2} style={{ textAlign: 'center', color: 'var(--muted)', padding: 14 }}>{agents.length === 0 ? 'No data.' : 'No closings in this period.'}</td></tr>}
              {agentRows.map((a) => <tr key={a.id ?? a.agent}><td>{a.agent}</td><td>{a.count}</td>{showMoney && <td>{formatCurrency(a.total ?? 0)}</td>}</tr>)}
            </tbody>
          </table>
          <WindowBar from={agentCut} older={olderAgents} expanded={agentChunks > 1}
            onMore={() => setAgentChunks((n) => n + 1)} onLess={() => setAgentChunks(1)} />
        </div>
        <div className="card">
          <div className="modal-h" style={{ fontSize: 14 }}>By Transaction Type</div>
          <table className="list-table"><thead><tr><th>Type</th><th>Deals</th><th>Commission</th></tr></thead>
            <tbody>
              {types.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)', padding: 14 }}>No data.</td></tr>}
              {types.map((t) => <tr key={t.type}><td><span className={`pill ${typeClass(t.type)}`}>{t.type}</span></td><td>{t.count}</td><td>{formatCurrency(t.total)}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
