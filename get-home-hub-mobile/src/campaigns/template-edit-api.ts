import { environment } from '@/config/environment';

export const templateCategories = ['welcome', 'follow-up', 'showing', 'property-update', 'thank-you', 'custom'] as const;
export type TemplateMetadataPatch = { name?: string; subject?: string; is_active?: boolean; category?: string };
export class UnconfirmedTemplateSaveError extends Error {}

export async function uploadTemplateAttachment(token: string, templateId: number, input: { filename: string; content_type: string; data: string }, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(templateId) || templateId <= 0) throw new Error('Invalid template.');
  const filename = validatedText(input.filename, 'Filename', 255);
  const content_type = validatedText(input.content_type, 'File type', 128);
  const data = input.data;
  if (typeof data !== 'string' || !data.length || data.length > 6990508 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Invalid or oversized file.');
  const size = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (size > 5 * 1024 * 1024) throw new Error('Attachments must total no more than 5 MB.');
  await saveTemplate(token, `/${templateId}/attachments`, 'POST', { filename, content_type, data }, signal);
}

/** Only removes a file from its owning template; never deletes the template or sends mail. */
export async function removeTemplateAttachment(token: string, templateId: number, attachmentId: number, signal?: AbortSignal): Promise<void> {
  if (![templateId, attachmentId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid attachment.');
  await saveTemplate(token, `/${templateId}/attachments/${attachmentId}`, 'DELETE', undefined, signal);
}

function validatedText(value: string, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} must contain 1–${limit} characters.`);
  return value;
}

/** Creates an inactive custom template; never creates a campaign or sends mail. */
export async function createTemplate(token: string, input: { name: string; subject: string; content: string }, signal?: AbortSignal): Promise<void> {
  const body = {
    name: validatedText(input.name, 'Name', 255).trim(),
    subject: validatedText(input.subject, 'Subject', 500).trim(),
    content: validatedText(input.content, 'Body', 200000),
    category: 'custom', is_active: false,
  };
  await saveTemplate(token, '', 'POST', body, signal);
}

/** Body source is preserved, not reconstructed from the approximate text preview. */
export async function updateTemplateBody(token: string, id: number, content: string, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid template.');
  await saveTemplate(token, `/${id}`, 'PUT', { content: validatedText(content, 'Body', 200000) }, signal);
}

async function saveTemplate(token: string, path: string, method: 'POST' | 'PUT' | 'DELETE', body: object | undefined, signal?: AbortSignal): Promise<void> {
  if (!token) throw new Error('Please sign in again.');
  if (signal?.aborted) throw new Error('Save cancelled before submission.');
  let response: Response;
  try {
    response = await fetch(`${environment.apiUrl}/api/campaigns/templates${path}`, {
      method, signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new UnconfirmedTemplateSaveError('Save could not be confirmed. Refresh the template list before retrying to avoid duplicates.');
  }
  if (!response.ok && ![400, 401, 403, 404].includes(response.status)) throw new UnconfirmedTemplateSaveError('Save could not be confirmed. Refresh the template list before retrying to avoid duplicates.');
  if (!response.ok) throw new Error(response.status === 401 ? 'Please sign in again.'
    : response.status === 403 ? 'You do not have permission to edit templates.'
    : response.status === 404 ? 'This template is no longer available.'
    : response.status === 400 ? 'The template changes were rejected. Check your entries.'
    : 'Save could not be confirmed. Refresh the template list before retrying to avoid duplicates.');
}

/** Metadata-only PUT: never round-trip or overwrite body HTML, category or attachments. */
export async function updateTemplateMetadata(token: string, id: number, patch: TemplateMetadataPatch, signal?: AbortSignal): Promise<void> {
  if (!token) throw new Error('Please sign in again.');
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid template.');
  if (signal?.aborted) throw new Error('Save cancelled before submission.');
  const body: TemplateMetadataPatch = {};
  for (const key of Object.keys(patch)) {
    if (key === 'name' || key === 'subject') {
      const value = patch[key];
      const limit = key === 'name' ? 255 : 500;
      if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new Error(`${key === 'name' ? 'Name' : 'Subject'} must contain 1–${limit} characters.`);
      body[key] = value.trim();
    } else if (key === 'category') {
      if (!templateCategories.some(category => category === patch.category)) throw new Error('Invalid template category.');
      body.category = patch.category;
    } else if (key === 'is_active') {
      if (typeof patch.is_active !== 'boolean') throw new Error('Invalid active status.');
      body.is_active = patch.is_active;
    } else throw new Error('Unsupported template field.');
  }
  if (!Object.keys(body).length) throw new Error('No template changes to save.');
  let response: Response;
  try {
    response = await fetch(`${environment.apiUrl}/api/campaigns/templates/${id}`, {
      method: 'PUT', signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Save could not be confirmed. Refresh the template before retrying.');
  }
  if (!response.ok) throw new Error(response.status === 401 ? 'Please sign in again.'
    : response.status === 403 ? 'You do not have permission to edit this template.'
    : response.status === 404 ? 'This template is no longer available.'
    : response.status === 400 ? 'The template changes were rejected. Check your entries.'
    : 'Save could not be confirmed. Refresh the template before retrying.');
}
