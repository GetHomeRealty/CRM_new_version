import http from 'node:http';
import { contentDisposition, asciiFilename } from './content-disposition';

/**
 * TD-046 (follow-up) — a non-ASCII filename must not 500 the download.
 *
 * Node writes headers as latin-1 and throws `ERR_INVALID_CHAR` on anything above U+00FF, so
 * interpolating a stored filename straight into `Content-Disposition` meant a document uploaded as
 * "契約書.pdf" could be stored and listed but never opened. The last test here is the one that
 * matters most: it puts the produced header through a REAL `res.setHeader`, because that is the
 * call that used to throw, and no amount of string assertion proves it does not.
 *
 * The rest pin the two parameters RFC 6266 asks for — an ASCII rendering anything can read, and
 * `filename*` carrying the name that was actually uploaded — plus the header-injection cases a
 * filename is an obvious vector for.
 */

const HEADER_SAFE = /^[\x20-\x7E]*$/;

describe('Content-Disposition is built from the filename safely (TD-046)', () => {
  it('leaves an ordinary ASCII name exactly as the routes always sent it', () => {
    // No `filename*` for a name that has nothing to encode: the header these routes produced before
    // is the header they produce now, so nothing that reads only the plain parameter changes.
    expect(contentDisposition('Waiver of Conditions.pdf'))
      .toBe('attachment; filename="Waiver of Conditions.pdf"');
    expect(contentDisposition('avatar.png', { inline: true }))
      .toBe('inline; filename="avatar.png"');
  });

  it('carries a non-ASCII name in filename*, and stays ASCII on the wire', () => {
    const header = contentDisposition('契約書.pdf');
    expect(header).toContain("filename*=UTF-8''");
    expect(HEADER_SAFE.test(header)).toBe(true);
    // The real name survives the round trip — this is what the browser and our own client read.
    const encoded = /filename\*=UTF-8''(.+)$/.exec(header)![1];
    expect(decodeURIComponent(encoded)).toBe('契約書.pdf');
    // ...and whoever reads only the plain parameter still gets an openable file.
    expect(header).toContain('filename="download.pdf"');
  });

  it('keeps whatever ASCII the name does have, rather than a row of underscores', () => {
    expect(asciiFilename('契約書 Waiver.pdf')).toBe('Waiver.pdf');
    expect(asciiFilename('Отчёт 2026.xlsx')).toBe('2026.xlsx');
    // Nothing to keep and no extension either: the caller's own fallback, not an empty name.
    expect(asciiFilename('契約書', 'documents')).toBe('documents');
  });

  it('refuses to let a filename inject a header, end the quoted string, or choose a folder', () => {
    // A filename is user input on every one of these routes: it is uploaded, not chosen by us.
    expect(contentDisposition('re"port.xlsx')).toBe('attachment; filename="report.xlsx"');
    expect(contentDisposition('a\r\nX-Evil: 1.pdf')).not.toMatch(/[\r\n]/);
    expect(contentDisposition('../../etc/passwd')).toBe('attachment; filename="passwd"');
    expect(contentDisposition('C:\\Users\\x\\secret.pdf')).toBe('attachment; filename="secret.pdf"');
  });

  it('is accepted by a real res.setHeader — the call that used to throw', async () => {
    const names = ['契約書.pdf', '報告 2026.xlsx', 'Отчёт.pdf', 'emoji 🎉.png', 'plain.pdf'];
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(String(req.url).slice(1));
      // No try/catch: an ERR_INVALID_CHAR here must fail the test, not be swallowed into a 500 the
      // way it reached the user.
      res.setHeader('Content-Disposition', contentDisposition(name));
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      for (const name of names) {
        const received = await new Promise<{ status: number; dispo: string }>((resolve, reject) => {
          http.get({ port, path: '/' + encodeURIComponent(name) }, (r) => {
            r.resume();
            r.on('end', () => resolve({ status: r.statusCode ?? 0, dispo: String(r.headers['content-disposition'] ?? '') }));
          }).on('error', reject);
        });
        expect([name, received.status]).toEqual([name, 200]);
        expect([name, received.dispo]).toEqual([name, contentDisposition(name)]);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
