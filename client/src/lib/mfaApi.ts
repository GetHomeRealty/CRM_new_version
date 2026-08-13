import api from './axios';
import type { AuthUser } from '../types';

/**
 * Two-factor authentication, from the browser's side.
 *
 * Two groups of call, and the split matters. The `challenge*` functions run BEFORE there is a
 * session — the server holds a half-finished sign-in and nothing else — so they carry no user
 * identity and receive none back until the factor is answered. Everything else runs behind a normal
 * authenticated session.
 */

export type MfaType = 'totp' | 'email' | 'sms';
export type OtpChannel = 'email' | 'sms';

export interface MfaMethod {
  type: MfaType;
  destination: string | null;
  confirmed: boolean;
  last_used_at: string | null;
  created_at: string;
}

export interface TrustedDevice {
  id: number;
  label: string | null;
  ip: string | null;
  last_seen_at: string | null;
  expires_at: string;
  created_at: string;
}

export type MfaObligation =
  | { state: 'none' }
  | { state: 'grace'; days_left: number }
  | { state: 'overdue' };

export interface MfaStatus {
  enabled: boolean;
  methods: MfaMethod[];
  recovery_codes_remaining: number;
  trusted_devices: TrustedDevice[];
  available_channels: OtpChannel[];
  /** False when the server has no APP_KEY, which is why the authenticator option is refused. */
  storage_available: boolean;
  obligation: MfaObligation;
}

export interface MfaChallenge {
  methods: Array<{ type: MfaType; destination: string | null }>;
  preferred: MfaType;
  recovery_available: boolean;
}

/** What `POST /api/login` answers with — a challenge, or a signed-in user. */
export type LoginOutcome =
  | { mfa_required: true; challenge: MfaChallenge }
  | { user: AuthUser; mfa: MfaObligation };

export const isChallenge = (o: LoginOutcome): o is { mfa_required: true; challenge: MfaChallenge } =>
  (o as { mfa_required?: boolean }).mfa_required === true;

// ------------------------------------------------------------------ during sign-in

export const answerChallenge = async (
  method: MfaType | 'recovery',
  code: string,
  trustDevice: boolean,
): Promise<{ user: AuthUser; mfa: MfaObligation }> =>
  (await api.post('/api/login/mfa', { method, code, trust_device: trustDevice })).data;

export const sendChallengeCode = async (channel: OtpChannel): Promise<void> => {
  await api.post('/api/login/mfa/send', { channel });
};

// ------------------------------------------------------------------ managing it

export const getMfaStatus = async (): Promise<MfaStatus> => (await api.get('/api/mfa')).data;

export const beginTotp = async (): Promise<{ secret: string; secret_display: string; uri: string }> =>
  (await api.post('/api/mfa/totp/begin')).data;

export const beginOtp = async (channel: OtpChannel, destination: string): Promise<{ masked: string }> =>
  (await api.post('/api/mfa/otp/begin', { channel, destination })).data;

export const confirmEnrolment = async (type: MfaType, code: string): Promise<{ recovery_codes: string[] }> =>
  (await api.post('/api/mfa/confirm', { type, code })).data;

export const removeMethod = async (type: MfaType, password: string): Promise<void> => {
  await api.post('/api/mfa/remove', { type, password });
};

export const regenerateRecoveryCodes = async (password: string): Promise<{ recovery_codes: string[] }> =>
  (await api.post('/api/mfa/recovery-codes', { password })).data;

export const revokeDevice = async (id: number): Promise<void> => {
  await api.delete(`/api/mfa/devices/${id}`);
};

export const revokeAllDevices = async (): Promise<{ revoked: number }> =>
  (await api.post('/api/mfa/devices/revoke-all')).data;

// ------------------------------------------------------------------ administration

export interface MfaPolicy { role: string; required: boolean; grace_days: number }

export const getMfaPolicies = async (): Promise<MfaPolicy[]> =>
  (await api.get('/api/mfa/admin/policies')).data.policies;

export const setMfaPolicy = async (role: string, required: boolean, graceDays: number): Promise<MfaPolicy> =>
  (await api.post('/api/mfa/admin/policies', { role, required, grace_days: graceDays })).data;

export const resetMfaFor = async (userId: number): Promise<void> => {
  await api.post(`/api/mfa/admin/reset/${userId}`);
};
