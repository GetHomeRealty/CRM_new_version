import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { UserPhotoService } from './user-photo.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * U-L1 — an avatar has to be an image, not merely be named like one.
 *
 * The extension was the only check, so `evil.png` containing a script tag was accepted with a 200
 * and written to disk. Not exploitable through today's paths — helmet sets `nosniff`, the file is
 * served as `image/png`, the stored name is randomised — but the guarantee should be "it is an
 * image", not "nothing currently reads it as anything else".
 *
 * The refusal happens before `userOr404` and before any write, which is what makes these tests
 * cheap: an id that does not exist reaches a 404 ONLY when the content passed inspection, so the
 * positive case is provable without creating a user or leaving a file behind.
 */

const prisma = new PrismaClient();
const admin = { id: 1, name: 'Root', role: 'admin' } as unknown as AuthUserRecord;
const noAudit = { logModule: async () => {}, record: async () => {} } as never;
const svc = new UserPhotoService(prisma as unknown as PrismaService, noAudit);

/** An id no row can hold, so the call cannot accidentally write over a real account. */
const NO_SUCH_USER = -1;

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');

/** The smallest byte sequences that each format is recognised by. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const GIF = [...Buffer.from('GIF89a'), 0, 0, 0, 0, 0, 0];
const WEBP = [...Buffer.from('RIFF'), 0x1a, 0, 0, 0, ...Buffer.from('WEBP')];

afterAll(async () => { await prisma.$disconnect(); });

describe('U-L1 — the content has to agree with the name', () => {
  it.each([
    ['a.png', PNG],
    ['a.jpg', JPEG],
    ['a.jpeg', JPEG],
    ['a.gif', GIF],
    ['a.webp', WEBP],
  ])('lets a real %s through to the rest of the upload', async (name, bytes) => {
    // Reaching "user not found" is the proof: the check that would have stopped it did not.
    await expect(svc.store(admin, NO_SUCH_USER, name, b64(bytes))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a script renamed to .png — the finding itself', async () => {
    const html = Buffer.from('<script>alert(1)</script>').toString('base64');
    await expect(svc.store(admin, NO_SUCH_USER, 'evil.png', html)).rejects.toThrow(/not a .*image/i);
  });

  it.each([
    ['an SVG', '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
    ['an HTML page', '<!doctype html><html><body>hi</body></html>'],
    ['a PDF', '%PDF-1.7\n%\xe2\xe3\xcf\xd3'],
    ['plain text', 'this is just a note'],
  ])('refuses %s carrying an image extension', async (_what, text) => {
    const payload = Buffer.from(text, 'binary').toString('base64');
    await expect(svc.store(admin, NO_SUCH_USER, 'photo.jpg', payload)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a genuine image whose extension names a different format', async () => {
    // A real PNG called `.gif`. Harmless in itself, but it means the mime this service reports for
    // the file afterwards — which it derives from the extension — would be wrong.
    await expect(svc.store(admin, NO_SUCH_USER, 'portrait.gif', b64(PNG))).rejects.toThrow(/contents are image\/png/i);
  });

  it('treats .jpg and .jpeg as the same format', async () => {
    // The comparison is on the resolved mime, not on the extension string, so neither spelling is
    // rejected for "not matching" the other.
    await expect(svc.store(admin, NO_SUCH_USER, 'p.jpeg', b64(JPEG))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still refuses an unsupported extension before looking at the bytes', async () => {
    await expect(svc.store(admin, NO_SUCH_USER, 'a.bmp', b64(PNG))).rejects.toThrow(/not a supported image/i);
  });

  it('refuses a file too short to carry a signature', async () => {
    await expect(svc.store(admin, NO_SUCH_USER, 'a.png', b64([0x89, 0x50]))).rejects.toThrow(/not a .*image/i);
  });
});
