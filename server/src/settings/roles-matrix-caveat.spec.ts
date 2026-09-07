import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BANKING_FIELDS, OPERATIONS_FIELDS } from './company-settings.controller';
import { CompanySettingsService } from './company-settings.service';
import { can } from '../core/authz';

/**
 * TD-119 — the Roles & Permissions matrix describes the system that exists.
 *
 * The entry is a disagreement between what the matrix says and what an agent's session receives:
 * the Agent row reads `settings: 'none'` and `GET /api/company-settings` answered that same agent
 * 200. Both were deliberate and they described different systems.
 *
 * THE FIRST FIX MADE IT WORSE IN AN INSTRUCTIVE WAY. It corrected the MATRIX, adding a caveat that
 * named six letterhead fields as what a role at 'none' still receives. The endpoint was returning
 * eighteen keys, eight of which are not letterhead — `invoice_prefix` and `next_invoice_no` among
 * them. So the caveat was itself a description of a system that did not exist, which is the entry's
 * own complaint, and it was written by reading the new wording rather than by measuring the
 * response. QA reopened the entry on precisely that, and were right to.
 *
 * WHAT THIS SPEC IS FOR. Not to check that a sentence exists — the last attempt would have passed
 * such a check. It holds the SENTENCE against the SERVER'S OWN WITHHELD LISTS, so a field that
 * starts or stops being returned fails here until somebody updates the words a brokerage reads to
 * decide what its agents can see. That is the only check that would have caught the first mistake.
 */

const ROLES_PANEL = readFileSync(
  join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'RolesPanel.tsx'),
  'utf8',
);

/** The caveat as it RENDERS — the surrounding comment block explains the fault and is not it. */
const caveat = ((): string => {
  const code = ROLES_PANEL.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = code.match(/settings:\s*'((?:[^'\\]|\\.)*)'/);
  expect(m).not.toBeNull();
  return m![1];
})();

/** Every key the serializer emits, from the shape the service actually builds. */
const allFields = (): string[] => {
  const svc = new CompanySettingsService(
    ...([{}, {}, {}] as unknown as ConstructorParameters<typeof CompanySettingsService>),
  );
  const row = {
    id: 1, feature_flags: null, name: 'X', address: 'A', phone: 'P', email: 'E', logo_path: null,
    hst_number: null, bank_beneficiary: null, bank_name: null, transit_no: null, account_no: null,
    institution_no: null, currency: 'CAD', default_tax_rate: 13, invoice_prefix: 'GHR-',
    next_invoice_no: 1, default_terms: null, thank_you_note: null, deposit_heading: null,
    deposit_signatory: null, created_at: null, updated_at: null,
  };
  return Object.keys(svc.serialize(row as never));
};

describe('what an agent actually receives from company settings (TD-119)', () => {
  it('withholds the operational block from a role the matrix says has no Settings access', () => {
    for (const cap of ['company.read-banking', 'company.read-operations'] as const) {
      expect([cap, can({ role: 'agent' }, cap)]).toEqual([cap, false]);
      expect([cap, can({ role: 'crm' }, cap)]).toEqual([cap, false]);
      // The two roles that produce the documents these fields print on keep them.
      expect([cap, can({ role: 'accounting' }, cap)]).toEqual([cap, true]);
      expect([cap, can({ role: 'documentation' }, cap)]).toEqual([cap, true]);
    }
  });

  it('names invoice numbering among the withheld fields — the ones QA measured', () => {
    // `next_invoice_no` is the one the entry singles out: operational rather than decorative, it
    // tells the reader what the brokerage's next invoice number will be.
    for (const f of ['invoice_prefix', 'next_invoice_no', 'feature_flags']) {
      expect([f, (OPERATIONS_FIELDS as readonly string[]).includes(f)]).toEqual([f, true]);
    }
  });

  it('keeps the lawyer-reminder cadence, which an agent’s own Triggers screen reads', () => {
    // QA's list of eight uncovered fields includes this one. It is deliberately NOT withheld: an
    // agent holds `triggers: 'view'` and DeskTriggersPanel renders the cadence from it.
    expect((OPERATIONS_FIELDS as readonly string[])).not.toContain('lawyer_reminder_days');
  });

  it('leaves exactly the fields the caveat describes, and no others', () => {
    /*
     * THE ASSERTION THIS ENTRY EXISTS FOR. Everything the serializer emits, minus what the two
     * capabilities withhold, is what a role at `settings: 'none'` receives — and every one of those
     * has to be accounted for in the sentence a brokerage reads.
     */
    const withheld = new Set<string>([...BANKING_FIELDS, ...OPERATIONS_FIELDS]);
    const visible = allFields().filter((f) => !withheld.has(f));

    // `id`, `created_at` and `updated_at` are record plumbing rather than brokerage information;
    // they are not what the matrix is about and the caveat does not claim to cover them.
    const described = visible.filter((f) => !['id', 'created_at', 'updated_at'].includes(f));

    const WORDS: Record<string, string> = {
      name: 'name', address: 'address', phone: 'phone', email: 'email', logo_path: 'logo',
      currency: 'currency', default_tax_rate: 'tax rate', lawyer_reminder_days: 'lawyer-reminder cadence',
    };
    // Every visible field has a word in the caveat…
    expect(Object.keys(WORDS).sort()).toEqual([...described].sort());
    // …and the caveat actually says each of them.
    for (const f of described) {
      expect([f, caveat.includes(WORDS[f])]).toEqual([f, true]);
    }
  });

  it('tells the reader what is withheld, not only what is kept', () => {
    // The complaint was a matrix that says 'none' and a payload that says otherwise. Naming the
    // withheld side is what makes the row readable as a permission rather than as a list.
    for (const phrase of ['bank account', 'HST number', 'invoice prefix', 'Accounting and above']) {
      expect([phrase, caveat.includes(phrase)]).toEqual([phrase, true]);
    }
  });
});
