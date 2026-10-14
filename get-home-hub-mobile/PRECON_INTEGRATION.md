# Precon native integration — local evidence and remaining work

Inspected September 12, 2026. No production requests or changes were made.

## Evidence

- Mobile `src/app/precon.tsx` contains three static sample projects, not an API integration.
- Saved Precon repository `/Users/prudhviraj/CoDEX/get-home-realty` is at `3bcf102` on main.
- Its local `codex/shared-sso` branch is at `7144f5a`; its former temporary worktree is missing.
- That branch's middleware authorizes a signed CRM session cookie or Clerk session. It does
  not authenticate the opaque bearer token issued by CRM's MobileSessionService.
- CRM mobile tokens are random opaque credentials stored as hashed session identifiers in
  CRM's database. They are not signed JWTs that Precon can independently verify.
- Precon project routes exist at `/api/projects` and `/api/projects/[slug]`. The saved main
  checkout's routes use Dropbox-backed services and snapshots. Route existence alone does
  not establish native authentication compatibility or the current deployed contract.

## Required implementation sequence

1. Resolve the current canonical Precon source into an isolated writable local checkout,
   preserving the existing repository. Inspect its instructions, session handling, project
   schemas, file authorization, and tests before implementing against it.
2. Implement a native authorization boundary. Prefer a narrowly scoped server-side token
   exchange or authenticated gateway, with active-user verification and revocation semantics.
   Never embed Precon's confidential SSO client secret or signing secret in the mobile app,
   reuse arbitrary browser cookies, or make protected project routes public.
3. Build the native project list/search/detail experience from the verified contract,
   followed by authorized project-file viewing and remaining website actions. Browser-only
   links are not a substitute for the requested native feature parity.
4. Exercise the actual handlers against an isolated local database and synthetic project/file
   fixtures; replace Dropbox and other external transports. Cover expired/revoked credentials,
   inactive users, denied access, pagination/search, missing projects/files, and network errors.
5. Verify native UI flows in the simulator before physical-device testing. Deployment remains
   outside the present authorization: production is reserved for the CRM team's testing.

This is an integration assessment, not a claim that Precon mobile access is implemented or
that the inspected local branch matches production. Other mobile modules can continue locally
while the canonical Precon source is resolved.
