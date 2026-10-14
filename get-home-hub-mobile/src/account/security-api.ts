import { environment } from '@/config/environment';

export interface SecurityStatus {
  enabled: boolean;
  methods: ('totp' | 'email' | 'sms')[];
  recoveryCodesRemaining: number;
  trustedDeviceCount: number;
  obligation: 'none' | 'grace' | 'overdue';
}
/** Read only: never retain destinations, recovery codes, device addresses or enrolment secrets. */
export function securitySummary(value: unknown): SecurityStatus {
  const data = value as { enabled?: unknown; methods?: unknown; recovery_codes_remaining?: unknown; trusted_devices?: unknown; obligation?: { state?: unknown } } | null;
  if (!data || typeof data.enabled !== 'boolean' || !Array.isArray(data.methods) || !Array.isArray(data.trusted_devices)
    || !Number.isSafeInteger(data.recovery_codes_remaining) || (data.recovery_codes_remaining as number) < 0
    || !['none', 'grace', 'overdue'].includes(String(data.obligation?.state))) throw new Error('Security status could not be verified.');
  const methods: SecurityStatus['methods'] = [];
  for (const method of data.methods) {
    if (!method || !['totp', 'email', 'sms'].includes(method.type) || typeof method.confirmed !== 'boolean') throw new Error('Security methods could not be verified.');
    if (method.confirmed && !methods.includes(method.type)) methods.push(method.type);
  }
  if (data.enabled !== (methods.length > 0)) throw new Error('Security status is inconsistent. Refresh before making changes.');
  return { enabled: data.enabled, methods, recoveryCodesRemaining: data.recovery_codes_remaining as number, trustedDeviceCount: data.trusted_devices.length, obligation: data.obligation!.state as SecurityStatus['obligation'] };
}
export async function fetchSecurityStatus(token: string, signal?: AbortSignal): Promise<SecurityStatus> {
  if (!token || signal?.aborted) throw new Error('Sign in to view security settings.');
  const response = await fetch(`${environment.apiUrl}/api/mfa`, { signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 401 ? 'Your session expired. Sign in again.' : 'Security status is unavailable. Use the secure CRM website or retry.');
  return securitySummary(await response.json());
}
export function securityPageUrl(area: 'crm' | 'desk', destination: 'password' | 'two-step'): string {
  if (!['crm', 'desk'].includes(area) || !['password', 'two-step'].includes(destination)) throw new Error('Unknown security destination.');
  const base = new URL(environment.authUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && local))) throw new Error('Security settings require a trusted HTTPS CRM origin.');
  // Password change is the existing top-bar modal, not a separate website route.
  return new URL(`/${area}/${destination === 'password' ? 'account' : 'two-step'}`, base).toString();
}
