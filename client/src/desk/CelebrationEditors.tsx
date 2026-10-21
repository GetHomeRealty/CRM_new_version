import { useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '../lib/apiError';
import { aiDraftGreeting, searchCelebrationLeads, starterMessage, templateFlyer, updateFlyerAlt, uploadFlyer } from '../lib/celebrationsApi';
import { useToast } from './toast';
import type { AiGreetingDraft, CelebrationOptions, Flyer, PickableLead, RecipientSpec } from '../types/celebration';

/** Shared pieces of the Celebrations wizard and the annual automation editor. */

export const DATE_OCCASIONS = ['birthday', 'anniversary'];

export function allTimeZones(fallback: string): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return list.length ? list : [fallback];
  } catch {
    return [fallback];
  }
}

export const STATUS_PILL: Record<string, string> = {
  completed: 'ok', partial: 'warn', failed: 'bad', sending: 'warn', scheduled: 'info', cancelled: '', draft: '',
  sent: 'ok', diverted: 'info', skipped: '', pending: '',
};

// ----------------------------------------------------------------------------------- message

export interface MessageValue { subject: string; preview_text: string; message: string; ai_assisted: boolean }

/**
 * Subject, inbox preview text and message, with merge fields, a suggested (non-AI) starting point
 * and the AI writer. Generating never saves or sends — the result lands in these fields to edit.
 */
export function MessageFields({ value, onChange, options, occasion, occasionLabel, branding, onFlyerText }: {
  value: MessageValue;
  onChange: (v: MessageValue) => void;
  options: CelebrationOptions;
  occasion: string;
  occasionLabel: string;
  branding: string;
  /** The AI also suggests flyer wording; the wizard offers it to the flyer editor. */
  onFlyerText?: (headline: string, greeting: string) => void;
}) {
  const toast = useToast();
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const [ai, setAi] = useState({ instructions: '', tone: 'warm', length: 'medium', language: 'English', revision: '' });
  const [busy, setBusy] = useState<'' | 'generate' | 'revise' | 'starter'>('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);

  const insert = (token: string) => {
    const el = textRef.current;
    const t = `{{${token}}}`;
    if (!el) { onChange({ ...value, message: value.message + t }); return; }
    const start = el.selectionStart ?? value.message.length;
    const end = el.selectionEnd ?? start;
    onChange({ ...value, message: value.message.slice(0, start) + t + value.message.slice(end) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + t.length, start + t.length); });
  };

  const apply = (d: AiGreetingDraft) => {
    onChange({ subject: d.subject, preview_text: d.preview_text, message: d.message, ai_assisted: true });
    onFlyerText?.(d.flyer_headline, d.flyer_greeting);
  };

  const generate = async (mode: 'generate' | 'revise') => {
    if (mode === 'revise' && !ai.revision.trim()) { toast('Say what to change first.', 'bad'); return; }
    setBusy(mode); setAiError(null);
    try {
      const r = await aiDraftGreeting({
        occasion, occasion_label: occasionLabel, instructions: ai.instructions, tone: ai.tone, length: ai.length,
        language: ai.language, branding,
        previous: value.message ? { subject: value.subject, preview_text: value.preview_text, message: value.message } : null,
        revision: mode === 'revise' ? ai.revision : '',
      });
      apply(r.draft);
      setWarnings(r.warnings);
      if (mode === 'revise') setAi((a) => ({ ...a, revision: '' }));
    } catch (e) {
      setAiError(apiErrorMessage(e, 'The AI writer did not answer.'));
    } finally {
      setBusy('');
    }
  };

  const starter = async () => {
    setBusy('starter');
    try {
      const s = await starterMessage(occasion, occasionLabel);
      onChange({ ...s, ai_assisted: false });
      setWarnings([]);
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not load a suggested message'), 'bad');
    } finally { setBusy(''); }
  };

  return (
    <div>
      <div className="camp-section" data-testid="ai-panel" style={{ background: 'var(--panel-2, #f8fafc)', padding: 12, borderRadius: 8 }}>
        <div className="camp-section-h"><strong>✨ Generate with AI</strong>
          {value.ai_assisted && <span className="pill info" style={{ fontSize: 10 }}>AI draft — review before sending</span>}
        </div>
        {!options.ai.available ? (
          <div className="reminder-warn" style={{ fontSize: 12.5 }} data-testid="ai-unavailable">{options.ai.reason}</div>
        ) : (
          <>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Instructions (optional)</label>
              <textarea rows={2} value={ai.instructions} onChange={(e) => setAi({ ...ai, instructions: e.target.value })}
                placeholder="e.g. Mention we are grateful for their trust this year. Keep it short." />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8 }}>
              <div className="field"><label>Tone</label>
                <select value={ai.tone} onChange={(e) => setAi({ ...ai, tone: e.target.value })}>
                  {options.tones.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                </select></div>
              <div className="field"><label>Length</label>
                <select value={ai.length} onChange={(e) => setAi({ ...ai, length: e.target.value })}>
                  {options.lengths.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                </select></div>
              <div className="field"><label>Language</label>
                <input list="celebration-languages" value={ai.language} onChange={(e) => setAi({ ...ai, language: e.target.value })} />
                <datalist id="celebration-languages">{options.languages.map((l) => <option key={l} value={l} />)}</datalist>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <button type="button" className="btn primary sm" disabled={!!busy || !occasion} onClick={() => generate('generate')} data-testid="ai-generate">
                {busy === 'generate' ? 'Writing…' : value.message ? 'Regenerate' : 'Generate'}
              </button>
              {value.message && (
                <>
                  <input style={{ flex: 1, minWidth: 180 }} value={ai.revision} onChange={(e) => setAi({ ...ai, revision: e.target.value })}
                    placeholder="Revise: e.g. make it shorter and warmer" data-testid="ai-revision" />
                  <button type="button" className="btn sm" disabled={!!busy} onClick={() => generate('revise')}>{busy === 'revise' ? 'Revising…' : 'Revise'}</button>
                </>
              )}
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              Sends only the occasion, your settings and instructions, and the sender name to the AI provider — no lead data.
              Merge fields are filled in by the CRM afterwards.
            </div>
          </>
        )}
        {aiError && <div className="reminder-warn" style={{ marginTop: 8, fontSize: 12.5 }} data-testid="ai-error">{aiError} You can write the message yourself below.</div>}
        {warnings.length > 0 && (
          <ul className="reminder-warn" style={{ margin: '8px 0 0', paddingLeft: 26, fontSize: 12.5 }} data-testid="ai-warnings">
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
        <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} disabled={!!busy || !occasion} onClick={starter}>
          {busy === 'starter' ? 'Loading…' : 'Use a suggested message (not AI)'}
        </button>
      </div>

      <div className="field">
        <label>Subject</label>
        <input value={value.subject} maxLength={200} onChange={(e) => onChange({ ...value, subject: e.target.value })} data-testid="cel-subject" />
      </div>
      <div className="field">
        <label>Preview text <span className="muted" style={{ fontWeight: 400 }}>— the line inboxes show after the subject</span></label>
        <input value={value.preview_text} maxLength={255} onChange={(e) => onChange({ ...value, preview_text: e.target.value })} />
      </div>
      <div className="field">
        <label>Message</label>
        <textarea ref={textRef} rows={9} value={value.message} onChange={(e) => onChange({ ...value, message: e.target.value })}
          placeholder={'Hi {{LEAD_FIRST_NAME}},\n\nWishing you…'} data-testid="cel-message" />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {options.tokens.map((t) => (
            <button key={t.token} type="button" className="btn ghost sm" style={{ fontSize: 11 }} title={`Falls back to ${t.fallback}`} onClick={() => insert(t.token)}>
              + {t.label}
            </button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          Plain text: a blank line starts a new paragraph. Your signature is added automatically from the branding choice.
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------- flyer

const readAsDataUrl = (file: File): Promise<string> => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(file);
});

/** None, upload, or the branded template (clearly not AI). The email text stays separate. */
export function FlyerEditor({ flyer, onChange, options, occasion, occasionLabel, suggestion }: {
  flyer: Flyer | null;
  onChange: (f: Flyer | null) => void;
  options: CelebrationOptions;
  occasion: string;
  occasionLabel: string;
  suggestion?: { headline: string; greeting: string } | null;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<'none' | 'upload' | 'template'>(flyer ? flyer.source : 'none');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadAlt, setUploadAlt] = useState('');
  const settings = (flyer?.source === 'template' ? flyer.settings : null) as Record<string, unknown> | null;
  const [t, setT] = useState(() => ({
    headline: String(settings?.headline ?? ''),
    greeting: String(settings?.greeting ?? ''),
    style: String(settings?.style ?? 'festive'),
    format: String(settings?.format ?? 'square'),
    primary: String((settings?.colors as Record<string, string> | undefined)?.primary ?? options.flyer.brand_colours.primary),
    accent: String((settings?.colors as Record<string, string> | undefined)?.accent ?? options.flyer.brand_colours.accent),
    background: String((settings?.colors as Record<string, string> | undefined)?.background ?? options.flyer.brand_colours.background),
    include_logo: settings?.include_logo !== false,
    sender_line: String(settings?.sender_line ?? ''),
    alt_text: flyer?.alt_text ?? '',
  }));
  const [alt, setAlt] = useState(flyer?.alt_text ?? '');
  useEffect(() => { setAlt(flyer?.alt_text ?? ''); }, [flyer?.id, flyer?.alt_text]);

  useEffect(() => {
    if (suggestion && (suggestion.headline || suggestion.greeting) && !t.headline && !t.greeting) {
      setT((x) => ({ ...x, headline: suggestion.headline, greeting: suggestion.greeting }));
    }
  }, [suggestion]); // eslint-disable-line react-hooks/exhaustive-deps

  const doUpload = async () => {
    if (!file) { toast('Choose an image first.', 'bad'); return; }
    if (uploadAlt.trim().length < 3) { toast('Describe the image (alt text) first.', 'bad'); return; }
    if (file.size > 8 * 1024 * 1024) { toast('That image is larger than 8 MB.', 'bad'); return; }
    setBusy(true);
    try {
      onChange(await uploadFlyer(await readAsDataUrl(file), uploadAlt.trim()));
      setFile(null);
      toast('Image uploaded and compressed for email.', 'ok');
    } catch (e) { toast(apiErrorMessage(e, 'Upload failed'), 'bad'); } finally { setBusy(false); }
  };

  const doTemplate = async () => {
    const altText = t.alt_text.trim() || [t.headline, t.greeting].filter(Boolean).join(' — ');
    if (!t.headline.trim() && !t.greeting.trim()) { toast('Give the flyer a headline or greeting.', 'bad'); return; }
    setBusy(true);
    try {
      onChange(await templateFlyer({
        occasion, occasion_label: occasionLabel, headline: t.headline, greeting: t.greeting, style: t.style, format: t.format,
        colors: { primary: t.primary, accent: t.accent, background: t.background }, include_logo: t.include_logo,
        sender_line: t.sender_line, alt_text: altText,
      }));
      setT((x) => ({ ...x, alt_text: altText }));
    } catch (e) { toast(apiErrorMessage(e, 'Could not draw the flyer'), 'bad'); } finally { setBusy(false); }
  };

  const saveAlt = async () => {
    if (!flyer) return;
    try { onChange(await updateFlyerAlt(flyer.id, alt)); toast('Alt text saved.', 'ok'); } catch (e) { toast(apiErrorMessage(e, 'Could not save alt text'), 'bad'); }
  };

  return (
    <div className="camp-section" data-testid="flyer-editor">
      <div className="camp-section-h"><strong>Flyer (optional)</strong></div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
        {(['none', 'upload', 'template'] as const).map((m) => (
          <label key={m} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" checked={mode === m} onChange={() => { setMode(m); if (m === 'none') onChange(null); }} />
            {m === 'none' ? 'No flyer' : m === 'upload' ? 'Upload an image' : 'Branded template'}
          </label>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{options.flyer.image_generation_note}</div>

      {mode === 'upload' && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="flyer-file" />
          <div className="field" style={{ margin: 0 }}><label>Alt text (required)</label>
            <input value={uploadAlt} onChange={(e) => setUploadAlt(e.target.value)} placeholder="e.g. Diwali greeting card with lit lamps" maxLength={200} /></div>
          <div className="muted" style={{ fontSize: 11.5 }}>JPEG, PNG or WebP up to 8 MB. It is resized to 1200 px and compressed for email.</div>
          <button type="button" className="btn sm" disabled={busy || !file} onClick={doUpload}>{busy ? 'Uploading…' : flyer ? 'Replace image' : 'Upload'}</button>
        </div>
      )}

      {mode === 'template' && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            An editable branded design drawn by the CRM — <strong>not AI-generated</strong>.
            {!options.flyer.agent_photo_available && ` ${options.flyer.agent_photo_note}`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 8 }}>
            <div className="field" style={{ margin: 0 }}><label>Headline</label>
              <input value={t.headline} maxLength={60} onChange={(e) => setT({ ...t, headline: e.target.value })} placeholder={`Happy ${occasionLabel || 'Holidays'}`} data-testid="flyer-headline" /></div>
            <div className="field" style={{ margin: 0 }}><label>Greeting on the image</label>
              <input value={t.greeting} maxLength={200} onChange={(e) => setT({ ...t, greeting: e.target.value })} placeholder="Wishing you joy and good health" /></div>
            <div className="field" style={{ margin: 0 }}><label>Style</label>
              <select value={t.style} onChange={(e) => setT({ ...t, style: e.target.value })}>
                {options.flyer.styles.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
              </select></div>
            <div className="field" style={{ margin: 0 }}><label>Format</label>
              <select value={t.format} onChange={(e) => setT({ ...t, format: e.target.value })}>
                {options.flyer.formats.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select></div>
            <div className="field" style={{ margin: 0 }}><label>Name line (optional)</label>
              <input value={t.sender_line} maxLength={80} onChange={(e) => setT({ ...t, sender_line: e.target.value })} placeholder="e.g. From your agent, Priya" /></div>
            <div className="field" style={{ margin: 0 }}><label>Alt text</label>
              <input value={t.alt_text} maxLength={200} onChange={(e) => setT({ ...t, alt_text: e.target.value })} placeholder="Defaults to the headline and greeting" /></div>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
            <label>Main <input type="color" value={t.primary} onChange={(e) => setT({ ...t, primary: e.target.value })} /></label>
            <label>Accent <input type="color" value={t.accent} onChange={(e) => setT({ ...t, accent: e.target.value })} /></label>
            <label>Background <input type="color" value={t.background} onChange={(e) => setT({ ...t, background: e.target.value })} /></label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={t.include_logo} onChange={(e) => setT({ ...t, include_logo: e.target.checked })} />
              {options.flyer.logo_available ? 'Brokerage logo' : 'Brokerage name (no logo uploaded in Settings)'}
            </label>
          </div>
          <button type="button" className="btn sm" disabled={busy} onClick={doTemplate} data-testid="flyer-draw">
            {busy ? 'Drawing…' : flyer?.source === 'template' ? 'Redraw flyer' : 'Draw flyer'}
          </button>
        </div>
      )}

      {flyer && mode !== 'none' && (
        <div style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }} data-testid="flyer-preview">
          <img src={flyer.data_url} alt={flyer.alt_text} style={{ width: 220, maxWidth: '100%', borderRadius: 6, border: '1px solid var(--line)' }} />
          <div style={{ flex: 1, minWidth: 200, display: 'grid', gap: 6 }}>
            <span className={`pill ${flyer.source === 'template' ? '' : 'info'}`} style={{ justifySelf: 'start' }}>{flyer.label}</span>
            <div className="muted" style={{ fontSize: 12 }}>{flyer.width} × {flyer.height} px · {Math.round(flyer.size / 1024)} KB</div>
            <div className="field" style={{ margin: 0 }}><label>Alt text</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={200} />
                <button type="button" className="btn sm" disabled={alt.trim() === flyer.alt_text || alt.trim().length < 3} onClick={saveAlt}>Save</button>
              </div></div>
            <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => { onChange(null); setMode('none'); }}>Remove flyer</button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------- recipients

/** All / filtered / hand-picked / one lead, plus the birthday & anniversary date window. */
export function RecipientEditor({ spec, onChange, options, occasion, allowPick = true }: {
  spec: RecipientSpec;
  onChange: (s: RecipientSpec) => void;
  options: CelebrationOptions;
  occasion: string;
  allowPick?: boolean;
}) {
  const f = spec.filters;
  const setF = (patch: Partial<RecipientSpec['filters']>) => onChange({ ...spec, filters: { ...f, ...patch } });
  const dated = DATE_OCCASIONS.includes(occasion);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<PickableLead[]>([]);
  const [picked, setPicked] = useState<Record<number, PickableLead>>({});
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (spec.mode !== 'selected' && spec.mode !== 'single') return undefined;
    const t = setTimeout(() => {
      setSearching(true);
      searchCelebrationLeads(q).then(setFound).catch(() => setFound([])).finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, spec.mode]);

  const pick = (l: PickableLead) => {
    setPicked((p) => ({ ...p, [l.id]: l }));
    onChange({ ...spec, lead_ids: spec.mode === 'single' ? [l.id] : [...new Set([...spec.lead_ids, l.id])] });
  };
  const unpick = (id: number) => onChange({ ...spec, lead_ids: spec.lead_ids.filter((x) => x !== id) });

  const modes: { v: RecipientSpec['mode']; label: string }[] = [
    { v: 'all', label: 'All eligible leads' },
    { v: 'filtered', label: 'Filtered leads' },
    ...(allowPick ? [{ v: 'selected' as const, label: 'Pick leads' }, { v: 'single' as const, label: 'One lead' }] : []),
  ];

  return (
    <div data-testid="recipient-editor">
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, marginBottom: 8 }}>
        {modes.map((m) => (
          <label key={m.v} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" name="recipient-mode" checked={spec.mode === m.v}
              onChange={() => onChange({ ...spec, mode: m.v, lead_ids: m.v === 'single' ? spec.lead_ids.slice(0, 1) : spec.lead_ids })} />
            {m.label}
          </label>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{options.scope_note} Opted-out, suppressed and invalid addresses are always excluded.</div>

      {dated && (spec.mode === 'all' || spec.mode === 'filtered') && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 8, marginBottom: 8 }}>
          <div className="field" style={{ margin: 0 }}><label>{occasion === 'birthday' ? 'Birthdays' : 'Anniversaries'} falling</label>
            <select value={f.date_window ?? 'today'} onChange={(e) => setF({ date_window: e.target.value as never })} data-testid="date-window">
              <option value="today">Today</option>
              <option value="next7">In the next 7 days</option>
              <option value="this_month">This month</option>
              <option value="on_date">On a date…</option>
            </select></div>
          {f.date_window === 'on_date' && (
            <div className="field" style={{ margin: 0 }}><label>Date</label>
              <input type="date" value={f.date_on ?? ''} onChange={(e) => setF({ date_on: e.target.value })} /></div>
          )}
          <div className="field" style={{ margin: 0 }}><label>Feb 29 dates in other years</label>
            <select value={f.feb29_rule ?? 'feb28'} onChange={(e) => setF({ feb29_rule: e.target.value as never })}>
              <option value="feb28">Greet on Feb 28</option>
              <option value="mar1">Greet on Mar 1</option>
              <option value="skip">Skip until a leap year</option>
            </select></div>
        </div>
      )}

      {spec.mode === 'filtered' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 8 }}>
          <div className="field" style={{ margin: 0 }}><label>Assigned agent</label>
            <select value={f.agent_id ?? ''} onChange={(e) => setF({ agent_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Any</option>
              {options.filters.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
          <div className="field" style={{ margin: 0 }}><label>Status</label>
            <select value={f.status ?? ''} onChange={(e) => setF({ status: e.target.value || undefined })}>
              <option value="">Any</option>
              {options.filters.lead_status.map((s) => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <div className="field" style={{ margin: 0 }}><label>Source</label>
            <select value={f.source ?? ''} onChange={(e) => setF({ source: e.target.value || undefined })}>
              <option value="">Any</option>
              {options.filters.lead_source.map((s) => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <div className="field" style={{ margin: 0 }}><label>Lead type</label>
            <select value={f.lead_type ?? ''} onChange={(e) => setF({ lead_type: e.target.value || undefined })}>
              <option value="">Any</option>
              {options.filters.lead_type.map((s) => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <div className="field" style={{ margin: 0 }}><label>Client type</label>
            <select value={f.client_type ?? ''} onChange={(e) => setF({ client_type: e.target.value || undefined })}>
              <option value="">Any</option>
              {options.filters.client_type.map((s) => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <div className="field" style={{ margin: 0 }}><label>Location contains</label>
            <input value={f.location ?? ''} onChange={(e) => setF({ location: e.target.value || undefined })} placeholder="e.g. Brampton" /></div>
          {options.filters.tags.length > 0 && (
            <div className="field" style={{ margin: 0, gridColumn: '1 / -1' }}><label>Tags (any of)</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {options.filters.tags.map((t) => {
                  const on = (f.tags ?? []).includes(t);
                  return (
                    <button key={t} type="button" className={`btn sm ${on ? 'primary' : 'ghost'}`}
                      onClick={() => setF({ tags: on ? (f.tags ?? []).filter((x) => x !== t) : [...(f.tags ?? []), t] })}>{t}</button>
                  );
                })}
              </div></div>
          )}
        </div>
      )}

      {(spec.mode === 'selected' || spec.mode === 'single') && (
        <div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your leads by name or email" data-testid="lead-search" />
          <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6, marginTop: 6 }}>
            {searching && <div className="muted" style={{ padding: 8, fontSize: 12 }}>Searching…</div>}
            {!searching && found.length === 0 && <div className="muted" style={{ padding: 8, fontSize: 12 }}>No leads match.</div>}
            {found.map((l) => (
              <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{l.name}</strong> <span className="muted">{l.email ?? 'no email'}</span>
                  {!l.eligible && <span className="pill warn" style={{ marginLeft: 6, fontSize: 10 }}>{l.reason}</span>}
                </div>
                <button type="button" className="btn sm" disabled={!l.eligible || spec.lead_ids.includes(l.id)} onClick={() => pick(l)}>
                  {spec.lead_ids.includes(l.id) ? 'Added' : spec.mode === 'single' ? 'Choose' : 'Add'}
                </button>
              </div>
            ))}
          </div>
          {spec.lead_ids.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }} data-testid="picked-leads">
              {spec.lead_ids.map((id) => (
                <span key={id} className="pill info" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  {picked[id]?.name ?? `Lead #${id}`}
                  <button type="button" onClick={() => unpick(id)} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0 }} aria-label="Remove">✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
