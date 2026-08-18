import DeskTriggersPanel from './DeskTriggersPanel';
import { AREA_LABEL } from './area';

/**
 * Triggers — the Transaction Desk's automations, the ones that fire on their own.
 *
 * THIS SCREEN USED TO SERVE BOTH AREAS. It branched on the active area: the Desk got the panel
 * below, and the CRM got a list of switches deciding which CRM emails an agent could send by hand.
 * The comment here argued for two independent modules rather than one screen listing both, and that
 * reasoning still holds — it is simply that there is only one module left to serve.
 *
 * WHERE THE CRM HALF WENT. All of it, to CRM → Communications: an agent's own switches, the
 * brokerage-wide master switch, and the brokerage defaults those switches inherit. Nothing was
 * dropped in the move and nothing was duplicated — Communications writes the same
 * `crm_trigger_settings` and `crm_email_settings` rows the Triggers screen wrote, through the same
 * services. `area.ts` now maps `triggers` to the Desk alone, so `/crm/triggers` redirects to
 * `/desk/triggers` and no CRM sidebar offers it.
 *
 * The Desk's triggers are unchanged: same panel, same endpoints, same permission.
 */
export default function TriggersPage() {
  return (
    <>
      <div className="toolbar"><div className="toolbar-row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{'⚡'} {AREA_LABEL.desk} Triggers</span>
        <span className="muted" style={{ fontSize: 12 }}>
          Automations that run on transaction activity. CRM emails are managed under CRM →
          Communications.
        </span>
      </div></div>

      <DeskTriggersPanel />
    </>
  );
}
