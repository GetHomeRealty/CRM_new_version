import type { MobileDocument } from './transactions-api';

export interface DocumentAttachment { key: string; label: string; path: string }
/** Paths stay relative; the download transport must attach authentication in headers, never URLs. */
export function documentAttachments(document: MobileDocument): DocumentAttachment[] {
  if (!Number.isSafeInteger(document.id) || document.id < 1) throw new Error('Invalid document identifier.');
  const base = `/api/documents/${document.id}`;
  const result: DocumentAttachment[] = [];
  if (document.has_file) result.push({ key: 'primary', label: document.file_name || 'Primary attachment', path: `${base}/file` });
  for (const file of document.files ?? []) {
    if (!Number.isSafeInteger(file.index) || file.index < 0) throw new Error('Invalid document attachment index.');
    const key = `file-${file.index}`;
    if (result.some((item) => item.key === key)) continue;
    result.push({ key, label: [file.client_name, file.file_name || `Attachment ${file.index + 1}`].filter(Boolean).join(' · '), path: `${base}/files/${file.index}` });
  }
  if (document.has_validation_file) result.push({ key: 'validation', label: `Validation · ${document.validation_file_name || 'Attachment'}`, path: `${base}/validation-file` });
  return result;
}
