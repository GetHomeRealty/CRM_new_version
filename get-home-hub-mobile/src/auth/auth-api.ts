import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { environment } from '@/config/environment';

const TOKEN_KEY = 'get-home-hub.mobile-session';

export interface MobileUser {
  id?: number;
  sub?: string;
  name: string;
  email: string;
  username?: string | null;
  role: string;
  modules?: ('crm' | 'desk')[];
  is_admin?: boolean;
  permissions?: Record<string, 'none' | 'view' | 'edit'>;
}

interface TokenResponse {
  token_type: 'Bearer';
  access_token: string;
  expires_in: number;
  user: MobileUser;
}

function base64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function randomValue(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return base64Url(btoa(binary));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return base64Url(digest);
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: string | string[] };
    return Array.isArray(body.message) ? body.message.join(' ') : body.message || 'Sign-in failed.';
  } catch {
    return 'Sign-in failed. Please try again.';
  }
}

export async function signInWithCrm(): Promise<{ token: string; user: MobileUser }> {
  if (Platform.OS === 'web') {
    throw new Error('CRM sign-in is available in the iOS and Android app. Use a device or simulator to test it.');
  }
  const verifier = await randomValue();
  const state = await randomValue();
  const challenge = await challengeFor(verifier);
  const query = new URLSearchParams({
    client_id: environment.mobileClientId,
    redirect_uri: environment.mobileRedirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const result = await WebBrowser.openAuthSessionAsync(
    `${environment.authUrl}/sso/authorize?${query.toString()}`,
    environment.mobileRedirectUri,
  );
  if (result.type !== 'success') throw new Error('Sign-in was cancelled.');

  if (result.url.length > 8192) throw new Error('The sign-in response could not be verified.');
  const callback = new URL(result.url);
  const expected = new URL(environment.mobileRedirectUri);
  if (callback.protocol !== expected.protocol || callback.host !== expected.host
    || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash
    || callback.searchParams.getAll('state').length !== 1
    || callback.searchParams.get('state') !== state
    || callback.searchParams.getAll('code').length > 1) {
    throw new Error('The sign-in response could not be verified.');
  }
  const code = callback.searchParams.get('code');
  if (!code) throw new Error(callback.searchParams.get('error') || 'The sign-in response is incomplete.');

  const response = await fetch(`${environment.apiUrl}/api/sso/mobile/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: environment.mobileClientId,
      redirect_uri: environment.mobileRedirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error(await responseMessage(response));
  const body = await response.json() as TokenResponse;
  await SecureStore.setItemAsync(TOKEN_KEY, body.access_token);
  return { token: body.access_token, user: body.user };
}

export async function refreshAccess(token: string, signal?: AbortSignal): Promise<MobileUser | null> {
  const response = await fetch(`${environment.apiUrl}/api/user`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal,
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error('Could not refresh account access.');
  const user = await response.json() as MobileUser;
  if (!user || !Number.isInteger(user.id) || typeof user.name !== 'string') throw new Error('Invalid account response.');
  return user;
}

export async function restoreSession(): Promise<{ token: string; user: MobileUser } | null> {
  if (Platform.OS === 'web') return null;
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!token) return null;
  const response = await fetch(`${environment.apiUrl}/api/user`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (response.status === 401 || response.status === 403) {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    return null;
  }
  if (!response.ok) throw new Error('Could not verify your saved session. Please try again when the server is available.');
  return { token, user: await response.json() as MobileUser };
}

export async function revokeSession(token: string | null): Promise<void> {
  if (token) {
    try {
      await fetch(`${environment.apiUrl}/api/sso/mobile/logout`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
    } catch {
      // Local deletion still signs this device out if the server is unavailable.
    }
  }
  if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(TOKEN_KEY);
}
