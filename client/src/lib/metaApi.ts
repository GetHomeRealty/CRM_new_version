import api from './axios';
import type {
  MetaAdAccount, MetaDefaultPageResponse, MetaDiagnostics, MetaForm, MetaLeadsResponse, MetaPage,
  MetaStatus, MetaSyncResult, MetaSyncRun, MetaWebhookHealth,
} from '../types';

/** Meta API. No endpoint here ever returns an access token — those stay on the server. */

export const metaStatus = (): Promise<MetaStatus> =>
  api.get<MetaStatus>('/api/meta/status').then((r) => r.data);

export const metaAuthUrl = (): Promise<string> =>
  api.get<{ auth_url: string }>('/api/meta/auth-url').then((r) => r.data.auth_url);

export const metaPages = (): Promise<MetaPage[]> =>
  api.get<{ pages: MetaPage[] }>('/api/meta/pages').then((r) => r.data.pages);

export const refreshMetaPages = (): Promise<{ pages: number; message: string }> =>
  api.post<{ pages: number; message: string }>('/api/meta/pages/refresh').then((r) => r.data);

export const metaForms = (pageId: string): Promise<{ page_name: string; forms: MetaForm[] }> =>
  api.get<{ page_name: string; forms: MetaForm[] }>('/api/meta/forms', { params: { page_id: pageId } }).then((r) => r.data);

export const toggleMetaForm = (pageId: string, formId: string, formName: string, connect: boolean): Promise<{ connected: boolean; message: string }> =>
  api.post<{ connected: boolean; message: string }>('/api/meta/forms', {
    page_id: pageId, form_id: formId, form_name: formName, connect,
  }).then((r) => r.data);

export const syncMetaLeads = (): Promise<MetaSyncResult> =>
  api.post<MetaSyncResult>('/api/meta/sync').then((r) => r.data);

export const disconnectMeta = (): Promise<void> =>
  api.delete('/api/meta/disconnect').then(() => undefined);

/** Remember which Page this person's Meta screen opens on. An empty id clears the preference. */
export const setMetaDefaultPage = (pageId: string): Promise<MetaDefaultPageResponse> =>
  api.post<MetaDefaultPageResponse>('/api/meta/pages/default', { page_id: pageId }).then((r) => r.data);

/**
 * `pageId` scopes the whole answer — list and tiles — to one Facebook Page, which is what the rest
 * of the Meta screen is already showing. `formId` narrows the LIST further, and never the tiles.
 */
/** `listPage` is which page of the list (1 = the first, the default) — not a Facebook Page. */
export const metaLeads = (limit = 50, formId?: string, pageId?: string, listPage?: number): Promise<MetaLeadsResponse> =>
  api.get<MetaLeadsResponse>('/api/meta/leads', {
    params: { limit, form_id: formId || undefined, page_id: pageId || undefined, list_page: listPage && listPage > 1 ? listPage : undefined },
  }).then((r) => r.data);

export const metaDiagnostics = (): Promise<MetaDiagnostics> =>
  api.get<MetaDiagnostics>('/api/meta/diagnostics').then((r) => r.data);

export const metaSyncHistory = (limit = 20): Promise<MetaSyncRun[]> =>
  api.get<MetaSyncRun[]>('/api/meta/sync-history', { params: { limit } }).then((r) => r.data);

export const metaWebhookHealth = (limit = 20): Promise<MetaWebhookHealth> =>
  api.get<MetaWebhookHealth>('/api/meta/webhook-health', { params: { limit } }).then((r) => r.data);

export const metaAdAccounts = (): Promise<{ accounts: MetaAdAccount[]; note: string }> =>
  api.get<{ accounts: MetaAdAccount[]; note: string }>('/api/meta/ad-accounts').then((r) => r.data);

export const selectMetaAdAccount = (id: string): Promise<{ selected: string | null; message: string }> =>
  api.post<{ selected: string | null; message: string }>('/api/meta/ad-accounts/select', { id }).then((r) => r.data);