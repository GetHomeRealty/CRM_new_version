# Mobile dependency review — 2026-09-18

Read-only npm audit reports 14 moderate package findings, with two underlying advisories. These are not 14 independent vulnerabilities. No production packages or services were changed.

- `expo-router@57.0.20 → query-string@7.1.3 → decode-uri-component@0.2.2`: malformed URL decoding can cause excessive CPU use. Patched upstream version is 0.5.0, but it is ESM while the installed consumer uses CommonJS. A blind override is not verified compatible. This routing dependency is runtime-relevant; resolution remains a release gate.
- Expo configuration tooling → `xcode@3.0.1 → uuid@7.0.3`: buffer bounds advisory affects v3/v5/v6 with caller-supplied buffers. The inspected Xcode source calls `uuid.v4()` without a buffer. This inspected call is outside the described vulnerable path, but the dependency finding remains unresolved.

Sources:
- https://github.com/advisories/GHSA-vcc3-ghjq-m6fr
- https://github.com/advisories/GHSA-w5hq-g745-h8pq

Do not run `npm audit fix --force`: the audit proposes incompatible Expo downgrades. Resolve with compatible upstream patches or a reviewed compatibility patch, then rerun routing, native builds and sign-in tests. The new jsdom test dependency is not in the reported vulnerability chains.

Separate hardening: sign-in now validates callback scheme, host, path, parameter uniqueness and size before exchanging a code. This does not remediate Expo Router's decoder vulnerability, because the router can parse links before the auth handler.
