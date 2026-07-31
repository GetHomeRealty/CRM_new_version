import { useEffect, useState } from 'react';
import { getReviewErrors, type ReviewErrors } from '../lib/api';
import { Tile } from './DashboardTiles';
import Icon from '../ui/Icon';

/**
 * What keeps going wrong: the fields rejected most often, and the reasons given most often.
 *
 * Horizontal bars because both axes are categories with long names — "Documents Outstanding —
 * Validation" does not fit under a vertical bar, and rotating a label to make it fit is how a chart
 * becomes unreadable. Ranked, most first, because the question is "what should we fix next".
 *
 * ONE series per chart, so one hue rather than a different colour per bar: colouring by rank would
 * say the bars are different KINDS of thing, and they are not — they are the same measure at
 * different sizes. The value is printed at the end of each bar, which removes the need for an axis
 * entirely. Both hues are the validated blue for their surface (light #2a78d6 / dark #3987e5).
 */

const hours = (h: number | null): string => {
  if (h === null) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round((h / 24) * 10) / 10} days`;
};

/** A ranked bar list. Bars are proportional to the largest value, not to the total. */
function BarList({ rows, empty }: { rows: { name: string; count: number }[]; empty: string }) {
  if (rows.length === 0) return <div className="help">{empty}</div>;
  const top = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="rvc-list">
      {rows.map((r) => (
        <div key={r.name} className="rvc-row" title={`${r.name} — ${r.count}`}>
          <span className="rvc-label">{r.name}</span>
          <span className="rvc-track">
            <i className="rvc-bar" style={{ width: `${Math.max(3, (r.count / top) * 100)}%` }} />
          </span>
          <span className="rvc-value">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

export default function ReviewErrorCharts() {
  const [data, setData] = useState<ReviewErrors | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getReviewErrors().then(setData).catch(() => setFailed(true));
  }, []);

  if (failed || !data) return null;
  // Nothing has been rejected: there is no pattern to show, and two empty charts say less than
  // nothing at all.
  if (data.sampled === 0) return null;

  return (
    <>
      <div className="tiles">
        <Tile label="First Response" value={hours(data.first_response.median_hours)}
          sub={data.first_response.sampled ? `median · avg ${hours(data.first_response.average_hours)} · ${data.first_response.sampled} answered` : 'nothing answered yet'} />
        <Tile label="Correction Time" value={hours(data.correction_time.median_hours)}
          sub={data.correction_time.sampled ? `median · avg ${hours(data.correction_time.average_hours)} · ${data.correction_time.sampled} corrected` : 'nothing corrected yet'} />
      </div>

      <div className="rvc-grid">
        <div className="card rvc-card">
          <div className="modal-h" style={{ fontSize: 13.5 }}><Icon name="alert" size={12} /> Most rejected fields</div>
          <p className="help" style={{ marginTop: 0 }}>
            Rejections by field, most first{data.scope === 'own' ? ', on your deals' : ''} — over the last {data.sampled} decisions.
          </p>
          <BarList rows={data.by_field} empty="Nothing has been rejected yet." />
        </div>

        <div className="card rvc-card">
          <div className="modal-h" style={{ fontSize: 13.5 }}><Icon name="message" size={12} /> Most common reasons</div>
          <p className="help" style={{ marginTop: 0 }}>
            Wording is grouped, so the same complaint typed twice counts once.
          </p>
          <BarList rows={data.by_reason} empty="No reasons recorded yet." />
        </div>
      </div>
    </>
  );
}

