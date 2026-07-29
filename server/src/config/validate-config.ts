import type { AppConfig } from './configuration';

/**
 * Refuse to start a production server that is configured to fail.
 *
 * Every check below guards a setting whose wrong value produces no error at boot and no useful
 * error later — just an application that looks fine and does not work. A cookie without `secure`
 * is simply never stored by the browser, so login appears to succeed and the next request is
 * anonymous. An empty APP_KEY silently becomes a 32-byte zero key, so secrets encrypt and decrypt
 * happily until the day a real key is set and every stored credential turns to noise.
 *
 * Failing at boot turns each of those into a deploy that stops with a readable list, which is
 * recoverable in a minute. All problems are collected and reported together so a misconfigured
 * environment is fixed in one pass rather than one restart at a time.
 *
 * Development is untouched: nothing here runs unless NODE_ENV is production.
 */

/** Laravel's AES-256-CBC key: base64, exactly 32 bytes decoded, optional `base64:` prefix. */
function appKeyProblem(appKey: string): string | null {
  if (!appKey.trim()) {
    return 'APP_KEY is empty. It encrypts stored IMAP passwords and Google refresh tokens; blank '
      + 'silently becomes an all-zero key, and setting a real one later makes every stored '
      + 'credential undecryptable. Carry forward the exact key already in use.';
  }
  const raw = appKey.startsWith('base64:') ? appKey.slice(7) : appKey;
  let bytes: number;
  try { bytes = Buffer.from(raw, 'base64').length; } catch { bytes = -1; }
  if (bytes !== 32) {
    return `APP_KEY must decode to 32 bytes for AES-256 (got ${bytes < 0 ? 'invalid base64' : `${bytes} bytes`}). `
      + 'Generate with: openssl rand -base64 32';
  }
  return null;
}

export function productionConfigProblems(cfg: AppConfig): string[] {
  const problems: string[] = [];

  const keyProblem = appKeyProblem(cfg.appKey);
  if (keyProblem) problems.push(keyProblem);

  if (!cfg.databaseUrl.trim()) problems.push('DATABASE_URL is not set.');

  const secret = cfg.session.secret;
  if (!secret || secret === 'insecure-dev-secret') {
    problems.push('SESSION_SECRET is unset or still the built-in development value, which is public '
      + 'in this repository and would let anyone forge a session. Generate with: openssl rand -base64 48');
  } else if (secret.length < 32) {
    problems.push(`SESSION_SECRET is only ${secret.length} characters; use at least 32.`);
  }

  // Browsers discard a cookie marked Secure=false on HTTPS pages only when SameSite=None, but a
  // production site is HTTPS and a non-secure session cookie is sent in the clear regardless.
  if (!cfg.session.secure) {
    problems.push('COOKIE_SECURE is false. Over HTTPS the session cookie must be Secure, or it is '
      + 'transmitted in the clear. Set COOKIE_SECURE=true.');
  }

  // SameSite=None without Secure is rejected outright by every current browser: the cookie is
  // simply not stored, so login succeeds and the next request arrives with no session.
  if (cfg.session.sameSite === 'none' && !cfg.session.secure) {
    problems.push('COOKIE_SAMESITE=none requires COOKIE_SECURE=true; browsers reject the combination '
      + 'and drop the cookie, which surfaces as a login that immediately bounces back.');
  }

  const origins = cfg.corsOrigins;
  if (!origins.length) {
    problems.push('CORS_ORIGINS (or FRONTEND_URL) is not set, so the browser has no allowed origin.');
  }
  for (const o of origins) {
    if (/localhost|127\.0\.0\.1/i.test(o)) {
      problems.push(`CORS_ORIGINS still contains a development origin (${o}). Replace it with the public site origin.`);
    } else if (!o.startsWith('https://')) {
      problems.push(`CORS origin "${o}" is not https.`);
    }
    if (o.endsWith('/')) {
      problems.push(`CORS origin "${o}" has a trailing slash; browsers send the origin without one, so it will never match.`);
    }
  }

  // A domain-scoped cookie is only needed to span subdomains, and must be written with the
  // leading dot; without it the cookie is host-only and the other subdomain never sees it.
  const domain = cfg.session.domain;
  if (domain && !domain.startsWith('.')) {
    problems.push(`COOKIE_DOMAIN="${domain}" has no leading dot. Use ".${domain.replace(/^\./, '')}" to share the `
      + 'cookie across subdomains, or leave it empty for a single-origin deployment.');
  }

  return problems;
}

/** Throws with every problem listed, or returns quietly. No-op outside production. */
export function assertProductionConfig(cfg: AppConfig): void {
  if (cfg.env !== 'production') return;
  const problems = productionConfigProblems(cfg);
  if (!problems.length) return;
  throw new Error(
    `Refusing to start: ${problems.length} configuration problem${problems.length === 1 ? '' : 's'} `
    + `would break this deployment.\n\n`
    + problems.map((p, i) => `  ${i + 1}. ${p}`).join('\n\n')
    + '\n\nSee server/.env.example for the production block.\n',
  );
}
