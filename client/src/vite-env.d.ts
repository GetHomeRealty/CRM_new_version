/// <reference types="vite/client" />

/**
 * Typed access to the app's Vite environment variables. Augments the base
 * ImportMetaEnv from `vite/client` so `import.meta.env.VITE_*` is strongly typed.
 */
interface ImportMetaEnv {
  /** Base URL of the Laravel API. Falls back to http://localhost:8000 when unset. */
  readonly VITE_API_URL?: string;
  /** Display name of the application. */
  readonly VITE_APP_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
