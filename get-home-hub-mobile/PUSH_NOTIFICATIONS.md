# Native push notifications

## Implemented locally

Notifications → Device notifications offers explicit opt-in/disable/refresh when the build and API are configured. Refresh never prompts for system permission; unregistered sessions do not auto-enrol. Registration is serialized, authenticated to the current opaque mobile session and expires within 24 hours or at session expiry, whichever comes first. Foreground/6-hour checks renew an opted-in registration. Permission revocation removes registration. Unmount aborts pending API work and ignores late native callbacks.

Alerts contain only generic update text and an account identifier; opening an alert shows the authenticated notification feed for that same account. Foreign/stale-account interactions and foreground banners are rejected. The sheet is scoped to both account and session. Foreground alerts show banner/list without sound or badge; cleanup removes handlers/listeners and clears notification responses/displayed alerts.

The backend respects existing category preferences, validates ownership/expiry at dispatch, stores provider tickets, polls receipts and removes invalid tokens. Logout/revocation removes device registrations and receipt rows through the session foreign key. Receipt `ok` is provider acceptance, not proof a person saw the alert. No automatic send retry follows an uncertain result.

## Release configuration — not performed

Production is frozen. Do not turn on real push or deploy based on local checks alone.

1. Review/isolate the existing dirty worktree. Apply additive server migration `20261005190000_mobile_push`, regenerate Prisma and deploy compatible API before enabling server push. Never overwrite production .env.
2. Link the actual Expo/EAS project and configure its APNs signing/provisioning and Android FCM v1 credentials for package/bundle `ca.gethomehub.mobile`. No project ID or credentials are invented or embedded in source. The notifications plugin is in app.json; prebuild generates iOS entitlements, and pods include ExpoNotifications.
3. Configure Expo enhanced push security. Keep `EXPO_PUSH_ACCESS_TOKEN` on the server only. The backend requires it and `NATIVE_PUSH_ENABLED=true`; both default disabled/unconfigured. Never put this secret in an EXPO_PUBLIC variable.
4. The signed mobile build requires the real public `EXPO_PUBLIC_EAS_PROJECT_ID` plus `EXPO_PUBLIC_NATIVE_PUSH_ENABLED=true`. Current local build explicitly uses false and an empty ID. This keeps native permission/token/provider calls inactive. Client flags do not replace server authentication.
5. Verify opt-in, denied permission, foreground/background/cold-start interaction, same-account routing, account switching, offline/online logout, server revocation, expired-lease renewal, invalid-device receipt cleanup and OS permission removal on physical iPhone and Android. Verify a chosen synthetic alert only after real delivery is explicitly authorized. Keep the notification category preference matrix intact.
6. Enable a release only after those gates and final regression/signing checks. Android/physical delivery has not been certified by simulator or mocked tests.

## Known operational limits

A logout while offline cannot immediately revoke the server session; generic notifications can continue until server revocation/lease expiry. Server registration leases bound this to 24 hours and session expiry. Provider-accepted messages already queued cannot be recalled. Alerts reveal no lead/mail details. Re-authenticate to renew an expired/revoked session.

## Evidence to reuse

Saved 5 October checks: 13 focused mobile tests; backend 10 service, 28 integration/affected-dispatcher and 4 HTTP tests. The isolated integration suite enforces local gh_mobile_test, uses rollback fixtures and mocks provider delivery. Reuse these checks unless their exact behavior changes.

6 October additions: focused provider test verifies foreground account checks, account/session change closes the old sheet and teardown clears native handlers; targeted CommonJS globals/provider lint and mobile source TypeScript pass with saved exit statuses. Native build/default-off acceptance is recorded separately in the completion report. No real APNs/FCM/Expo transmission is included in this local evidence.

Official references: [Expo SDK 57 notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/), [Expo push setup](https://docs.expo.dev/push-notifications/push-notifications-setup/), [provider tickets/receipts](https://docs.expo.dev/push-notifications/sending-notifications/).
