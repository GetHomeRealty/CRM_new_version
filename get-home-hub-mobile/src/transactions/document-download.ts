import { Directory, DownloadTask, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { environment } from '@/config/environment';
import type { DocumentAttachment } from './document-files';

const MAX_BYTES = 25 * 1024 * 1024;

/** Returns a private temporary file. The caller must invoke dispose when finished. */
export async function downloadDocument(token: string, attachment: DocumentAttachment, signal?: AbortSignal) {
  if (!/^\/api\/documents\/[1-9]\d*\/(?:file|validation-file|files\/(?:0|[1-9]\d*))$/.test(attachment.path)) {
    throw new Error('Invalid document download route.');
  }
  return downloadPrivateFile(token, attachment, signal);
}

export async function downloadTemplateAttachment(token: string, templateId: number, attachmentId: number, filename: string, signal?: AbortSignal) {
  if (![templateId, attachmentId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid attachment.');
  return downloadPrivateFile(token, { path: `/api/campaigns/templates/${templateId}/attachments/${attachmentId}`, label: filename }, signal);
}

export async function downloadForm630(token:string,txn:number,client:number,version:string,signal?:AbortSignal) {
 if(![txn,client].every(id=>Number.isSafeInteger(id)&&id>0)||!/^[a-f0-9]{64}$/.test(version))throw new Error('Reload the client form before exporting.');
 const downloaded=await downloadPrivateFile(token,{path:`/api/transactions/${txn}/clients/${client}/form630/pdf?version=${version}`,label:'OREA-Form-630.pdf'},signal);
 try{const bytes=await new File(downloaded.uri).bytes();if(bytes.length<5||String.fromCharCode(...bytes.slice(0,5))!=='%PDF-')throw new Error('Could not export Form 630. Reload and check the saved values.');return downloaded;}catch(error){downloaded.dispose();throw error;}
}

export async function downloadInvoicePdf(token:string,id:number,version:string,signal?:AbortSignal){if(!Number.isSafeInteger(id)||id<=0||!/^[a-f0-9]{64}$/.test(version))throw new Error('Reload the invoice before exporting.');const file=await downloadPrivateFile(token,{path:`/api/mobile-invoices/${id}/pdf?version=${version}`,label:'Invoice.pdf'},signal);try{const bytes=await new File(file.uri).bytes();if(bytes.length<5||String.fromCharCode(...bytes.slice(0,5))!=='%PDF-')throw new Error('Invalid invoice PDF. Reload before exporting.');return file;}catch(error){file.dispose();throw error;}}

async function downloadPrivateFile(token: string, attachment: { path: string; label: string }, signal?: AbortSignal) {
  if (!token) throw new Error('Sign in to download documents.');
  if (signal?.aborted) throw new Error('Download cancelled.');
  const directory = new Directory(Paths.cache, `hub-document-${Crypto.randomUUID()}`);
  let exceeded = false;
  let task: DownloadTask | undefined;
  const dispose = () => { if (directory.exists) directory.delete(); };
  try {
    directory.create();
    // Never use an untrusted server filename as a filesystem path.
    const suffix = /\.([a-z0-9]{1,8})$/i.exec(attachment.label)?.[1]?.toLowerCase();
    const file = new File(directory, `attachment${suffix ? `.${suffix}` : ''}`);
    task = new DownloadTask(`${environment.apiUrl}${attachment.path}`, file, {
      headers: { Authorization: `Bearer ${token}` }, signal, sessionType: 'foreground',
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (bytesWritten > MAX_BYTES || totalBytes > MAX_BYTES) { exceeded = true; task?.cancel(); }
      },
    });
    const result = await task.downloadAsync();
    exceeded = exceeded || (result?.size ?? 0) > MAX_BYTES;
    if (exceeded) throw new Error('Document exceeds the 25 MB mobile download limit.');
    if (!result || signal?.aborted) throw new Error('Download cancelled.');
    return { uri: result.uri, dispose };
  } catch {
    dispose();
    throw new Error(exceeded ? 'Document exceeds the 25 MB mobile download limit.' : signal?.aborted ? 'Download cancelled.' : 'Could not download the document. Please retry.');
  } finally {
    task?.release();
  }
}
