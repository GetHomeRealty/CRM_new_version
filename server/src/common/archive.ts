import * as archiverNs from 'archiver';

/**
 * Create a ZIP archiver.
 *
 * archiver v8 is ESM-only and dropped the callable module export that v5/v6 had. It now
 * exports classes, and the ZIP wiring lives in `ZipArchive` — the bare `Archiver` base class
 * has no format module, so constructing it directly fails later with
 * "this._module.append is not a function". `@types/archiver` still describes the old callable
 * namespace, so all of this type-checks cleanly while breaking at runtime; every caller must
 * go through this helper rather than importing archiver directly.
 */
export function createZip(options: Record<string, unknown> = {}): archiverNs.Archiver {
  const mod = archiverNs as unknown as {
    ZipArchive?: new (options?: Record<string, unknown>) => archiverNs.Archiver;
    default?: (format: string, options?: Record<string, unknown>) => archiverNs.Archiver;
  };
  // v8: the ZipArchive class registers the zip module in its constructor
  if (typeof mod.ZipArchive === 'function') return new mod.ZipArchive(options);
  // v5/v6 under esModuleInterop: the factory hangs off .default
  if (typeof mod.default === 'function') return mod.default('zip', options);
  // v5/v6 plain CommonJS: the module itself is the factory
  if (typeof archiverNs === 'function') {
    return (archiverNs as unknown as (f: string, o?: Record<string, unknown>) => archiverNs.Archiver)('zip', options);
  }
  throw new Error('archiver: no usable export found (checked ZipArchive, default and the module itself).');
}
