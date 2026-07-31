import { useEffect, useState } from 'react';
import { getReviewStats, type ReviewStats } from '../lib/api';
import { Tile } from './DashboardTiles';
import Icon from '../ui/Icon';

/**
 * The review figures on the Transaction Desk dashboard.
 *
 * Loaded on their own after the dashboard has rendered, from an endpoint of their own: the desk
 * dashboard is already the heaviest read in the application, and five aggregates over a table that
 * grows with every decision should not be charged to every visit before the page can paint.
 *
 * An agent sees their own items and an administrator sees the brokerage's — decided on the server,
 * not here, so the screen cannot show a figure the API would not have given.
 */

/** Hours into something a person can read at a glance. */
const duration = (hours: number | null): string => {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
};

/** A short ranked list — who is holding the most, most first. */
function Ranked({ rows }: { rows: { name: string; count: number }[] }) {
  if (rows.length === 0) return <span className="muted">None</span>;
  const top = rows[0].count || 1;
  return (
    <div className="rev-rank">
      {rows.slice(0, 5).map((r) => (
        <div key={r.name} className="rev-rank-row" title={`${r.name}: ${r.count}`}>
          <span className="rev-rank-name">{r.name}</span>
          <span className="rev-rank-bar"><i style={{ width: `${Math.max(6, (r.count / top) * 100)}%` }} /></span>
          <span className="rev-rank-n">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

export default function ReviewWidgets() {
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getReviewStats().then(setStats).catch(() => setFailed(true));
  }, []);

  // A dashboard that cannot load one of its panels should lose that panel, not shout about it.
  if (failed || !stats) return null;
  // Nothing has ever been reviewed: no counters worth the space.
  if (stats.open === 0 && stats.corrected === 0 && stats.by_staff.length === 0 && stats.resolved_sampled === 0) return null;

  return (
    <>
      <div className="tiles">
        <Tile
          label="Open Reviews"
          value={stats.open}
          color={stats.open > 0 ? 'var(--warn-700)' : undefined}
          sub={stats.scope === 'own' ? 'your items awaiting correction' : 'awaiting the agent’s correction'}
        />
        <Tile
          label="Overdue Reviews"
          value={stats.overdue}
          color={stats.overdue > 0 ? 'var(--bad-700)' : undefined}
          sub={`open longer than ${stats.overdue_after_hours}h`}
        />
        <Tile
          label="Awaiting Approval"
          value={stats.corrected}
          color={stats.corrected > 0 ? 'var(--info-700)' : undefined}
          sub="corrected, not yet approved"
        />
        <Tile
          label="Average Resolution"
          value={duration(stats.average_resolution_hours)}
          sub={stats.resolved_sampled ? `over the last ${stats.resolved_sampled} resolved` : 'nothing resolved yet'}
        />
      </div>

      <div className="rev-widgets">
        <div className="card">
          <div className="modal-h" style={{ fontSize: 13.5 }}><Icon name="lead" size={12} /> Reviews by Agent</div>
          <p className="help" style={{ marginTop: 0 }}>Open and awaiting-approval items, by whose deal they are on.</p>
          <Ranked rows={stats.by_agent} />
        </div>
        <div className="card">
          <div className="modal-h" style={{ fontSize: 13.5 }}><Icon name="users" size={12} /> Reviews by Office Staff</div>
          <p className="help" style={{ marginTop: 0 }}>Rejections raised, by who reviewed them.</p>
          <Ranked rows={stats.by_staff} />
        </div>
      </div>
    </>
  );
}
