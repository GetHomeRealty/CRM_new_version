import axios from 'axios';

const baseURL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

/**
 * Pre-configured axios instance for talking to the Laravel API.
 *
 * `withCredentials` + `withXSRFToken` make the browser send the Sanctum
 * session cookie and the X-XSRF-TOKEN header on cross-origin requests, which
 * is what powers cookie-based SPA authentication.
 */
const api = axios.create({
  baseURL,
  withCredentials: true,
  withXSRFToken: true,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  },
});

/**
 * Fetch the CSRF cookie from Sanctum. Must be called once before the first
 * state-changing request (login / register / logout).
 */
export const getCsrfCookie = () => api.get('/sanctum/csrf-cookie');

export default api;
