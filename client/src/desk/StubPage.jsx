import { useParams } from 'react-router-dom';

const INFO = {
  dashboard: ['Dashboard', 'Overview KPIs across transactions, agents, and leads.'],
  analytics: ['Analytics', 'Charts for commission, pipeline, agent performance.'],
  calendar: ['Calendar', 'Offer and closing dates plus reminders.'],
  reviews: ['Client Reviews', 'Collected reviews from closed transactions.'],
  favorites: ['Favorites', 'Pinned listings and clients.'],
  inbox: ['Inbox', 'Internal messages between admin and agents.'],
  inventory: ['Inventory', 'Listing inventory with status tags.'],
  invoice: ['Invoice', 'Generated invoices from closed transactions.'],
  lead: ['Lead', 'Leads from marketing sources.'],
  mls: ['MLS', 'MLS listing sync and history.'],
  reports: ['Reports', 'Monthly and YTD reports with CSV export.'],
  triggers: ['Triggers', 'Automations on status change or date reached.'],
  users: ['Users', 'Agent and admin directory with roles.'],
  settings: ['Settings', 'Brokerage settings, taxes, branding.'],
};

export default function StubPage() {
  const { page } = useParams();
  const [title, msg] = INFO[page] || ['Page', 'Coming soon.'];
  return (
    <div className="card stub">
      <h2>{title}</h2>
      <p>{msg}</p>
      <p className="help">This module is stubbed in Stage 1 — the Transactions module is the focus. It will be built out in later stages.</p>
    </div>
  );
}
