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
  /**
   * The brokerage default this row falls back to when the viewer has expressed nothing. Null for
   * the staff notifications, which have no brokerage layer.
   */
  brokerage_default: boolean | null;
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

/**
 * The brokerage-wide controls, moved here from the retired CRM Triggers screen.
 *
 * `can_edit` is the `settings: edit` permission as the SERVER evaluates it, not a role check in the
 * browser — the same permission `PUT /api/crm-communications/brokerage` enforces. Reading it from
 * the payload rather than re-deriving it here is what stops the button and the endpoint drifting.
 */
export interface CrmBrokerageControls {
  auto_send_enabled: boolean;
  /** One default per communication key, inherited by anyone who has not chosen for themselves. */
  defaults: Record<string, boolean>;
  /** The keys this screen may offer, from the server's compiled list. */
  default_keys: string[];
  can_edit: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

export interface CrmCommunicationsOverview {
  brokerage: CrmBrokerageControls;
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

/**
 * Set the brokerage-wide controls. An absent field is left alone by the server, so this sends only
 * what actually changed — the semantics the Triggers screen lacked, where flipping one switch
 * posted the whole `crm_email_settings` row back and reverted anything changed elsewhere.
 */
export const setCrmBrokerage = (body: {
  auto_send_enabled?: boolean;
  defaults?: Record<string, boolean>;
}): Promise<CrmCommunicationsOverview & { message: string }> =>
  api.put<CrmCommunicationsOverview & { message: string }>('/api/crm-communications/brokerage', body).then((r) => r.data);

export const previewCrmTemplate = (id: number): Promise<{ subject: string; html: string }> =>
  api.post<{ subject: string; html: string }>(`/api/crm-communications/templates/${id}/preview`).then((r) => r.data);

export const updateCrmTemplate = (id: number, body: Record<string, unknown>): Promise<unknown> =>
  api.put(`/api/crm-communications/templates/${id}`, body).then((r) => r.data);

export const createCrmTemplate = (body: {
  name: string; subject: string; body_html: string; event_key?: string; mail_account_id?: number | null;
}): Promise<{ id: number; mapped: boolean; notice: string | null }> =>
  api.post<{ id: number; mapped: boolean; notice: string | null }>('/api/crm-communications/templates', body).then((r) => r.data);

/**
 * Remove a CRM template. `was_connected` distinguishes the two very different outcomes: an
 * unconnected draft simply goes, while a connected one resets that email to its built-in default
 * wording — the event keeps sending either way.
 */
export const deleteCrmTemplate = (id: number): Promise<{ deleted: boolean; was_connected: boolean; name: string }> =>
  api.delete<{ deleted: boolean; was_connected: boolean; name: string }>(`/api/crm-communications/templates/${id}`).then((r) => r.data);
