export interface ReplyAttachment { filename: string; content_type: string; data: string; size: number }
export const MAX_REPLY_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Reads only the picker cache copy, then deletes that copy. Never uploads or sends. */
export async function pickReplyAttachment(existing: readonly ReplyAttachment[], signal: AbortSignal): Promise<ReplyAttachment | null> {
  if (existing.length >= 5) throw new Error('A maximum of five attachments is allowed.');
  if (signal.aborted) return null;
  const Picker = await import('expo-document-picker');
  const result = await Picker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) throw new Error('No file was selected.');
  const { File, Paths } = await import('expo-file-system');
  const file = new File(asset.uri);
  const cache = `${Paths.cache.uri.replace(/\/$/, '')}/`;
  const path = decodeURIComponent(file.uri);
  if (!file.uri.startsWith(cache) || path.split('/').some(part => part === '..' || part === '.') || /[\\\x00-\x1f]/.test(path) || file.uri.endsWith('/')) {
    throw new Error('The selected file was not copied to private cache.');
  }
  try {
    if (signal.aborted) return null;
    const filename = asset.name.trim();
    if (!filename || filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(filename)) throw new Error('Choose a file with a valid filename.');
    const size = file.size;
    if (!Number.isSafeInteger(size) || size <= 0 || existing.reduce((sum, item) => sum + item.size, 0) + size > MAX_REPLY_ATTACHMENT_BYTES) {
      throw new Error('Choose a nonempty file. Attachments must total no more than 5 MB.');
    }
    const data = await file.base64();
    if (signal.aborted) return null;
    const decodedSize = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || decodedSize !== size) {
      throw new Error('The file changed while reading. Please select it again.');
    }
    const mime = asset.mimeType || 'application/octet-stream';
    return { filename, content_type: /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream', size, data };
  } finally { if (file.exists) file.delete(); }
}
