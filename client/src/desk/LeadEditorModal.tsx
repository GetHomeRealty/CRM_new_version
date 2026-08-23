import { useEffect, useRef, useState } from 'react';
import { createLead, listLeadTags, updateLead } from '../lib/leadsApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useToast } from './toast';
import type { Lead, LeadOptions, LeadPropertyPreferences } from '../types';
import { ageFromDateOfBirth } from './age';

/** Title-case a stored vocabulary value for display ("first home buyer" → "First Home Buyer"). */
export const label = (v: string): string =>
  v.replace(/\b[a-z]/g, (c) => c.toUpperCase());

const lockNote = 'The brokerage assigned this lead to you, so its contact details, source and assignment are locked. Ask an administrator to change them.';

interface Form {
  name: string; email: string; phone: string; location: string; property: string;
  lead_status: string; lead_type: string; lead_source: string; lead_response: string;
  client_type: string; lead_conversion: string;
  gender: string; language: string; religion: string; age: string;
  date_of_birth: string; marriage_day: string; notes: string; assigned_to: string;
  tags: string;
}

/**
 * One set of property preferences. A lead may keep several — a home to live in and a property to
 * let, say — so these live in their own list rather than as fields on the lead form.
 *
 * `types` holds the standard vocabulary choices; `custom` holds anything typed in by hand. They
 * are kept apart while editing so a custom entry survives a change to the standard list, and are
 * merged into one `propertyType` array on save.
 */
export interface PrefForm {
  budget_min: string; budget_max: string;
  types: string[]; custom: string[];
  bedrooms: string; bathrooms: string; square_footage: string;
  year_built: string; lot_size: string; parking: string; features: string;
}

export const EMPTY_PREF: PrefForm = {
  budget_min: '', budget_max: '', types: [], custom: [],
  bedrooms: '', bathrooms: '', square_footage: '',
  year_built: '', lot_size: '', parking: '', features: '',
};

const EMPTY: Form = {
  name: '', email: '', phone: '', location: '', property: '',
  lead_status: '', lead_type: '', lead_source: '', lead_response: '',
  client_type: '', lead_conversion: '',
  gender: '', language: '', religion: '', age: '',
  date_of_birth: '', marriage_day: '', notes: '', assigned_to: '', tags: '',
};

const numOrNull = (v: string): number | null => {
  const n = Number(v);
  return v.trim() === '' || !Number.isFinite(n) ? null : n;
};

/** "Property Preferences", then "2nd Preference", "3rd Preference", … */
export const prefHeading = (i: number): string => {
  if (i === 0) return 'Property Preferences';
  const n = i + 1;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${suffix} Preference`;
};

function toForm(lead: Lead): Form {
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return {
    name: lead.name ?? '', email: lead.email ?? '', phone: s(lead.phone),
    location: s(lead.location), property: s(lead.property),
    lead_status: s(lead.lead_status), lead_type: s(lead.lead_type),
    lead_source: s(lead.lead_source), lead_response: s(lead.lead_response),
    client_type: s(lead.client_type), lead_conversion: s(lead.lead_conversion),
    gender: s(lead.gender), language: s(lead.language), religion: s(lead.religion),
    age: s(lead.age), date_of_birth: s(lead.date_of_birth), marriage_day: s(lead.marriage_day),
    notes: s(lead.notes), assigned_to: s(lead.assigned_to),
    tags: (lead.tags ?? []).join(', '),
  };
}

/**
 * Split a stored propertyType list back into standard and custom.
 *
 * Anything the brokerage's vocabulary does not contain is treated as custom, so a value typed in
 * last month still shows as custom today — and a value later added to the standard list quietly
 * becomes a normal checkbox instead of being stranded.
 */
function toPrefForms(lead: Lead, vocabulary: string[]): PrefForm[] {
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const known = new Set(vocabulary);
  const list = lead.property_preferences ?? [];
  if (!list.length) return [{ ...EMPTY_PREF }];
  return list.map((p) => ({
    budget_min: s(p.budget?.min), budget_max: s(p.budget?.max),
    types: (p.propertyType ?? []).filter((t) => known.has(t)),
    custom: (p.propertyType ?? []).filter((t) => !known.has(t)),
    bedrooms: s(p.bedrooms), bathrooms: s(p.bathrooms), square_footage: s(p.squareFootage),
    year_built: s(p.yearBuilt), lot_size: s(p.lotSize), parking: s(p.parking),
    features: (p.features ?? []).join(', '),
  }));
}

/** A set with nothing filled in is dropped, so an untouched form stores null rather than blanks. */
function toPreferences(f: PrefForm): LeadPropertyPreferences | null {
  const prefs: LeadPropertyPreferences = {
    budget: { min: numOrNull(f.budget_min), max: numOrNull(f.budget_max) },
    propertyType: [...f.types, ...f.custom],
    bedrooms: numOrNull(f.bedrooms),
    bathrooms: numOrNull(f.bathrooms),
    squareFootage: numOrNull(f.square_footage),
    yearBuilt: numOrNull(f.year_built),
    lotSize: f.lot_size.trim(),
    parking: numOrNull(f.parking),
    features: f.features.split(',').map((x) => x.trim()).filter(Boolean),
  };
  const filled = prefs.budget?.min != null || prefs.budget?.max != null
    || (prefs.propertyType?.length ?? 0) > 0 || prefs.bedrooms != null || prefs.bathrooms != null
    || prefs.squareFootage != null || prefs.yearBuilt != null || !!prefs.lotSize
    || prefs.parking != null || (prefs.features?.length ?? 0) > 0;
  return filled ? prefs : null;
}

/**
 * Property type: several may be chosen, and anything the standard list does not cover can be
 * typed in under **Custom**.
 *
 * Checkboxes rather than a `<select multiple>`: a multiple-select needs ctrl-click to add a
 * second value and gives no indication that it can, which is exactly the thing people miss.
 * Everything chosen is echoed back underneath as removable chips, so the selection is legible
 * without scrolling the list.
 */
function PropertyTypePicker({ vocabulary, types, custom, onChange }: {
  vocabulary: string[];
  types: string[];
  custom: string[];
  onChange: (patch: { types?: string[]; custom?: string[] }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  /*
   * Collapsed into a dropdown. The checkboxes, the custom entry and the chips are unchanged — the
   * list was simply always open, which on a form with a dozen other fields pushed everything below
   * it off the screen. Closed, the trigger says what is selected; open, it is the same picker.
   */
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  /*
   * Close on an outside click or Escape. Registered only while open, so a form with this field on
   * it carries no document listener until somebody actually opens the menu. `mousedown` rather
   * than `click`: a click that begins outside and ends inside would otherwise slip through.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setOpen(false); setAdding(false); }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setAdding(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = (t: string) =>
    onChange({ types: types.includes(t) ? types.filter((x) => x !== t) : [...types, t] });

  const addCustom = () => {
    const v = draft.trim();
    // Typing a value that is already on the standard list ticks that box instead of creating a
    // near-duplicate the reports would then have to reconcile.
    if (!v) return;
    if (vocabulary.includes(v)) {
      if (!types.includes(v)) onChange({ types: [...types, v] });
    } else if (!custom.includes(v)) {
      onChange({ custom: [...custom, v] });
    }
    setDraft('');
    setAdding(false);
  };

  const chosen = [...types, ...custom];

  return (
    <div className="field">
      <label id="prop-type-label">Property Type</label>
      <div className="type-dd" ref={boxRef}>
        <button
          type="button"
          className="type-dd-trigger"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-labelledby="prop-type-label"
          onClick={() => setOpen((v) => !v)}
        >
          <span className={chosen.length ? '' : 'muted'}>
            {chosen.length === 0
              ? 'Select property types…'
              : `${chosen.length} selected`}
          </span>
          <span aria-hidden="true">{open ? '▲' : '▼'}</span>
        </button>

        {open && (
          <div className="type-dd-menu" role="listbox" aria-multiselectable="true">
            <div className="type-picker">
              {vocabulary.map((t) => (
                <label key={t} className={`type-opt${types.includes(t) ? ' on' : ''}`}>
                  <input type="checkbox" checked={types.includes(t)} onChange={() => toggle(t)} />
                  {t}
                </label>
              ))}
              <button type="button" className={`type-opt custom${adding ? ' on' : ''}`} onClick={() => setAdding((a) => !a)}>
                + Custom
              </button>
            </div>

            {adding && (
              <div className="type-custom-row">
                <input value={draft} autoFocus placeholder="Type a property type…"
                  onChange={(e) => setDraft(e.target.value)}
                  // Enter must not submit the whole lead form while the user is mid-entry.
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
                <button className="btn primary sm" type="button" disabled={!draft.trim()} onClick={addCustom}>Add</button>
                <button className="btn ghost sm" type="button" onClick={() => { setDraft(''); setAdding(false); }}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>

      {chosen.length === 0 ? <div className="help">None selected.</div> : (
        <div className="type-chosen">
          {chosen.map((t) => (
            <span key={t} className={`pill ${custom.includes(t) ? 'warn' : 'info'}`}>
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => (
                custom.includes(t)
                  ? onChange({ custom: custom.filter((x) => x !== t) })
                  : onChange({ types: types.filter((x) => x !== t) })
              )}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  lead: Lead | null;
  options: LeadOptions | null;
  onClose: () => void;
  onSaved: (lead: Lead) => void;
  /**
   * Lock the identity fields — email, phone, lead source and assignment. Set when an agent opens
   * a lead the brokerage assigned to them: they may edit everything else, but not who the lead is
   * or whose desk it sits on. The server enforces the same rule, so this is only about not
   * offering an edit that would be rejected.
   */
  lockIdentity?: boolean;
}

export default function LeadEditorModal({ lead, options, onClose, onSaved, lockIdentity = false }: Props) {
  const toast = useToast();
  const [form, setForm] = useState<Form>(EMPTY);
  const [prefs, setPrefs] = useState<PrefForm[]>([{ ...EMPTY_PREF }]);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);

  const vocabulary = options?.property_types ?? [];

  /*
   * THE TAGS THAT ALREADY EXIST, so this field stops being a memory test.
   *
   * Tags were editable here only as free text, with no list of what the brokerage already uses.
   * That is worse than inconvenient: tags drive campaign audiences by exact name, so "VIP" typed
   * here and "vip" typed on the Tags screen are two different audiences, and a lead tagged with a
   * near-miss silently drops out of the campaign it was meant for. Every other place that edits a
   * tag — the importer, the bulk-tag dialog, the Campaigns builder — already offers the list.
   *
   * FETCHED HERE rather than passed in, because this modal opens from two screens and only one of
   * them holds the tag list; threading a prop would have meant a second fetch on the Lead detail
   * page for a value this component is perfectly able to ask for itself. A failure is ignored: not
   * knowing the existing tags makes the picker empty, and the text field still works exactly as it
   * always has.
   */
  const [knownTags, setKnownTags] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    listLeadTags().then((d) => { if (live) setKnownTags(d.tags ?? []); }).catch(() => { /* picker stays empty */ });
    return () => { live = false; };
  }, []);

  /** The tags currently typed into the field, in the order they appear. */
  const currentTags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);

  /** Append a chosen tag, matching case-insensitively so the same tag cannot be added twice. */
  const addTag = (tag: string) => {
    if (!tag || currentTags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    set('tags', [...currentTags, tag].join(', '));
  };

  useEffect(() => {
    setForm(lead ? toForm(lead) : EMPTY);
    setPrefs(lead ? toPrefForms(lead, vocabulary) : [{ ...EMPTY_PREF }]);
    setErrors({});
    // The vocabulary only decides which stored values read as custom; re-splitting on every
    // options load would discard whatever the user has typed since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead]);

  const set = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  /**
   * Picking a date of birth fills the age in.
   *
   * A DATE OF BIRTH ANSWERS THE AGE QUESTION, so leaving both fields to be typed independently
   * invites them to disagree — and the one that disagrees is always the age, because it is the one
   * that goes out of date. The server derives it too, on save and on read, so this is not the thing
   * that makes it correct; it is what makes it VISIBLE while somebody is filling the form in, rather
   * than a value that silently changes after they press Save.
   *
   * Clearing the date leaves the age alone: forgetting a birthday is not a statement that the person
   * has no age, and wiping a number somebody typed would be the more annoying behaviour.
   */
  const setDateOfBirth = (v: string) => {
    const age = ageFromDateOfBirth(v);
    setForm((f) => ({ ...f, date_of_birth: v, ...(age === null ? {} : { age: String(age) }) }));
  };
  const setPref = (i: number, patch: Partial<PrefForm>) =>
    setPrefs((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const err = (k: string) => (errors[k]?.length ? <div className="field-err">{errors[k][0]}</div> : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const body: Partial<Lead> = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        location: form.location.trim(),
        property: form.property.trim(),
        lead_status: form.lead_status,
        lead_type: form.lead_type,
        lead_source: form.lead_source,
        lead_response: form.lead_response,
        client_type: form.client_type,
        lead_conversion: form.lead_conversion,
        gender: form.gender,
        language: form.language.trim(),
        religion: form.religion.trim(),
        age: form.age.trim() === '' ? null : Number(form.age),
        date_of_birth: form.date_of_birth,
        marriage_day: form.marriage_day,
        notes: form.notes.trim(),
        assigned_to: form.assigned_to === '' ? null : Number(form.assigned_to),
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        // Empty sets are dropped, so adding a preference block and leaving it blank stores
        // nothing rather than an empty shell.
        property_preferences: prefs.map(toPreferences).filter((p): p is LeadPropertyPreferences => p !== null),
      };
      // On a locked lead the four identity fields are simply not sent, so the save is a clean
      // update of everything the agent is allowed to touch rather than a rejected request.
      if (lockIdentity) {
        delete body.email; delete body.phone; delete body.lead_source; delete body.assigned_to;
      }
      const saved = lead ? await updateLead(lead.id, body) : await createLead(body);
      toast(lead ? 'Lead updated.' : 'Lead created.', 'ok');
      onSaved(saved);
    } catch (ex) {
      const fields = apiFieldErrors(ex);
      if (fields) setErrors(fields);
      toast(apiErrorMessage(ex, 'Could not save the lead'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Options for a select, keeping whatever is already stored even when it is not on the list.
   *
   * `current` matters for the fields that used to be free text. Language and Religion were typed
   * into a datalist, so real leads carry values these lists have never contained — and a plain
   * select cannot display a value it has no option for, so it would show the placeholder and then
   * SAVE that emptiness the next time anybody touched the form. Someone editing a phone number
   * would silently erase a lead's recorded language. Carrying the stored value through as its own
   * option means the list guides new entries without rewriting old ones.
   */
  const pick = (list: string[] | undefined, placeholder: string, current?: string) => {
    const all = list ?? [];
    const kept = current && !all.some((v) => v.toLowerCase() === current.toLowerCase()) ? [current] : [];
    return (
      <>
        <option value="">{placeholder}</option>
        {[...all, ...kept].map((v) => <option key={v} value={v}>{label(v)}</option>)}
      </>
    );
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h">{lead ? `Edit Lead — ${lead.name}` : 'Add New Lead'}</div>
        {lockIdentity && (
          <div className="lead-lock-note">
            🔒 The brokerage assigned this lead to you. You can update everything except its
            contact details, source and assignment — those are locked.
          </div>
        )}

        <form onSubmit={submit}>
          <div className="modal-sub">Contact</div>
          <div className="g2">
            <div className="field">
              <label>Name *</label>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
              {err('name')}
            </div>
            <div className="field">
              <label>Email *</label>
              <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required
                disabled={lockIdentity} title={lockIdentity ? lockNote : undefined} />
              {err('email')}
            </div>
            <div className="field">
              <label>Phone</label>
              <input value={form.phone} onChange={(e) => set('phone', e.target.value)}
                disabled={lockIdentity} title={lockIdentity ? lockNote : undefined} />
              {err('phone')}
            </div>
            <div className="field">
              <label>Location</label>
              <input value={form.location} onChange={(e) => set('location', e.target.value)} />
              {err('location')}
            </div>
            <div className="field">
              <label>Property of Interest</label>
              <input value={form.property} onChange={(e) => set('property', e.target.value)} />
              {err('property')}
            </div>
            <div className="field">
              <label>Assigned To</label>
              <select value={form.assigned_to} onChange={(e) => set('assigned_to', e.target.value)}
                disabled={lockIdentity} title={lockIdentity ? lockNote : undefined}>
                <option value="">Unassigned</option>
                {(options?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              {err('assigned_to')}
            </div>
          </div>

          <div className="modal-sub">Classification</div>
          <div className="g3">
            <div className="field">
              <label>Lead Status</label>
              <select value={form.lead_status} onChange={(e) => set('lead_status', e.target.value)}>
                {pick(options?.lead_status, 'Not set')}
              </select>
              {err('lead_status')}
            </div>
            <div className="field">
              <label>Lead Type</label>
              <select value={form.lead_type} onChange={(e) => set('lead_type', e.target.value)}>
                {pick(options?.lead_type, 'Not set')}
              </select>
              {err('lead_type')}
            </div>
            <div className="field">
              <label>Lead Source</label>
              <select value={form.lead_source} onChange={(e) => set('lead_source', e.target.value)}
                disabled={lockIdentity} title={lockIdentity ? lockNote : undefined}>
                {pick(options?.lead_source, 'Not set')}
              </select>
              {err('lead_source')}
            </div>
            <div className="field">
              <label>Lead Response</label>
              <select value={form.lead_response} onChange={(e) => set('lead_response', e.target.value)}>
                {pick(options?.lead_response, 'Not set')}
              </select>
              {err('lead_response')}
            </div>
            <div className="field">
              <label>Client Type</label>
              <select value={form.client_type} onChange={(e) => set('client_type', e.target.value)}>
                {pick(options?.client_type, 'Not set')}
              </select>
              {err('client_type')}
            </div>
            <div className="field">
              <label>Conversion</label>
              <select value={form.lead_conversion} onChange={(e) => set('lead_conversion', e.target.value)}>
                {pick(options?.lead_conversion, 'Not set')}
              </select>
              {err('lead_conversion')}
            </div>
          </div>

          <div className="field">
            <label>Tags</label>
            <input value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="Comma-separated, e.g. Expo-2026, VIP" />
            {/*
              The picker ADDS to the field rather than replacing it. A lead can carry several tags,
              so the comma-separated text stays the thing being edited — this only saves people
              typing a name they have to spell exactly right. Typing a brand-new tag straight into
              the field still works and still creates it, which is how tags were made before.

              Resets to its placeholder after each pick, so the same list can be used twice.
            */}
            {knownTags.length > 0 && (
              <select value="" style={{ marginTop: 6 }}
                onChange={(e) => { addTag(e.target.value); e.currentTarget.value = ''; }}>
                <option value="">Add an existing tag…</option>
                {knownTags.map((t) => (
                  <option key={t} value={t} disabled={currentTags.some((c) => c.toLowerCase() === t.toLowerCase())}>
                    {t}
                  </option>
                ))}
              </select>
            )}
            <span className="help">
              Tags drive campaign audiences — the same names appear in the Campaigns builder. Pick an
              existing tag above so the names match exactly, or type a new one to create it.
            </span>
            {err('tags')}
          </div>

          <div className="modal-sub">Demographics</div>
          <div className="g3">
            <div className="field">
              <label>Age</label>
              {/* Editable, because plenty of leads give a rough age and no birthday. Entering a
                  date of birth below fills this in and the server keeps it in step from then on. */}
              <input type="number" min={0} max={120} value={form.age} onChange={(e) => set('age', e.target.value)} />
              {err('age')}
            </div>
            <div className="field">
              <label>Gender</label>
              <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
                {pick(options?.genders, 'Not set')}
              </select>
              {err('gender')}
            </div>
            {/*
              SELECTS, like Gender beside them. These two were `input list=` datalists: a text box
              that reveals its suggestions only once you start typing, and on several browsers gives
              no sign a list exists at all. Sat next to Gender — a real dropdown — they read as a
              different kind of control entirely, and the values they offered went unseen.

              A fixed list is also what these fields are for. They feed segmentation, so a lead typed
              as "Punjabi" and another as "punjabi" are two groups; the datalist invited exactly that.
            */}
            <div className="field">
              <label>Language</label>
              <select value={form.language} onChange={(e) => set('language', e.target.value)}>
                {pick(options?.languages, 'Not set', form.language)}
              </select>
              {err('language')}
            </div>
            <div className="field">
              <label>Religion</label>
              <select value={form.religion} onChange={(e) => set('religion', e.target.value)}>
                {pick(options?.religions, 'Not set', form.religion)}
              </select>
              {err('religion')}
            </div>
            <div className="field">
              <label>Date of Birth</label>
              <input type="date" value={form.date_of_birth} onChange={(e) => setDateOfBirth(e.target.value)} />
              {err('date_of_birth')}
            </div>
            <div className="field">
              <label>Marriage Day</label>
              <input type="date" value={form.marriage_day} onChange={(e) => set('marriage_day', e.target.value)} />
              {err('marriage_day')}
            </div>
          </div>

          {prefs.map((p, i) => (
            <div key={i} className="pref-block">
              <div className="pref-head">
                <div className="modal-sub" style={{ margin: 0 }}>{prefHeading(i)}</div>
                {prefs.length > 1 && (
                  <button className="btn ghost sm" type="button"
                    onClick={() => setPrefs((list) => list.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </div>
              <div className="g3">
                <div className="field">
                  <label>Budget Min</label>
                  <input type="number" value={p.budget_min} onChange={(e) => setPref(i, { budget_min: e.target.value })} />
                </div>
                <div className="field">
                  <label>Budget Max</label>
                  <input type="number" value={p.budget_max} onChange={(e) => setPref(i, { budget_max: e.target.value })} />
                </div>
                <div className="field">
                  <label>Bedrooms</label>
                  <input type="number" value={p.bedrooms} onChange={(e) => setPref(i, { bedrooms: e.target.value })} />
                </div>
                <div className="field">
                  <label>Bathrooms</label>
                  <input type="number" value={p.bathrooms} onChange={(e) => setPref(i, { bathrooms: e.target.value })} />
                </div>
                <div className="field">
                  <label>Square Footage</label>
                  <input type="number" value={p.square_footage} onChange={(e) => setPref(i, { square_footage: e.target.value })} />
                </div>
                <div className="field">
                  <label>Year Built</label>
                  <input type="number" value={p.year_built} onChange={(e) => setPref(i, { year_built: e.target.value })} />
                </div>
                <div className="field">
                  <label>Lot Size</label>
                  <input value={p.lot_size} onChange={(e) => setPref(i, { lot_size: e.target.value })} />
                </div>
                <div className="field">
                  <label>Parking</label>
                  <input type="number" value={p.parking} onChange={(e) => setPref(i, { parking: e.target.value })} />
                </div>
              </div>

              <PropertyTypePicker
                vocabulary={vocabulary}
                types={p.types}
                custom={p.custom}
                onChange={(patch) => setPref(i, patch)}
              />

              <div className="field">
                <label>Must-have Features</label>
                <input value={p.features} onChange={(e) => setPref(i, { features: e.target.value })}
                  placeholder="Comma-separated, e.g. Finished basement, South-facing yard" />
              </div>
            </div>
          ))}

          <div className="field">
            <button className="btn ghost sm" type="button"
              onClick={() => setPrefs((list) => [...list, { ...EMPTY_PREF }])}>
              + Add Preference
            </button>
          </div>

          <div className="field">
            <label>Notes</label>
            <textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            <span className="help">A running summary. Dated entries live in the lead's Notes history.</span>
            {err('notes')}
          </div>

          <div className="actions">
            <button className="btn ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : lead ? 'Update Lead' : 'Create Lead'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
