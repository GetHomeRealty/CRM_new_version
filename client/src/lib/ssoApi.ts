import api from './axios';

export interface SsoAuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  state: string;
}

export const authorizeSso = async (request: SsoAuthorizeRequest): Promise<string> => {
  const response = await api.post<{ redirect_url: string; expires_in: number }>('/api/sso/authorize', request);
  return response.data.redirect_url;
};
