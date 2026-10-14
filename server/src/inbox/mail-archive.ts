export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
export type ArchivedFile = { name: string; mime: string; size: number; data?: string; unavailable?: string };
export function archiveFiles(files: { filename?: string; contentType?: string; content: Buffer }[]) {
  let total = 0;
  return { total: files.length, files: files.slice(0, 20).map((file): ArchivedFile => {
    const name = (file.filename || 'attachment').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180);
    const size = file.content.length;
    if (!size || size > MAX_ARCHIVE_BYTES || total + size > MAX_ARCHIVE_BYTES) return { name, mime: 'application/octet-stream', size, unavailable: 'Not stored: exceeds the 5 MB message attachment limit or is empty.' };
    total += size;
    // Store bytes, but never interpret sender-supplied HTML/SVG/JavaScript as active content.
    return { name, mime: 'application/octet-stream', size, data: file.content.toString('base64') };
  }) };
}
export function archiveMetadata(value: unknown) {
  const archive = value as { total: number; files: ArchivedFile[] } | null;
  if (!archive || !Array.isArray(archive.files)) return { available: false, total: 0, files: [] };
  return { available: true, total: archive.total, files: archive.files.map((file, index) => ({ id: index, name: file.name, size: file.size, available: typeof file.data === 'string', reason: file.unavailable ?? null })) };
}
