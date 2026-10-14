import type { ConfigContext, ExpoConfig } from 'expo/config';

export default function configureProviders({ config }: ConfigContext): ExpoConfig {
  const environmentProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();
  const configuredProjectId = config.extra?.eas?.projectId;
  if (environmentProjectId && configuredProjectId && environmentProjectId !== configuredProjectId) {
    throw new Error('The EAS project in the environment differs from the configured project.');
  }
  const projectId = environmentProjectId || configuredProjectId;
  if (projectId && (typeof projectId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(projectId))) {
    throw new Error('EXPO_PUBLIC_EAS_PROJECT_ID must be the actual EAS project UUID.');
  }
  if (process.env.EXPO_PUBLIC_NATIVE_PUSH_ENABLED === 'true' && !projectId) {
    throw new Error('Native push requires the actual EXPO_PUBLIC_EAS_PROJECT_ID.');
  }
  if (process.env.GHH_PROVIDER_PREVIEW === 'true') {
    for (const key of ['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_AUTH_URL']) {
      let url: URL;
      try { url = new URL(process.env[key] || ''); }
      catch { throw new Error(`${key} must be an explicit HTTPS test origin for a provider preview.`); }
      if (url.protocol !== 'https:' || url.hostname === 'transaction.gethomehub.ca' ||
          url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error(`${key} must be an explicit HTTPS test origin, without credentials or URL parameters.`);
      }
    }
    if (!projectId) throw new Error('A provider preview requires the actual EXPO_PUBLIC_EAS_PROJECT_ID.');
  }
  return {
    ...config,
    name: config.name || 'Get Home Hub',
    slug: config.slug || 'get-home-hub-mobile',
    ...(projectId ? { extra: { ...config.extra, eas: { ...config.extra?.eas, projectId } } } : {}),
  };
}
