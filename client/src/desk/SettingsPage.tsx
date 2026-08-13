import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import { useArea } from './AreaContext';
import { areaPath, type Area } from './area';
import IntegrationsPanel from './IntegrationsPanel';
import { TemplatesTab } from './EmailSettingsPanels';
import CrmSettingsPanel from './CrmSettingsPanel';
import CrmCommunicationsPanel from './CrmCommunicationsPanel';
import TwoFactorCard from './TwoFactorCard';
import CompanySettingsPage from './CompanySettingsPage';
import RolesPanel from './RolesPanel';
import LicencePanel from './LicencePanel';
import LeadBooksPanel from './LeadBooksPanel';
import Icon from '../ui/Icon';

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
  { key: 'desk', label: 'Transaction Desk Settings', ico: 'briefcase', superAdmin: true, area: 'desk' },
  /*
   * `screen: 'settings'`, NOT `superAdmin`. The API behind this tab is gated on
   * `@Screen('settings', 'edit')`, and gating the tab on the role instead produced the inverse of
   * the bug that gating change was made to fix: measured on 2026-08-04, granting the Admin role
   * `settings: edit` through Roles & Permissions was honoured by every endpoint — `PUT
   * /api/crm-settings` 200, `PUT /api/crm-settings/email-settings` 200, `POST
   * /api/crm-settings/broadcasts` 201, which emails every member of staff — while no screen
   * anywhere in the product showed them a single one of those controls. A grant the API obeys and
   * the interface never mentions is worse than one that visibly fails, because nobody finds out
   * what they handed over.
   *
   * `view` opens the tab, `edit` makes it writable — CrmSettingsPanel renders read-only without it,
   * exactly as CompanySettingsPage already does. That is why widening this is safe: `view` reveals
   * nothing new, because every read endpoint behind this tab is already `@Screen('settings',
   * 'view')` and already answered 200 to an Admin who could not see the screen. Nothing here stores
   * a password — `crm_email_settings` has no such column.
   */
  { key: 'crm', label: 'CRM Settings', ico: 'settings', screen: 'settings', area: 'crm' },
  { key: 'company', label: 'Company Settings', ico: 'building', screen: 'settings' },
  // Behind the Users screen rather than a Super Admin flag: changing what a role grants is the
  // same authority as changing who holds it, and the endpoint enforces exactly that.
  { key: 'roles', label: 'Roles & Permissions', ico: 'lock', screen: 'users' },
];

/** The two sections inside Transaction Desk Settings. */
const DESK_SECTIONS = [
  { key: 'integrations', label: 'Integrations', ico: 'external' },
  { key: 'templates', label: 'Templates', ico: 'file' },
] as const;

/**
 * The two sections inside CRM Settings.
 *
 * Templates moved here from Transaction Desk. They are the CRM's own automated emails — new lead,
 * lead assigned, follow-up due, Meta lead, campaign finished, and the greetings that go to a lead
 * directly — so they belong beside the rest of the CRM's configuration rather than behind a tab
 * about deals. The rows, the endpoints and the editor are unchanged; only where they are listed
 * moved. Transaction Desk keeps every other module group.
 */
const CRM_SECTIONS = [
  { key: 'settings', label: 'CRM Settings', ico: 'settings' },
  /*
   * Communications is where CRM email preferences and template management are heading: one screen
   * instead of Templates, Notification Preferences and Triggers. It is added ALONGSIDE Templates
   * rather than replacing it while the preference migration is still outstanding — the old routes
   * keep working, and nothing is removed until the cutover is approved.
   */
  { key: 'communications', label: 'Communications', ico: 'mail' },
  { key: 'templates', label: 'Templates', ico: 'file' },
  /*
   * Two-step verification, moved here from the personal Settings page beside Email Accounts.
   *
   * It is listed here as asked, but it is NOT an administrator's setting and is not gated like one:
   * the card only ever reads and writes the signed-in person's own factors, and the policy can make
   * enrolment REQUIRED for a role. Reachable only through this tab, every agent — who holds no
   * `settings` permission — would have been told to set up a factor with no screen on which to do
   * it. So it also answers at its own open route, and that is the door agents use. See the entry in
   * App.tsx and the sidebar entry in DeskLayout.tsx.
   */
  { key: 'two-step', label: 'Two-Step Verification', ico: 'lock' },
] as const;

/** The sections a given top-level tab owns. Tabs without sub-navigation have none. */
const sectionsFor = (tabKey: string): readonly { key: string; label: string; ico: string }[] =>
  (tabKey === 'desk' ? DESK_SECTIONS : tabKey === 'crm' ? CRM_SECTIONS : []);

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
  /*
   * `'company'` as the last resort is unreachable in practice and deliberately kept simple.
   *
   * L7 recorded that a role without `settings` reaching this screen got an empty tab bar and no
   * explanation. It does not: `RequireScreen` in `desk/guards.tsx` renders "🔒 No access — ask an
   * administrator to grant you access under Users" before this component ever mounts, and the one
   * account that gets past it via `orSuperAdmin` is a Super Admin, who `PermissionService.effectiveFor`
   * gives every screen at `edit` regardless of what the role map says. So `visible` is never empty
   * here. Verified in the browser on 2026-08-05, including by revoking `settings` from the admin
   * role and confirming the Super Admin still sees all three tabs.
   */
  const fallback = visible[0]?.key ?? 'company';
  // A tab that belongs to the other area is not silently swapped for this area's first tab —
  // that would answer a request for CRM Settings with the Transaction Desk's. It is sent to the
  // same tab in the area that owns it, so the sidebar and the URL agree on where you ended up.
  const foreign = TABS.find((t) => t.key === aliasTab && t.area && t.area !== area);
  const active = visible.some((t) => t.key === aliasTab) ? aliasTab : fallback;
  const requestedSub = aliasSub ?? params.get('section') ?? '';
  /*
   * Resolved against the sections the ACTIVE tab owns, not against the Desk's alone. Both tabs
   * happen to have a section called `templates`; scoping the lookup this way is what keeps
   * `?tab=crm&section=templates` on the CRM's list rather than silently falling back.
   */
  const tabSections = sectionsFor(active);
  const activeSub = tabSections.some((s) => s.key === requestedSub)
    ? requestedSub
    : (tabSections[0]?.key ?? '');

  const [tab, setTab] = useState(active);
  const [sub, setSub] = useState<string>(activeSub);

  // Keep both levels in step with the URL, so a deep link (or the OAuth return) opens the
  // right section and the browser's Back button behaves.
  useEffect(() => { setTab(active); }, [active]);
  useEffect(() => { setSub(activeSub); }, [activeSub]);

  /*
   * A tab that does not exist is corrected in the URL, not just on screen.
   *
   * `?tab=doesnotexist` fell back to the first visible tab and left the address bar saying
   * `doesnotexist` — so the page showed CRM Settings while the URL claimed something else, and
   * bookmarking or sharing it carried the lie forward. Replaced rather than pushed, so it does not
   * add a history entry the Back button has to walk through.
   *
   * ONLY a value that resolves to nothing is corrected. An ALIAS resolves to a real tab and is left
   * exactly as it is: `?tab=templates` is a live bookmark and the OAuth return path, and rewriting
   * it to `?tab=desk` would drop the sub-section it carries and land people on Integrations instead
   * of Templates. A tab belonging to the other area is left alone too — that is a redirect to the
   * area that owns it, further down, and answering it here would re-create the bug that redirect
   * exists to fix.
   */
  const unknownTab = !!requested && !foreign && !visible.some((t) => t.key === aliasTab);
  useEffect(() => {
    if (!unknownTab) return;
    const next = new URLSearchParams(params);
    next.set('tab', active);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unknownTab, active]);

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
    // Both tabs that own sections keep theirs in the URL, so a CRM Templates link is shareable
    // and the Back button steps through sections the same way on either side.
    if (sectionsFor(key).length) next.set('section', section ?? sectionsFor(key)[0].key);
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
            <Icon name={t.ico} size={14} /> {t.label}
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
                <Icon name={s.ico} size={14} /> {s.label}
              </button>
            ))}
          </div></div>

          {sub === 'integrations' && <IntegrationsPanel />}
          {/* `desk` scope = every module EXCEPT CRM. The CRM group now lives under CRM Settings. */}
          {sub === 'templates' && <TemplatesTab toast={toast} scope="desk" />}
        </>
      )}

      {tab === 'crm' && (
        <>
          {/*
            Sub-navigation, and Templates only for a Super Admin.
            `/api/email-templates` is behind `AdminGuard`, which is the top tier — so offering the
            section to the Admin/manager role that `settings: view` also admits here would show
            them a tab that 403s the moment it loads. The gate matches the endpoint exactly;
            widening who may edit templates is an API decision, not a navigation one.
          */}
          <div className="toolbar"><div className="toolbar-row">
            <strong style={{ marginRight: 6 }}>CRM Settings</strong>
            {CRM_SECTIONS.filter((s) => s.key !== 'templates' || isSuperAdmin).map((s) => (
              <button key={s.key} className={`btn sm ${sub === s.key ? 'primary' : 'ghost'}`}
                onClick={() => go('crm', s.key)}>
                <Icon name={s.ico} size={14} /> {s.label}
              </button>
            ))}
          </div></div>

          {/* Communications is open to everybody: an agent controls their own preferences there,
              and the write endpoints refuse anything beyond that on the server. */}
          {sub === 'communications' ? <CrmCommunicationsPanel />
            : sub === 'two-step' ? <TwoFactorCard />
              : sub === 'templates' && isSuperAdmin ? <TemplatesTab toast={toast} scope="crm" />
                : <CrmSettingsPanel />}
        </>
      )}
      {tab === 'company' && <CompanySettingsPage />}
      {tab === 'roles' && <><LicencePanel /><RolesPanel /><LeadBooksPanel /></>}
    </>
  );
}
