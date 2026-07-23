import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ExtractionResult {
  ok: boolean;
  configured: boolean;
  fields: Record<string, string | null>;
}

const BLANK: Record<string, string | null> = {
  full_legal_name: null, address: null, dob: null, occupation: null,
  id_type: null, id_number: null, issuing_jurisdiction: null, country: null, expiry_date: null,
};

/**
 * Extracts identity fields from a photo-ID image/PDF for FINTRAC Form 630 (port of
 * IdExtractionService). Anthropic Claude vision; never throws — returns null fields so the
 * upload flow degrades gracefully. Does not log raw field values or image contents.
 */
@Injectable()
export class IdExtractionService {
  constructor(private readonly config: ConfigService) {}

  async extractIdFields(contents: Buffer, mime: string): Promise<ExtractionResult> {
    const provider = this.config.get<string>('idExtraction.provider') ?? 'anthropic';
    const key = this.config.get<string>('idExtraction.apiKey') ?? '';
    if (provider !== 'anthropic' || !key) return { ok: false, configured: false, fields: { ...BLANK } };

    let raw: string;
    try {
      raw = await this.callAnthropic(contents, mime, key);
    } catch {
      return { ok: false, configured: true, fields: { ...BLANK } };
    }
    const data = this.decodeJson(raw);
    if (!data || typeof data !== 'object') return { ok: false, configured: true, fields: { ...BLANK } };
    return { ok: true, configured: true, fields: this.normalize(data as Record<string, unknown>) };
  }

  private async callAnthropic(contents: Buffer, mime: string, key: string): Promise<string> {
    const model = this.config.get<string>('idExtraction.model') ?? 'claude-sonnet-5';
    const isPdf = mime === 'application/pdf';
    const prompt =
      'You are extracting fields from a single government-issued identity document ' +
      '(driver licence, passport, or provincial ID). Read only what is printed; never guess or invent. ' +
      'Return ONLY a compact JSON object with exactly these keys and nothing else: ' +
      '{"full_name":string|null,"address":string|null,"date_of_birth":string|null,' +
      '"document_type":"driver_licence"|"passport"|"other"|null,"document_number":string|null,' +
      '"issuing_jurisdiction":string|null,"country":string|null,"expiry_date":string|null,"confidence":number}. ' +
      'Rules: dates as ISO YYYY-MM-DD; full_name in natural reading order (given names then surname); ' +
      'issuing_jurisdiction is the province/state/authority that issued the document; country is the issuing country; ' +
      'use null for any field that is absent or not legible; confidence is 0..1 for the overall read.';
    const media = { type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: isPdf ? 'application/pdf' : mime, data: contents.toString('base64') } };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: [media, { type: 'text', text: prompt }] }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error('ID extraction provider returned HTTP ' + res.status);
    const body = (await res.json()) as { content?: { text?: string }[] };
    return body.content?.[0]?.text ?? '';
  }

  private decodeJson(raw: string): unknown {
    let s = raw.trim();
    if (s.startsWith('```')) s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '');
    const m = /\{[\s\S]*\}/.exec(s);
    if (m) s = m[0];
    try { return JSON.parse(s); } catch { return null; }
  }

  private normalize(d: Record<string, unknown>): Record<string, string | null> {
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
    const dt = String(d.document_type ?? '').toLowerCase();
    const type = ['driver_licence', 'driver_license', 'drivers_licence', 'drivers_license', 'driving_licence', 'driving_license', 'dl'].includes(dt)
      ? "Driver's Licence"
      : dt === 'passport' ? 'Passport' : dt === 'other' ? 'Other' : null;
    return {
      full_legal_name: str(d.full_name),
      address: str(d.address),
      dob: this.isoDate(d.date_of_birth),
      occupation: null,
      id_type: type,
      id_number: str(d.document_number),
      issuing_jurisdiction: str(d.issuing_jurisdiction),
      country: str(d.country),
      expiry_date: this.isoDate(d.expiry_date),
    };
  }

  private isoDate(v: unknown): string | null {
    if (typeof v !== 'string' || v.trim() === '') return null;
    const d = new Date(v.trim());
    if (isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
}
