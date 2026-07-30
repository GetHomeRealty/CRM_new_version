import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import { useArea } from './AreaContext';
import { areaPath, type Area } from './area';
import IntegrationsPanel from './IntegrationsPanel';
import { TemplatesTab } from './EmailSettingsPanels';
import CrmSettingsPanel from './CrmSettingsPanel';
import CompanySettingsPage from './CompanySettingsPage';

/**
 * Settings — the single home for every configuration screen.
 *
 * The standalone "Email Settings" screen is gone; everything it held (SMTP accounts,
 * templates, CRM Settings) is reached from here instead. Nothing about those screens
 * changed apart from where they are mounted.
 *
 * PERMISSIONS ARE PRESERVED EXACTLY. The old Email Settings route was Super Admin only, so
 * the three tabs that came from it stay Super Admin only; Company Settings keeps its own
 * `settings` screen permission. Merging them under one route without this gate would have
 * quietly exposed SMTP credentials and templates to every role with Settings access.
 */

interface TabDef {
  key: string;
  label: string;
  ico: string;
  /** Only Super Admins see this tab — it came from the Super-Admin-only Email Settings screen. */
  superAdmin?: boolean;
  /** Needs this screen permission — what gated the tab before it moved here. */
  screen?: string;
  /**
   * The area this tab belongs to. Shown only from inside that area.
   *
   * The two integration sets are deliberately separate — an email account added under CRM must
   * not appear in the Transaction Desk — and offering both tabs from either side is what made
   * that easy to get wrong. Company Settings has no area and appears in both.
   */
  area?: Area;
}

/**
 * Declaration order is display order. Integrations and Templates are no longer top-level:
 * they are the two halves of Transaction Desk Settings, which keeps their original leading
 * position.
 */
const TABS: TabDef[] = [
  { key: 'desk', label: 'Transaction Desk Settings', ico: '\u{1F4DA}', superAdmin: true, area: 'desk' },
  { key: 'crm', label: 'CRM Settings', ico: '\u{2699}', superAdmin: true, area: 'crm' },
  { key: 'company', label: 'Company Settings', ico: '\u{1F3E2}', screen: 'settings' },
];

/** The two sections inside Transaction Desk Settings. */
const DESK_SECTIONS = [
  { key: 'integrations', label: 'Integrations', ico: '\u{1F517}' },
  { key: 'templates', label: 'Templates', ico: '\u{1F4DD}' },
] as const;

/**
 * Old deep links, bookmarks and the Google/Gmail OAuth return path (`?tab=integrations`)
 * still point at the previous top-level names. Map each onto its new home so none of them
 * break — the second element is the Transaction Desk sub-section to open.
 */
const ALIASES: Record<string, [string, string?]> = {
  integrations: ['desk', 'integrations'],
  templates: ['desk', 'templates'],
  accounts: ['desk', 'integrations'],   // the old "SMTP Accounts" tab
  smtp: ['desk', 'integrations'],
  email: ['desk', 'integrations'],
};

export default function SettingsPage() {
  const { isSuperAdmin, can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { area } = useArea();

  // Each tab keeps exactly the permission it had before the move: the three that came from
  // Email Settings stay Super Admin only, Company Settings keeps its `settings` screen check.
  const visible = TABS
    .filter((t) => !t.area || t.area === area)
    .filter((t) => (!t.superAdmin || isSuperAdmin) && (!t.screen || can(t.screen, 'view')));
  const requested = params.get('tab') ?? '';
  const [aliasTab, aliasSub] = ALIASES[requested] ?? [requested, undefined];
  const fallback = visible[0]?.key ?? 'company';
  // A tab that belongs to the other area is not silently swapped for this area's first tab —
  // that would answer a request for CRM Settings with the Transaction Desk's. It is sent to the
  // same tab in the area that owns it, so the sidebar and the URL agree on where you ended up.
  const foreign = TABS.find((t) => t.key === aliasTab && t.area && t.area !== area);
  const active = visible.some((t) => t.key === aliasTab) ? aliasTab : fallback;
  const requestedSub = aliasSub ?? params.get('section') ?? '';
  const activeSub = DESK_SECTIONS.some((s) => s.key === requestedSub) ? requestedSub : DESK_SECTIONS[0].key;

  const [tab, setTab] = useState(active);
  const [sub, setSub] = useState<string>(activeSub);

  // Keep both levels in step with the URL, so a deep link (or the OAuth return) opens the
  // right section and the browser's Back button behaves.
  useEffect(() => { setTab(active); }, [active]);
  useEffect(() => { setSub(activeSub); }, [activeSub]);

  // ?tab=crm reached from the Transaction Desk (an old bookmark, or the OAuth return for a CRM
  // calendar) belongs in the CRM's Settings. Sent there rather than quietly showing a different
  // tab — landing on the Desk's integrations after asking for the CRM's was the original bug.
  if (foreign) {
    const q = new URLSearchParams(params);
    return <Navigate to={`${areaPath(foreign.area!, 'settings')}?${q.toString()}`} replace />;
  }

  const go = (key: string, section?: string) => {
    setTab(key);
    if (section) setSub(section);
    const next = new URLSearchParams(params);
    next.set('tab', key);
    if (key === 'desk') next.set('section', section ?? sub);
    else next.delete('section');
    setParams(next, { replace: true });
  };

  return (
    <>
      {/* `settings-tabs` pins this bar below the topbar so the section switcher never
          scrolls out of reach on a long panel (CRM Settings and Templates are both tall). */}
      <div className="toolbar settings-tabs"><div className="toolbar-row" style={{ flexWrap: 'wrap' }}>
        {visible.map((t) => (
          <button key={t.key} className={`btn sm ${tab === t.key ? 'primary' : 'ghost'}`} onClick={() => go(t.key)}>
            {t.ico} {t.label}
          </button>
        ))}
      </div></div>

      {tab === 'desk' && (
        <>
          {/* Sub-navigation for the two Transaction Desk sections. */}
          <div className="toolbar"><div className="toolbar-row">
            <strong style={{ marginRight: 6 }}>Transaction Desk Settings</strong>
            {DESK_SECTIONS.map((s) => (
              <button key={s.key} className={`btn sm ${sub === s.key ? 'primary' : 'ghost'}`}
                onClick={() => go('desk', s.key)}>
                {s.ico} {s.label}
              </button>
            ))}
          </div></div>

          {sub === 'integrations' && <IntegrationsPanel />}
          {sub === 'templates' && <TemplatesTab toast={toast} />}
        </>
      )}
      {tab === 'crm' && <CrmSettingsPanel />}
      {tab === 'company' && <CompanySettingsPage />}
    </>
  );
}
