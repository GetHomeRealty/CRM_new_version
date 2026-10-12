import { useCallback, useEffect, useState } from 'react';
import { deliverabilityReport, type AuthCheck, type DeliverabilityReport } from '../lib/campaignsApi';
import { apiErrorMessage } from '../lib/apiError';
import Icon from '../ui/Icon';

/**
 * What DNS says about the domain this brokerage's campaigns are sent from.
 *
 * WHY IT IS ON SCREEN AT ALL. The server has been able to produce this report for some time —
 * `GET /api/campaigns/deliverability` runs the SPF, DKIM and DMARC checks and returns them — and
 * nothing in the client had ever called it. So the one place the answer existed was a developer
 * running the endpoint by hand, which is how a domain can go on failing authentication for months
 * with everybody wondering why campaigns land in Promotions.
 *
 * AUTHENTICATION IS OBJECTIVE; PLACEMENT IS NOT. SPF, DKIM and DMARC either exist in DNS or they
 * do not, and Gmail has required them of bulk senders since 2024 — failing them risks the SPAM
 * FOLDER, which is a different and worse problem than the Promotions tab. This panel therefore
 * reports authentication as fact and says nothing that promises a tab: Gmail decides that per
 * RECIPIENT from engagement history, and no sender controls it.
 *
 * FIXES ARE SHOWN, NEVER APPLIED. Every remedy here is a DNS record, which belongs to whoever
 * administers the domain. The panel prints the record to publish and stops there.
 */

const TONE: Record<AuthCheck['status'], { cls: string; label: string }> = {
  pass: { cls: 'ok', label: 'Pass' },
  warn: { cls: 'warn', label: 'Warning' },
  fail: { cls: 'bad', label: 'Fail' },
  unknown: { cls: '', label: 'Unknown' },
};

const RISK: Record<DeliverabilityReport['risk'], { cls: string; text: string }> = {
  low: { cls: 'ok', text: 'Low spam risk' },
  medium: { cls: 'warn', text: 'Medium spam risk' },
  high: { cls: 'bad', text: 'High spam risk' },
};

export default function DeliverabilityPanel() {
  const [report, setReport] = useState<DeliverabilityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReport(await deliverabilityReport());
    } catch (e) {
      // A DNS check that cannot run is not a campaign failure, so this reports itself quietly and
      // leaves the rest of the screen alone.
      setError(apiErrorMessage(e, 'The deliverability check could not be run'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading && !report) {
    return <div className="card" style={{ marginBottom: 12 }}><span className="help">Checking sender authentication…</span></div>;
  }
  if (error) {
    return (
      <div className="card" style={{ marginBottom: 12 }}>
        <span className="help bad" role="alert">{error}</span>{' '}
        <button className="btn ghost sm" type="button" onClick={() => void load()}>Try again</button>
      </div>
    );
  }
  if (!report) return null;

  // No mailbox connected: there is no domain to check, and saying so is the whole message.
  if (report.error) {
    return <div className="card" style={{ marginBottom: 12 }}><span className="help">{report.error}</span></div>;
  }

  const failing = report.auth.filter((a) => a.status === 'fail' || a.status === 'warn');
  const risk = RISK[report.risk];

  return (
    <div className="card" style={{ marginBottom: 12 }} data-testid="deliverability-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="rev-toggle" onClick={() => setOpen((v) => !v)}
          data-testid="deliverability-toggle">
          <Icon name="lock" size={13} /> Sender authentication
          <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{report.domain}</span>
          <span className={`pill ${risk.cls}`} style={{ fontSize: 10 }} data-testid="deliverability-risk">{risk.text}</span>
          <span className="muted" style={{ fontSize: 11 }}>{open ? '▾' : '▸'}</span>
        </button>

        {/* The headline when closed: how many mechanisms are not passing, if any. */}
        {!open && failing.length > 0 && (
          <span className="muted" style={{ fontSize: 12 }} data-testid="deliverability-summary">
            {failing.map((a) => a.name).join(', ')} need attention
          </span>
        )}

        <button className="btn ghost sm" type="button" style={{ marginLeft: 'auto' }}
          disabled={loading} onClick={() => void load()}>
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {open && (
        <>
          <table className="tbl" style={{ marginTop: 10 }}>
            <thead><tr><th>Check</th><th>Result</th><th>What DNS says</th></tr></thead>
            <tbody>
              {report.auth.map((a) => (
                <tr key={a.name} data-testid={`auth-${a.name}`}>
                  <td><strong>{a.name}</strong></td>
                  <td><span className={`pill ${TONE[a.status].cls}`} style={{ fontSize: 10 }}>{TONE[a.status].label}</span></td>
                  <td style={{ fontSize: 12.5 }}>
                    {a.detail}
                    {a.fix && (
                      <div className="muted" style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11.5, wordBreak: 'break-all' }}>
                        Publish: {a.fix}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="help" style={{ marginTop: 8 }}>
            These are DNS records for the sending domain and have to be published by whoever
            administers it — nothing here changes them. Authentication affects whether mail is
            accepted at all; which Gmail tab it lands in is decided separately, per recipient, and
            cannot be guaranteed.
          </p>
        </>
      )}
    </div>
  );
}
