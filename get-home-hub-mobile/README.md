# Get Home Hub Mobile

Native iOS and Android workspace for Get Home Realty agents. This application unifies CRM,
Transactions, and Precon/Canada while continuing to use the existing production services as the
authoritative source for data, permissions, and business rules.

## Current milestone

- Expo SDK 57 / React Native 0.86 foundation
- Native tab navigation for Home, Leads, Transactions, and Precon
- Shared light/dark design tokens and accessible mobile screen primitives
- TanStack Query API state provider
- CRM authorization-code + PKCE sign-in using the existing password and MFA flow
- Revocable opaque mobile sessions stored in encrypted SecureStore (passwords never enter the app)
- Production application identifiers reserved in config

Authentication, Leads, Transactions, dashboard summaries, and Calendar have API integrations.
Lead editing includes classifications, tags, demographics, property preferences, and activity.
Task status changes and note pinning are implemented. Precon still displays prototype fixtures;
this is not yet a full-parity or release-ready application.

## Local verification safety

Connected screens can write to whichever API is configured. Do not assume a preview is read-only.
While production testing is underway, use only an isolated local API/database and explicitly set
both `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_AUTH_URL` to local endpoints. Release-mode builds may
otherwise select production defaults. Do not launch a release export for mutation testing without
checking its configured endpoints. Disable or replace outbound mail, SMS, and other integrations
in the test backend; disabling scheduled jobs alone does not prevent event-triggered messages.

No production deployments, server restarts, migrations, or real outbound communications are
part of the current mobile development/test workflow.

Local automated checks:

```bash
npx tsc --noEmit
npm run lint
node --test scripts/*.test.cjs
```

The script suite includes pure validation and mocked API contract tests. Passing it does not prove
device interaction, backend integration, or full website parity. The September 12 local export
successfully bundled iOS, Android, and web; physical-device verification of the latest changes
remains pending. The exported bundles were not deployed or launched against production.

## Authentication decision

The web hub uses PostgreSQL-backed browser sessions plus CSRF cookies. A mobile application must not
embed a reusable client secret or weaken that flow. The app uses a dedicated native authorization-
code + PKCE exchange and stores only the resulting revocable credential in SecureStore. Existing
browser login, MFA, permissions, and Precon SSO remain unchanged. Mobile sessions expire after 30
days by default and can be revoked server-side.

## Run locally

Use Node 22.13 or newer.

```bash
npm install
npm run ios
```

For Android, use `npm run android`. For a browser preview, use `npm run web`.

Set `EXPO_PUBLIC_API_URL` only when the API is not available at the default development URL
(`http://localhost:8000`) or production URL (`https://transaction.gethomehub.ca`).

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Campaign release gate

Campaign sending is off unless explicitly enabled at build time. Never enable it merely because local tests pass.

1. Reconcile the campaign-only server changes with the current production branch; do not deploy this dirty workspace wholesale. Preserve the team's unrelated edits and production environment configuration.
2. With deployment approval and a database backup, apply `20260930090000_campaign_submission_receipts` using the team's migration workflow, then deploy the compatible API. Do not run unrelated pending migrations automatically.
3. Verify authenticated `POST /api/campaigns/submissions` and `GET /api/campaigns/submissions/:key`, account isolation, health and cancellation in staging. Test mail must be intercepted. Old servers must reject the dedicated endpoint rather than fall back to the legacy send route.
4. Complete physical-device/network-interruption regression. Only then build with `EXPO_PUBLIC_CAMPAIGN_SENDING_ENABLED=true`; keep `EXPO_PUBLIC_LOCAL_CAMPAIGN_SEND_TESTING=false` in release builds. These public flags are not secrets or substitutes for server authorization.
5. Unknown outcomes remain blocked until the original receipt is recovered. A 404 is not proof that no in-flight request exists. Never clear a pending attempt to force another send.

The receipt prevents duplicates for the same account/request key; independently created drafts on separate devices have different keys. It is not a promise of exactly-once SMTP delivery. Keep receipts across campaign deletion and rollbacks. Disabling the UI does not cancel campaigns already scheduled on the server.

Current evidence and limitations are recorded in `LOCAL_VERIFICATION.md` and `REMAINING_DEVELOPMENT.md`. No production campaign deployment has been performed as part of this local implementation.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.

Native push implementation, safe default-off configuration and device/delivery release gates: [PUSH_NOTIFICATIONS.md](PUSH_NOTIFICATIONS.md). Production remains frozen.
