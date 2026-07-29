import * as path from 'path';
import * as fs from 'fs';

/**
 * Where uploaded files live: documents, FINTRAC identification, the brand logo, user photos,
 * generated exports and the recycle bin.
 *
 * This used to be computed as `path.join(process.cwd(), '..', 'storage', 'app')` in seven
 * separate files, which made the location depend on the directory the process happened to be
 * started from. Run under systemd, pm2 or Docker with a different WorkingDirectory and every one
 * of those paths silently moves: uploads are written somewhere new, and documents already in the
 * database resolve to files that are not there. Nothing reports it — the API answers, the upload
 * succeeds, and the download 404s.
 *
 * `STORAGE_ROOT` makes the location explicit and independent of the working directory. The
 * default is exactly the old expression, so an existing deployment that does set its working
 * directory correctly is unaffected.
 */
function resolveRoot(): string {
  const fromEnv = (process.env.STORAGE_ROOT ?? '').trim();
  // Resolved against cwd if someone gives a relative path, so the value is always absolute.
  if (fromEnv) return path.resolve(fromEnv);
  // Historical default: the Laravel layout, where the API runs in <app>/server and
  // Storage::disk('local') points at <app>/storage/app.
  return path.resolve(process.cwd(), '..', 'storage', 'app');
}

/** Absolute path to the storage root. Resolved once — it cannot change while running. */
export const STORAGE_ROOT: string = resolveRoot();

/** Generated export files, swept on a timer. */
export const EXPORT_ROOT: string = path.join(STORAGE_ROOT, 'exports');

/**
 * Confirm the root is real and writable before the server starts taking uploads.
 *
 * Deliberately does NOT create the directory in production. Creating it is precisely what makes a
 * wrong working directory invisible: a fresh empty tree appears, uploads succeed into it, and
 * every document already recorded in the database is suddenly missing. A missing root is far more
 * likely to mean "pointed at the wrong place" than "first run", so production is told to fix it
 * rather than being given a new empty folder. Development creates it, where that convenience is
 * worth more than the protection.
 */
export function checkStorageRoot(env: string): { ok: true } | { ok: false; problem: string } {
  const isProduction = env === 'production';

  if (!fs.existsSync(STORAGE_ROOT)) {
    if (!isProduction) {
      try {
        fs.mkdirSync(STORAGE_ROOT, { recursive: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, problem: `STORAGE_ROOT "${STORAGE_ROOT}" could not be created: ${(err as Error).message}` };
      }
    }
    return {
      ok: false,
      problem:
        `STORAGE_ROOT "${STORAGE_ROOT}" does not exist. Uploaded documents, the brand logo, user `
        + `photos and exports are read from and written to it, so starting without it would lose `
        + `every existing file. Either point STORAGE_ROOT at the directory that holds them, or set `
        + `the process working directory so that "../storage/app" resolves to it.`,
    };
  }

  if (!fs.statSync(STORAGE_ROOT).isDirectory()) {
    return { ok: false, problem: `STORAGE_ROOT "${STORAGE_ROOT}" is not a directory.` };
  }

  // Permission is the other half: an existing but unwritable directory fails only at the moment
  // someone uploads, which is a far worse place to discover it.
  try {
    fs.accessSync(STORAGE_ROOT, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return { ok: false, problem: `STORAGE_ROOT "${STORAGE_ROOT}" is not readable and writable by this process.` };
  }

  return { ok: true };
}
