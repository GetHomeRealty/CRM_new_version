import * as zlib from 'zlib';

/**
 * Trims the fully-transparent border from a PNG.
 *
 * Logo files are very often exported onto a large square canvas with the mark floating in
 * the middle. Nothing in CSS can recover that space — the padding is pixels in the file —
 * so a logo uploaded that way renders with a thick band of emptiness above and below it on
 * every letterhead, and the visible mark ends up a fraction of the height it was given.
 *
 * Everything here is deliberately conservative: only 8-bit non-interlaced PNGs that carry
 * an alpha channel are touched, and anything unexpected returns the original bytes
 * unchanged. A logo is a brand asset — leaving it alone is always safer than mangling it.
 */

/** Ignore near-invisible pixels (anti-aliasing, faint export artefacts). */
const ALPHA_THRESHOLD = 12;
/** Not worth rewriting the file for a sliver. */
const MIN_TRIM_RATIO = 0.02;
/** Guard against a decompression bomb. */
const MAX_PIXELS = 30_000_000;

export interface TrimResult {
  buffer: Buffer;
  trimmed: boolean;
  /** Present when the image was understood, whether or not it was trimmed. */
  before?: { width: number; height: number };
  after?: { width: number; height: number };
  /** Why it was left alone, for logging/tests. */
  reason?: string;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function trimPngTransparentBorder(input: Buffer): TrimResult {
  const keep = (reason: string, extra: Partial<TrimResult> = {}): TrimResult =>
    ({ buffer: input, trimmed: false, reason, ...extra });

  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_MAGIC)) return keep('not a PNG');

  // ---- read the chunks we care about ----
  let off = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= input.length) {
    const len = input.readUInt32BE(off);
    const type = input.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    if (start + len > input.length) return keep('truncated PNG');
    if (type === 'IHDR') ihdr = input.subarray(start, start + len);
    else if (type === 'IDAT') idat.push(input.subarray(start, start + len));
    else if (type === 'IEND') break;
    off = start + len + 4;
  }
  if (!ihdr || ihdr.length < 13 || !idat.length) return keep('malformed PNG');

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colour = ihdr[9];
  const interlace = ihdr[12];
  const before = { width, height };

  // Only the two colour types that carry alpha, 8-bit, non-interlaced.
  const channels = colour === 6 ? 4 : colour === 4 ? 2 : 0;
  if (!channels) return keep('no alpha channel to trim against', { before });
  if (depth !== 8) return keep(`unsupported bit depth ${depth}`, { before });
  if (interlace !== 0) return keep('interlaced PNG', { before });
  if (width * height > MAX_PIXELS) return keep('image too large to process', { before });

  // ---- inflate + reverse the per-scanline filters ----
  let raw: Buffer;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); }
  catch { return keep('could not inflate image data', { before }); }

  const bpp = channels;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return keep('image data shorter than declared size', { before });

  const img = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const out = img.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const est = a + b - c;
        const pa = Math.abs(est - a), pb = Math.abs(est - b), pc = Math.abs(est - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return keep(`unknown scanline filter ${filter}`, { before });
      out[x] = v & 0xff;
    }
  }

  // ---- bounding box of everything meaningfully opaque ----
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      if (img[row + x * bpp + bpp - 1] <= ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // A fully transparent image would trim to nothing — keep it and let the user see the problem.
  if (maxX < 0) return keep('image is fully transparent', { before });

  const newW = maxX - minX + 1;
  const newH = maxY - minY + 1;
  const removed = 1 - (newW * newH) / (width * height);
  if (removed < MIN_TRIM_RATIO) return keep('already tightly cropped', { before, after: before });

  // ---- re-encode the cropped region ----
  const outStride = newW * bpp;
  const body = Buffer.alloc(newH * (outStride + 1));
  for (let y = 0; y < newH; y++) {
    body[y * (outStride + 1)] = 0; // filter: none
    img.copy(
      body,
      y * (outStride + 1) + 1,
      (minY + y) * stride + minX * bpp,
      (minY + y) * stride + minX * bpp + outStride,
    );
  }
  const newIhdr = Buffer.alloc(13);
  newIhdr.writeUInt32BE(newW, 0);
  newIhdr.writeUInt32BE(newH, 4);
  newIhdr[8] = 8;          // bit depth
  newIhdr[9] = colour;     // same colour type
  newIhdr[10] = 0;         // deflate
  newIhdr[11] = 0;         // adaptive filtering
  newIhdr[12] = 0;         // no interlace

  const out = Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', newIhdr),
    chunk('IDAT', zlib.deflateSync(body, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return { buffer: out, trimmed: true, before, after: { width: newW, height: newH } };
}
