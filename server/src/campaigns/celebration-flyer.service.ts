import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import type { campaign_flyers } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_ROOT } from '../config/storage';
import type { AuthUserRecord } from '../auth/auth.types';
import { occasionGroup, occasionLabel } from './celebration';

/** Largest upload accepted before compression. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Email-friendly width; the layout shows it at up to 544 px, so 1200 covers 2x screens. */
const MAX_WIDTH = 1200;
/** What a compressed flyer may weigh. Each recipient's message carries it once. */
const MAX_OUTPUT_BYTES = 600 * 1024;

export const FLYER_FORMATS: Record<string, { w: number; h: number; label: string }> = {
  square: { w: 1080, h: 1080, label: 'Square (1080 × 1080)' },
  portrait: { w: 1080, h: 1350, label: 'Portrait (1080 × 1350)' },
  landscape: { w: 1200, h: 630, label: 'Landscape banner (1200 × 630)' },
};
export const FLYER_STYLES = ['festive', 'elegant', 'minimal', 'warm'] as const;
export const BRAND_COLOURS = { primary: '#c8102e', accent: '#d4a017', background: '#fffaf3', text: '#0f172a' };

export interface FlyerTemplateInput {
  occasion: string;
  occasion_label?: string;
  headline: string;
  greeting: string;
  style: string;
  format: string;
  colors?: { primary?: string; accent?: string; background?: string };
  include_logo?: boolean;
  sender_line?: string;
  alt_text: string;
}

const str = (v: unknown): string => String(v ?? '').trim();
const hex = (v: unknown, fallback: string): string => (/^#[0-9a-f]{6}$/i.test(str(v)) ? str(v) : fallback);
const xml = (v: string): string => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));

/** Greedy word wrap by an estimated glyph width — enough for a short headline and greeting. */
function wrap(text: string, fontSize: number, width: number, maxLines: number, glyph = 0.54): string[] {
  const perLine = Math.max(6, Math.floor(width / (fontSize * glyph)));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > perLine && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s*\S*$/, '')}…`;
    return kept;
  }
  return lines;
}

/** Decorations per occasion group: shapes only, no religious or cultural symbols. */
function decorations(group: string, style: string, w: number, h: number, c: { primary: string; accent: string }): string {
  const rnd = (seed: number) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };
  const out: string[] = [];
  if (style === 'minimal') {
    out.push(`<rect x="${w * 0.08}" y="${h * 0.1}" width="${w * 0.12}" height="6" fill="${c.primary}"/>`);
    return out.join('');
  }
  if (group === 'birthday') {
    const colours = [c.primary, c.accent, '#3b82f6', '#10b981'];
    for (let i = 0; i < 4; i += 1) {
      const x = w * (0.1 + i * 0.07); const y = h * (0.16 + (i % 2) * 0.05);
      out.push(`<line x1="${x}" y1="${y + 52}" x2="${x + 8}" y2="${y + 150}" stroke="#94a3b8" stroke-width="2"/>`);
      out.push(`<ellipse cx="${x}" cy="${y}" rx="34" ry="44" fill="${colours[i]}" opacity="0.9"/>`);
    }
  } else if (group === 'anniversary') {
    out.push(`<circle cx="${w * 0.16}" cy="${h * 0.18}" r="46" fill="none" stroke="${c.accent}" stroke-width="10"/>`);
    out.push(`<circle cx="${w * 0.22}" cy="${h * 0.18}" r="46" fill="none" stroke="${c.primary}" stroke-width="10"/>`);
  } else {
    // String of lights / confetti — generic festivity.
    out.push(`<path d="M0 ${h * 0.06} Q ${w / 2} ${h * 0.16} ${w} ${h * 0.06}" fill="none" stroke="#94a3b8" stroke-width="2"/>`);
    for (let i = 1; i < 12; i += 1) {
      const t = i / 12; const x = t * w; const y = h * 0.06 + Math.sin(Math.PI * t) * h * 0.075;
      out.push(`<circle cx="${x}" cy="${y + 14}" r="11" fill="${i % 2 ? c.accent : c.primary}"/>`);
    }
  }
  if (style === 'festive') {
    for (let i = 0; i < 26; i += 1) {
      const x = rnd(i) * w; const y = h * 0.55 + rnd(i + 50) * h * 0.4; const s = 5 + rnd(i + 99) * 9;
      out.push(`<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${i % 3 ? c.accent : c.primary}" opacity="0.55" transform="rotate(${Math.round(rnd(i + 7) * 90)} ${x} ${y})"/>`);
    }
  }
  return out.join('');
}

/**
 * Flyer images for celebration emails — uploaded, or drawn from the branded template.
 *
 * THE TEMPLATE IS NOT AI, and is labelled so wherever it appears: it is an SVG laid out here from
 * the author's own words, the brand colours and (optionally) the brokerage logo, rendered to JPEG by
 * sharp. No image-generation service is configured, and none is called (decided 2026-10-21).
 */
@Injectable()
export class CelebrationFlyerService {
  private readonly log = new Logger(CelebrationFlyerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The brokerage logo from Settings → Company, as a data URI sharp can embed, or null. */
  async logoDataUri(): Promise<string | null> {
    const s = await this.prisma.company_settings.findFirst({ select: { logo_path: true } });
    if (!s?.logo_path) return null;
    try {
      const abs = path.resolve(STORAGE_ROOT, s.logo_path);
      if (!abs.startsWith(path.resolve(STORAGE_ROOT))) return null;
      const buf = await fs.readFile(abs);
      // Normalised to PNG so an SVG or WebP logo embeds the same way as any other.
      const png = await sharp(buf).resize({ width: 480, height: 160, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      return `data:image/png;base64,${png.toString('base64')}`;
    } catch {
      return null;
    }
  }

  /** The SVG for a template flyer. Exposed for tests; `renderTemplate` turns it into an image. */
  buildSvg(input: FlyerTemplateInput, logo: string | null): { svg: string; w: number; h: number } {
    const fmt = FLYER_FORMATS[input.format] ?? FLYER_FORMATS.square;
    const { w, h } = fmt;
    const style = (FLYER_STYLES as readonly string[]).includes(input.style) ? input.style : 'festive';
    const c = {
      primary: hex(input.colors?.primary, BRAND_COLOURS.primary),
      accent: hex(input.colors?.accent, BRAND_COLOURS.accent),
      background: hex(input.colors?.background, BRAND_COLOURS.background),
    };
    const serif = style === 'elegant';
    const family = serif ? "'DejaVu Serif', Georgia, 'Times New Roman', serif" : "'DejaVu Sans', Arial, Helvetica, sans-serif";
    const headline = str(input.headline) || `Happy ${occasionLabel(input.occasion, input.occasion_label)}`;
    const greeting = str(input.greeting);
    const landscape = w > h;
    const hSize = landscape ? 64 : 92;
    const gSize = landscape ? 30 : 40;
    const textW = w * 0.8;
    // Bold serif runs wider than the sans estimate, and the elegant frame leaves less room.
    const glyph = serif ? 0.62 : 0.54;
    const hLines = wrap(headline, hSize, textW, 2, glyph);
    const gLines = greeting ? wrap(greeting, gSize, textW, landscape ? 3 : 5, glyph) : [];
    const blockH = hLines.length * hSize * 1.15 + (gLines.length ? 30 + gLines.length * gSize * 1.35 : 0);
    let y = h * (landscape ? 0.5 : 0.48) - blockH / 2 + hSize;

    const bg = style === 'warm'
      ? `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.background}" stop-opacity="0"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0.35"/></linearGradient></defs><rect width="${w}" height="${h}" fill="${c.background}"/><rect width="${w}" height="${h}" fill="url(#g)"/>`
      : `<rect width="${w}" height="${h}" fill="${c.background}"/>`;
    const frame = style === 'elegant'
      ? `<rect x="28" y="28" width="${w - 56}" height="${h - 56}" fill="none" stroke="${c.accent}" stroke-width="3"/><rect x="40" y="40" width="${w - 80}" height="${h - 80}" fill="none" stroke="${c.accent}" stroke-width="1"/>`
      : '';

    // In a banner the balloons and rings would crowd the headline, so they are drawn smaller there.
    const deco = decorations(occasionGroup(input.occasion), style, w, h, c);
    const parts: string[] = [bg, frame, landscape && occasionGroup(input.occasion) !== 'festival' ? `<g transform="scale(0.6)">${deco}</g>` : deco];
    for (const line of hLines) {
      parts.push(`<text x="${w / 2}" y="${y}" text-anchor="middle" font-family="${family}" font-size="${hSize}" font-weight="700" fill="${c.primary}">${xml(line)}</text>`);
      y += hSize * 1.15;
    }
    if (gLines.length) {
      y += 30 - hSize * 0.15;
      for (const line of gLines) {
        y += gSize * 0.2;
        parts.push(`<text x="${w / 2}" y="${y}" text-anchor="middle" font-family="${family}" font-size="${gSize}" fill="${BRAND_COLOURS.text}">${xml(line)}</text>`);
        y += gSize * 1.15;
      }
    }
    // Footer: the logo when there is one and it was asked for, else the brokerage wordmark.
    const footY = h - (landscape ? 70 : 110);
    parts.push(`<rect x="${w * 0.35}" y="${footY - 40}" width="${w * 0.3}" height="2" fill="${c.accent}" opacity="0.7"/>`);
    if (input.include_logo !== false && logo) {
      parts.push(`<image href="${logo}" x="${w / 2 - 150}" y="${footY - 22}" width="300" height="70" preserveAspectRatio="xMidYMid meet"/>`);
    } else {
      parts.push(`<text x="${w / 2}" y="${footY + 18}" text-anchor="middle" font-family="'DejaVu Sans', Arial, sans-serif" font-size="30" font-weight="700" letter-spacing="3" fill="${c.primary}">GET HOME REALTY</text>`);
    }
    const sender = str(input.sender_line);
    if (sender) {
      parts.push(`<text x="${w / 2}" y="${footY + (landscape ? 52 : 70)}" text-anchor="middle" font-family="'DejaVu Sans', Arial, sans-serif" font-size="24" fill="#475569">${xml(sender.slice(0, 80))}</text>`);
    }
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`, w, h };
  }

  private validateAlt(alt: unknown): string {
    const a = str(alt).replace(/\s+/g, ' ');
    if (a.length < 3) {
      throw new BadRequestException({ message: 'Describe the image in a few words (alt text) — it is shown when images are blocked and read aloud by screen readers.', errors: { alt_text: ['Required.'] } });
    }
    return a.slice(0, 200);
  }

  /** Draw a branded template flyer and store it. */
  async renderTemplate(input: FlyerTemplateInput, user: AuthUserRecord): Promise<campaign_flyers> {
    const alt = this.validateAlt(input.alt_text);
    if (!str(input.headline) && !str(input.greeting)) {
      throw new BadRequestException({ message: 'Give the flyer a headline or a greeting.' });
    }
    const logo = input.include_logo === false ? null : await this.logoDataUri();
    const { svg, w, h } = this.buildSvg(input, logo);
    let jpg: Buffer;
    try {
      jpg = await sharp(Buffer.from(svg)).flatten({ background: '#ffffff' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    } catch (err) {
      this.log.error(`Flyer template render failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadRequestException({ message: 'The flyer could not be drawn. Try a different style, or upload an image instead.' });
    }
    return this.store(user, 'template', jpg, 'image/jpeg', w, h, alt, {
      occasion: input.occasion, occasion_label: input.occasion_label ?? null,
      headline: str(input.headline), greeting: str(input.greeting), style: input.style, format: input.format,
      colors: input.colors ?? {}, include_logo: input.include_logo !== false, sender_line: str(input.sender_line),
    });
  }

  /**
   * Validate, normalise and compress an uploaded image.
   *
   * The bytes are decoded by sharp — the extension and the browser's claimed type are not trusted.
   * Only still raster images are accepted (an animated GIF or an SVG is refused), EXIF rotation is
   * applied and stripped, transparency is flattened onto white, and the result is a JPEG no wider
   * than 1200 px and no heavier than ~600 KB.
   */
  async upload(dataUrl: string, altText: string, user: AuthUserRecord): Promise<campaign_flyers> {
    const alt = this.validateAlt(altText);
    const b64 = String(dataUrl ?? '').replace(/^data:[^;,]+;base64,/, '');
    if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new BadRequestException({ message: 'Choose an image file to upload.' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_UPLOAD_BYTES) throw new BadRequestException({ message: 'That image is larger than 8 MB. Choose a smaller one.' });
    let meta: sharp.Metadata;
    try {
      meta = await sharp(buf).metadata();
    } catch {
      throw new BadRequestException({ message: 'That file is not an image this can read. Use a JPEG, PNG or WebP.' });
    }
    if (!['jpeg', 'png', 'webp', 'gif'].includes(String(meta.format))) {
      throw new BadRequestException({ message: `"${meta.format ?? 'unknown'}" images are not supported. Use a JPEG, PNG or WebP.` });
    }
    if ((meta.pages ?? 1) > 1) throw new BadRequestException({ message: 'Animated images are not supported in greeting emails. Use a still image.' });
    if ((meta.width ?? 0) < 300 || (meta.height ?? 0) < 150) {
      throw new BadRequestException({ message: 'That image is too small to look good in an email — use one at least 300 px wide.' });
    }
    let out: Buffer = Buffer.alloc(0);
    let info: sharp.OutputInfo = { width: 0, height: 0 } as sharp.OutputInfo;
    for (const quality of [82, 72, 62]) {
      const r = await sharp(buf).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      out = r.data; info = r.info;
      if (out.length <= MAX_OUTPUT_BYTES) break;
    }
    return this.store(user, 'upload', out, 'image/jpeg', info.width, info.height, alt, { original_bytes: buf.length });
  }

  private async store(
    user: AuthUserRecord, source: 'upload' | 'template', data: Buffer, mime: string, width: number, height: number,
    alt: string, settings: Record<string, unknown>,
  ): Promise<campaign_flyers> {
    const now = new Date();
    return this.prisma.campaign_flyers.create({
      data: {
        created_by_id: user.id ?? null, source, mime, width, height, size: data.length, data: new Uint8Array(data),
        alt_text: alt, settings: JSON.stringify(settings), created_at: now, updated_at: now,
      },
    });
  }

  /** One of this person's flyers, or 404 — a flyer is as private as the draft it belongs to. */
  async mine(id: number, user: AuthUserRecord): Promise<campaign_flyers> {
    const f = await this.prisma.campaign_flyers.findFirst({ where: { id, created_by_id: user.id ?? -1 } });
    if (!f) throw new NotFoundException({ message: 'Flyer not found.' });
    return f;
  }

  async updateAlt(id: number, alt: string, user: AuthUserRecord): Promise<campaign_flyers> {
    await this.mine(id, user);
    return this.prisma.campaign_flyers.update({ where: { id }, data: { alt_text: this.validateAlt(alt), updated_at: new Date() } });
  }

  /** What a screen needs to show a flyer: metadata plus the image itself as a data URI. */
  present(f: campaign_flyers): Record<string, unknown> {
    let settings: unknown = null;
    try { settings = f.settings ? JSON.parse(f.settings) : null; } catch { settings = null; }
    return {
      id: f.id, source: f.source, mime: f.mime, width: f.width, height: f.height, size: f.size,
      alt_text: f.alt_text, settings,
      label: f.source === 'template' ? 'Branded template — not AI-generated' : 'Uploaded image',
      data_url: `data:${f.mime};base64,${Buffer.from(f.data).toString('base64')}`,
    };
  }
}
