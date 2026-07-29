import { useState } from 'react';
import CrmTriggersPanel from './CrmTriggersPanel';

/**
 * Triggers — automations that fire on their own.
 *
 * The sidebar has always carried this entry, but it fell through to the "planned module"
 * placeholder because nothing was mounted at /app/triggers. The CRM's automatic emails were the
 * one set of triggers that did exist, buried at the bottom of CRM Settings; they now live here,
 * behind the CRM Triggers button, which is where someone looking for an automation would go.
 *
 * Kept as a section list rather than a single panel so the automations that follow — the
 * transaction-status and deadline triggers this screen was always meant to hold — have an
 * obvious place to be added.
 */

type Section = 'crm' | null;

export default function TriggersPage() {
  const [open, setOpen] = useState<Section>('crm');

  return (
    <>
      <div className="toolbar"><div className="toolbar-row">
        <button className={`btn sm ${open === 'crm' ? 'primary' : 'ghost'}`} onClick={() => setOpen('crm')}>
          ⚡ CRM Triggers
        </button>
      </div></div>

      {open === 'crm' && <CrmTriggersPanel />}

      <div className="card">
        <div className="modal-h">Other automations</div>
        <p className="help">
          Transaction and deadline triggers are not built yet. The recurring lawyer-detail
          reminder and the document-review nudges run on their own schedule today and are
          configured in Company Settings.
        </p>
      </div>
    </>
  );
}
