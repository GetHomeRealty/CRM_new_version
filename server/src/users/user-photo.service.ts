import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { parseJsonObject } from '../common/serialize';
import { trimPngTransparentBorder } from '../settings/image-trim';
import type { AuthUserRecord } from '../auth/auth.types';
import { STORAGE_ROOT } from '../config/storage';

import { can } from '../core/authz';
/**
 * Profile pictures, for every account — agent, accounting, documentation, CRM, manager,
 * admin and super admin alike. A user always manages their own; administrators may also
 * set one for anybody, so a picture can be added on behalf of staff who never get round
 * to it.
 *
 * The path is kept inside the existing `users.profile` JSON blob rather than a new column,
 * so this needs no migration and cannot disturb the other keys that already live there
 * (commission split, loan position).
 */

const PHOTO_DIR = 'avatars';
/** The key inside users.profile. */
const PHOTO_KEY = 'photo_path';
/** A face shot; anything larger is a mistake, not an avatar. */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface PhotoFile { abs: string; mime: string; size: number; mtime: number }

/**
 * What the bytes actually are, as opposed to what the filename claims.
 *
 * The extension was the only check, so `evil.png` containing `<script>alert(1)</script>` was
 * accepted with a 200 and stored — confirmed during the Users audit. It was not exploitable:
 * helmet sets `nosniff`, the file is served as `image/png`, and the stored name is randomised. But
 * "not exploitable through the paths we happen to have today" is a weaker guarantee than "it is an
 * image", and the second one costs four signature checks.
 *
 * Returns the mime the content implies, or null when it is not one of the four formats allowed.
 */
function sniffImage(buf: Buffer): string | null {
  const at = (i: number, ...bytes: number[]): boolean => bytes.every((b, k) => buf[i + k] === b);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  // JPEG: FF D8 FF — every variant (JFIF, Exif, raw) begins with it.
  if (buf.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  // GIF: "GIF87a" or "GIF89a"
  if (buf.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'image/gif';
  // WEBP: "RIFF" .... "WEBP" — the size field sits between the two markers.
  if (buf.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';

  return null;
}

@Injectable()
export class UserPhotoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A user may always act on their own picture; administrators may act on anyone's. */
  assertMayManage(actor: AuthUserRecord | null, targetId: number): void {
    const isSelf = !!actor?.id && actor.id === targetId;
    if (!isSelf && !can(actor, 'users.manage-photo')) {
      throw new ForbiddenException({ message: 'You can only change your own profile picture.' });
    }
  }

  async store(actor: AuthUserRecord | null, targetId: number, fileName: string, base64: string): Promise<Record<string, unknown>> {
    this.assertMayManage(actor, targetId);

    const ext = path.extname(String(fileName || '')).toLowerCase();
    const mime = PHOTO_TYPES[ext];
    if (!mime) {
      throw new BadRequestException({
        message: `"${ext || fileName}" is not a supported image. Use ${Object.keys(PHOTO_TYPES).join(', ')}.`,
      });
    }
    let buffer: Buffer;
    try { buffer = Buffer.from(String(base64 ?? ''), 'base64'); }
    catch { throw new BadRequestException({ message: 'The uploaded file could not be read.' }); }
    if (!buffer.length) throw new BadRequestException({ message: 'The uploaded file is empty.' });
    if (buffer.length > MAX_PHOTO_BYTES) {
      throw new BadRequestException({
        message: `The image is ${(buffer.length / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`,
      });
    }

    /*
     * The content has to agree with the extension.
     *
     * Checked after the size cap, so a huge non-image is refused for being oversized rather than
     * sniffed first — and before anything is written, so nothing that is not an image reaches disk.
     *
     * A JPEG named `.jpg` and one named `.jpeg` are the same thing, so the comparison is on the
     * resolved mime rather than on the extension string.
     */
    const actual = sniffImage(buffer);
    if (!actual) {
      throw new BadRequestException({
        message: `That file is not a ${Object.keys(PHOTO_TYPES).join(', ')} image. `
          + 'It may have been renamed, or saved in a format that is not a picture.',
      });
    }
    if (actual !== mime) {
      throw new BadRequestException({
        message: `The file is named "${fileName}" but its contents are ${actual}. `
          + 'Rename it with the extension that matches, or save it in the format the name claims.',
      });
    }

    const target = await this.userOr404(targetId);
    // Same reasoning as the brand logo: a PNG exported with a transparent border would
    // render as a small face floating in a large empty circle.
    buffer = trimPngTransparentBorder(buffer).buffer;

    const dir = path.join(STORAGE_ROOT, PHOTO_DIR, String(targetId));
    await fs.mkdir(dir, { recursive: true });
    const name = `photo-${crypto.randomBytes(12).toString('hex')}${ext}`;
    await fs.writeFile(path.join(dir, name), buffer);

    const profile = parseJsonObject(target.profile);
    const previous = typeof profile[PHOTO_KEY] === 'string' ? (profile[PHOTO_KEY] as string) : null;
    profile[PHOTO_KEY] = `${PHOTO_DIR}/${targetId}/${name}`;

    await this.prisma.users.update({
      where: { id: targetId },
      data: { profile: JSON.stringify(profile), updated_at: new Date() },
    });
    await this.removeFile(previous);
    await this.log(actor, targetId, target.name, 'Profile picture updated', fileName);
    return this.describe(targetId);
  }

  async remove(actor: AuthUserRecord | null, targetId: number): Promise<Record<string, unknown>> {
    this.assertMayManage(actor, targetId);
    const target = await this.userOr404(targetId);
    const profile = parseJsonObject(target.profile);
    const previous = typeof profile[PHOTO_KEY] === 'string' ? (profile[PHOTO_KEY] as string) : null;
    delete profile[PHOTO_KEY];

    await this.prisma.users.update({
      where: { id: targetId },
      data: { profile: JSON.stringify(profile), updated_at: new Date() },
    });
    await this.removeFile(previous);
    await this.log(actor, targetId, target.name, 'Profile picture removed', null);
    return this.describe(targetId);
  }

  /** Where the picture lives on disk, or null when the user has none. */
  async file(targetId: number): Promise<PhotoFile | null> {
    const row = await this.prisma.users.findUnique({ where: { id: targetId }, select: { profile: true } });
    if (!row) return null;
    const rel = parseJsonObject(row.profile)[PHOTO_KEY];
    if (typeof rel !== 'string' || !rel) return null;
    // Never trust a stored value with a filesystem read.
    const abs = path.resolve(STORAGE_ROOT, rel);
    if (!abs.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) return null;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return null;
      return {
        abs,
        mime: PHOTO_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
        size: stat.size,
        mtime: stat.mtimeMs,
      };
    } catch {
      return null; // recorded but missing — treated as "no picture"
    }
  }

  /** Whether a user has a picture, and the stamp that busts its cache. */
  async describe(targetId: number): Promise<Record<string, unknown>> {
    const row = await this.prisma.users.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, profile: true, updated_at: true },
    });
    if (!row) throw new NotFoundException({ message: 'User not found.' });
    const rel = parseJsonObject(row.profile)[PHOTO_KEY];
    return {
      id: row.id,
      name: row.name,
      has_photo: typeof rel === 'string' && rel !== '',
      photo_version: row.updated_at ? row.updated_at.getTime() : null,
    };
  }

  private async userOr404(id: number): Promise<{ id: number; name: string; profile: string | null }> {
    const row = await this.prisma.users.findUnique({ where: { id }, select: { id: true, name: true, profile: true } });
    if (!row) throw new NotFoundException({ message: 'User not found.' });
    return row;
  }

  private async removeFile(rel: string | null): Promise<void> {
    if (!rel) return;
    const abs = path.resolve(STORAGE_ROOT, rel);
    if (!abs.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) return;
    try { await fs.unlink(abs); } catch { /* best-effort */ }
  }

  private async log(actor: AuthUserRecord | null, targetId: number, targetName: string, action: string, details: string | null): Promise<void> {
    const acting: ActingUser | null = actor ? { id: actor.id, name: actor.name } : null;
    const onBehalf = actor?.id !== targetId ? ` for ${targetName}` : '';
    await this.audit.logModule(acting, 'Users', {
      section: 'Profile',
      field: 'Profile picture',
      action: `${action}${onBehalf}`,
      details,
    });
  }
}
