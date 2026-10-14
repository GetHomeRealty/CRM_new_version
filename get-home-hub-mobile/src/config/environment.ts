const defaultApiUrl = __DEV__
  ? 'http://localhost:8000'
  : 'https://transaction.gethomehub.ca';

export const environment = {
  // External Meta management stays off until provider/native acceptance.
  metaManagementEnabled: process.env.EXPO_PUBLIC_META_MANAGEMENT_ENABLED === 'true',
  nativePushEnabled: process.env.EXPO_PUBLIC_NATIVE_PUSH_ENABLED === 'true',
  pushProjectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '',
  // Release gate: enable only after native picker/submission verification.
  leadImportEnabled: process.env.EXPO_PUBLIC_LEAD_IMPORT_ENABLED === 'true',
  // Keep off until reply migration, HTTP authorization and native tests are verified.
  inboxReplySendingEnabled: process.env.EXPO_PUBLIC_INBOX_REPLY_SENDING_ENABLED === 'true',
  // Opt-in only for an isolated local API with mail transport intercepted/blocked.
  localCampaignSendTesting: process.env.EXPO_PUBLIC_LOCAL_CAMPAIGN_SEND_TESTING === 'true',
  // Release opt-in only after the receipt migration/API are deployed and verified.
  campaignSendingEnabled: process.env.EXPO_PUBLIC_CAMPAIGN_SENDING_ENABLED === 'true',
  apiUrl: process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') || defaultApiUrl,
  authUrl: process.env.EXPO_PUBLIC_AUTH_URL?.replace(/\/$/, '') || (__DEV__
    ? 'http://localhost:5173'
    : 'https://transaction.gethomehub.ca'),
  mobileClientId: 'get-home-hub-mobile',
  mobileRedirectUri: 'gethomehub://auth/callback',
  preconUrl: 'https://precon.gethomerealty.ca',
} as const;
