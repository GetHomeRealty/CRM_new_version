import { environment } from '@/config/environment';
import { pickReplyAttachment, type ReplyAttachment } from '@/inbox/reply-attachments';
export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
export interface LeadMessage { id: number; direction: 'inbound' | 'outbound'; body: string; status: string | null; sent_at: string; phone: string | null; error_message?: string | null }
export interface CallRecording { id: number; filename: string; content_type: string; size: number }
const AUDIO = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/ogg', 'audio/flac'];
const id = (v: number) => { if (!Number.isSafeInteger(v) || v < 1) throw new Error('Invalid communication reference.'); return v; };
const headers = (token: string) => { if (!token) throw new Error('Sign in to view lead communications.'); return { Authorization: `Bearer ${token}`, Accept: 'application/json' }; };
function recording(v: unknown): CallRecording {
  const r = v as CallRecording;
  if (!r || !Number.isSafeInteger(r.id) || r.id < 1 || typeof r.filename !== 'string' || !r.filename || r.filename.length > 255 || /[\/\x00-\x1f]/.test(r.filename) || !AUDIO.includes(r.content_type) || !Number.isSafeInteger(r.size) || r.size < 1 || r.size > 8 * 1024 * 1024) throw new Error('Invalid call recording.');
  return { id: r.id, filename: r.filename, content_type: r.content_type, size: r.size };
}
async function request(token: string, leadId: number, path: string, method: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  if (signal.aborted) throw new Error('Communication request cancelled.');
  const response = await fetch(`${environment.apiUrl}/api/leads/${id(leadId)}/${path}`, { method, signal, headers: { ...headers(token), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 403 ? 'You cannot change these lead communications.' : 'The change could not be confirmed. Refresh the lead before making another change.');
  return response.json();
}
export async function logLeadMessage(token: string, leadId: number, draft: { body: string; direction: 'inbound' | 'outbound'; status: string; sent_at: string }, signal: AbortSignal): Promise<void> {
  if (!draft.body.trim() || draft.body.length > 2000 || !['inbound', 'outbound'].includes(draft.direction) || !MESSAGE_STATUSES.includes(draft.status as typeof MESSAGE_STATUSES[number]) || !/(Z|[+-]\d{2}:\d{2})$/.test(draft.sent_at) || !Number.isFinite(Date.parse(draft.sent_at))) throw new Error('Enter message text and a valid timestamp including timezone.');
  // Record a past exchange only. Never ask Twilio or the device to deliver a message.
  const value = await request(token, leadId, 'messages', 'POST', signal, { body: draft.body.trim(), direction: draft.direction, status: draft.status, sent_at: draft.sent_at, send: false }) as LeadMessage;
  if (!value || !Number.isSafeInteger(value.id) || value.id < 1 || value.direction !== draft.direction || value.body !== draft.body.trim()) throw new Error('SMS record could not be confirmed. Refresh the lead.');
}
export async function changeLeadMessage(token: string, leadId: number, messageId: number, status: string | null, signal: AbortSignal): Promise<void> {
  if (status !== null && !MESSAGE_STATUSES.includes(status as typeof MESSAGE_STATUSES[number])) throw new Error('Choose a valid SMS status.');
  const value = await request(token, leadId, 'messages/' + id(messageId), status === null ? 'DELETE' : 'PUT', signal, status === null ? undefined : { status }) as { deleted?: boolean; id?: number; status?: string };
  if (status === null ? value.deleted !== true : value.id !== messageId || value.status !== status) throw new Error('SMS change could not be confirmed. Refresh the lead.');
}
export function normalizePickedRecording(file: ReplyAttachment): ReplyAttachment {
  const mime = file.content_type.toLowerCase();
  if (AUDIO.includes(mime)) return { ...file, content_type: mime };
  // Apple Files may omit MIME or report its WAV alias for a shared WAV.
  if (mime === 'application/octet-stream' || mime === 'audio/vnd.wave') {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let header = '';
    for (let i = 0; i < 16; i += 4) {
      const group = file.data.slice(i, i + 4);
      if (group.length !== 4 || [...group].some(c => !alphabet.includes(c))) break;
      const n = [...group].reduce((bits, c) => bits * 64 + alphabet.indexOf(c), 0);
      header += String.fromCharCode((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }
    if (/\.wav$/i.test(file.filename) && header.slice(0, 4) === 'RIFF' && header.slice(8, 12) === 'WAVE') return { ...file, content_type: 'audio/wav' };
  }
  throw new Error('Choose an MP3, M4A, AAC, WAV, OGG, WebM or FLAC audio file.');
}
export async function pickCallRecording(signal: AbortSignal): Promise<ReplyAttachment | null> { const file = await pickReplyAttachment([], signal); return file ? normalizePickedRecording(file) : null; }

export async function uploadCallRecording(token: string, leadId: number, callId: number, file: ReplyAttachment, signal: AbortSignal): Promise<CallRecording> {
  if (!AUDIO.includes(file.content_type) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 5 * 1024 * 1024 || !file.filename || file.filename.length > 255 || /[\/\x00-\x1f]/.test(file.filename)) throw new Error('Choose an audio file up to 5 MB.');
  const decoded = file.data.length / 4 * 3 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data) || decoded !== file.size) throw new Error('The recording changed. Select it again.');
  return recording(await request(token, leadId, 'calls/' + id(callId) + '/recording', 'POST', signal, { filename: file.filename, content_type: file.content_type, data: file.data }));
}
export async function removeCallRecording(token: string, leadId: number, callId: number, signal: AbortSignal): Promise<void> { const value = await request(token, leadId, 'calls/' + id(callId) + '/recording', 'DELETE', signal) as { deleted?: boolean }; if (value.deleted !== true) throw new Error('Recording removal could not be confirmed. Refresh the lead.'); }
export async function shareCallRecording(token: string, leadId: number, callId: number, metadata: CallRecording, signal: AbortSignal, stillAllowed: () => boolean): Promise<void> {
  const rec = recording(metadata), url = `${environment.apiUrl}/api/leads/${id(leadId)}/calls/${id(callId)}/recording`;
  if (!stillAllowed() || signal.aborted) throw new Error('Recording access changed.');
  const response = await fetch(url, { signal, redirect: 'error', headers: headers(token) });
  if (!response.ok || !AUDIO.includes((response.headers.get('content-type') || '').split(';')[0]) || Number(response.headers.get('content-length')) !== rec.size || response.url && response.url !== url) throw new Error('Recording download could not be verified. Refresh the lead.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== rec.size || signal.aborted || !stillAllowed()) throw new Error('Recording download changed or access was revoked.');
  const { File, Directory, Paths } = await import('expo-file-system'), Sharing = await import('expo-sharing');
  if (!await Sharing.isAvailableAsync() || !stillAllowed() || signal.aborted) throw new Error('Recording sharing is unavailable.');
  const directory = new Directory(Paths.cache, 'lead-recordings'); directory.create({ intermediates: true, idempotent: true });
  const ext = rec.content_type.includes('mp4') || rec.content_type.includes('m4a') ? 'm4a' : rec.content_type.split('/')[1].replace('x-', '').replace('mpeg', 'mp3').replace('wave', 'wav');
  const file = new File(directory, `call-${callId}-${Date.now()}.${ext}`);
  try { file.write(bytes); if (!stillAllowed() || signal.aborted) throw new Error('Recording access changed.'); await Sharing.shareAsync(file.uri, { mimeType: rec.content_type, dialogTitle: rec.filename }); }
  finally { if (file.exists) file.delete(); }
}
