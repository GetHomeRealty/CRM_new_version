import api from './axios';

/**
 * CRM → Settings → Communications.
 *
 * One request draws the whole screen. The shape comes from the server's communication registry, so
 * a communication added there appears here without this file or the screen being edited — which is
 * the point of having a registry rather than a list per layer.
 */

export type CrmChannel = 'email' | 'in_app' | 'push';

export interface CrmCommunicationTemplate {
  id: number;
  event_key: string;
  name: string;
  subject: string;
  is_active: boolean;
  mail_account_id: number | null;
  variables: string[];
  /** Whether THIS viewer may edit it. Decided by the server; the screen only reflects it. */
  can_edit: boolean;
}

export interface CrmCommunicationRow {
  key: string;
  name: string;
  description: string;
  kind: 'automated' | 'manual';
  audience: 'lead' | 'staff';
  /** Which channels this communication has at all. A false channel is not offered, not "off". */
  channels: Record<CrmChannel, boolean>;
  /** This viewer's own answers, for the channels they have. */
  preferences: Partial<Record<CrmChannel, boolean>>;
  template: CrmCommunicationTemplate | null;
}

export interface UnmappedTemplate {
  id: number;
  event_key: string;
  name: string;
  subject: string;
  is_active: boolean;
  can_edit: boolean;
}

export interface CrmCommunicationsOverview {
  brokerage: { auto_send_enabled: boolean; can_edit: boolean };
  is_admin: boolean;
  communications: CrmCommunicationRow[];
  unmapped_templates: UnmappedTemplate[];
  /** CRM events with no template yet — the only keys a new template may be mapped to. */
  mappable_events: { key: string; name: string }[];
}

export const getCrmCommunications = (): Promise<CrmCommunicationsOverview> =>
  api.get<CrmCommunicationsOverview>('/api/crm-communications').then((r) => r.data);

/** Always sets the CALLER's own preference — the endpoint has no way to name anyone else. */
export const setCrmPreference = (key: string, channel: CrmChannel, enabled: boolean): Promise<unknown> =>
  api.put(`/api/crm-communications/preferences/${key}/${channel}`, { enabled }).then((r) => r.data);

export const previewCrmTemplate = (id: number): Promise<{ subject: string; html: string }> =>
  api.post<{ subject: string; html: string }>(`/api/crm-communications/templates/${id}/preview`).then((r) => r.data);

export const updateCrmTemplate = (id: number, body: Record<string, unknown>): Promise<unknown> =>
  api.put(`/api/crm-communications/templates/${id}`, body).then((r) => r.data);

export const createCrmTemplate = (body: {
  name: string; subject: string; body_html: string; event_key?: string; mail_account_id?: number | null;
}): Promise<{ id: number; mapped: boolean; notice: string | null }> =>
  api.post<{ id: number; mapped: boolean; notice: string | null }>('/api/crm-communications/templates', body).then((r) => r.data);
