import { useParams } from 'react-router-dom';

// Only the modules without an existing data source remain here. Each needs its
// own backend (table + endpoints) before it can be built.
const INFO = {
  reviews: ['Client Reviews', 'Collect and display reviews from closed transactions.', 'Needs a reviews table + a client review-request email flow.'],
  favorites: ['Favorites', 'Pin listings and clients for quick access.', 'Needs a favorites table linking users to records.'],
  inbox: ['Inbox', 'Internal messages between admin and agents.', 'Needs a messages/threads table (the per-transaction Chat is a separate feature).'],
  lead: ['Lead', 'Leads captured from marketing sources.', 'Needs a leads table + intake form / source integrations.'],
  triggers: ['Triggers', 'Automations that fire on status change or a date being reached.', 'Needs a triggers/automation-rules engine.'],
  settings: ['Settings', 'Brokerage settings, taxes, and branding.', 'Needs a settings store (HST rate, brokerage details, branding).'],
};

export default function StubPage() {
  const { page } = useParams();
  const [title, msg, note] = INFO[page] || ['Page', 'Coming soon.', ''];
  return (
    <div className="card stub">
      <h2>{title}</h2>
      <p>{msg}</p>
      <p className="help" style={{ marginTop: 10 }}>🚧 Planned module — {note}</p>
    </div>
  );
}
