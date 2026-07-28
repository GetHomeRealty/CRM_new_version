import GoogleCalendarCard from './GoogleCalendarCard';
import EmailIntegrationCard from './EmailIntegrationCard';

/**
 * Settings → Integrations — the transaction side.
 *
 * Exactly two connections, and nothing else:
 *
 *  · Email    — the per-user Gmail / SMTP sending + inbox connection
 *  · Calendar — Google Calendar via OAuth, for closing dates, showings and reminders
 *
 * Meta is NOT here. Facebook/Instagram lead capture feeds the CRM, not transactions, so it
 * belongs to CRM Settings → Integrations and is reachable only from there. Mail and
 * calendar appear in both areas on purpose: one per-user connection serves both sides, so
 * these are two doors onto the same thing rather than two configurations to keep in step.
 *
 * The legacy brokerage-wide "SMTP Sender Accounts" table is deliberately not on this
 * screen — sending is configured per user through Mail Configuration above.
 *
 * Both components are the originals — same cards, same layout, same validation, same
 * save / test / enable behaviour.
 */
export default function IntegrationsPanel() {
  return (
    <div className="card">
      <div className="modal-h">Integrations</div>
      <p className="help">
        Email and calendar connections for the transaction side. Each connection is scoped
        to your own login. Looking for Meta? It lives in{' '}
        <strong>CRM Settings → Integrations</strong>, because it feeds the CRM.
      </p>

      {/* Mail Configuration — connect your own Gmail / SMTP sending + inbox account. */}
      <EmailIntegrationCard scope="desk" />

      {/* Google Calendar — real OAuth "Sign in with Google", connected right here. */}
      <GoogleCalendarCard scope="desk" />
    </div>
  );
}
