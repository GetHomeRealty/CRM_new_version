import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import * as Sharing from 'expo-sharing';
import { archiveRequest, attachmentPath } from './mail-archive-api';
import type { InboxArea } from './inbox-api';

export async function shareArchivedAttachment(token: string, area: InboxArea, kind: 'sent' | 'inbound', id: string | number, index: number, signal: AbortSignal) {
  if (!await Sharing.isAvailableAsync()) throw new Error('File sharing is unavailable on this device.');
  const file = await archiveRequest<{ filename: string; size: number; data: string }>(token, area, attachmentPath(kind, id, index), signal);
  if (!file || !/^attachment-\d+\.(pdf|png|jpg|bin)$/.test(file.filename) || !Number.isInteger(file.size) || file.size < 1 || file.size > 5 * 1024 * 1024 || typeof file.data !== 'string' || file.data.length > 6990508) throw new Error('Invalid attachment response.');
  const binary = atob(file.data);
  if (binary.length !== file.size || btoa(binary) !== file.data) throw new Error('Attachment content could not be verified.');
  if (signal.aborted) return;
  const directory = new Directory(Paths.cache, `hub-mail-${Crypto.randomUUID()}`);
  try {
    directory.create();
    const output = new File(directory, file.filename);
    output.write(Uint8Array.from(binary, character => character.charCodeAt(0)));
    if (!signal.aborted) await Sharing.shareAsync(output.uri, { dialogTitle: 'Open or save email attachment' });
  } finally { if (directory.exists) directory.delete(); }
}
