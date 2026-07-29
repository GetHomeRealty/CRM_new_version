import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * The one thing that must not change is where files already live.
 *
 * Seven modules each computed `path.join(process.cwd(), '..', 'storage', 'app')`. Centralising
 * that is only safe if the default resolves to the identical directory — a different one would
 * not error, it would quietly write new uploads somewhere else while every document already in
 * the database resolved to a file that is not there.
 *
 * `STORAGE_ROOT` is read at import time, so each case re-imports the module with a fresh registry.
 */
const load = (env: Record<string, string | undefined>) => {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let mod: typeof import('./storage');
  jest.isolateModules(() => { mod = require('./storage') as typeof import('./storage'); });
  process.env = saved;
  return mod!;
};

describe('storage root', () => {
  it('defaults to exactly the path the seven modules each computed before', () => {
    const { STORAGE_ROOT } = load({ STORAGE_ROOT: undefined });
    const historical = path.join(process.cwd(), '..', 'storage', 'app');
    expect(STORAGE_ROOT).toBe(path.resolve(historical));
  });

  it('still points at the real directory holding this deployment\'s files', () => {
    // Guards the migration itself: if this fails, the default has drifted off the live data.
    const { STORAGE_ROOT } = load({ STORAGE_ROOT: undefined });
    expect(fs.existsSync(STORAGE_ROOT)).toBe(true);
    expect(fs.existsSync(path.join(STORAGE_ROOT, 'documents'))).toBe(true);
  });

  it('is overridden by STORAGE_ROOT, so it no longer depends on the working directory', () => {
    const target = path.join(os.tmpdir(), 'td-storage-probe');
    const { STORAGE_ROOT } = load({ STORAGE_ROOT: target });
    expect(STORAGE_ROOT).toBe(path.resolve(target));
  });

  it('resolves a relative override to an absolute path', () => {
    const { STORAGE_ROOT } = load({ STORAGE_ROOT: './some/where' });
    expect(path.isAbsolute(STORAGE_ROOT)).toBe(true);
  });

  it('ignores a blank override rather than treating it as the filesystem root', () => {
    const { STORAGE_ROOT } = load({ STORAGE_ROOT: '   ' });
    expect(STORAGE_ROOT).toBe(path.resolve(path.join(process.cwd(), '..', 'storage', 'app')));
  });

  it('puts exports under the root, wherever that is', () => {
    const target = path.join(os.tmpdir(), 'td-storage-probe');
    const { STORAGE_ROOT, EXPORT_ROOT } = load({ STORAGE_ROOT: target });
    expect(EXPORT_ROOT).toBe(path.join(STORAGE_ROOT, 'exports'));
  });

  describe('boot check', () => {
    it('accepts an existing writable directory', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-ok-'));
      const { checkStorageRoot } = load({ STORAGE_ROOT: dir });
      expect(checkStorageRoot('production')).toEqual({ ok: true });
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('refuses to start in production when the root is missing', () => {
      // Auto-creating here is what would make a wrong working directory invisible: a fresh empty
      // tree appears, uploads succeed into it, and every existing document is suddenly missing.
      const missing = path.join(os.tmpdir(), `td-missing-${Date.now()}`);
      const { checkStorageRoot } = load({ STORAGE_ROOT: missing });
      const result = checkStorageRoot('production');
      expect(result.ok).toBe(false);
      expect(fs.existsSync(missing)).toBe(false); // and it did NOT create it
      if (!result.ok) expect(result.problem).toContain('does not exist');
    });

    it('creates the root in development, where convenience outweighs the protection', () => {
      const missing = path.join(os.tmpdir(), `td-dev-${Date.now()}`);
      const { checkStorageRoot } = load({ STORAGE_ROOT: missing });
      expect(checkStorageRoot('development')).toEqual({ ok: true });
      expect(fs.existsSync(missing)).toBe(true);
      fs.rmSync(missing, { recursive: true, force: true });
    });

    it('rejects a path that exists but is a file', () => {
      const file = path.join(os.tmpdir(), `td-file-${Date.now()}`);
      fs.writeFileSync(file, 'x');
      const { checkStorageRoot } = load({ STORAGE_ROOT: file });
      const result = checkStorageRoot('production');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toContain('not a directory');
      fs.rmSync(file, { force: true });
    });
  });
});
