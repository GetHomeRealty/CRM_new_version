# Provider setup

Repository-side configuration is prepared. Actual provider accounts/credentials are not linked: none were supplied or configured, and no existing provider-console browser tab was found. This is setup preparation, not live-provider acceptance. Production is frozen; no build submission, project/app creation, real message or external permission grant performed.

## Prepared files

- `app.config.ts`: preserves app.json configuration and optionally binds the actual EXPO_PUBLIC_EAS_PROJECT_ID to extra.eas.projectId. Rejects malformed/conflicting IDs and enabled native push without a project. It never copies server secrets into public config.
- `eas.json`: internal `provider-preview` profile using the EAS preview environment. Requires explicit HTTPS test API/auth origins and a real project UUID. Sending, Meta management, import and push flags remain off. No production profile or submission configuration is invented.
- `.env.providers.example`: public mobile test values only; no actual URLs/IDs invented.
- `../server/.env.providers.example`: server-only preparation overlay, local gh_mobile_test database and test mode, no secrets, schedulers/live flags disabled.

[Expo configuration](https://docs.expo.dev/workflow/configuration/) and [EAS environments](https://docs.expo.dev/eas/environment-variables/) describe the dynamic-config and preview-environment mechanisms used here. The custom provider env filenames are intentionally not auto-loaded.

Copy public values to an ignored `.env.providers.local` only after real approved test values are known. Keep the server overlay private with mode 0600 and outside committed source. Do not overwrite either production .env or the existing isolated server .env. Never put GOOGLE_MAIL_CLIENT_SECRET, META_APP_SECRET, EXPO_PUSH_ACCESS_TOKEN, SMTP/IMAP passwords or APP_KEY in EXPO_PUBLIC variables or EAS app extra.

Preserve the existing test encryption key when encrypted mailbox/Meta data already exists. An empty APP_KEY template is not a request to clear or rotate it. Existing local provider transports remain blocked in NODE_ENV=test; staging/live validation is a separate authorized environment step, not a reason to bypass the current transport sandbox.

## Inputs still needed from the real test accounts

| Provider | Required account setup/configuration |
|---|---|
| Email | Dedicated non-production Google mail OAuth client pair (or intentionally configured main pair); approved GOOGLE_PUBLIC_URL with /api/google/callback registered; test mailbox owner consent; owned SMTP/IMAP configuration through the existing mailbox UI. |
| Meta | Test Meta app ID/secret/login configuration and permissions; approved reachable META_PUBLIC_URL with /api/meta/callback and /api/meta/webhook; webhook verification token and valid app-secret signature configuration; dedicated test page/form. |
| Push | Actual test Expo/EAS project UUID; server-only enhanced-security access token; APNs/FCM signing setup for ca.gethomehub.mobile. Physical-device testing follows configuration. |

Provide local paths to the private non-production configuration, not pasted secrets. The application cannot invent provider-issued client IDs/secrets, a real EAS project or owner consent. Any new external security-sensitive permission grant must be reviewed at its action; no account access is assumed from placeholders.

The provider-preview guard rejects the known production host transaction.gethomehub.ca, HTTP, absent origins, embedded URL credentials/query/hash/path and missing project IDs. It cannot prove that every other HTTPS host is non-production: the supplied test environment must still be identified and authorized. UUID syntax validation does not prove a project exists or belongs to this account.

Live email/push remain prohibited by the existing briefing until a concrete test destination/payload is authorized. Profile flags must be changed deliberately only for the corresponding approved acceptance batch; provider setup alone does not certify delivery or justify production activation.

## Validation and remaining acceptance

Five new focused configuration checks passed: unchanged local app configuration; explicit public project binding without server-secret copying; malformed/conflicting/missing project guards; test-origin guard; safe preview-profile defaults. Changed-file lint and isolated app.config.ts TypeScript passed. Actual local Expo public config preserved ca.gethomehub.mobile platform IDs and ExpoNotifications with no configured EAS project. TypeScript's first isolated command omitted Node types; only that failed command was corrected with existing --types node and rerun. No earlier suite/build/native pass repeated.

Exact logs in /private/tmp: mobile-provider-build-config-tests-20261009.log, mobile-provider-setup-lint-20261009.log, mobile-provider-setup-types-fixed-20261009.log and mobile-provider-public-config-status-20261009.log, all saved exit 0. Original mobile-provider-setup-types-20261009.log retains the initial command failure.

After genuine test setup is supplied: verify mailbox OAuth/refresh/SMTP/IMAP/Sent, Meta OAuth/pages/forms/sync/webhooks/disconnect and device push registration/delivery/logout/receipts in the order recorded in ../reports/mobile-provider-readiness-20261009.md. Those live-provider checkboxes remain open; prepared config files are not a connected provider.


## Private client reviews

The mobile CRM now includes internal Client Reviews. Configure `CLIENT_REVIEWS_PUBLIC_URL` as the dedicated nonproduction API HTTPS origin; response links target `/api/client-reviews/respond` with the capability in the URL fragment. Loopback HTTP is accepted only under `NODE_ENV=test`. Keep `CLIENT_REVIEWS_EMAIL_ENABLED=false` until an owned CRM mailbox and explicit test recipient are ready. Email sends use the chosen owned active mailbox once; uncertain results are not automatically retried. Existing `APP_KEY` must decode to 32 bytes to encrypt recoverable links. Do not rotate or replace that key as part of provider setup. Apply `20261009180000_client_reviews` only to the authorised environment. The SQL is already applied to the isolated local test database, which has no Prisma migration-history table; production is unchanged.

Creating and recovering a link requires Reviews edit permission; all stored requests and feedback are private to the requesting user. The client response page publishes nothing. Submitted, cancelled and expired links stop accepting feedback. See `../reports/mobile-crm-additional-scope-20261009.md` for local evidence and native/provider acceptance still pending.

## Transaction Desk document reminders

`DESK_DOCUMENT_REMINDERS_ENABLED` is server-only and defaults to false. Enable only for separately authorized provider acceptance with a configured active Desk mailbox/template. Native preview includes the selected visible flagged pending/invalid documents, recipients, sender, subject and template attachment names. A durable per-owner UUID receipt is saved before a single transport attempt. Accepted means mail transport acceptance; partial/error/crash outcomes must be reconciled without automatic resend. The device blocks another attempt across relaunch until a sent receipt is recovered and the user confirms preparing another reminder. Local acceptance used only a synthetic mail mock and does not certify real delivery. Evidence: `../reports/mobile-document-reminders-20261013.md`.
