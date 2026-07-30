import CrmTriggersPanel from './CrmTriggersPanel';
import DeskTriggersPanel from './DeskTriggersPanel';
import { useArea } from './AreaContext';
import { AREA_LABEL } from './area';

/**
 * Triggers — automations that fire on their own.
 *
 * Two independent modules, not one screen with two sections. The CRM's triggers are reachable only
 * from the CRM and the Transaction Desk's only from the Desk, which is what section 13 asks for: a
 * screen listing both invites configuring one from the other, and that is how a CRM automation ends
 * up acting on a transaction.
 *
 * The "CRM Triggers" section button is gone with the split — there is one module per area now, so it
 * was a switcher with a single option. So is the "Other automations" note that said transaction
 * triggers were not built: the ones that do exist are now shown, and what is genuinely missing is
 * stated inside the Desk panel where someone looking for it will be.
 */
export default function TriggersPage() {
  const { area } = useArea();

  return (
    <>
      <div className="toolbar"><div className="toolbar-row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{'⚡'} {AREA_LABEL[area]} Triggers</span>
        <span className="muted" style={{ fontSize: 12 }}>
          {area === 'crm'
            ? 'Automatic emails sent on lead activity. The Transaction Desk keeps its own triggers.'
            : 'Automations that run on transaction activity. The CRM keeps its own triggers.'}
        </span>
      </div></div>

      {area === 'crm' ? <CrmTriggersPanel /> : <DeskTriggersPanel />}
    </>
  );
}
