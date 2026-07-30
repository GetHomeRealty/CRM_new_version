import { useEffect, useState } from 'react';
import { getUsers } from '../lib/api';
import type { ManagedUser } from '../types/users';
import { useAuth } from '../context/AuthContext';
import { AREA_LABEL, AREAS, type Area } from './area';
import Icon from '../ui/Icon';

/**
 * What this brokerage is licensed for, and who has been given it.
 *
 * Module access is the AND of two facts — the company bought the module, and this person was
 * assigned it — and until now neither was visible anywhere. An administrator could assign modules
 * on the Users screen without ever being told what the subscription actually covered, which makes
 * an unassignable module look like a broken checkbox rather than a plan that does not include it.
 *
 * DELIBERATELY READ-ONLY. What a brokerage has bought is not something the brokerage edits — a
 * screen that let an administrator tick "CRM" would be a licence you grant yourself. It is shown
 * so the answer is knowable, and changed by whoever sells the plan.
 */
export default function LicencePanel() {
  const { user } = useAuth();
  const licence = user?.licence;
  const [users, setUsers] = useState<ManagedUser[] | null>(null);

  useEffect(() => { void getUsers().then(setUsers).catch(() => setUsers([])); }, []);

  if (!licence) return null;

  const licensedFor = (a: Area) => (a === 'crm' ? licence.crm : licence.desk);
  const assignedCount = (a: Area) => (users ?? []).filter((u) => (u.modules ?? []).includes(a)).length;

  const statusPill = licence.valid
    ? <span className="pill ok"><Icon name="check" size={11} /> Active</span>
    : <span className="pill bad"><Icon name="alert" size={11} /> {licence.status === 'expired' ? 'Expired' : licence.status}</span>;

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3 style={{ margin: 0 }}>Modules &amp; Licence</h3>
          <p className="help" style={{ margin: '3px 0 0' }}>
            What this brokerage is licensed for. Somebody can open a module only if it is licensed here
            <em> and</em> assigned to them on the Users screen.
          </p>
        </div>
        {statusPill}
      </div>

      <div className="licence-grid">
        {AREAS.map((a) => {
          const on = licensedFor(a);
          return (
            <div className={`licence-card ${on ? 'on' : 'off'}`} key={a}>
              <div className="licence-card-h">
                <Icon name={a === 'crm' ? 'lead' : 'briefcase'} size={16} />
                <span>{AREA_LABEL[a]}</span>
              </div>
              {on ? (
                <>
                  <span className="pill ok">Licensed</span>
                  <span className="help">
                    {users === null ? 'counting…' : `${assignedCount(a)} of ${users.length} ${users.length === 1 ? 'person has' : 'people have'} it`}
                  </span>
                </>
              ) : (
                <>
                  <span className="pill neutral">Not in this plan</span>
                  <span className="help">Nobody can open it, however it is assigned.</span>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="licence-meta">
        <span><strong>Plan</strong> {licence.plan ?? '—'}</span>
        <span><strong>Status</strong> {licence.status}</span>
        <span><strong>Renews / expires</strong> {licence.expires ?? 'no end date'}</span>
        <span className="help" style={{ marginLeft: 'auto' }}>
          Changing the plan is handled by your provider — a licence you can grant yourself is not one.
        </span>
      </div>
    </div>
  );
}
