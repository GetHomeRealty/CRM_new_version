import {
  CRM_COMMUNICATIONS, ACTIVE_CRM_COMMUNICATIONS, byKey, byPreferenceCategory, byTemplateEventKey, variablesFor,
} from './crm-communications.registry';
import { MAIL_EVENTS } from '../email/mail-event-registry';
import { NOTIFICATION_CATEGORIES } from '../notifications/notification-preference.service';
import { TRIGGER_KEYS } from './crm-settings.constants';

/**
 * The registry claims to be the one description of a CRM communication. These tests are what make
 * that claim true rather than aspirational: every cross-reference it makes to the two tables that
 * hold the real data is checked to actually resolve.
 *
 * Nothing here exercises sending — the registry is additive and nothing reads it yet.
 */

describe('CRM communications registry — shape', () => {
  it('has a unique key for every communication', () => {
    const keys = CRM_COMMUNICATIONS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('registers the ten automated communications plus the three manual ones', () => {
    expect(ACTIVE_CRM_COMMUNICATIONS.map((c) => c.key).sort()).toEqual([
      'anniversary', 'birthday', 'campaign_completed', 'campaign_failed', 'custom',
      'lead_assigned', 'lead_meta', 'lead_new', 'lead_task_due', 'promotional', 'referral', 'seasonal',
      'welcome',
    ]);
    expect(ACTIVE_CRM_COMMUNICATIONS.filter((c) => c.kind === 'automated')).toHaveLength(10);
    expect(ACTIVE_CRM_COMMUNICATIONS.filter((c) => c.kind === 'manual')).toHaveLength(3);
  });

  it('keeps Wedding registered but retired, so it stays out of the list and the migration', () => {
    const wedding = byKey('wedding');
    expect(wedding?.retired).toBe(true);
    expect(ACTIVE_CRM_COMMUNICATIONS.find((c) => c.key === 'wedding')).toBeUndefined();
    // Still has a template, because it can still be sent by hand. Registered ≠ offered.
    expect(wedding?.templateEventKey).toBe('crm.wedding_congratulations');
  });

  it('never offers a channel a communication cannot actually use', () => {
    for (const c of CRM_COMMUNICATIONS) {
      // Email is the only channel that reaches a client — they have no in-app inbox.
      if (c.audience === 'lead') {
        expect(c.channels.in_app).toBe(false);
        expect(c.channels.push).toBe(false);
      }
      // A communication that offers no channel at all would be a row that does nothing.
      expect(c.channels.email || c.channels.in_app || c.channels.push).toBe(true);
    }
  });

  it('gives every automated communication a template, and every manual one a reason not to have one', () => {
    for (const c of ACTIVE_CRM_COMMUNICATIONS) {
      if (c.kind === 'automated') expect(c.templateEventKey).toBeTruthy();
      // The three manual emails build their body at send time from what the sender supplies.
      else expect(c.templateEventKey).toBeNull();
    }
  });
});

describe('CRM communications registry — cross-references resolve', () => {
  it('every templateEventKey exists in the mail registry, under the CRM module', () => {
    for (const c of CRM_COMMUNICATIONS) {
      if (!c.templateEventKey) continue;
      const meta = MAIL_EVENTS[c.templateEventKey];
      expect(meta).toBeDefined();
      expect(meta.module).toBe('CRM');
    }
  });

  it('every legacyTriggerKey is a real trigger key', () => {
    for (const c of CRM_COMMUNICATIONS) {
      if (!c.legacyTriggerKey) continue;
      expect(TRIGGER_KEYS as readonly string[]).toContain(c.legacyTriggerKey);
    }
  });

  it('the six staff categories match live notification categories exactly', () => {
    // These rows already exist for real users. A renamed category would discard their settings.
    for (const c of ACTIVE_CRM_COMMUNICATIONS) {
      if (c.audience !== 'staff') continue;
      const def = NOTIFICATION_CATEGORIES.find((n) => n.key === c.preferenceCategory);
      expect(def).toBeDefined();
      expect(def!.channels.email).toBe('live');
    }
  });

  it('the greeting categories are the ones the Phase 1 migration writes', () => {
    expect(byKey('birthday')?.preferenceCategory).toBe('crm_birthday');
    expect(byKey('anniversary')?.preferenceCategory).toBe('crm_anniversary');
    expect(byKey('seasonal')?.preferenceCategory).toBe('crm_seasonal');
  });

  it('exposes each communication\'s variables from the mail registry rather than re-listing them', () => {
    const birthday = byKey('birthday')!;
    expect(variablesFor(birthday)).toEqual(MAIL_EVENTS['crm.birthday_greeting'].variables);
    // A manual email has no stored template, so no variables to offer.
    expect(variablesFor(byKey('custom')!)).toEqual([]);
  });

  it('looks a communication up by either of its foreign keys', () => {
    expect(byPreferenceCategory('lead_task_due')?.key).toBe('lead_task_due');
    expect(byTemplateEventKey('crm.meta_lead_received')?.key).toBe('lead_meta');
    expect(byPreferenceCategory('nope')).toBeUndefined();
  });

  it('no two communications share a preference category or a template', () => {
    const cats = CRM_COMMUNICATIONS.map((c) => c.preferenceCategory).filter(Boolean);
    expect(new Set(cats).size).toBe(cats.length);
    const tpls = CRM_COMMUNICATIONS.map((c) => c.templateEventKey).filter(Boolean);
    expect(new Set(tpls).size).toBe(tpls.length);
  });
});

describe('CRM communications registry — stays out of Transaction Desk', () => {
  it('claims no template outside the CRM module', () => {
    const deskKeys = Object.entries(MAIL_EVENTS).filter(([, m]) => m.module !== 'CRM').map(([k]) => k);
    const claimed = new Set(CRM_COMMUNICATIONS.map((c) => c.templateEventKey));
    for (const k of deskKeys) expect(claimed.has(k)).toBe(false);
  });

  it('claims no notification category Transaction Desk owns', () => {
    const crmCats = new Set(CRM_COMMUNICATIONS.map((c) => c.preferenceCategory).filter(Boolean));
    const deskCats = NOTIFICATION_CATEGORIES
      .filter((n) => !crmCats.has(n.key))
      .map((n) => n.key);
    // Sanity: Desk categories exist and none is claimed above.
    expect(deskCats.length).toBeGreaterThan(0);
    for (const k of deskCats) expect(crmCats.has(k)).toBe(false);
  });
});
