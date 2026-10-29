import api from './axios';

/** WhatsApp agent intake — CRM → Settings → WhatsApp Rotation. */

export interface WhatsAppRotationMember {
  user_id: number;
  name: string;
  role: string | null;
  duration_minutes: number;
  /** Taking turns. A paused member keeps their place but is skipped. */
  is_active: boolean;
  /** The person's account is active. */
  user_active: boolean;
}

export interface WhatsAppTurn {
  user_id: number;
  name: string;
  starts_at: string;
  ends_at: string;
}

export interface WhatsAppIntakeRow {
  id: number;
  lead_id: number;
  lead_name: string;
  from_phone: string;
  body: string;
  is_new_lead: boolean;
  assigned_user_id: number | null;
  assigned_user_name: string | null;
  slot_starts_at: string | null;
  slot_ends_at: string | null;
  received_at: string;
}

export interface WhatsAppRotation {
  enabled: boolean;
  cycle_starts_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
  members: WhatsAppRotationMember[];
  on_duty: WhatsAppTurn | null;
  upcoming: WhatsAppTurn[];
  recent: WhatsAppIntakeRow[];
  webhook: { configured: boolean; path: string; phone_number_filter: boolean };
}

export interface WhatsAppRotationInput {
  enabled: boolean;
  members: { user_id: number; duration_minutes: number; is_active: boolean }[];
  cycle_starts_at?: string | null;
  /** Start member 1's turn now. */
  restart?: boolean;
}

export const getWhatsAppRotation = (): Promise<WhatsAppRotation> =>
  api.get<WhatsAppRotation>('/api/whatsapp/rotation').then((r) => r.data);

export const saveWhatsAppRotation = (body: WhatsAppRotationInput): Promise<WhatsAppRotation> =>
  api.put<WhatsAppRotation>('/api/whatsapp/rotation', body).then((r) => r.data);
