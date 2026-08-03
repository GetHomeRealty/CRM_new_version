import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Where a call recording's bytes live.
 *
 * WHY THEY MOVED OUT OF THE DATABASE. Recordings were `bytea` columns, up to 8 MB each, one per
 * call. Postgres stores them perfectly well — that was never the problem. The problem is everything
 * that touches the database afterwards: `pg_dump` reads every byte, so a nightly backup grows with
 * call volume rather than with business data; a restore has to write them all back before the
 * application can start; replication ships them again; and the working set that Postgres would like
 * to keep in memory is competing with audio nobody is querying. A year of a busy brokerage's calls
 * is tens of gigabytes of backup that exists to hold data no query ever filters on.
 *
 * NOTHING IS MIGRATED AUTOMATICALLY. Rows written before this keep their `data` column and are
 * served from it, so the change is invisible to anyone using the application and cannot lose a
 * recording it fails to copy. `scripts/migrate-recordings.cjs` moves them across deliberately, when
 * somebody is watching.
 *
 * DEPLOYMENT REQUIREMENT, stated plainly because getting it wrong loses data: the directory must be
 * on persistent storage. In a container without a mounted volume it is the container's own
 * filesystem, and every recording disappears on the next restart. If the directory cannot be
 * written at startup the service says so and falls back to the database, which is slower and older
 * but never silently loses anything.
 *
 *   RECORDING_STORAGE_DIR   absolute or relative path. Default: ./storage/recordings
 *   RECORDING_STORAGE       'disk' (default) or 'database' to opt out entirely
 */
@Injectable()
export class RecordingStorageService {
  private readonly log = new Logger(RecordingStorageService.name);
  private ready: Promise<boolean> | null = null;

  /** Absolute path of the storage root. */
  readonly root = path.resolve(process.env.RECORDING_STORAGE_DIR ?? path.join(process.cwd(), 'storage', 'recordings'));

  /** Whether disk storage is even wanted. Set RECORDING_STORAGE=database to keep the old behaviour. */
  private get wanted(): boolean {
    return (process.env.RECORDING_STORAGE ?? 'disk').toLowerCase() !== 'database';
  }

  /**
   * Confirm the directory exists and is writable, once per process.
   *
   * Checked by actually writing a file rather than by `fs.access`: a read-only mount, a full disk
   * and a directory owned by another user all pass an access check and fail the write, and the
   * write is what matters. Cached, so this costs one probe per boot rather than one per upload.
   */
  private async usable(): Promise<boolean> {
    if (!this.wanted) return false;
    this.ready ??= (async () => {
      try {
        await fs.mkdir(this.root, { recursive: true });
        const probe = path.join(this.root, `.write-probe-${randomBytes(6).toString('hex')}`);
        await fs.writeFile(probe, 'ok');
        await fs.unlink(probe);
        this.log.log(`Call recordings are stored on disk at ${this.root}. This directory MUST be on persistent storage.`);
        return true;
      } catch (err) {
        this.log.error(
          `Call recordings will be stored in the database: ${this.root} is not writable `
          + `(${err instanceof Error ? err.message : String(err)}). Set RECORDING_STORAGE_DIR to a writable, persistent path.`,
        );
        return false;
      }
    })();
    return this.ready;
  }

  /**
   * Write the bytes and return the path to record, or null when they should stay in the database.
   *
   * The path is relative and dated (`2026/08/<random>.<ext>`), so a directory listing stays a
   * manageable size and an operator can find or archive a month at a time. The filename is random
   * rather than derived from the lead or the caller: the directory may end up on a shared volume,
   * and a filename is not the place to publish who a brokerage has been talking to.
   */
  async write(bytes: Uint8Array, contentType: string): Promise<string | null> {
    if (!(await this.usable())) return null;
    const now = new Date();
    const dir = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
    const rel = path.join(dir, `${randomBytes(16).toString('hex')}${extensionFor(contentType)}`);
    const abs = path.join(this.root, rel);

    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
      return rel.split(path.sep).join('/');   // stored POSIX-style, so it reads the same on any host
    } catch (err) {
      // A failed write must not fail the upload — the caller falls back to the database column,
      // which is exactly the state every existing recording is already in.
      this.log.error(`Could not write a recording to ${abs}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Read the bytes for a stored path.
   *
   * `resolve` then a prefix check, because the path comes from a database column and a column is
   * not a promise. A stored `../../etc/passwd` would otherwise be read and served; this refuses
   * anything that does not land inside the root, whatever route it took to get there.
   */
  async read(relative: string): Promise<Uint8Array | null> {
    const abs = path.resolve(this.root, relative);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      this.log.error(`Refusing to read a recording outside the storage root: ${relative}`);
      return null;
    }
    try {
      return new Uint8Array(await fs.readFile(abs));
    } catch (err) {
      this.log.error(`Recording missing from disk (${relative}): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Best-effort removal. A file left behind is clutter; a failed delete must not fail the request. */
  async remove(relative: string): Promise<void> {
    const abs = path.resolve(this.root, relative);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) return;
    await fs.unlink(abs).catch(() => undefined);
  }

  /** Total bytes on disk, for the health endpoint. Walks the tree; called rarely. */
  async usage(): Promise<{ files: number; bytes: number }> {
    if (!(await this.usable())) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const stat = await fs.stat(full).catch(() => null);
          if (stat) { files++; bytes += stat.size; }
        }
      }
    };
    await walk(this.root);
    return { files, bytes };
  }

  /** A short, stable checksum, so a migration can prove the copy matches the original. */
  static checksum(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  }
}

/** File extension for a stored content type. Only affects readability on disk, never what is served. */
function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
    'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
    'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/flac': '.flac',
  };
  return map[contentType.toLowerCase()] ?? '.audio';
}
