/**
 * TD-195 - an open tab must survive a new release of the screens.
 *
 * Each screen is a separate file named after its content (AnalyticsPage-BYAk0gMP.js). A build
 * replaces those files, so a tab opened before it still asks for the old names and every page it
 * opens fails with "Failed to fetch dynamically imported module". Seen live 2026-09-17 after the
 * morning release: Analytics, Calendar, Inventory, Inbox and Transactions all failed until reload.
 */

const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed/i;
const RELOAD_KEY = 'ghr-new-version-reload-at';

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return CHUNK_ERROR.test(message);
}

/**
 * Reload once onto the published version. Refuses when it already reloaded in the last minute - a
 * file that is missing for another reason must not reload forever - and when the browser will not
 * let it remember that, for the same reason.
 */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** The main file this tab is running, e.g. /assets/index-Cc66eITg.js. Null on the dev server. */
export function runningBundle(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return script ? new URL(script.src, window.location.href).pathname : null;
}

/** The main file the server publishes right now. Null when it cannot be read - never a guess. */
export async function publishedBundle(): Promise<string | null> {
  try {
    const res = await fetch('/index.html', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const found = /\/assets\/index-[\w-]+\.js/.exec(await res.text());
    return found ? found[0] : null;
  } catch {
    return null;
  }
}
